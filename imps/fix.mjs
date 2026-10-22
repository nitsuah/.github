#!/usr/bin/env node
// A fix round: a 9router imp answers review feedback and CI failures on its
// own open PR, so the paid hypervisor isn't woken for routine comments.
//
//   node fix.mjs <run-id> [--dry-run] [--max-rounds 2] [--slack 30]
//
// 1. Collect the PR's state with gh (no model): unresolved review threads, new
//    human comments, the imp reviewer's blocker/major findings, failing checks.
// 2. Filter the noise (bot summaries, skip/rate-limit notices, deploy previews,
//    confirmations, our own replies). Nothing left means no model runs. If
//    CodeRabbit's stale CHANGES_REQUESTED is the only blocker, CI is green and
//    every thread is resolved, comment `@coderabbitai approve` once.
// 3. Otherwise the imp decides fix / pushback / skip per item (FIX.md), in the
//    PR's own worktree, then the same gate runs with --slack extra lines.
// 4. Gate passes: push, reply on every thread, resolve the fixed and skipped
//    ones (pushback stays open for the reviewer). Gate fails: the worktree is
//    reset and the PR is labelled imp:needs-human.
// After --max-rounds rounds the PR is labelled imp:needs-human instead.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { feedbackItems, shouldAskCodeRabbitApprove, parseFixDecisions } from './lib.mjs';
import { HOME, rows, update, sh, git, runClaude, loadBrief } from './runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: o, positionals: [id] } = parseArgs({
    allowPositionals: true,
    options: {
        'dry-run': { type: 'boolean', default: false },
        'max-rounds': { type: 'string', default: '2' },
        slack: { type: 'string', default: '30' },
        minutes: { type: 'string', default: '20' },
    },
});
const dry = o['dry-run'];
const r = rows().find((x) => x.id === id);
if (!r?.pr) throw new Error(`run ${id} has no PR`);
const slug = r.pr.replace(/^https:\/\/github\.com\//, '').replace(/\/pull\/\d+$/, '');
const [owner, repo] = slug.split('/');
const number = Number(r.pr.match(/\/pull\/(\d+)/)[1]);
const ghJson = (args) => JSON.parse(sh('gh', args).out || 'null');
const say = (event, extra = {}) => console.log(JSON.stringify({ id, pr: r.pr, event, ...extra }));

// ── 1. collect ────────────────────────────────────────────────────────────
const pr = ghJson(['pr', 'view', String(number), '-R', slug, '--json', 'state,isDraft,mergeable,reviewDecision,headRefName,reviews']);
if (pr.state !== 'OPEN') {
    update(id, { outcome: pr.state.toLowerCase() });
    say('closed', { state: pr.state });
    process.exit(0);
}
const threads = ghJson(['api', 'graphql', '-f', `query={repository(owner:"${owner}",name:"${repo}"){pullRequest(number:${number}){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:20){nodes{databaseId author{login} body}}}}}}}`,
    '--jq', '.data.repository.pullRequest.reviewThreads.nodes'])
    .map((t) => ({ ...t, comments: t.comments.nodes.map((c) => ({ ...c, author: c.author?.login || '' })) }));
const comments = ghJson(['api', `repos/${slug}/issues/${number}/comments`, '--paginate', '--jq', '[.[]|{id, author: .user.login, body, createdAt: .created_at}]']) || [];
const checks = ghJson(['pr', 'checks', String(number), '-R', slug, '--json', 'name,state,link']) || [];
for (const c of checks.filter((x) => /FAILURE|ERROR/i.test(x.state) && /actions\/runs\/\d+/.test(x.link || ''))) {
    const run = c.link.match(/actions\/runs\/(\d+)/)[1];
    c.log = sh('gh', ['run', 'view', run, '-R', slug, '--log-failed']).out.split('\n').slice(-60).join('\n').slice(-3000);
}
const since = r.fixes?.length ? r.fixes[r.fixes.length - 1].at : r.gate?.at || null;
const items = feedbackItems({ threads, comments, checks, impReview: r.review, since });

// ── 2. nothing to do / stale CodeRabbit block / limits ───────────────────
const latestBy = {};
for (const rv of pr.reviews || []) latestBy[rv.author.login] = rv.state;
if (!items.length) {
    if (shouldAskCodeRabbitApprove({ reviewDecision: pr.reviewDecision, latestBy, threads, checks, askedAt: r.crApproveAskedAt })) {
        if (!dry) sh('gh', ['pr', 'comment', String(number), '-R', slug, '-b', '@coderabbitai approve']);
        if (!dry) update(id, { crApproveAskedAt: new Date().toISOString() });
        say('coderabbit-approve-asked');
        process.exit(0);
    }
    say('clean');
    process.exit(0);
}
const round = (r.fixes?.length || 0) + 1;
if (round > Number(o['max-rounds']) || pr.mergeable === 'CONFLICTING') {
    const why = pr.mergeable === 'CONFLICTING' ? 'merge conflict' : `${round - 1} fix rounds already`;
    if (!dry) {
        sh('gh', ['label', 'create', 'imp:needs-human', '-R', slug, '-c', 'd93f0b', '-d', 'An imp could not finish this; a human or the hypervisor should look', '--force']);
        sh('gh', ['pr', 'edit', String(number), '-R', slug, '--add-label', 'imp:needs-human']);
    }
    say('needs-human', { why, items: items.map((i) => i.id) });
    process.exit(0);
}
say('items', { round, items: items.map((i) => `${i.id} (${i.kind}, ${i.author})`) });
if (dry) process.exit(0);

// ── 3. the imp's round, in the PR's own worktree ─────────────────────────
// Others (a human, the hypervisor) may have pushed to the branch: fast-forward first.
sh('git', ['-C', r.worktree, 'fetch', '-q', 'origin', pr.headRefName]);
if (git(r.worktree, 'merge', '--ff-only', '-q', `origin/${pr.headRefName}`).code) throw new Error('worktree diverged from the PR branch; not touching it');
const before = git(r.worktree, 'rev-parse', 'HEAD').out;
const { meta: bm, prompt: base } = loadBrief(r.brief, r.worktree);
const list = items.map((i) => `### ${i.id} · ${i.kind} · ${i.author}${i.path ? ` · \`${i.path}${i.line ? `:${i.line}` : ''}\`` : ''}\n\n${i.text}`).join('\n\n');
const prompt = `${base}\n\n---\n\n${readFileSync(join(HERE, 'FIX.md'), 'utf8').replaceAll('<#PR>', `#${number}`)}\n\n## Feedback items (round ${round}, PR ${r.pr})\n\n${list}`;
const tools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git add:*)',
    'Bash(git commit:*)', 'Bash(git log:*)', 'Bash(git checkout -- :*)', ...[bm.test, bm.lint].filter(Boolean).map((c) => `Bash(${c})`)];
const metrics = await runClaude({
    cwd: r.worktree, prompt, model: r.model || 'MAX', tools, minutes: o.minutes, budget: 10,
    transcript: join(HOME, 'runs', `${id}.fix${round}.jsonl`),
});
const decisions = parseFixDecisions(metrics.finalText, items);
const committed = git(r.worktree, 'rev-parse', 'HEAD').out !== before;

// ── 4. gate, push, reply ─────────────────────────────────────────────────
let gatePass = true;
let reasons = [];
if (committed) {
    spawnSync(process.execPath, [join(HERE, 'imp.mjs'), 'gate', id, '--slack', o.slack], { stdio: 'inherit' });
    const g = rows().find((x) => x.id === id).gate;
    gatePass = !!g?.pass;
    reasons = g?.reasons || [];
}
const record = {
    at: new Date().toISOString(), round, items: items.map(({ id: iid, kind, author }) => ({ id: iid, kind, author })), decisions,
    committed, gate: committed ? { pass: gatePass, reasons } : null,
    metrics: { end: metrics.end, turns: metrics.turns, toolErrors: metrics.toolErrors, served: metrics.served, tokens: metrics.tokens, minutes: Number(((metrics.durationMs || 0) / 60000).toFixed(1)) },
};
if (committed && !gatePass) {
    git(r.worktree, 'reset', '-q', '--hard', before);
    sh('gh', ['label', 'create', 'imp:needs-human', '-R', slug, '-c', 'd93f0b', '-d', 'An imp could not finish this; a human or the hypervisor should look', '--force']);
    sh('gh', ['pr', 'edit', String(number), '-R', slug, '--add-label', 'imp:needs-human']);
    sh('gh', ['pr', 'comment', String(number), '-R', slug, '-b', `<!-- imp-fix -->\nFix round ${round} didn't pass the gate, so nothing was pushed:\n\n${reasons.map((x) => `- ${x}`).join('\n')}\n\nLabelled \`imp:needs-human\`.`]);
    update(id, (row) => ({ fixes: [...(row.fixes || []), { ...record, pushed: false }] }));
    say('gate-fail', { reasons });
    process.exit(1);
}
if (committed) {
    git(r.worktree, 'remote', 'set-url', '--push', 'origin', git(r.worktree, 'remote', 'get-url', 'origin').out);
    const push = git(r.worktree, 'push', '-q', 'origin', `HEAD:${pr.headRefName}`);
    git(r.worktree, 'remote', 'set-url', '--push', 'origin', 'no_push');
    if (push.code) throw new Error(`push failed: ${push.err}`);
}
const sha = git(r.worktree, 'rev-parse', '--short', 'HEAD').out;
const label = { fix: `Fixed in ${sha}`, pushback: 'Pushing back', skip: 'Not in this PR' };
for (const d of decisions) {
    const body = `<!-- imp-fix -->\n**${label[d.action]}:** ${d.reply}\n\n<sub>Fix round ${round} by an imp through 9router (run \`${id}\`).</sub>`;
    const it = items.find((x) => x.id === d.id);
    if (d.kind === 'thread') {
        sh('gh', ['api', `repos/${slug}/pulls/${number}/comments/${it.commentId}/replies`, '-f', `body=${body}`]);
        if (d.action !== 'pushback')
            sh('gh', ['api', 'graphql', '-f', `query=mutation{resolveReviewThread(input:{threadId:"${d.id}"}){thread{isResolved}}}`]);
    } else if (d.kind === 'comment' || d.kind === 'review') {
        sh('gh', ['pr', 'comment', String(number), '-R', slug, '-b', body.replace('**', `**${d.id}: `)]);
    }
}
update(id, (row) => ({
    fixes: [...(row.fixes || []), { ...record, pushed: committed }],
    ...(items.some((i) => i.kind === 'review') ? { review: { ...row.review, handled: true } } : {}),
}));
say('done', { round, committed, decisions: decisions.map((d) => `${d.id}:${d.action}`) });
