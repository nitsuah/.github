// bugbot: pure decisions for the fallback PR reviewer (imps/bugbot.mjs).
//
// CodeRabbit is the primary reviewer. When it cannot review the current head
// commit (its free tier is rate-limited, or it has gone silent), bugbot runs an
// adversarial 9router review and posts it the way CodeRabbit does: one inline
// review thread per finding, plus a `bugbot` commit status on the head. It only
// reviews; it never edits code. The PR's owner fixes the threads (the imp fix
// round on imp PRs, the hypervisor elsewhere). CodeRabbit's stale
// CHANGES_REQUESTED is dismissed only when CodeRabbit is stalled on the head,
// bugbot passed that same head, and no thread is open.
// Contract: imps/STANDARD.md § Bugbot.

export const BUGBOT_MARK = '<!-- bugbot';
export const STATUS_CONTEXT = 'bugbot';
// On every inline comment and thread reply bugbot writes, so it can find its own threads and its own last word.
export const THREAD_MARK = '<!-- bugbot-thread -->';

export const BUGBOT_DEFAULTS = {
    graceMinutes: 20, // how long CodeRabbit gets to review a new head before it counts as silent
    pendingMaxMinutes: 45, // a CodeRabbit check still pending after this long counts as stalled
    maxPerSweep: 2, // bugbot reviews per sweep (each one is a 9router completion)
    perPrPerDay: 6, // bugbot reviews of one PR in 24 h, so a fix/re-review loop cannot spin
    skipLabel: 'bugbot:skip',
    skipRepos: ['security-program', '9router', '9router-fork'],
};

const CR_LOGIN = /^coderabbitai(\[bot\])?$/i;
export const isCodeRabbit = (login = '') => CR_LOGIN.test(String(login));

// CodeRabbit's own words when it will not review (free OSS quota, hourly chat limit, paused reviews).
export const CR_STALL_TEXT =
    /review(s)? rate limited|review limit reached|rate limit exceeded|used all free (oss )?reviews|rate limited by coderabbit|exceeded the limit for the number of|reviews? (are )?paused/i;
// Its reply when the head commit was in fact already reviewed.
const CR_ALREADY_REVIEWED = /already reviewed the last commit/i;

const ts = (s) => {
    const t = Date.parse(s || '');
    return Number.isFinite(t) ? t : 0;
};

/**
 * Where does CodeRabbit stand on the PR's current head commit?
 * Pure; every input is passed in.
 *  reviewed      it submitted a review for the head commit (it is working; defer to it)
 *  working       its check on the head is still pending (give it time)
 *  waiting       the head is younger than the grace period
 *  rate-limited  its latest note after the head says it will not review (stalled)
 *  silent        no review for the head after the grace period (stalled)
 *  absent        it has never touched this PR (no CodeRabbit here; stalled)
 * @returns {{state:string, stalled:boolean, reason:string}}
 */
export function codeRabbitStatus({ headSha, headAt, reviews = [], comments = [], checks = [], now = Date.now(), graceMinutes = BUGBOT_DEFAULTS.graceMinutes, pendingMaxMinutes = BUGBOT_DEFAULTS.pendingMaxMinutes } = {}) {
    const out = (state, reason) => ({ state, stalled: ['rate-limited', 'silent', 'absent'].includes(state), reason });
    const crReviews = reviews.filter((r) => isCodeRabbit(r.author));
    if (crReviews.some((r) => r.commit === headSha && r.state !== 'PENDING')) return out('reviewed', 'CodeRabbit reviewed the head commit');

    const headTime = ts(headAt);
    const age = now - headTime;
    // A CodeRabbit check still running on the head wins over any notice: it is working (CodeRabbit #320 review).
    const crCheck = checks.find((c) => /coderabbit/i.test(c.name || ''));
    if (crCheck && /^(PENDING|IN_PROGRESS|QUEUED|EXPECTED|pending)$/i.test(crCheck.state || '') && age < pendingMaxMinutes * 60_000)
        return out('working', 'CodeRabbit check is still running');

    const crComments = comments.filter((c) => isCodeRabbit(c.author)).sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
    const afterHead = crComments.filter((c) => ts(c.createdAt) >= headTime);
    const latest = afterHead[afterHead.length - 1];
    if (latest && CR_STALL_TEXT.test(latest.body || '')) return out('rate-limited', 'CodeRabbit says it is rate-limited for this head');
    if (latest && CR_ALREADY_REVIEWED.test(latest.body || '')) return out('reviewed', 'CodeRabbit says it already reviewed the head');

    if (age < graceMinutes * 60_000) return out('waiting', `head is ${Math.round(age / 60_000)} min old (grace ${graceMinutes} min)`);
    if (!crReviews.length && !crComments.length && !crCheck) return out('absent', 'CodeRabbit has not touched this PR');
    return out('silent', `no CodeRabbit review of the head after ${graceMinutes} min`);
}

/** Read `<!-- bugbot sha=<sha> verdict=<verdict> scope=<full|partial> -->` from a review body. */
export function parseBugbotMarker(body = '') {
    const m = String(body).match(/<!-- bugbot sha=([0-9a-f]{7,40}) verdict=(approve|comment|request_changes)(?: scope=(full|partial))? -->/);
    return m ? { sha: m[1], verdict: m[2], scope: m[3] || 'full' } : null;
}

/**
 * The latest bugbot verdict for this exact head commit, or null. A marker only
 * counts on a review written by a trusted bugbot account and submitted on the
 * head commit itself, so a pasted marker cannot pass the gate.
 */
export function bugbotVerdictFor(reviews = [], headSha, { trustedAuthors = [] } = {}) {
    const trusted = new Set(trustedAuthors.map((a) => String(a).toLowerCase()));
    let found = null;
    for (const r of [...reviews].sort((a, b) => ts(a.submittedAt) - ts(b.submittedAt))) {
        const m = parseBugbotMarker(r.body);
        if (!m || !headSha || m.sha !== headSha || r.commit !== headSha) continue;
        if (!trusted.has(String(r.author || '').toLowerCase())) continue;
        found = { ...m, url: r.url || null };
    }
    return found;
}

/** A bugbot result the gate may count as a pass: not request_changes, and the whole diff was reviewed. */
export const bugbotPassed = (b) => Boolean(b) && b.verdict !== 'request_changes' && b.scope !== 'partial';

/**
 * New-side line numbers each file shows in a unified diff (added and context
 * lines). GitHub only accepts an inline review comment on one of these lines.
 * @returns {Map<string, Set<number>>}
 */
export function rightSideLines(diff = '') {
    const files = new Map();
    let file = null;
    let line = 0;
    let oldLeft = 0; // lines of the current hunk still to read, per side (from the @@ header),
    let newLeft = 0; // so hunk content such as "+++ heading" is never mistaken for a file header
    for (const raw of String(diff).split('\n')) {
        if (oldLeft > 0 || newLeft > 0) {
            if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
            const tag = raw[0];
            if (tag === '+') {
                if (file) files.get(file).add(line);
                line++;
                newLeft--;
            } else if (tag === '-') {
                oldLeft--;
            } else {
                if (file) files.get(file).add(line);
                line++;
                oldLeft--;
                newLeft--;
            }
            continue;
        }
        if (raw.startsWith('diff --git ')) {
            file = null;
            continue;
        }
        if (raw.startsWith('+++ ')) {
            const p = raw.slice(4).trim();
            file = p === '/dev/null' ? null : p.replace(/^b\//, '');
            if (file && !files.has(file)) files.set(file, new Set());
            continue;
        }
        const h = raw.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (h) {
            oldLeft = h[1] === undefined ? 1 : Number(h[1]);
            line = Number(h[2]);
            newLeft = h[3] === undefined ? 1 : Number(h[3]);
        }
    }
    return files;
}

const escapeCell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const VERDICT_LABEL = { approve: '✅ No blocking issues', comment: '💬 Minor findings', request_changes: '⛔ Changes needed' };

/**
 * Turn a parsed review (lib.mjs parseReview) into a GitHub review payload.
 * Findings above nit that point at a line visible in the diff become inline
 * threads (no `<!-- imp-` marker, so the imp fix round treats them as
 * feedback); the rest go in the summary.
 */
export function buildBugbotReview(rv, { diff = '', headSha, reason = '', model = 'MAX', served = [], partial = false } = {}) {
    const lines = rightSideLines(diff);
    const comments = [];
    const unplaced = [];
    for (const f of rv.findings || []) {
        if (f.severity === 'nit') continue;
        const okLine = f.file && Number.isInteger(f.line) && lines.get(f.file)?.has(f.line);
        if (!okLine) {
            unplaced.push(f);
            continue;
        }
        comments.push({
            path: f.file,
            line: f.line,
            side: 'RIGHT',
            body: `${THREAD_MARK}\n**${f.severity}** · ${f.title}\n\n${f.detail}\n\n<sub>bugbot: fallback review while CodeRabbit is unavailable. Fix it, or reply with evidence; bugbot reads the reply and resolves the thread if it holds.</sub>`,
        });
    }
    const nits = (rv.findings || []).filter((f) => f.severity === 'nit').slice(0, 3);
    const body = [
        `<!-- bugbot sha=${headSha} verdict=${rv.verdict} scope=${partial ? 'partial' : 'full'} -->`,
        `### Bugbot review: ${VERDICT_LABEL[rv.verdict] || rv.verdict}`,
        '',
        rv.summary || '(no summary)',
        '',
        `CodeRabbit could not review this head (${reason || 'unavailable'}), so this adversarial review stands in for it. ${comments.length} finding(s) are inline threads.`,
    ];
    if (partial) body.push('', '**The diff was too large to review in full**, so this review does not count as a pass: the `bugbot` status stays failing until CodeRabbit or a human reviews the rest.');
    if (unplaced.length) {
        body.push('', '**Findings outside the diff lines:**', '', '| | Finding | Where |', '| --- | --- | --- |');
        for (const f of unplaced) body.push(`| **${f.severity}** | ${escapeCell(f.title)} | \`${escapeCell(f.file || '?')}${f.line ? `:${f.line}` : ''}\` |`);
        for (const f of unplaced) body.push('', `<details><summary><b>${f.severity}</b>: ${f.title}</summary>\n\n${f.detail}\n\n</details>`);
    }
    if (nits.length) body.push('', `Nits: ${nits.map((f) => `${f.title} (\`${f.file}${f.line ? `:${f.line}` : ''}\`)`).join('; ')}`);
    const statusState = rv.verdict === 'request_changes' || partial ? 'failure' : 'success';
    body.push('', `<sub>Read-only review through 9router (\`${model}\`, served ${served.join(', ') || '?'}). Bugbot never edits code or merges; the \`bugbot\` status on this commit is ${statusState}.</sub>`);
    return { body: body.join('\n'), comments, unplaced, statusState };
}

/**
 * May CodeRabbit's CHANGES_REQUESTED be dismissed? Only when CodeRabbit is
 * stalled on the head, bugbot passed this exact head, every thread is resolved
 * and checks are green. A working CodeRabbit is never overridden.
 */
export function shouldDismissCodeRabbit({ crLatestState, crStatus, bugbot, openThreads = 0, checksGreen = false } = {}) {
    if (crLatestState !== 'CHANGES_REQUESTED') return { ok: false, reason: 'CodeRabbit is not blocking' };
    if (!crStatus?.stalled) return { ok: false, reason: `CodeRabbit is ${crStatus?.state || 'unknown'} on the head; defer to it` };
    if (!bugbot) return { ok: false, reason: 'no bugbot review of the head yet' };
    if (!bugbotPassed(bugbot)) return { ok: false, reason: bugbot.scope === 'partial' ? 'bugbot only reviewed part of the diff' : 'bugbot requests changes on the head' };
    if (openThreads > 0) return { ok: false, reason: `${openThreads} review thread(s) still open` };
    if (!checksGreen) return { ok: false, reason: 'checks are not green' };
    return { ok: true, reason: 'CodeRabbit is stalled; bugbot passed the head with every thread resolved and green checks' };
}

/**
 * The independent-review half of the merge rule: CodeRabbit approved the head,
 * or (when it is stalled) bugbot passed the head. Either way no thread may be
 * open and checks must be green.
 */
export function reviewGate({ crApprovedHead = false, crStatus, bugbot, openThreads = 0, checksGreen = false } = {}) {
    if (!checksGreen) return { ok: false, reason: 'checks are not green' };
    if (openThreads > 0) return { ok: false, reason: `${openThreads} review thread(s) still open` };
    if (crApprovedHead) return { ok: true, reason: 'CodeRabbit approved the head' };
    if (crStatus?.stalled && bugbotPassed(bugbot)) return { ok: true, reason: `CodeRabbit ${crStatus.state}; bugbot passed the head` };
    if (crStatus?.stalled) return { ok: false, reason: !bugbot ? 'CodeRabbit stalled and bugbot has not reviewed the head' : bugbot.scope === 'partial' ? 'bugbot only reviewed part of the diff' : 'bugbot requests changes on the head' };
    return { ok: false, reason: `waiting for CodeRabbit (${crStatus?.state || 'unknown'})` };
}

/**
 * Bugbot threads waiting for bugbot: unresolved, opened by bugbot, and the last
 * word is someone else's (a fix round's "Fixed in …" / "Pushing back", or a human).
 */
export function threadsAwaitingBugbot(threads = []) {
    return threads.filter((t) => {
        const cs = t.comments || [];
        if (t.isResolved || cs.length < 2) return false;
        if (!String(cs[0].body || '').includes(THREAD_MARK)) return false;
        return !String(cs[cs.length - 1].body || '').includes(THREAD_MARK);
    });
}

/** Read bugbot's answer to a reply: `{"decision":"accept|keep","reply":"…"}` in a json block. */
export function parseThreadJudgement(text = '') {
    const blocks = [...String(text).matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
    if (!blocks.length) return { error: 'no json block' };
    try {
        const raw = JSON.parse(blocks[blocks.length - 1][1]);
        if (!['accept', 'keep'].includes(raw.decision)) return { error: `bad decision ${raw.decision}` };
        return { decision: raw.decision, reply: String(raw.reply || '').trim() || (raw.decision === 'accept' ? 'Agreed.' : 'This still applies.') };
    } catch (e) {
        return { error: `unparseable json: ${e.message}` };
    }
}

/** Open PRs bugbot may look at: not drafts, not bot-authored, not skipped repos or labelled bugbot:skip. */
export function sweepCandidates(prs = [], { skipRepos = BUGBOT_DEFAULTS.skipRepos, skipLabel = BUGBOT_DEFAULTS.skipLabel } = {}) {
    return prs.filter((p) => {
        if (p.isDraft) return false;
        const repo = p.repository?.name || p.repo;
        if (skipRepos.includes(repo)) return false;
        const author = p.author?.login || '';
        if (/\[bot\]$|^app\/|^(dependabot|renovate|github-actions)$/i.test(author)) return false;
        if ((p.labels || []).some((l) => (l.name || l) === skipLabel)) return false;
        return true;
    });
}

/** How many bugbot reviews this PR got in the last 24 h (from bugbot.jsonl events). */
export function reviewsInLastDay(events = [], prUrl, now = Date.now()) {
    return events.filter((e) => e && e.event === 'bugbot-review' && !e.dryRun && e.pr === prUrl && now - ts(e.at) < 24 * 3600_000).length;
}
