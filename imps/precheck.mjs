#!/usr/bin/env node
// Zero-token gate for the daily hypervisor: exit 0 when there is work for a model
// (reasons on stdout), exit 3 when the day is quiet and the session can be skipped.
//   node precheck.mjs [--owner nitsuah]
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { triageWork } from './lib.mjs';

const { values: o } = parseArgs({ options: { owner: { type: 'string', default: 'nitsuah' } } });
const gh = (args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${(r.error?.message || r.stderr || '').trim()}`);
    return r.stdout;
};
const search = (q) =>
    JSON.parse(
        gh([
            'api', 'graphql', '-f',
            `query=query{search(query:"${q}",type:ISSUE,first:100){nodes{... on Issue{number title repository{name} labels(first:20){nodes{name}} comments(last:15){nodes{body}}}}}}`,
            '--jq', '.data.search.nodes',
        ]),
    ).map((n) => ({
        repo: n.repository.name,
        number: n.number,
        title: n.title,
        labels: n.labels.nodes.map((l) => l.name),
        comments: n.comments.nodes.map((c) => c.body),
    }));

try {
    const impPRs = JSON.parse(gh(['search', 'prs', '--owner', o.owner, '--state', 'open', '--label', 'imp', '--limit', '100', '--json', 'labels'])).map((p) => ({ labels: p.labels.map((l) => l.name) }));
    const seen = new Map();
    for (const label of ['bot:review', 'bug']) for (const i of search(`user:${o.owner} is:issue is:open label:${label}`)) seen.set(`${i.repo}#${i.number}`, i);
    const failed = search(`user:${o.owner} is:issue is:open label:imp:failed`);
    const res = triageWork({ impPRs, issues: [...seen.values()], failed });
    console.log(JSON.stringify(res));
    process.exit(res.work ? 0 : 3);
} catch (e) {
    // If the check itself breaks, let the model run rather than silently skipping a day.
    console.log(JSON.stringify({ work: true, reasons: [`precheck failed: ${e.message}`], unbriefed: [] }));
    process.exit(0);
}
