#!/usr/bin/env node
// groomer: draft-first triage for untriaged issues. Finds open issues without imp:*
// labels, screens for PR-shaped work, drafts briefs via 9router and lints them.
// A brief that passes every check in groom-promote.mjs (trusted author, sandboxed
// Docker commands, brieflint, no security terms) is posted as a real brief with
// `imp:ready`; anything else is posted as a held draft with `imp:needs-brief`.
//
//   node groom.mjs [--dry-run] [--owner nitsuah] [--json]
//
// Opt-in: does nothing unless IMPS_GROOM=1 (setup.ps1 -WithGroomer sets it in the
// scheduled wrapper). Kill switch: ~/.imps/config.json { "groom": false } always wins.
// Safety: daily issue cap (like rsiDailyIssueCap), never touches .github/workflows or secrets,
// dedupes by issue number and brief hash.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULTS } from './defaults.mjs';
import { BRIEF_MARK, resolveRouter } from './lib.mjs';
import { runGroom, loadGroomConfig, groomEnabled } from './groom-lib.mjs';

const HOME = process.env.IMPS_HOME || join(homedir(), '.imps');
mkdirSync(HOME, { recursive: true });

const { values: o } = parseArgs({
    options: {
        'dry-run': { type: 'boolean', default: false },
        owner: { type: 'string', default: DEFAULTS.owner },
        json: { type: 'boolean', default: false },
    },
});

const config = loadGroomConfig(join(HOME, 'config.json'));
if (!groomEnabled(config, process.env)) {
    const msg = { event: 'groom-disabled', reason: 'groomer is opt-in: set IMPS_GROOM=1 (and not config.groom=false)' };
    console.log(o.json ? JSON.stringify(msg) : 'groom disabled (opt-in: set IMPS_GROOM=1)');
    process.exit(0);
}

const gh = (args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (r.status) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${(r.stderr || '').trim()}`);
    return r.stdout.trim();
};
const ghJson = (args) => JSON.parse(gh(args) || 'null');

const router = resolveRouter();
if (!router.key) {
    console.error('groom: no 9router key (NINEROUTER_KEY or ANTHROPIC_API_KEY in settings)');
    process.exit(1);
}

// Repos with open issues (search across owner's repos)
let repos = {};
try {
    const orgRepos = ghJson(['repo', 'list', o.owner, '--limit', '100', '--json', 'name,isPrivate']);
    for (const r of orgRepos) {
        if (r.isPrivate) continue; // skip private for now
        repos[r.name] = { humanPRs: 0, lastCommitHours: 99 };
    }
} catch (e) {
    console.error('repo list failed:', e.message);
    process.exit(1);
}

// Check each repo for open human PRs and recent commits
for (const name of Object.keys(repos)) {
    try {
        const prs = ghJson(['pr', 'list', '-R', `${o.owner}/${name}`, '--state', 'open', '--json', 'author']);
        repos[name].humanPRs = prs.filter((p) => String(p.author?.type || '').toLowerCase() !== 'bot').length;
    } catch { /* ignore */ }
    try {
        const commits = gh(['api', `repos/${o.owner}/${name}/commits?per_page=1`, '--jq', '.[0].commit.author.date']);
        if (commits) {
            const hours = (Date.now() - Date.parse(commits)) / 36e5;
            repos[name].lastCommitHours = hours;
        }
    } catch { /* ignore */ }
}

const dailyCap = config.groomDailyIssueCap ?? DEFAULTS.groomDailyIssueCap;
const quietHours = config.groomQuietHours ?? DEFAULTS.quietHours;
const maxLines = config.groomMaxLines ?? DEFAULTS.maxLines;

const results = await runGroom({
    gh,
    ghJson,
    owner: o.owner,
    repos,
    router,
    config,
    dailyCap,
    quietHours,
    maxLines,
    dryRun: o['dry-run'],
});

if (o.json) console.log(JSON.stringify(results, null, 2));
else {
    console.log(`groom ${new Date().toISOString()}: ${results.drafted} drafted (${results.promoted.length} promoted to imp:ready, ${results.held.length} held), ${results.skipped} skipped, ${results.candidates} candidates`);
    for (const p of results.promoted) console.log(`  + ${p}`);
    for (const h of results.held) console.log(`  ~ ${h.issue}: ${h.reasons.join('; ')}`);
    if (results.errors.length) {
        console.log('errors:');
        for (const e of results.errors) console.log(`  - ${e}`);
    }
}

if (o['dry-run']) process.exit(0);
if (results.errors.length && results.drafted === 0) process.exit(1);