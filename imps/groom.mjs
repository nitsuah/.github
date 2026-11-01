#!/usr/bin/env node
// groomer: draft-first triage for untriaged issues. Finds open issues without imp:*
// labels, screens for PR-shaped work, drafts briefs via 9router, lints them,
// and posts as draft comments with `imp:needs-brief` for human promotion.
//
//   node groom.mjs [--dry-run] [--owner nitsuah] [--json]
//
// Opt-in: IMPS_GROOM=1 or ~/.imps/config.json { "groom": true }.
// Kill switch: IMPS_GROOM=0 or ~/.imps/config.json { "groom": false }
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
    const msg = { event: 'groom-disabled', reason: 'not explicitly enabled or kill switch set' };
    console.log(o.json ? JSON.stringify(msg) : 'groom disabled (kill switch)');
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
        repos[r.name] = { humanPRs: null, lastCommitHours: null };
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
    } catch { /* leave unknown; isQuietRepo fails closed */ }
    try {
        const commits = gh(['api', `repos/${o.owner}/${name}/commits?per_page=1`, '--jq', '.[0].commit.author.date']);
        if (commits) {
            const hours = (Date.now() - Date.parse(commits)) / 36e5;
            repos[name].lastCommitHours = hours;
        }
    } catch { /* leave unknown; isQuietRepo fails closed */ }
}

const dailyCap = config.groomDailyIssueCap ?? DEFAULTS.rsiDailyIssueCap;
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
    console.log(`groom: ${results.drafted} drafted, ${results.skipped} skipped, ${results.candidates} candidates`);
    if (results.errors.length) {
        console.log('errors:');
        for (const e of results.errors) console.log(`  - ${e}`);
    }
}

if (o['dry-run']) process.exit(0);
if (results.errors.length && results.drafted === 0) process.exit(1);