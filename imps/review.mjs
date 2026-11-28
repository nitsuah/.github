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
import { parseReview, renderReview, agentNotes } from './lib.mjs';
import { HOME, rows, update, sh, git, runClaude, chat } from './runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: o, positionals: [id] } = parseArgs({
    allowPositionals: true,
    options: {
        model: { type: 'string', default: 'MAX' },
        minutes: { type: 'string', default: '12' },
        'dry-run': { type: 'boolean', default: false },
        mode: { type: 'string', default: 'chat' }, // chat = one completion (cheap); agent = read-only claude -p session
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
    // The brief comes first and is labelled as the scope: the issue body is often an older brief, and the
    // reviewer used to block PRs for following a corrected brief (vhs#192, 2026-11-19).
    `---\n\n## The brief the imp was given (this is the scope)\n\n${brief.slice(0, 8000)}`,
    `## Issue ${slug}#${r.issue}: ${issue.title || ''} (background; the brief above wins where they differ)\n\n${(issue.body || '').slice(0, 6000)}`,
    `## The PR diff (${r.pr})\n\n\`\`\`\n${stat}\n\`\`\`\n\n\`\`\`diff\n${diff}\n\`\`\``,
].join('\n\n');

console.log(`reviewing ${r.pr} (${id})`);
const transcript = join(HOME, 'runs', `${id}.review.jsonl`);
// A model sometimes ends without the JSON block (vhs#91, 2026-10-22). One
// retry; the second attempt is reminded up front.
let metrics;
let rv;
let mode = o.mode;
const CHAT_ONLY = `**You cannot read other files in this mode: judge the diff and the context above only, and do not report a file as missing because you cannot see it. Keep the reasoning short and end with the required \`json\` block.**`;

function combineMetrics(earlier, later) {
    if (!earlier) return later;
    const keys = ['input', 'output', 'cacheRead', 'cacheWrite'];
    return {
        ...later,
        turns: (earlier.turns || 0) + (later.turns || 0),
        durationMs: (earlier.durationMs || 0) + (later.durationMs || 0),
        served: [...new Set([...(earlier.served || []), ...(later.served || [])])],
        toolErrors: (earlier.toolErrors || 0) + (later.toolErrors || 0),
        tokens: Object.fromEntries(keys.map((key) => [key, (earlier.tokens?.[key] || 0) + (later.tokens?.[key] || 0)])),
    };
}
if (mode === 'chat') {
    // The whole diff and brief are in the prompt, so one completion is enough.
    // A reasoning model can spend the default output budget before it reaches
    // the JSON block, so a miss gets one more completion with more room and a
    // terser ask before the (much costlier) agent session.
    const RETRY = `\n\n**Your previous answer ended without the \`json\` block. Output only that block, nothing before it.**`;
    for (const [maxTokens, extra] of [[6000, ''], [16000, RETRY]]) {
        const previous = metrics;
        metrics = await chat({ model: o.model, minutes: o.minutes, maxTokens, prompt: `${prompt}

${CHAT_ONLY}${extra}` });
        metrics = combineMetrics(previous, metrics);
        rv = parseReview(metrics.finalText);
        if (!rv.error) break;
        console.log(`chat review unusable (${rv.error}, ${metrics.end}, maxTokens ${maxTokens})`);
    }
    if (rv.error) mode = 'agent';
}
if (mode === 'agent') {
    const previous = metrics;
    metrics = await runClaude({
        cwd: r.worktree, model: o.model, tools: ['Read', 'Glob', 'Grep'], deny: ['Edit', 'Write'],
        prompt, minutes: o.minutes, budget: 10, maxTurns: 25, permissionMode: 'default', transcript,
    });
    metrics = combineMetrics(previous, metrics);
    rv = parseReview(metrics.finalText);
    if (rv.error) {
        // A second 25-turn session explored the same files again and ran out the
        // same way (vhs#181, 2026-11-19). Instead, hand what the agent concluded
        // to one tool-less completion that only has to write the verdict.
        console.log(`agent review: ${rv.error} (${metrics.end}); salvaging with one completion`);
        const notes = agentNotes(transcript, metrics.finalText) || '(the agent left no notes)';
        const beforeSalvage = metrics;
        metrics = await chat({
            model: o.model, minutes: o.minutes, maxTokens: 16000,
            prompt: `${prompt}

## A reviewer's notes so far

${notes}

${CHAT_ONLY}

**Write the final review now from the diff and these notes. Output only the \`json\` block.**`,
        });
        metrics = combineMetrics(beforeSalvage, metrics);
        rv = parseReview(metrics.finalText);
        if (!rv.error) mode = 'agent+salvage';
    }
}
const minutes = metrics.durationMs ? (metrics.durationMs / 60000).toFixed(1) : null;
const record = {
    at: new Date().toISOString(), mode, model: o.model, transcript, end: metrics.end, turns: metrics.turns, minutes: Number(minutes),
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
if (!o['dry-run']) update(id, { review: { ...record, verdict: rv.verdict, modelVerdict: rv.modelVerdict, counts: rv.counts, findings: rv.findings, url } });
console.log(o['dry-run'] ? body : `posted ${rv.verdict}: ${url}`);
