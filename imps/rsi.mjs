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
import { rows } from './runner.mjs';

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

// Open bot:journey / bot:review issues become brief candidates (journeys → imps).
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

// Existing open RSI-filed issues (dedupe by title marker).
let openRsi = [];
try {
    openRsi = ghJson([
        'search', 'issues', '--owner', o.owner, '--state', 'open',
        '--limit', '50', '--json', 'repository,number,title',
        '--', 'label:imp:ready "<!-- imp-rsi -->"',
    ]).map((i) => ({ repo: i.repository.name, number: i.number, title: i.title }));
} catch {
    openRsi = [];
}

const filedTodayPath = join(HOME, 'rsi-filed.json');
const filedToday = (() => {
    try {
        const j = JSON.parse(readFileSync(filedTodayPath, 'utf8'));
        const day = new Date().toISOString().slice(0, 10);
        return j.day === day ? j : { day, keys: [] };
    } catch {
        return { day: new Date().toISOString().slice(0, 10), keys: [] };
    }
})();

const proposals = proposeRsiIssues({
    rows: ledger,
    dispatchLog,
    journeyIssues,
    openRsi,
    filedKeys: filedToday.keys,
    kitRepo: o['kit-repo'],
    minRecurrence: config.rsiMinRecurrence ?? DEFAULTS.rsiMinRecurrence,
    dailyCap: config.rsiDailyIssueCap ?? DEFAULTS.rsiDailyIssueCap,
});

if (o.json) console.log(JSON.stringify({ proposals, report: report(ledger) }, null, 2));
else {
    console.log(`rsi: ${proposals.length} proposal(s) (cap ${config.rsiDailyIssueCap ?? DEFAULTS.rsiDailyIssueCap})`);
    for (const p of proposals) console.log(`- ${p.repo}: ${p.title}`);
}

if (o['dry-run'] || !proposals.length) process.exit(0);

for (const p of proposals) {
    const slug = `${o.owner}/${p.repo}`;
    // Labels used by the dispatcher; create if missing.
    for (const [name, color, desc] of [
        ['imp:ready', '0e8a16', 'Has an imp brief; the hourly dispatcher may take it'],
        ['imp-rsi', '5319e7', 'Filed by rsi.mjs self-improvement'],
    ]) {
        spawnSync('gh', ['label', 'create', name, '-R', slug, '-c', color, '-d', desc, '--force'], { encoding: 'utf8', windowsHide: true });
    }
    const body = [
        '<!-- imp-rsi -->',
        p.body,
        '',
        `${BRIEF_MARK}`,
        '```markdown',
        p.brief.trim(),
        '```',
        '',
        `<sub>Filed by \`rsi.mjs\` from ledger/dispatch signals. Kill switch: \`IMPS_RSI=0\` or \`~/.imps/config.json\` \`{"rsi":false}\`.</sub>`,
    ].join('\n');
    const url = gh([
        'issue', 'create', '-R', slug,
        '--title', p.title,
        '--body', body,
        '--label', 'imp:ready',
        '--label', 'imp-rsi',
    ]);
    filedToday.keys.push(p.key);
    console.log(`filed ${url}`);
    appendFileSync(join(HOME, 'rsi.jsonl'), JSON.stringify({ at: new Date().toISOString(), key: p.key, url, repo: p.repo }) + '\n');
}
writeFileSync(filedTodayPath, JSON.stringify(filedToday, null, 2) + '\n');
