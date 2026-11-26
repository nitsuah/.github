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
import { outcomeFromPr, feedbackItems, shouldAskCodeRabbitApprove, parseFixDecisions, latestDecisiveReviews, shouldResolveFixDecision, parseBriefAuthors, fixRoundProgress, feedbackCutoff } from './lib.mjs';
import { HOME, rows, update, sh, git, runClaude, loadBrief, IMP_TOOLS, applyRiskLabel } from './runner.mjs';
import { prRisk, dropStaleAck } from './checks.mjs';

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
    update(id, (row) => ({ outcome: row.outcome === 'closed-duplicate' ? row.outcome : outcomeFromPr({ state: pr.state }) }));
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
const items = feedbackItems({ threads, comments, checks, impReview: r.review, since, allowedAuthors: parseBriefAuthors(process.env.IMPS_BRIEF_AUTHORS) });

// ── 2. nothing to do / stale CodeRabbit block / limits ───────────────────
const latestBy = latestDecisiveReviews(pr.reviews);
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
const tools = IMP_TOOLS;
const metrics = await runClaude({
    cwd: r.worktree, prompt, model: r.model || 'MAX', tools, minutes: o.minutes, budget: 10, maxTurns: 25,
    transcript: join(HOME, 'runs', `${id}.fix${round}.jsonl`),
});
const decisions = parseFixDecisions(metrics.finalText, items);
const committed = git(r.worktree, 'rev-parse', 'HEAD').out !== before;

const record = {
    at: new Date().toISOString(), round, items: items.map(({ id: iid, kind, author }) => ({ id: iid, kind, author })), decisions,
    committed, gate: null,
    metrics: { end: metrics.end, turns: metrics.turns, toolErrors: metrics.toolErrors, served: metrics.served, tokens: metrics.tokens, minutes: Number(((metrics.durationMs || 0) / 60000).toFixed(1)) },
};
const progress = fixRoundProgress(items, decisions);
const noThreadProgress = progress.hasThreads && progress.addressedThreads === 0;
const unanswered = progress.unanswered.length > 0;
if (noThreadProgress || unanswered) {
    let rollbackFailure = null;
    if (committed) {
        const rollback = git(r.worktree, 'reset', '-q', '--hard', before);
        if (rollback.code) rollbackFailure = (rollback.err || 'git reset failed').trim();
    }
    const reason = noThreadProgress
        ? 'Fix round addressed zero review threads; CI-only fixes do not count as thread progress'
        : `Fix round left feedback decisions unanswered: ${progress.unanswered.join(', ')}`;
    record.at = feedbackCutoff({ previousSince: since, failed: true, completedAt: record.at });
    if (!dry) {
        sh('gh', ['label', 'create', 'imp:failed', '-R', slug, '-c', 'b60205', '-d', 'The imp did not pass the gate; needs a new brief or a human', '--force']);
        const labelResult = sh('gh', ['pr', 'edit', String(number), '-R', slug, '--add-label', 'imp:failed']);
        const labelNote = labelResult.code === 0 ? 'Labelled `imp:failed`.' : `Failed to apply `imp:failed` label: ${labelResult.err || 'unknown GitHub CLI error'}.`;
        sh('gh', ['pr', 'comment', String(number), '-R', slug, '-b', `<!-- imp-fix -->\nFix round ${round} failed: ${reason}.${rollbackFailure ? ` Rollback also failed: ${rollbackFailure}.` : ''}\n\n${labelNote}`]);
    }
    update(id, (row) => ({ fixes: [...(row.fixes || []), { ...record, failure: reason, rollbackFailure, pushed: false }] }));
    say('gate-fail', { reasons: [reason] });
    process.exit(1);
}

// ── 4. gate, push, reply ─────────────────────────────────────────────────
let gatePass = true;
let reasons = [];
if (committed) {
    spawnSync(process.execPath, [join(HERE, 'imp.mjs'), 'gate', id, '--slack', o.slack], { stdio: 'inherit', windowsHide: true });
    const g = rows().find((x) => x.id === id).gate;
    gatePass = !!g?.pass;
    reasons = g?.reasons || [];
}
record.gate = committed ? { pass: gatePass, reasons } : null;
if (committed && !gatePass) {
    const rollback = git(r.worktree, 'reset', '-q', '--hard', before);
    const rollbackFailure = rollback.code ? (rollback.err || 'git reset failed').trim() : null;
    record.at = feedbackCutoff({ previousSince: since, failed: true, completedAt: record.at });
    sh('gh', ['label', 'create', 'imp:needs-human', '-R', slug, '-c', 'd93f0b', '-d', 'An imp could not finish this; a human or the hypervisor should look', '--force']);
    const labelResult = sh('gh', ['pr', 'edit', String(number), '-R', slug, '--add-label', 'imp:needs-human']);
    const labelNote = labelResult.code === 0 ? 'Labelled `imp:needs-human`.' : `Failed to apply `imp:needs-human` label: ${labelResult.err || 'unknown GitHub CLI error'}.`;
    sh('gh', ['pr', 'comment', String(number), '-R', slug, '-b', `<!-- imp-fix -->\nFix round ${round} didn't pass the gate, so nothing was pushed:\n\n${reasons.map((x) => `- ${x}`).join('\n')}${rollbackFailure ? `\nRollback also failed: ${rollbackFailure}.` : ''}\n\n${labelNote}`]);
    update(id, (row) => ({ fixes: [...(row.fixes || []), { ...record, rollbackFailure, pushed: false }] }));
    say('gate-fail', { reasons });
    process.exit(1);
}
if (committed) {
    // Re-class and drop any acknowledgement before the new commit is published.
    const live = sh('gh', ['pr', 'view', String(number), '-R', slug, '--json', 'labels']);
    if (live.code) throw new Error(`could not read the PR's labels, so nothing is pushed: ${live.err}`);
    const { labels } = JSON.parse(live.out);
    dropStaleAck(slug, number, labels, { run: (args) => sh('gh', args) });
    // Live labels count, so a class someone raised by hand is never written back lower.
    const level = prRisk({
        paths: git(r.worktree, 'diff', '--name-only', '--no-renames', `${r.baseSha}..HEAD`).out.split('\n').filter(Boolean),
        recorded: rows().find((x) => x.id === id).risk, labels,
    });
    update(id, { risk: level });
    applyRiskLabel(r.pr, slug, level);
    git(r.worktree, 'remote', 'set-url', '--push', 'origin', git(r.worktree, 'remote', 'get-url', 'origin').out);
    const push = git(r.worktree, 'push', '-q', 'origin', `HEAD:${pr.headRefName}`);
    git(r.worktree, 'remote', 'set-url', '--push', 'origin', 'no_push');
    if (push.code) throw new Error(`push failed: ${push.err}`);
}
const sha = git(r.worktree, 'rev-parse', '--short', 'HEAD').out;
const label = { fix: `Fixed in ${sha}`, pushback: 'Pushing back', skip: 'Not in this PR' };
for (const d of decisions) {
    const body = `<!-- imp-fix -->\n**${label[d.action] ?? 'Skipped'}:** ${d.reply}\n\n<sub>Fix round ${round} by an imp through 9router (run \`${id}\`).</sub>`;
    const it = items.find((x) => x.id === d.id);
    if (d.kind === 'thread') {
        sh('gh', ['api', `repos/${slug}/pulls/${number}/comments/${it.commentId}/replies`, '-f', `body=${body}`]);
        if (shouldResolveFixDecision(d))
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
