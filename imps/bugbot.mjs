#!/usr/bin/env node
// bugbot: the fallback PR reviewer for when CodeRabbit is rate-limited or silent.
//
//   node bugbot.mjs sweep  [--dry-run] [--max 2]        every open PR in the owner's repos
//   node bugbot.mjs review <owner/repo#n> [--dry-run] [--force]
//   node bugbot.mjs status <owner/repo#n>               print CodeRabbit state and the review gate
//
// Per PR, each sweep:
//   1. If CodeRabbit reviewed the head, or is still working on it, do nothing (it is the primary reviewer).
//   2. If it is stalled on the head (rate-limited, silent past the grace period, or absent) and bugbot has not
//      reviewed this head: one adversarial 9router review (BUGBOT.md, REVIEW.md's JSON). Findings become inline
//      review threads, like CodeRabbit's; a `bugbot` commit status records the verdict. Bugbot never edits code:
//      the imp fix round answers the threads on imp PRs, the hypervisor elsewhere.
//   3. If bugbot passed this head, every thread is resolved and checks are green, dismiss CodeRabbit's stale
//      CHANGES_REQUESTED through the API so it no longer blocks the merge.
// Kill switch: IMPS_BUGBOT=0. Events go to ~/.imps/bugbot.jsonl. Contract: imps/STANDARD.md § Bugbot.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseReview } from './lib.mjs';
import { evaluateChecks } from './checks.mjs';
import { DEFAULTS } from './defaults.mjs';
import { HOME, sh, chat } from './runner.mjs';
import {
    BUGBOT_DEFAULTS, STATUS_CONTEXT, codeRabbitStatus, bugbotVerdictFor, buildBugbotReview, shouldDismissCodeRabbit,
    reviewGate, sweepCandidates, reviewsInLastDay, isCodeRabbit, THREAD_MARK, threadsAwaitingBugbot, parseThreadJudgement,
} from './bugbot-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HOME, 'bugbot.jsonl');
const { values: o, positionals: [cmd = 'sweep', target] } = parseArgs({
    allowPositionals: true,
    options: {
        'dry-run': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        max: { type: 'string' },
        model: { type: 'string', default: 'MAX' },
    },
});

const cfg = (() => {
    try {
        return JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8')).bugbot || {};
    } catch {
        return {};
    }
})();
const C = { ...BUGBOT_DEFAULTS, ...cfg };
const owner = (() => {
    try {
        return JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8')).owner || DEFAULTS.owner || 'nitsuah';
    } catch {
        return DEFAULTS.owner || 'nitsuah';
    }
})();

const log = (e) => {
    const line = { at: new Date().toISOString(), ...e };
    try {
        appendFileSync(LOG, JSON.stringify(line) + '\n');
    } catch { /* logging is best effort */ }
    console.log(JSON.stringify(line));
};
const events = () => {
    if (!existsSync(LOG)) return [];
    return readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => {
        try {
            return JSON.parse(l);
        } catch {
            return null;
        }
    }).filter(Boolean);
};
const gh = (args, opts) => sh('gh', args, opts);
const ghJson = (args) => {
    const r = gh(args);
    if (r.code) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${r.err.slice(0, 200)}`);
    return JSON.parse(r.out || 'null');
};

const PR_QUERY = `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){
  url number title body state isDraft reviewDecision author{login} labels(first:20){nodes{name}}
  closingIssuesReferences(first:3){nodes{number title body}}
  commits(last:1){nodes{commit{oid committedDate statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{
    __typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}
  reviews(last:100){nodes{databaseId author{login} state submittedAt body url commit{oid}}}
  comments(last:100){nodes{author{login} createdAt body}}
  reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved isOutdated path line comments(first:30){nodes{author{login} body createdAt}}}}
}}}`;

/** Everything bugbot decides on, for one PR. */
function loadPr(slug, number) {
    const [own, repo] = slug.split('/');
    const d = ghJson(['api', 'graphql', '-f', `query=${PR_QUERY}`, '-F', `owner=${own}`, '-F', `repo=${repo}`, '-F', `n=${number}`]).data.repository.pullRequest;
    const head = d.commits.nodes[0]?.commit || {};
    const checks = (head.statusCheckRollup?.contexts?.nodes || []).map((c) => c.__typename === 'CheckRun'
        ? { name: c.name, state: c.status === 'COMPLETED' ? c.conclusion : c.status }
        : { name: c.context, state: c.state });
    const reviews = d.reviews.nodes.map((r) => ({ id: r.databaseId, author: r.author?.login || '', state: r.state, submittedAt: r.submittedAt, body: r.body, url: r.url, commit: r.commit?.oid }));
    const comments = d.comments.nodes.map((c) => ({ author: c.author?.login || '', createdAt: c.createdAt, body: c.body }));
    const threads = d.reviewThreads.nodes.map((t) => ({ ...t, comments: t.comments.nodes.map((c) => ({ author: c.author?.login || '', body: c.body, createdAt: c.createdAt })) }));
    // Fail closed past one page: an unseen check could be red and an unseen thread could be open.
    const moreThreads = Boolean(d.reviewThreads.pageInfo?.hasNextPage);
    const moreChecks = Boolean(head.statusCheckRollup?.contexts?.pageInfo?.hasNextPage);
    const openThreads = threads.filter((t) => !t.isResolved && !t.isOutdated).length + (moreThreads ? 1 : 0);
    // Our own status and CodeRabbit's check do not decide "green": a stalled CodeRabbit must not hold the gate.
    const gateChecks = checks.filter((c) => c.name !== STATUS_CONTEXT && !/coderabbit/i.test(c.name || ''));
    let crLatestState = null;
    for (const r of [...reviews].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)))
        if (isCodeRabbit(r.author) && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) crLatestState = r.state;
    return {
        slug, number, url: d.url, title: d.title, body: d.body || '', state: d.state, isDraft: d.isDraft, labels: d.labels.nodes,
        issues: d.closingIssuesReferences.nodes, headSha: head.oid, headAt: head.committedDate, checks, reviews, comments, threads, openThreads,
        checksGreen: !moreChecks && evaluateChecks(gateChecks).green, crLatestState, hasBugbotStatus: checks.some((c) => c.name === STATUS_CONTEXT),
        crApprovedHead: reviews.some((r) => isCodeRabbit(r.author) && r.state === 'APPROVED' && r.commit === head.oid),
    };
}

function assess(pr) {
    const crStatus = codeRabbitStatus({ headSha: pr.headSha, headAt: pr.headAt, reviews: pr.reviews, comments: pr.comments, checks: pr.checks, graceMinutes: C.graceMinutes, pendingMaxMinutes: C.pendingMaxMinutes });
    const bugbot = bugbotVerdictFor(pr.reviews, pr.headSha, { trustedAuthors: trustedAuthors() });
    const gate = reviewGate({ crApprovedHead: pr.crApprovedHead, crStatus, bugbot, openThreads: pr.openThreads, checksGreen: pr.checksGreen });
    const dismiss = shouldDismissCodeRabbit({ crLatestState: pr.crLatestState, crStatus, bugbot, openThreads: pr.openThreads, checksGreen: pr.checksGreen });
    return { crStatus, bugbot, gate, dismiss };
}

const MAX_DIFF = 60_000;

/** Who may write bugbot markers: the gh account bugbot posts as, plus any configured extra. */
let trusted = null;
function trustedAuthors() {
    if (trusted) return trusted;
    const me = gh(['api', 'user', '--jq', '.login']);
    trusted = [...(me.code ? [] : [me.out.trim()]), ...(C.trustedAuthors || [])].filter(Boolean);
    return trusted;
}

const statusDescription = (verdict, partial) => (partial ? 'Diff too large for a complete fallback review'
    : verdict === 'request_changes' ? 'Changes needed (fallback review)' : 'Passed fallback review');

function writeStatus(pr, state, description, url) {
    const res = gh(['api', `repos/${pr.slug}/statuses/${pr.headSha}`, '-X', 'POST', '-f', `state=${state}`, '-f', `context=${STATUS_CONTEXT}`,
        '-f', `description=${description}`, ...(url ? ['-f', `target_url=${url}`] : [])]);
    if (res.code) log({ event: 'bugbot-error', pr: pr.url, sha: pr.headSha, error: `status write failed: ${res.err.slice(0, 200)}` });
    return !res.code;
}

async function runReview(pr, reason) {
    const d = gh(['pr', 'diff', String(pr.number), '-R', pr.slug]);
    if (d.code || !d.out.trim()) {
        // No diff, no verdict: an empty prompt would "approve" code nobody read.
        log({ event: 'bugbot-error', pr: pr.url, sha: pr.headSha, error: `diff unavailable: ${(d.err || 'empty diff').slice(0, 200)}` });
        return null;
    }
    const fullDiff = d.out;
    const partial = fullDiff.length > MAX_DIFF;
    const diff = partial ? fullDiff.slice(0, MAX_DIFF) + '\n… (diff truncated)' : fullDiff;
    const issues = pr.issues.map((i) => `### Issue #${i.number}: ${i.title}\n\n${(i.body || '').slice(0, 4000)}`).join('\n\n') || '(no linked issue)';
    const prompt = [
        readFileSync(join(HERE, 'BUGBOT.md'), 'utf8'),
        `---\n\n## PR ${pr.slug}#${pr.number}: ${pr.title}\n\n${pr.body.slice(0, 6000)}`,
        `## Linked issues (background)\n\n${issues}`,
        `## The diff (head ${pr.headSha})\n\n\`\`\`diff\n${diff}\n\`\`\``,
    ].join('\n\n');
    const RETRY = `\n\n**Your previous answer ended without the \`json\` block. Output only that block, nothing before it.**`;
    let metrics;
    let rv;
    for (const [maxTokens, extra] of [[6000, ''], [16000, RETRY]]) {
        metrics = await chat({ model: o.model, maxTokens, minutes: 8, prompt: prompt + extra });
        rv = parseReview(metrics.finalText);
        if (!rv.error) break;
    }
    if (rv.error) {
        log({ event: 'bugbot-error', pr: pr.url, sha: pr.headSha, error: rv.error, end: metrics.end, detail: metrics.error ? String(metrics.error).slice(0, 200) : undefined });
        return null;
    }
    const payload = buildBugbotReview(rv, { diff: fullDiff, headSha: pr.headSha, reason, model: o.model, served: metrics.served, partial });
    let url = null;
    if (!o['dry-run']) {
        const post = (comments) => gh(['api', `repos/${pr.slug}/pulls/${pr.number}/reviews`, '-X', 'POST', '--input', '-', '--jq', '.html_url'], {
            input: JSON.stringify({ commit_id: pr.headSha, event: 'COMMENT', body: payload.body, comments }),
        });
        let res = post(payload.comments);
        if (res.code && payload.comments.length) {
            // GitHub refuses the whole review if one line is off the diff; fall back to a summary-only review.
            // Keep each finding whole (evidence and fix), minus the thread marker.
            const listed = payload.comments.map((c) => `#### \`${c.path}:${c.line}\`\n\n${c.body.split(THREAD_MARK).join('').trim()}`).join('\n\n');
            payload.body += `\n\n**Inline findings (GitHub refused the line anchors):**\n\n${listed}`;
            res = post([]);
        }
        if (res.code) {
            log({ event: 'bugbot-error', pr: pr.url, sha: pr.headSha, error: `post failed: ${res.err.slice(0, 200)}` });
            return null;
        }
        url = res.out;
        // A failed write is retried by the next sweep from the posted review (handle → restore status).
        writeStatus(pr, payload.statusState, statusDescription(rv.verdict, partial), url);
    } else {
        console.log(payload.body);
        for (const c of payload.comments) console.log(`  inline ${c.path}:${c.line} ${c.body.split('\n')[0]}`);
    }
    log({ event: 'bugbot-review', pr: pr.url, sha: pr.headSha, reason, verdict: rv.verdict, partial: partial || undefined, counts: rv.counts, inline: payload.comments.length, url, served: metrics.served, tokens: metrics.tokens, dryRun: o['dry-run'] || undefined });
    return { verdict: rv.verdict, url };
}

const JUDGE = `You are bugbot. Earlier you raised the review finding below on a pull request. Someone has since replied: a fix ("Fixed in <sha>"), a pushback with evidence, or a "not in this PR". Decide whether the thread can be resolved.

- **accept**: the reply shows the finding was wrong, or the current diff (below) shows it is fixed, or it is reasonably out of scope and the reply says where it will be handled.
- **keep**: the reply does not answer the finding, the claimed fix is not in the current diff, or the evidence does not hold.

Be fair: you were wrong sometimes, and a correct pushback should be accepted. Do not keep a thread just to be safe. Reply in one or two sentences.

Finish with exactly one fenced json block: {"decision":"accept|keep","reply":"..."}`;

/** Answer replies on bugbot's own threads: resolve the ones whose reply holds, keep the rest open. */
async function answerThreads(pr, budget) {
    const waiting = threadsAwaitingBugbot(pr.threads);
    if (!waiting.length) return 0;
    const fullDiff = gh(['pr', 'diff', String(pr.number), '-R', pr.slug]).out;
    let answered = 0;
    for (const t of waiting) {
        if (budget.left <= 0) break;
        budget.left--;
        // Only the current diff of the thread's file: the judge checks "Fixed in …" against the code as it is now.
        const fileDiff = (fullDiff.split(/^(?=diff --git )/m).find((part) => part.includes(` b/${t.path}\n`)) || '(this file is no longer in the diff)').slice(0, 20_000);
        const conversation = t.comments.map((c) => `**${c.author}:** ${stripComments(c.body)}`).join('\n\n');
        const metrics = await chat({ model: o.model, maxTokens: 3000, minutes: 6, prompt: `${JUDGE}\n\n## The thread (${t.path}:${t.line ?? '?'})\n\n${conversation}\n\n## The current diff of ${t.path}\n\n\`\`\`diff\n${fileDiff}\n\`\`\`` });
        const j = parseThreadJudgement(metrics.finalText);
        if (j.error) {
            log({ event: 'bugbot-error', pr: pr.url, thread: t.id, error: `judgement: ${j.error}`, end: metrics.end, detail: metrics.error ? String(metrics.error).slice(0, 200) : undefined });
            continue;
        }
        if (!o['dry-run']) {
            const body = `${THREAD_MARK}\n${j.decision === 'accept' ? '**Resolved:**' : '**Still open:**'} ${j.reply}\n\n<sub>bugbot</sub>`;
            gh(['api', 'graphql', '-f', 'query=mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}', '-f', `t=${t.id}`, '-f', `b=${body}`]);
            if (j.decision === 'accept') gh(['api', 'graphql', '-f', 'query=mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}', '-f', `t=${t.id}`]);
        }
        log({ event: 'bugbot-thread', pr: pr.url, thread: t.id, path: t.path, decision: j.decision, served: metrics.served, tokens: metrics.tokens, dryRun: o['dry-run'] || undefined });
        answered++;
    }
    return answered;
}

/** HTML comments out (repeated until stable, then any stray opener or closer), for prompt text. */
function stripComments(text = '') {
    let out = String(text);
    let prev;
    do {
        prev = out;
        out = out.replace(/<!--[\s\S]*?-->/g, '');
    } while (out !== prev);
    return out.replace(/<!--|-->/g, '').trim();
}

/**
 * Dismiss only the CodeRabbit reviews the assessment saw: CHANGES_REQUESTED on an older commit. Each one is
 * re-read first, so a review CodeRabbit submits after the snapshot (it came back) is never touched.
 */
function dismissCodeRabbit(pr, why) {
    const snapshot = pr.reviews.filter((r) => isCodeRabbit(r.author) && r.state === 'CHANGES_REQUESTED' && r.commit !== pr.headSha && r.id);
    for (const s of snapshot) {
        const r = ghJson(['api', `repos/${pr.slug}/pulls/${pr.number}/reviews/${s.id}`]);
        if (!r || r.state !== 'CHANGES_REQUESTED' || r.commit_id === pr.headSha) continue;
        if (o['dry-run']) {
            console.log(`would dismiss CodeRabbit review ${r.id}`);
            continue;
        }
        const res = gh(['api', '-X', 'PUT', `repos/${pr.slug}/pulls/${pr.number}/reviews/${r.id}/dismissals`, '-f', 'event=DISMISS',
            '-f', `message=CodeRabbit could not review the head (${why}). Bugbot reviewed it instead, every thread is resolved and checks are green.`]);
        log({ event: res.code ? 'bugbot-dismiss-error' : 'bugbot-dismiss', pr: pr.url, sha: pr.headSha, review: r.id, error: res.code ? res.err.slice(0, 200) : undefined });
    }
}

/** One PR: review if CodeRabbit is stalled on the head, then lift its block if our gate passed. */
async function handle(slug, number, { force = false, budget = { left: Infinity } } = {}) {
    let pr = loadPr(slug, number);
    if (pr.state !== 'OPEN' || pr.isDraft) return { pr: pr.url, action: 'none', reason: pr.isDraft ? 'draft' : pr.state.toLowerCase() };
    // Replies on our own threads first: they unblock a PR sooner than a new review does.
    if (await answerThreads(pr, budget) && !o['dry-run']) pr = loadPr(slug, number);
    let a = assess(pr);
    // A bugbot review whose status write failed: restore the status from the review instead of reviewing again.
    if (a.bugbot && !pr.hasBugbotStatus && !o['dry-run']) {
        const failing = a.bugbot.verdict === 'request_changes' || a.bugbot.scope === 'partial';
        if (writeStatus(pr, failing ? 'failure' : 'success', statusDescription(a.bugbot.verdict, a.bugbot.scope === 'partial'), a.bugbot.url))
            log({ event: 'bugbot-status-restored', pr: pr.url, sha: pr.headSha });
    }
    if (!a.bugbot && (a.crStatus.stalled || force)) {
        if (reviewsInLastDay(events(), pr.url) >= C.perPrPerDay) {
            log({ event: 'bugbot-skip', pr: pr.url, sha: pr.headSha, reason: `per-PR cap (${C.perPrPerDay}/day)` });
            return { pr: pr.url, action: 'capped' };
        }
        if (budget.left <= 0) return { pr: pr.url, action: 'deferred', reason: 'sweep budget used' };
        budget.left--;
        const done = await runReview(pr, force && !a.crStatus.stalled ? 'forced' : a.crStatus.state);
        if (!done) return { pr: pr.url, action: 'review-failed' };
        if (o['dry-run']) return { pr: pr.url, action: 'reviewed', verdict: done.verdict };
        a = assess(loadPr(slug, number));
    }
    if (a.dismiss.ok) {
        dismissCodeRabbit(pr, a.crStatus.state);
        return { pr: pr.url, action: 'dismissed-coderabbit', gate: a.gate };
    }
    return { pr: pr.url, action: a.bugbot ? 'reviewed' : 'wait', coderabbit: a.crStatus.state, gate: a.gate };
}

function parseTarget(t = '') {
    const m = String(t).match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)$/);
    if (!m) throw new Error(`target must be owner/repo#n or a PR URL, got "${t}"`);
    return [m[1], Number(m[2])];
}

async function main() {
    if (process.env.IMPS_BUGBOT === '0') {
        console.log('bugbot disabled (IMPS_BUGBOT=0)');
        // `status` promises exit 0 only when the gate passes; an unassessed PR must not read as passed.
        if (cmd === 'status') process.exit(3);
        return;
    }
    if (cmd === 'status') {
        const [slug, n] = parseTarget(target);
        const pr = loadPr(slug, n);
        const a = assess(pr);
        console.log(JSON.stringify({ pr: pr.url, head: pr.headSha, coderabbit: a.crStatus, bugbot: a.bugbot, openThreads: pr.openThreads, checksGreen: pr.checksGreen, gate: a.gate, dismissCodeRabbit: a.dismiss }, null, 2));
        process.exit(a.gate.ok ? 0 : 3);
    }
    if (cmd === 'review') {
        const [slug, n] = parseTarget(target);
        console.log(JSON.stringify(await handle(slug, n, { force: o.force })));
        return;
    }
    if (cmd !== 'sweep') throw new Error(`unknown command ${cmd}`);
    const prs = sweepCandidates(ghJson(['search', 'prs', '--owner', owner, '--state', 'open', '--limit', '100',
        '--json', 'number,repository,author,labels,isDraft,url']), { skipRepos: C.skipRepos, skipLabel: C.skipLabel });
    const budget = { left: Number(o.max ?? C.maxPerSweep) };
    const results = [];
    for (const p of prs) {
        try {
            results.push(await handle(`${owner}/${p.repository.name}`, p.number, { budget }));
        } catch (e) {
            log({ event: 'bugbot-error', pr: p.url, error: String(e.message).slice(0, 200) });
        }
    }
    const acted = results.filter((r) => !['wait', 'none', 'reviewed'].includes(r.action));
    console.log(`bugbot sweep: ${prs.length} PR(s), ${acted.length} acted${acted.length ? `: ${acted.map((r) => `${r.pr} ${r.action}`).join('; ')}` : ''}`);
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
