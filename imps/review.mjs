#!/usr/bin/env node
// The imp reviewer: one read-only `claude -p` pass through 9router over an
// imp PR, posted as a single COMMENT review and logged to the ledger.
//
//   node review.mjs <run-id> [--model MAX] [--minutes 12] [--dry-run]
//
// It runs in the imp's worktree with Read/Grep/Glob only (no edits, no
// commands, no tokens), sees the issue, the brief and the diff, and answers
// with REVIEW.md's JSON. The runner recomputes the verdict from the findings
// and posts it. It never approves, requests changes as a blocking review, or
// merges: GitHub's COMMENT event only. Contract: imps/STANDARD.md § Review.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseReview, renderReview } from './lib.mjs';
import { HOME, rows, update, sh, git, runClaude } from './runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: o, positionals: [id] } = parseArgs({
    allowPositionals: true,
    options: {
        model: { type: 'string', default: 'MAX' },
        minutes: { type: 'string', default: '12' },
        'dry-run': { type: 'boolean', default: false },
    },
});
const r = rows().find((x) => x.id === id);
if (!r) throw new Error(`no run ${id}`);
if (!r.pr) throw new Error(`run ${id} has no PR yet`);
if (!r.worktree) throw new Error(`run ${id} has no worktree`);

// Context: the issue, the brief, and the diff (capped so the prompt stays sane;
// the reviewer can Read anything the cap cut off).
const slug = r.pr.replace(/^https:\/\/github\.com\//, '').replace(/\/pull\/\d+$/, '');
const prNumber = r.pr.match(/\/pull\/(\d+)/)[1];
const issue = JSON.parse(sh('gh', ['issue', 'view', String(r.issue), '-R', slug, '--json', 'title,body']).out || '{}');
const brief = r.brief ? readFileSync(r.brief, 'utf8') : '(no brief recorded)';
const base = r.baseSha || git(r.worktree, 'merge-base', 'HEAD', `origin/${r.base || 'main'}`).out;
const stat = git(r.worktree, 'diff', '--stat', '--no-renames', `${base}..HEAD`).out;
let diff = git(r.worktree, 'diff', '--no-renames', `${base}..HEAD`).out;
if (diff.length > 60_000) diff = diff.slice(0, 60_000) + '\n… (diff truncated; Read the files for the rest)';

const prompt = [
    readFileSync(join(HERE, 'REVIEW.md'), 'utf8'),
    `---\n\n## Issue ${slug}#${r.issue}: ${issue.title || ''}\n\n${(issue.body || '').slice(0, 6000)}`,
    `## The brief the imp was given\n\n${brief.slice(0, 8000)}`,
    `## The PR diff (${r.pr})\n\n\`\`\`\n${stat}\n\`\`\`\n\n\`\`\`diff\n${diff}\n\`\`\``,
].join('\n\n');

console.log(`reviewing ${r.pr} (${id})`);
const transcript = join(HOME, 'runs', `${id}.review.jsonl`);
// A model sometimes ends without the JSON block (vhs#91, 2026-10-22). One
// retry; the second attempt is reminded up front.
let metrics;
let rv;
for (const attempt of [1, 2]) {
    metrics = await runClaude({
        cwd: r.worktree, model: o.model, tools: ['Read', 'Glob', 'Grep'], deny: ['Edit', 'Write'],
        prompt: attempt === 1 ? prompt : `${prompt}\n\n**Your previous attempt ended without the required \`json\` block. Keep it short and end with that block.**`,
        minutes: o.minutes, budget: 10, maxTurns: 25, permissionMode: 'default',
        transcript: attempt === 1 ? transcript : transcript.replace(/\.jsonl$/, '.retry.jsonl'),
    });
    rv = parseReview(metrics.finalText);
    if (!rv.error) break;
    console.log(`attempt ${attempt}: ${rv.error} (${metrics.end})${attempt === 1 ? '; retrying once' : ''}`);
}
const minutes = metrics.durationMs ? (metrics.durationMs / 60000).toFixed(1) : null;
const record = {
    at: new Date().toISOString(), model: o.model, transcript, end: metrics.end, turns: metrics.turns, minutes: Number(minutes),
    served: metrics.served, tokens: metrics.tokens, toolErrors: metrics.toolErrors,
};
if (rv.error) {
    update(id, { review: { ...record, error: rv.error } });
    console.log(`review failed: ${rv.error} (${metrics.end}); nothing posted`);
    process.exit(1);
}
const body = renderReview(rv, { runId: id, model: o.model, served: metrics.served, turns: metrics.turns, minutes });
let url = null;
if (!o['dry-run']) {
    const post = sh('gh', ['api', `repos/${slug}/pulls/${prNumber}/reviews`, '-X', 'POST', '-f', 'event=COMMENT', '-f', `body=${body}`, '--jq', '.html_url']);
    if (post.code) throw new Error(`posting the review failed: ${post.err}`);
    url = post.out;
}
update(id, { review: { ...record, verdict: rv.verdict, modelVerdict: rv.modelVerdict, counts: rv.counts, findings: rv.findings, url } });
console.log(o['dry-run'] ? body : `posted ${rv.verdict}: ${url}`);
