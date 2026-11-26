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
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseReview, maxRisk } from './lib.mjs';
import { evaluateChecks, prRisk, fetchPrPaths, fetchAckEvents, ownerAcknowledged, riskMergeGate } from './checks.mjs';
import { DEFAULTS } from './defaults.mjs';
import { HOME, sh, chat, rows } from './runner.mjs';
import {
    BUGBOT_DEFAULTS, STATUS_CONTEXT, codeRabbitStatus, bugbotVerdictFor, buildBugbotReview, shouldDismissCodeRabbit,
    reviewGate, sweepCandidates, reviewsInLastDay, isCodeRabbit, THREAD_MARK, threadsAwaitingBugbot, parseThreadJudgement,
    ACCEPTED_MARK, acceptedButOpen, headArrival, canClearVerdict, APPROVE_ASK_MARK, shouldAskCodeRabbitApproval,
    latestPassedVerdict, ownChanges, sameOwnChanges, excerptLines, citedLocations, decodeContents,
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
  url number title body state isDraft reviewDecision baseRefName author{login} labels(first:20){nodes{name}}
  closingIssuesReferences(first:3){nodes{number title body}}
  commits(last:1){nodes{commit{oid committedDate statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{
    __typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}
  reviews(last:100){nodes{databaseId author{login} state submittedAt body url commit{oid}}}
  comments(last:100){pageInfo{hasPreviousPage} nodes{author{login} createdAt body}}
  reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved isOutdated path line originalLine
    first: comments(first:1){nodes{id author{login} body createdAt originalCommit{oid}}}
    latest: comments(last:30){nodes{id author{login} body createdAt originalCommit{oid}}}}}
}}}`;

/** When bugbot first saw each PR head (GitHub has no push time). Kept in ~/.imps/bugbot-heads.json. */
const HEADS = join(HOME, 'bugbot-heads.json');
function firstSeen(prUrl, sha) {
    let seen = {};
    try {
        seen = JSON.parse(readFileSync(HEADS, 'utf8'));
    } catch { /* first run */ }
    const key = `${prUrl}@${sha}`;
    if (!seen[key]) {
        seen[key] = new Date().toISOString();
        // Keep the file small: drop sightings older than two weeks.
        const cutoff = Date.now() - 14 * 24 * 3600_000;
        for (const [k, v] of Object.entries(seen)) if (Date.parse(v) < cutoff) delete seen[k];
        try {
            writeFileSync(HEADS, JSON.stringify(seen));
        } catch { /* best effort; the commit date is the fallback */ }
    }
    return seen[key];
}

/** Everything bugbot decides on, for one PR. */
function loadPr(slug, number) {
    const [own, repo] = slug.split('/');
    const d = ghJson(['api', 'graphql', '-f', `query=${PR_QUERY}`, '-F', `owner=${own}`, '-F', `repo=${repo}`, '-F', `n=${number}`]).data.repository.pullRequest;
    const head = d.commits.nodes[0]?.commit || {};
    const checks = (head.statusCheckRollup?.contexts?.nodes || []).map((c) => c.__typename === 'CheckRun'
        ? { name: c.name, state: c.status === 'COMPLETED' ? c.conclusion : c.status }
        : { name: c.context, state: c.state });
    const reviews = d.reviews.nodes.map((r) => ({ id: r.databaseId, author: r.author?.login || '', state: r.state, submittedAt: r.submittedAt, body: r.body, url: r.url, commit: r.commit?.oid }));
    // Fail closed: a response without pageInfo cannot prove the history is complete.
    const commentsComplete = d.comments.pageInfo ? !d.comments.pageInfo.hasPreviousPage : false;
    const comments = d.comments.nodes.map((c) => ({ author: c.author?.login || '', createdAt: c.createdAt, body: c.body }));
    // The original finding plus the latest replies (a long thread's newest word is what bugbot must read).
    const toComment = (c) => ({ id: c.id, author: c.author?.login || '', body: c.body, createdAt: c.createdAt, originalCommit: c.originalCommit?.oid });
    const threads = d.reviewThreads.nodes.map(({ first, latest, ...t }) => {
        const head0 = first.nodes[0];
        const rest = latest.nodes.filter((c) => !head0 || c.id !== head0.id);
        return { ...t, comments: [...(head0 ? [head0] : []), ...rest].map(toComment) };
    });
    // Fail closed past one page: an unseen check could be red and an unseen thread could be open.
    const moreThreads = Boolean(d.reviewThreads.pageInfo?.hasNextPage);
    const moreChecks = Boolean(head.statusCheckRollup?.contexts?.pageInfo?.hasNextPage);
    // Outdated is not resolved: a thread on changed lines still needs an answer.
    const openThreads = threads.filter((t) => !t.isResolved).length + (moreThreads ? 1 : 0);
    // Our own status and CodeRabbit's check do not decide "green": a stalled CodeRabbit must not hold the gate.
    const gateChecks = checks.filter((c) => c.name !== STATUS_CONTEXT && !/coderabbit/i.test(c.name || ''));
    let crLatestState = null;
    for (const r of [...reviews].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)))
        if (isCodeRabbit(r.author) && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) crLatestState = r.state;
    return {
        slug, number, url: d.url, title: d.title, body: d.body || '', state: d.state, baseRef: d.baseRefName, isDraft: d.isDraft, labels: d.labels.nodes,
        issues: d.closingIssuesReferences.nodes, headSha: head.oid, headAt: headArrival({ committedAt: head.committedDate, firstSeenAt: firstSeen(d.url, head.oid) }), checks, reviews, comments, threads, openThreads,
        commentsComplete,
        checksGreen: !moreChecks && evaluateChecks(gateChecks).green, crLatestState, hasBugbotStatus: checks.some((c) => c.name === STATUS_CONTEXT),
        crApprovedHead: reviews.some((r) => isCodeRabbit(r.author) && r.state === 'APPROVED' && r.commit === head.oid),
        crBlocksHead: reviews.some((r) => isCodeRabbit(r.author) && r.state === 'CHANGES_REQUESTED' && r.commit === head.oid),
    };
}

function assess(pr) {
    const crStatus = codeRabbitStatus({ headSha: pr.headSha, headAt: pr.headAt, reviews: pr.reviews, comments: pr.comments, checks: pr.checks, graceMinutes: C.graceMinutes, pendingMaxMinutes: C.pendingMaxMinutes });
    const bugbot = bugbotVerdictFor(pr.reviews, pr.headSha, { trustedAuthors: trustedAuthors() });
    const gate = reviewGate({ crApprovedHead: pr.crApprovedHead, crBlocksHead: pr.crBlocksHead, crStatus, bugbot, openThreads: pr.openThreads, checksGreen: pr.checksGreen });
    const dismiss = shouldDismissCodeRabbit({ crLatestState: pr.crLatestState, crStatus, bugbot, openThreads: pr.openThreads, checksGreen: pr.checksGreen });
    return { crStatus, bugbot, gate, dismiss };
}

const MAX_DIFF = 60_000;

/** Who may write bugbot markers: the gh account bugbot posts as, plus any configured extra. */
let trusted = null;
function trustedAuthors() {
    if (trusted) return trusted;
    const me = gh(['api', 'user', '--jq', '.login']);
    const list = [...(me.code ? [] : [me.out.trim()]), ...(C.trustedAuthors || [])].filter(Boolean);
    if (!me.code) trusted = list; // cache only a successful lookup, so a transient gh failure is retried
    return list;
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
        metrics = await chat({ model: o.model, maxTokens, minutes: 12, stream: true, prompt: prompt + extra });
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

The excerpts of files at the PR head show the code as it is now, including lines outside the diff. Code that already existed before this PR counts as evidence: do not keep a thread only because a cited line is not in the diff.

Be fair: you were wrong sometimes, and a correct pushback should be accepted. Do not keep a thread just to be safe. Reply in one or two sentences.

Finish with exactly one fenced json block: {"decision":"accept|keep","reply":"..."}`;

/** A file's text at a commit, or null (missing, binary, too large or unreadable). Cached per run. */
const fileCache = new Map();
function fileAt(slug, path, sha) {
    const key = `${slug}@${sha}:${path}`;
    if (fileCache.has(key)) return fileCache.get(key);
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    // JSON (base64) rather than raw: gh's captured stdout is trimmed, which would drop leading
    // blank lines and shift every line number in the excerpt.
    const res = gh(['api', `repos/${slug}/contents/${encoded}?ref=${sha}`]);
    const text = res.code ? null : decodeContents(res.out);
    fileCache.set(key, text);
    return text;
}

/** Head-file context for the judge: the thread's own file around its line, plus up to three cited locations. */
function headContext(pr, t, replies) {
    const fence = '```';
    const at = t.line ?? t.originalLine ?? null;
    const parts = [];
    const own = fileAt(pr.slug, t.path, pr.headSha);
    if (own !== null) parts.push(`### ${t.path} at the PR head (around line ${at ?? 1})\n\n${fence}\n${excerptLines(own, at, 60)}\n${fence}`);
    for (const loc of citedLocations(replies, 3)) {
        if (loc.path === t.path && at && Math.abs(loc.line - at) <= 60) continue;
        const text = fileAt(pr.slug, loc.path, pr.headSha);
        if (text === null) continue;
        parts.push(`### ${loc.path} at the PR head (cited line ${loc.line})\n\n${fence}\n${excerptLines(text, loc.line, 25)}\n${fence}`);
    }
    return parts.length ? parts.join('\n\n').slice(0, 40_000) : '(no head-file context available)';
}

/** Answer replies on bugbot's own threads: resolve the ones whose reply holds, keep the rest open. */
const resolveThread = (id) => !gh(['api', 'graphql', '-f', 'query=mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}', '-f', `t=${id}`]).code;

async function answerThreads(pr, budget) {
    let answered = 0;
    // Accepted earlier but the resolve failed: just resolve again, no new judgement.
    if (!o['dry-run']) {
        for (const t of acceptedButOpen(pr.threads)) {
            if (resolveThread(t.id)) {
                log({ event: 'bugbot-thread-resolved', pr: pr.url, thread: t.id, retry: true });
                answered++;
            }
        }
    }
    const waiting = threadsAwaitingBugbot(pr.threads);
    if (!waiting.length) return answered;
    const fullDiff = gh(['pr', 'diff', String(pr.number), '-R', pr.slug]).out;
    for (const t of waiting) {
        if (budget.left <= 0) break;
        budget.left--;
        // Only the current diff of the thread's file: the judge checks "Fixed in …" against the code as it is now.
        const fileDiff = (fullDiff.split(/^(?=diff --git )/m).find((part) => part.includes(` b/${t.path}\n`)) || '(this file is no longer in the diff)').slice(0, 20_000);
        // What changed in this file since the finding was posted: where a claimed fix has to be.
        const since = t.comments[0]?.originalCommit;
        let delta = '(could not compute the change since the finding)';
        if (since && since !== pr.headSha) {
            // Filter in JS: a path with quotes or backslashes must never become part of a jq program.
            const cmp = gh(['api', `repos/${pr.slug}/compare/${since}...${pr.headSha}`]);
            if (!cmp.code) {
                let patch = '';
                try {
                    patch = (JSON.parse(cmp.out).files || []).find((f) => f.filename === t.path)?.patch || '';
                } catch { /* unreadable compare: keep the fallback text */ }
                delta = patch.trim() ? patch.slice(0, 30_000) : '(no change to this file since the finding)';
            }
        } else if (since === pr.headSha) delta = '(no new commit since the finding)';
        const conversation = t.comments.map((c) => `**${c.author}:** ${stripComments(c.body)}`).join('\n\n');
        const ask = `${JUDGE}\n\n## The thread (${t.path}:${t.line ?? '?'})\n\n${conversation}\n\n## Changes to ${t.path} since the finding was posted (where a claimed fix must be)\n\n\`\`\`diff\n${delta}\n\`\`\`\n\n## The PR's current diff of ${t.path} (context, may be cut)\n\n\`\`\`diff\n${fileDiff}\n\`\`\`\n\n## Files at the PR head (the code as it is now, including lines outside the diff)\n\n${headContext(pr, t, t.comments.slice(1).map((c) => c.body || '').join('\n'))}`;
        // A reasoning model can spend the budget before the block: one retry with more room and a terser ask.
        let metrics;
        let j;
        for (const [maxTokens, extra] of [[3000, ''], [8000, '\n\n**Output only the json block, nothing before it.**']]) {
            metrics = await chat({ model: o.model, maxTokens, minutes: 6, stream: true, prompt: ask + extra });
            j = parseThreadJudgement(metrics.finalText);
            if (!j.error) break;
        }
        if (j.error) {
            log({ event: 'bugbot-error', pr: pr.url, thread: t.id, error: `judgement: ${j.error}`, end: metrics.end, detail: metrics.error ? String(metrics.error).slice(0, 200) : String(metrics.finalText || '').slice(0, 200) });
            continue;
        }
        let resolved = false;
        if (!o['dry-run']) {
            const mark = j.decision === 'accept' ? `${THREAD_MARK}${ACCEPTED_MARK}` : THREAD_MARK;
            const body = `${mark}\n${j.decision === 'accept' ? '**Resolved:**' : '**Still open:**'} ${j.reply}\n\n<sub>bugbot</sub>`;
            const reply = gh(['api', 'graphql', '-f', 'query=mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}', '-f', `t=${t.id}`, '-f', `b=${body}`]);
            if (reply.code) {
                // Nothing written: the thread is still waiting and the next sweep judges it again.
                log({ event: 'bugbot-error', pr: pr.url, thread: t.id, error: `reply failed: ${reply.err.slice(0, 200)}` });
                continue;
            }
            // A failed resolve is retried next sweep (acceptedButOpen), without another judgement.
            if (j.decision === 'accept') resolved = resolveThread(t.id);
        }
        log({ event: 'bugbot-thread', pr: pr.url, thread: t.id, path: t.path, decision: j.decision, resolved: j.decision === 'accept' ? resolved : undefined, served: metrics.served, tokens: metrics.tokens, dryRun: o['dry-run'] || undefined });
        answered++;
    }
    return answered;
}

/** HTML comments out (repeated until stable, then any stray opener or closer), for prompt text. */
/**
 * Thread text for the judge prompt. It only goes to the model, never to HTML, so instead of parsing HTML
 * comments (CodeQL flags every regex attempt as incomplete) it drops the markers bugbot and the imps add
 * and then every remaining angle bracket.
 */
function stripComments(text = '') {
    return String(text)
        .split(THREAD_MARK).join('')
        .replace(/[<>]/g, '')
        .trim();
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
/** The PR's own changes at a commit (base...sha, so measured from the merge base), or null. */
function ownChangesAt(pr, sha) {
    if (!pr.baseRef) return null;
    const cmp = gh(['api', `repos/${pr.slug}/compare/${encodeURIComponent(pr.baseRef)}...${sha}`]);
    if (cmp.code) return null;
    try {
        return ownChanges(JSON.parse(cmp.out).files || []);
    } catch {
        return null;
    }
}

/**
 * A head that only merged the base branch in (the PR's own changes identical to a
 * commit bugbot already passed) inherits that verdict instead of a full re-review.
 * Posts a trusted marker review on the head, so the usual gate reads it.
 * @returns {object|null} the carried verdict, or null when it cannot be carried.
 */
function carryOverVerdict(pr) {
    const prior = latestPassedVerdict(pr.reviews, { trustedAuthors: trustedAuthors() });
    if (!prior || prior.sha === pr.headSha) return null;
    const before = ownChangesAt(pr, prior.sha);
    const now = ownChangesAt(pr, pr.headSha);
    if (!sameOwnChanges(before, now)) return null;
    const body = `<!-- bugbot sha=${pr.headSha} verdict=${prior.verdict} scope=full -->\n### Bugbot review: carried over\n\nThe PR's own changes at this commit are identical to ${prior.sha.slice(0, 7)}, which bugbot already reviewed ([verdict](${prior.url})); the new commits only bring in \`${pr.baseRef}\`. The verdict carries over.\n\n<sub>bugbot</sub>`;
    if (o['dry-run']) return { ...prior, carriedFrom: prior.sha, sha: pr.headSha };
    const post = gh(['api', `repos/${pr.slug}/pulls/${pr.number}/reviews`, '-X', 'POST', '--input', '-', '--jq', '.html_url'], {
        input: JSON.stringify({ commit_id: pr.headSha, event: 'COMMENT', body }),
    });
    if (post.code) {
        log({ event: 'bugbot-error', pr: pr.url, sha: pr.headSha, error: `carry-over post failed: ${post.err.slice(0, 200)}` });
        return null;
    }
    writeStatus(pr, 'success', statusDescription(prior.verdict, false), post.out);
    log({ event: 'bugbot-carried', pr: pr.url, sha: pr.headSha, from: prior.sha, verdict: prior.verdict, url: post.out });
    return { ...prior, carriedFrom: prior.sha, sha: pr.headSha, url: post.out };
}

async function handle(slug, number, { force = false, budget = { left: Infinity } } = {}) {
    let pr = loadPr(slug, number);
    if (pr.state !== 'OPEN' || pr.isDraft) return { pr: pr.url, action: 'none', reason: pr.isDraft ? 'draft' : pr.state.toLowerCase() };
    // Replies on our own threads first: they unblock a PR sooner than a new review does.
    if (await answerThreads(pr, budget) && !o['dry-run']) pr = loadPr(slug, number);
    let a = assess(pr);
    // Every finding of a request_changes head verdict answered on its thread (fixed or accepted pushback):
    // record a cleared verdict for the same head instead of waiting for a new commit.
    if (a.bugbot?.verdict === 'request_changes' && !o['dry-run']) {
        const review = pr.reviews.find((r) => r.url === a.bugbot.url);
        const openBugbot = pr.threads.filter((t) => !t.isResolved && String(t.comments[0]?.body || '').includes(THREAD_MARK)).length;
        if (canClearVerdict({ verdict: a.bugbot.verdict, scope: a.bugbot.scope, openBugbotThreads: openBugbot, reviewBody: review?.body })) {
            const body = `<!-- bugbot sha=${pr.headSha} verdict=comment scope=full -->\n### Bugbot review: 💬 Findings answered\n\nEvery finding from the [earlier review](${a.bugbot.url}) of this commit was answered on its thread and resolved, so the verdict is cleared.\n\n<sub>bugbot</sub>`;
            const post = gh(['api', `repos/${pr.slug}/pulls/${pr.number}/reviews`, '-X', 'POST', '--input', '-', '--jq', '.html_url'], {
                input: JSON.stringify({ commit_id: pr.headSha, event: 'COMMENT', body }),
            });
            if (!post.code) {
                writeStatus(pr, 'success', 'Findings answered (fallback review)', post.out);
                log({ event: 'bugbot-verdict-cleared', pr: pr.url, sha: pr.headSha, url: post.out });
                pr = loadPr(slug, number);
                a = assess(pr);
            }
        }
    }
    // A bugbot review whose status write failed: restore the status from the review instead of reviewing again.
    if (a.bugbot && !pr.hasBugbotStatus && !o['dry-run']) {
        const failing = a.bugbot.verdict === 'request_changes' || a.bugbot.scope === 'partial';
        if (writeStatus(pr, failing ? 'failure' : 'success', statusDescription(a.bugbot.verdict, a.bugbot.scope === 'partial'), a.bugbot.url))
            log({ event: 'bugbot-status-restored', pr: pr.url, sha: pr.headSha });
    }
    // A merge of the base branch alone: inherit the verdict bugbot already gave the same changes.
    if (!a.bugbot && a.crStatus.stalled && !force && carryOverVerdict(pr) && !o['dry-run']) {
        pr = loadPr(slug, number);
        a = assess(pr);
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
        // Reload both: the review took minutes, and checks or CodeRabbit may have moved meanwhile.
        pr = loadPr(slug, number);
        a = assess(pr);
    }
    // CodeRabbit reviewed the head and only its stale block remains: ask it to approve, once per head.
    const ask = shouldAskCodeRabbitApproval({
        crStatus: a.crStatus, crLatestState: pr.crLatestState, openThreads: pr.openThreads, checksGreen: pr.checksGreen,
        headSha: pr.headSha, comments: pr.comments, historyComplete: pr.commentsComplete, isImpPr: pr.labels.some((l) => (l.name || l) === 'imp'),
    });
    if (ask.ok) {
        if (!o['dry-run']) {
            const res = gh(['pr', 'comment', String(pr.number), '-R', pr.slug, '--body', `@coderabbitai approve\n\n${APPROVE_ASK_MARK(pr.headSha)}`]);
            log({ event: res.code ? 'bugbot-error' : 'bugbot-approve-ask', pr: pr.url, sha: pr.headSha, error: res.code ? res.err.slice(0, 200) : undefined });
            if (res.code) return { pr: pr.url, action: 'approve-ask-failed', gate: a.gate };
        }
        return { pr: pr.url, action: 'asked-coderabbit-approve', gate: a.gate };
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
        if (cmd === 'status' || cmd === 'merge-check') process.exit(3);
        return;
    }
    if (cmd === 'status') {
        const [slug, n] = parseTarget(target);
        const pr = loadPr(slug, n);
        const a = assess(pr);
        console.log(JSON.stringify({ pr: pr.url, head: pr.headSha, coderabbit: a.crStatus, bugbot: a.bugbot, openThreads: pr.openThreads, checksGreen: pr.checksGreen, gate: a.gate, dismissCodeRabbit: a.dismiss }, null, 2));
        process.exit(a.gate.ok ? 0 : 3);
    }
    // The one check any merge helper runs: the review gate plus what the PR's risk class demands.
    if (cmd === 'merge-check') {
        const [slug, n] = parseTarget(target);
        const pr = loadPr(slug, n);
        const a = assess(pr);
        // The run record holds a brief's raised class even if the label was since removed.
        const recorded = maxRisk(...rows().filter((x) => x.pr === pr.url).map((x) => x.risk));
        const risk = prRisk({ ...fetchPrPaths(slug, n, { run: gh }), recorded, labels: pr.labels });
        const ownerAcked = ownerAcknowledged({ labels: pr.labels, events: fetchAckEvents(slug, n, { run: gh }), owners: [owner] });
        const riskGate = riskMergeGate({ risk, checksGreen: pr.checksGreen, openThreads: pr.openThreads, headSha: pr.headSha, bugbot: a.bugbot, crApprovedHead: pr.crApprovedHead, ownerAcked });
        const ok = pr.state === 'OPEN' && !pr.isDraft && a.gate.ok && riskGate.ok;
        console.log(JSON.stringify({ pr: pr.url, head: pr.headSha, ok, risk, reviewGate: a.gate, riskGate }, null, 2));
        process.exit(ok ? 0 : 3);
    }
    // Without its own identity bugbot cannot tell its reviews from pasted markers, so none would ever count:
    // stop loudly instead of posting reviews that can never pass the gate.
    if (!trustedAuthors().length) {
        log({ event: 'bugbot-error', error: 'cannot identify the gh account (gh api user failed) and no bugbot.trustedAuthors set' });
        process.exit(2);
    }
    if (cmd === 'review') {
        const [slug, n] = parseTarget(target);
        console.log(JSON.stringify(await handle(slug, n, { force: o.force })));
        return;
    }
    if (cmd !== 'sweep') throw new Error(`unknown command ${cmd}`);
    const prs = sweepCandidates(ghJson(['search', 'prs', '--owner', owner, '--state', 'open', '--limit', '100',
        '--json', 'number,repository,author,labels,isDraft,url']), { skipRepos: C.skipRepos, skipLabel: C.skipLabel });
    // For the status line, which never calls GitHub: which PRs are still open as of this sweep.
    try {
        writeFileSync(join(HOME, 'bugbot-open.json'), JSON.stringify({ at: new Date().toISOString(), prs: prs.map((p) => p.url) }));
    } catch { /* best effort */ }
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
    // Heartbeat for the status line, even when nothing needed doing.
    log({ event: 'bugbot-sweep', prs: prs.length, acted: acted.length });
    console.log(`bugbot sweep: ${prs.length} PR(s), ${acted.length} acted${acted.length ? `: ${acted.map((r) => `${r.pr} ${r.action}`).join('; ')}` : ''}`);
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
