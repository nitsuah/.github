#!/usr/bin/env node
// Repeatable tables: open work per repo, and what each imp run cost in tokens.
//   node stats.mjs [--repos] [--tokens] [--since 24h|7d|all] [--owner nitsuah] [--json]
// With neither --repos nor --tokens it prints both. Token numbers come from the
// ledger (~/.imps/runs.jsonl); runs killed before a result event have no usage, so
// their cost is ESTIMATED as tool calls x the median input per turn (marked `~`).
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { rows } from './runner.mjs';
import { repoTable, tokenTable } from './lib.mjs';

const { values: o } = parseArgs({
    options: {
        repos: { type: 'boolean', default: false },
        tokens: { type: 'boolean', default: false },
        since: { type: 'string', default: 'all' },
        owner: { type: 'string', default: 'nitsuah' },
        json: { type: 'boolean', default: false },
    },
});
const both = !o.repos && !o.tokens;
const out = {};

const gh = (args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${(r.error?.message || r.stderr || '').trim()}`);
    return JSON.parse(r.stdout);
};

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const md = (head, body) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (both || o.repos) {
        const issues = gh(['search', 'issues', '--owner', o.owner, '--state', 'open', '--limit', '1000', '--json', 'repository,labels']);
        const prs = gh(['search', 'prs', '--owner', o.owner, '--state', 'open', '--limit', '1000', '--json', 'repository,labels']);
        out.repos = repoTable(issues, prs);
    }
    if (both || o.tokens) {
        const ms = { all: 0, '24h': 864e5, '7d': 7 * 864e5 }[o.since];
        if (ms === undefined) throw new Error('--since must be 24h, 7d or all');
        out.tokens = tokenTable(rows(), { sinceMs: ms });
    }
    if (o.json) console.log(JSON.stringify(out, null, 2));
    else {
        if (out.repos) console.log(md(['Repo', 'Issues', 'Bugs', 'PRs', 'Imp PRs', 'imp:ready', 'imp:failed'], out.repos.map((r) => [r.repo, r.issues, r.bugs, r.prs, r.impPrs, r.ready, r.failed])) + '\n');
        if (out.tokens) {
            const t = out.tokens;
            console.log(md(['Run', 'Issue', 'Turns', 'Input', 'In/turn', 'Min', '1st edit', 'Ctx tools', 'End', 'Gate'],
                t.lines.map((l) => [l.id.slice(4), l.issue, l.turns, (l.estimated ? '~' : '') + k(l.input), k(l.inPerTurn), l.minutes ?? '-', l.firstEdit ?? '-', l.ctxTools ?? '-', l.end, l.gate])));
            const w = t.totals;
            console.log(`\n${w.runs} runs, ${w.pass} passed the gate; input ${k(w.input)} (median ${k(t.medianInPerTurn)}/turn); ${w.wastedRuns} runs without a passing gate used ${k(w.wastedInput)} (${w.input ? Math.round((100 * w.wastedInput) / w.input) : 0}%). \`~\` = estimated (killed before usage was reported).`);
            if (t.reviews.length) console.log('\nReviews:\n' + md(['Mode', 'Runs', 'Avg input', 'Avg output'], t.reviews.map((r) => [r.mode, r.runs, k(r.avgInput), k(r.avgOutput)])));
        }
    }
}
