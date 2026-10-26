#!/usr/bin/env node
// Bounded self-improvement (RSI): turn ledger + journey findings into
// `imp:ready` issues with briefs, so imps fix their own recurring failure modes.
//
//   node rsi.mjs [--dry-run] [--owner nitsuah] [--kit-repo .github]
//
// Kill switch (any of these disables filing):
//   IMPS_RSI=0
//   ~/.imps/config.json → { "rsi": false }
//
// Safety: daily issue cap, never briefs work that would touch .github/workflows
// or secrets, reuses BRIEF_MARK + path deny rules, dedupes open rsi issues.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BRIEF_MARK, report } from './lib.mjs';
import { DEFAULTS } from './defaults.mjs';
import { proposeRsiIssues, loadRsiConfig, rsiEnabled } from './rsi-lib.mjs';
import { rows, resolveVaultPrompt } from './runner.mjs';

const HOME = process.env.IMPS_HOME || join(homedir(), '.imps');
mkdirSync(HOME, { recursive: true });

const { values: o } = parseArgs({
    options: {
        'dry-run': { type: 'boolean', default: false },
        owner: { type: 'string', default: DEFAULTS.owner },
        'kit-repo': { type: 'string', default: '.github' },
        json: { type: 'boolean', default: false },
    },
});

const config = loadRsiConfig(join(HOME, 'config.json'));
if (!rsiEnabled(config, process.env)) {
    const msg = { event: 'rsi-disabled', reason: 'IMPS_RSI=0 or config.rsi=false' };
    console.log(o.json ? JSON.stringify(msg) : 'rsi disabled (kill switch)');
    process.exit(0);
}

const gh = (args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (r.status) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${(r.stderr || '').trim()}`);
    return r.stdout.trim();
};
const ghJson = (args) => JSON.parse(gh(args) || 'null');

const ledger = rows();
const dispatchLog = existsSync(join(HOME, 'dispatch.jsonl'))
    ? readFileSync(join(HOME, 'dispatch.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];

let journeyIssues = [];
try {
    journeyIssues = ghJson([
        'search', 'issues', '--owner', o.owner, '--state', 'open',
        '--limit', '50', '--json', 'repository,number,title,labels,body',
        '--', 'label:bot:journey OR label:bot:review',
    ]).map((i) => ({
        repo: i.repository.name,
        number: i.number,
        title: i.title,
        body: i.body || '',
        labels: (i.labels || []).map((l) => l.name),
    }));
} catch (e) {
    console.error('journey search failed:', e.message);
}

// Open RSI-filed issues (label:imp-rsi survives after imp:ready is consumed).
let openRsi = [];
try {
    openRsi = ghJson([
        'search', 'issues', '--owner', o.owner, '--state', 'open',
        '--limit', '100', '--json', 'repository,number,title',
        '--', 'label:imp-rsi',
    ]).map((i) => ({ repo: i.repository.name, number: i.number, title: i.title }));
} catch {
    openRsi = [];
}

// Persist filed keys across days (dedupe). Daily `count` resets and drives the cap.
const filedPath = join(HOME, 'rsi-filed.json');
const day = new Date().toISOString().slice(0, 10);
const filedState = (() => {
    try {
        const j = JSON.parse(readFileSync(filedPath, 'utf8'));
        return {
            day,
            count: j.day === day ? Number(j.count) || 0 : 0,
            keys: Array.isArray(j.keys) ? j.keys : [],
        };
    } catch {
        return { day, count: 0, keys: [] };
    }
})();

const dailyCap = config.rsiDailyIssueCap ?? DEFAULTS.rsiDailyIssueCap;
const remaining = Math.max(0, dailyCap - filedState.count);
const proposals = proposeRsiIssues({
    rows: ledger,
    dispatchLog,
    journeyIssues,
    openRsi,
    filedKeys: filedState.keys,
    kitRepo: o['kit-repo'],
    minRecurrence: config.rsiMinRecurrence ?? DEFAULTS.rsiMinRecurrence,
    dailyCap: remaining,
    testsByRepo: config.testsByRepo || {},
});

const vault = resolveVaultPrompt(config);
if (o.json) console.log(JSON.stringify({ proposals, remaining, vault, report: report(ledger) }, null, 2));
else {
    console.log(`rsi: ${proposals.length} proposal(s) (remaining cap ${remaining}/${dailyCap})${vault ? ` · vault ${vault}` : ''}`);
    for (const p of proposals) console.log(`- ${p.repo}: ${p.title}`);
}

if (o['dry-run'] || !proposals.length) process.exit(0);

for (const p of proposals) {
    const slug = `${o.owner}/${p.repo}`;
    for (const [name, color, desc] of [
        ['imp:ready', '0e8a16', 'Has an imp brief; the hourly dispatcher may take it'],
        ['imp-rsi', '5319e7', 'Filed by rsi.mjs self-improvement'],
    ]) {
        spawnSync('gh', ['label', 'create', name, '-R', slug, '-c', color, '-d', desc, '--force'], { encoding: 'utf8', windowsHide: true });
    }
    // Body is metadata only. The dispatcher reads briefs from *comments*.
    const body = [
        '<!-- imp-rsi -->',
        p.body,
        '',
        vault ? `Vault playbook: \`${vault}\` (also update its Run log after the fix lands).` : '',
        `<sub>Filed by \`rsi.mjs\` from ledger/dispatch signals. Kill switch: \`IMPS_RSI=0\` or \`~/.imps/config.json\` \`{"rsi":false}\`.</sub>`,
    ].filter(Boolean).join('\n');
    const url = gh([
        'issue', 'create', '-R', slug,
        '--title', p.title,
        '--body', body,
        '--label', 'imp:ready',
        '--label', 'imp-rsi',
    ]);
    // Rewrite issue: placeholder in the brief now that we know the number.
    const num = (url.match(/\/issues\/(\d+)/) || [])[1];
    let briefText = p.brief.trim();
    if (num) briefText = briefText.replace(/issue:\s*\(set after create\)/, `issue: ${num}`);
    gh(['issue', 'comment', url, '-R', slug, '--body', [BRIEF_MARK, '```markdown', briefText, '```'].join('\n')]);

    filedState.keys.push(p.key);
    filedState.count++;
    writeFileSync(filedPath, JSON.stringify(filedState, null, 2) + '\n');
    console.log(`filed ${url}`);
    appendFileSync(join(HOME, 'rsi.jsonl'), JSON.stringify({ at: new Date().toISOString(), key: p.key, url, repo: p.repo }) + '\n');
}
