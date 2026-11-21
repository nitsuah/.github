import test from 'node:test';
import assert from 'node:assert/strict';
import {
    codeRabbitStatus, parseBugbotMarker, bugbotVerdictFor, rightSideLines, buildBugbotReview,
    shouldDismissCodeRabbit, reviewGate, sweepCandidates, reviewsInLastDay, CR_STALL_TEXT,
    THREAD_MARK, threadsAwaitingBugbot, parseThreadJudgement, bugbotPassed,
} from './bugbot-lib.mjs';

const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-11-21T12:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString();

test('codeRabbitStatus: a CodeRabbit review of the head means it is working', () => {
    const s = codeRabbitStatus({ headSha: HEAD, headAt: minsAgo(60), now: NOW, reviews: [{ author: 'coderabbitai[bot]', commit: HEAD, state: 'COMMENTED' }] });
    assert.equal(s.state, 'reviewed');
    assert.equal(s.stalled, false);
});

test('codeRabbitStatus: a review of an older commit does not count for the head', () => {
    const s = codeRabbitStatus({ headSha: HEAD, headAt: minsAgo(60), now: NOW, reviews: [{ author: 'coderabbitai', commit: 'b'.repeat(40), state: 'CHANGES_REQUESTED' }] });
    assert.equal(s.state, 'silent');
    assert.equal(s.stalled, true);
});

test('codeRabbitStatus: its rate-limit notices after the head mean stalled at once', () => {
    for (const body of [
        'Review rate limited.',
        '## Review limit reached\nYou\'ve used all free OSS reviews for now.',
        '### Rate Limit Exceeded\n@nitsuah have exceeded the limit for the number of chat messages per hour.',
        '<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->',
    ]) {
        const s = codeRabbitStatus({ headSha: HEAD, headAt: minsAgo(2), now: NOW, comments: [{ author: 'coderabbitai', createdAt: minsAgo(1), body }] });
        assert.equal(s.state, 'rate-limited', body);
        assert.equal(s.stalled, true);
    }
});

test('codeRabbitStatus: a rate-limit notice from before the head push does not count', () => {
    const s = codeRabbitStatus({ headSha: HEAD, headAt: minsAgo(5), now: NOW, comments: [{ author: 'coderabbitai', createdAt: minsAgo(30), body: 'Review rate limited.' }] });
    assert.equal(s.state, 'waiting');
    assert.equal(s.stalled, false);
});

test('codeRabbitStatus: a pending CodeRabbit check gets time, then counts as stalled', () => {
    const checks = [{ name: 'CodeRabbit', state: 'PENDING' }];
    assert.equal(codeRabbitStatus({ headSha: HEAD, headAt: minsAgo(30), now: NOW, checks }).state, 'working');
    assert.equal(codeRabbitStatus({ headSha: HEAD, headAt: minsAgo(90), now: NOW, checks }).state, 'silent');
});

test('codeRabbitStatus: grace period, then silent; never-present CodeRabbit is absent', () => {
    const touched = [{ author: 'coderabbitai', createdAt: minsAgo(200), body: 'Walkthrough …' }];
    assert.equal(codeRabbitStatus({ headSha: HEAD, headAt: minsAgo(5), now: NOW, comments: touched }).state, 'waiting');
    assert.equal(codeRabbitStatus({ headSha: HEAD, headAt: minsAgo(25), now: NOW, comments: touched }).state, 'silent');
    assert.equal(codeRabbitStatus({ headSha: HEAD, headAt: minsAgo(25), now: NOW }).state, 'absent');
});

test('codeRabbitStatus: "already reviewed the last commit" means reviewed', () => {
    const s = codeRabbitStatus({ headSha: HEAD, headAt: minsAgo(40), now: NOW, comments: [{ author: 'coderabbitai', createdAt: minsAgo(1), body: 'Already reviewed the last commit.' }] });
    assert.equal(s.state, 'reviewed');
});

test('CR_STALL_TEXT does not match an ordinary review', () => {
    assert.equal(CR_STALL_TEXT.test('Actionable comments posted: 3'), false);
});

test('parseBugbotMarker reads sha, verdict and scope (full by default)', () => {
    assert.deepEqual(parseBugbotMarker(`<!-- bugbot sha=${HEAD} verdict=approve -->\nbody`), { sha: HEAD, verdict: 'approve', scope: 'full' });
    assert.deepEqual(parseBugbotMarker(`<!-- bugbot sha=${HEAD} verdict=comment scope=partial -->`), { sha: HEAD, verdict: 'comment', scope: 'partial' });
    assert.equal(parseBugbotMarker('<!-- imp-review -->'), null);
});

test('bugbotVerdictFor: latest verdict for the head, only from a trusted author on the head commit', () => {
    const t = { trustedAuthors: ['nitsuah'] };
    const reviews = [
        { author: 'nitsuah', commit: HEAD, body: `<!-- bugbot sha=${HEAD} verdict=request_changes -->`, submittedAt: minsAgo(30), url: 'u1' },
        { author: 'nitsuah', commit: 'b'.repeat(40), body: `<!-- bugbot sha=${'b'.repeat(40)} verdict=approve -->`, submittedAt: minsAgo(20), url: 'u2' },
        { author: 'nitsuah', commit: HEAD, body: `<!-- bugbot sha=${HEAD} verdict=approve -->`, submittedAt: minsAgo(10), url: 'u3' },
    ];
    assert.deepEqual(bugbotVerdictFor(reviews, HEAD, t), { sha: HEAD, verdict: 'approve', scope: 'full', url: 'u3' });
    assert.equal(bugbotVerdictFor(reviews, 'c'.repeat(40), t), null);
    // a pasted marker from someone else, or a marker on a review of another commit, does not count
    const forged = [{ author: 'mallory', commit: HEAD, body: `<!-- bugbot sha=${HEAD} verdict=approve -->`, submittedAt: minsAgo(1) }];
    assert.equal(bugbotVerdictFor(forged, HEAD, t), null);
    const wrongCommit = [{ author: 'nitsuah', commit: 'b'.repeat(40), body: `<!-- bugbot sha=${HEAD} verdict=approve -->`, submittedAt: minsAgo(1) }];
    assert.equal(bugbotVerdictFor(wrongCommit, HEAD, t), null);
    assert.equal(bugbotVerdictFor(reviews, HEAD), null, 'no trusted authors means nothing counts');
});

test('a partial (truncated) bugbot review never passes the gate or lifts CodeRabbit', () => {
    const stalled = { state: 'silent', stalled: true };
    const partial = { verdict: 'approve', scope: 'partial' };
    assert.equal(bugbotPassed(partial), false);
    assert.equal(reviewGate({ crStatus: stalled, bugbot: partial, checksGreen: true }).ok, false);
    assert.equal(shouldDismissCodeRabbit({ crLatestState: 'CHANGES_REQUESTED', crStatus: stalled, bugbot: partial, checksGreen: true }).ok, false);
    const out = buildBugbotReview({ verdict: 'approve', findings: [] }, { diff: DIFF, headSha: HEAD, partial: true });
    assert.equal(out.statusState, 'failure');
    assert.match(out.body, /scope=partial/);
});

test('codeRabbitStatus: a running CodeRabbit check wins over a later rate-limit notice', () => {
    const s = codeRabbitStatus({
        headSha: HEAD, headAt: minsAgo(30), now: NOW,
        checks: [{ name: 'CodeRabbit', state: 'PENDING' }],
        comments: [{ author: 'coderabbitai', createdAt: minsAgo(1), body: 'Rate Limit Exceeded: exceeded the limit for the number of chat messages' }],
    });
    assert.equal(s.state, 'working');
});

test('rightSideLines: hunk content starting with +++ is not a file header', () => {
    const diff = ['diff --git a/doc.md b/doc.md', '--- a/doc.md', '+++ b/doc.md', '@@ -1,1 +1,3 @@', ' title', '+++ heading', '+text'].join('\n');
    assert.deepEqual([...rightSideLines(diff).get('doc.md')], [1, 2, 3]);
    assert.equal(rightSideLines(diff).has('heading'), false);
});

const DIFF = [
    'diff --git a/src/a.js b/src/a.js',
    'index 1..2 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -10,3 +10,4 @@ function x() {',
    ' keep10',
    '-old11',
    '+new11',
    '+new12',
    ' keep13',
    '\\ No newline at end of file',
    'diff --git a/gone.js b/gone.js',
    '--- a/gone.js',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-x',
].join('\n');

test('rightSideLines maps the new-side lines of each hunk and skips deleted files', () => {
    const m = rightSideLines(DIFF);
    assert.deepEqual([...m.get('src/a.js')], [10, 11, 12, 13]);
    assert.equal(m.has('gone.js'), false);
});

test('rightSideLines handles several hunks, context-only hunks and new files', () => {
    const diff = [
        'diff --git a/m.js b/m.js', '--- a/m.js', '+++ b/m.js',
        '@@ -1,2 +1,2 @@', ' a', ' b',
        '@@ -20,3 +20,4 @@', ' c', '-d', '+e', '+f', ' g',
        'diff --git a/new.js b/new.js', 'new file mode 100644', '--- /dev/null', '+++ b/new.js',
        '@@ -0,0 +1,2 @@', '+x', '+y',
    ].join('\n');
    const m = rightSideLines(diff);
    assert.deepEqual([...m.get('m.js')], [1, 2, 20, 21, 22, 23]);
    assert.deepEqual([...m.get('new.js')], [1, 2]);
});

test('buildBugbotReview: inline threads only on diff lines, no imp- marker, nits summarised', () => {
    const rv = {
        verdict: 'request_changes', summary: 'S',
        findings: [
            { severity: 'major', file: 'src/a.js', line: 11, title: 'Off by one', detail: 'D1' },
            { severity: 'minor', file: 'src/a.js', line: 99, title: 'Outside diff', detail: 'D2' },
            { severity: 'nit', file: 'src/a.js', line: 12, title: 'Naming', detail: '' },
        ],
    };
    const out = buildBugbotReview(rv, { diff: DIFF, headSha: HEAD, reason: 'rate-limited' });
    assert.equal(out.comments.length, 1);
    assert.deepEqual({ path: out.comments[0].path, line: out.comments[0].line, side: out.comments[0].side }, { path: 'src/a.js', line: 11, side: 'RIGHT' });
    assert.doesNotMatch(out.comments[0].body, /<!-- imp-/);
    assert.match(out.body, new RegExp(`<!-- bugbot sha=${HEAD} verdict=request_changes scope=full -->`));
    assert.match(out.body, /Outside diff/);
    assert.match(out.body, /Nits: Naming/);
    assert.equal(out.statusState, 'failure');
    assert.equal(buildBugbotReview({ verdict: 'approve', findings: [] }, { diff: DIFF, headSha: HEAD }).statusState, 'success');
});

test('inline comments carry the bugbot thread mark', () => {
    const out = buildBugbotReview({ verdict: 'comment', findings: [{ severity: 'minor', file: 'src/a.js', line: 12, title: 'T', detail: 'D' }] }, { diff: DIFF, headSha: HEAD });
    assert.match(out.comments[0].body, new RegExp(THREAD_MARK));
});

test('threadsAwaitingBugbot: only open bugbot threads where someone replied last', () => {
    const mine = { body: `${THREAD_MARK}\n**major** · X` };
    const threads = [
        { id: 'waiting', isResolved: false, comments: [mine, { body: '<!-- imp-fix -->\n**Pushing back:** covered by test Y' }] },
        { id: 'answered', isResolved: false, comments: [mine, { body: 'reply' }, { body: `${THREAD_MARK}\nStill applies.` }] },
        { id: 'fresh', isResolved: false, comments: [mine] },
        { id: 'resolved', isResolved: true, comments: [mine, { body: 'fixed' }] },
        { id: 'coderabbit', isResolved: false, comments: [{ body: 'CodeRabbit finding' }, { body: 'reply' }] },
    ];
    assert.deepEqual(threadsAwaitingBugbot(threads).map((t) => t.id), ['waiting']);
});

test('parseThreadJudgement reads accept/keep and rejects anything else', () => {
    assert.deepEqual(parseThreadJudgement('ok\n```json\n{"decision":"accept","reply":"Right, the test covers it."}\n```'), { decision: 'accept', reply: 'Right, the test covers it.' });
    assert.equal(parseThreadJudgement('```json\n{"decision":"keep"}\n```').decision, 'keep');
    assert.ok(parseThreadJudgement('```json\n{"decision":"maybe"}\n```').error);
    assert.ok(parseThreadJudgement('no block').error);
    assert.equal(parseThreadJudgement('Looks fixed. {"decision":"accept","reply":"ok"}').decision, 'accept', 'bare object');
});

test('shouldDismissCodeRabbit: only when stalled, bugbot passed the head, no threads, green', () => {
    const base = { crLatestState: 'CHANGES_REQUESTED', crStatus: { state: 'rate-limited', stalled: true }, bugbot: { verdict: 'approve' }, openThreads: 0, checksGreen: true };
    assert.equal(shouldDismissCodeRabbit(base).ok, true);
    assert.equal(shouldDismissCodeRabbit({ ...base, crStatus: { state: 'reviewed', stalled: false } }).ok, false);
    assert.equal(shouldDismissCodeRabbit({ ...base, crStatus: { state: 'working', stalled: false } }).ok, false);
    assert.equal(shouldDismissCodeRabbit({ ...base, bugbot: null }).ok, false);
    assert.equal(shouldDismissCodeRabbit({ ...base, bugbot: { verdict: 'request_changes' } }).ok, false);
    assert.equal(shouldDismissCodeRabbit({ ...base, openThreads: 1 }).ok, false);
    assert.equal(shouldDismissCodeRabbit({ ...base, checksGreen: false }).ok, false);
    assert.equal(shouldDismissCodeRabbit({ ...base, crLatestState: 'APPROVED' }).ok, false);
});

test('reviewGate: CodeRabbit approval, or bugbot pass while CodeRabbit is stalled', () => {
    assert.equal(reviewGate({ crApprovedHead: true, checksGreen: true }).ok, true);
    assert.equal(reviewGate({ crApprovedHead: true, checksGreen: false }).ok, false);
    assert.equal(reviewGate({ crApprovedHead: true, checksGreen: true, openThreads: 2 }).ok, false);
    assert.equal(reviewGate({ crStatus: { state: 'silent', stalled: true }, bugbot: { verdict: 'comment' }, checksGreen: true }).ok, true);
    assert.equal(reviewGate({ crStatus: { state: 'silent', stalled: true }, bugbot: { verdict: 'request_changes' }, checksGreen: true }).ok, false);
    assert.equal(reviewGate({ crStatus: { state: 'silent', stalled: true }, checksGreen: true }).ok, false);
    // a working CodeRabbit is waited for, even with a bugbot pass on record
    assert.equal(reviewGate({ crStatus: { state: 'working', stalled: false }, bugbot: { verdict: 'approve' }, checksGreen: true }).ok, false);
});

test('sweepCandidates drops drafts, bot authors, skipped repos and skip-labelled PRs', () => {
    const prs = [
        { number: 1, repository: { name: 'fire' }, author: { login: 'nitsuah' }, labels: [] },
        { number: 2, repository: { name: 'fire' }, author: { login: 'nitsuah' }, isDraft: true, labels: [] },
        { number: 3, repository: { name: 'fire' }, author: { login: 'app/dependabot' }, labels: [] },
        { number: 4, repository: { name: 'security-program' }, author: { login: 'nitsuah' }, labels: [] },
        { number: 5, repository: { name: 'vhs' }, author: { login: 'nitsuah' }, labels: [{ name: 'bugbot:skip' }] },
    ];
    assert.deepEqual(sweepCandidates(prs).map((p) => p.number), [1]);
});

test('reviewsInLastDay counts only this PR in the last 24 h', () => {
    const ev = [
        { event: 'bugbot-review', pr: 'p1', at: minsAgo(60) },
        { event: 'bugbot-review', pr: 'p1', at: minsAgo(25 * 60) },
        { event: 'bugbot-review', pr: 'p2', at: minsAgo(60) },
        { event: 'bugbot-skip', pr: 'p1', at: minsAgo(10) },
        { event: 'bugbot-review', pr: 'p1', at: minsAgo(5), dryRun: true },
    ];
    assert.equal(reviewsInLastDay(ev, 'p1', NOW), 1);
});

test('acceptedButOpen finds bugbot threads it accepted that are still unresolved', async () => {
    const { acceptedButOpen, ACCEPTED_MARK } = await import('./bugbot-lib.mjs');
    const mine = { body: `${THREAD_MARK}\n**major** · X` };
    const threads = [
        { id: 'stuck', isResolved: false, comments: [mine, { body: 'pushback' }, { body: `${THREAD_MARK}${ACCEPTED_MARK}\n**Resolved:** ok` }] },
        { id: 'kept', isResolved: false, comments: [mine, { body: 'pushback' }, { body: `${THREAD_MARK}\n**Still open:** no` }] },
        { id: 'done', isResolved: true, comments: [mine, { body: 'x' }, { body: `${THREAD_MARK}${ACCEPTED_MARK}` }] },
    ];
    assert.deepEqual(acceptedButOpen(threads).map((t) => t.id), ['stuck']);
});

test('headArrival takes the later of the commit date and first sighting', async () => {
    const { headArrival } = await import('./bugbot-lib.mjs');
    assert.equal(headArrival({ committedAt: minsAgo(120), firstSeenAt: minsAgo(3) }), minsAgo(3), 'old commit pushed now gets the grace period');
    assert.equal(headArrival({ committedAt: minsAgo(5), firstSeenAt: minsAgo(10) }), minsAgo(5));
});

test('canClearVerdict: only request_changes, full scope, every bugbot thread answered, no unplaced blocker/major', async () => {
    const { canClearVerdict } = await import('./bugbot-lib.mjs');
    assert.equal(canClearVerdict({ verdict: 'request_changes', openBugbotThreads: 0, reviewBody: 'all inline' }), true);
    assert.equal(canClearVerdict({ verdict: 'request_changes', openBugbotThreads: 1 }), false);
    assert.equal(canClearVerdict({ verdict: 'request_changes', scope: 'partial' }), false);
    assert.equal(canClearVerdict({ verdict: 'comment' }), false);
    const unplaced = 'x\n**Findings outside the diff lines:**\n\n| | Finding | Where |\n| --- | --- | --- |\n| **major** | Bad | `a.js:9` |';
    assert.equal(canClearVerdict({ verdict: 'request_changes', reviewBody: unplaced }), false);
    assert.equal(canClearVerdict({ verdict: 'request_changes', reviewBody: unplaced.replace('**major**', '**minor**') }), true);
});
