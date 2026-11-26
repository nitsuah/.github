import test from 'node:test';
import assert from 'node:assert/strict';
import {
    codeRabbitStatus, parseBugbotMarker, bugbotVerdictFor, rightSideLines, buildBugbotReview,
    shouldDismissCodeRabbit, reviewGate, sweepCandidates, reviewsInLastDay, CR_STALL_TEXT,
    THREAD_MARK, threadsAwaitingBugbot, parseThreadJudgement, bugbotPassed,
    latestPassedVerdict, ownChanges, sameOwnChanges, excerptLines, citedLocations, decodeContents,
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

test('reviewGate: a CodeRabbit review of the head that requests nothing passes (approvals disabled)', () => {
    const reviewed = { state: 'reviewed', stalled: false };
    assert.equal(reviewGate({ crStatus: reviewed, checksGreen: true }).ok, true);
    // ...but not with a thread still open, red checks, or changes requested on the head itself
    assert.equal(reviewGate({ crStatus: reviewed, checksGreen: true, openThreads: 1 }).ok, false);
    assert.equal(reviewGate({ crStatus: reviewed, checksGreen: false }).ok, false);
    assert.equal(reviewGate({ crStatus: reviewed, crBlocksHead: true, checksGreen: true }).ok, false);
    // a review of an older commit does not count: CodeRabbit is still waited for
    assert.equal(reviewGate({ crStatus: { state: 'waiting', stalled: false }, checksGreen: true }).ok, false);
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

test('shouldAskCodeRabbitApproval: once per head, only when CodeRabbit reviewed it and nothing is open', async () => {
    const { shouldAskCodeRabbitApproval, APPROVE_ASK_MARK } = await import('./bugbot-lib.mjs');
    const base = { crStatus: { state: 'reviewed' }, crLatestState: 'CHANGES_REQUESTED', openThreads: 0, checksGreen: true, headSha: HEAD, comments: [], historyComplete: true };
    // the default is conservative: a caller that omits historyComplete never triggers a second ask
    const { historyComplete: _h, ...noHistory } = base;
    assert.equal(shouldAskCodeRabbitApproval(noHistory).ok, false);
    assert.equal(shouldAskCodeRabbitApproval(base).ok, true);
    assert.equal(shouldAskCodeRabbitApproval({ ...base, comments: [{ body: `@coderabbitai approve\n\n${APPROVE_ASK_MARK(HEAD)}` }] }).ok, false, 'asked already');
    assert.equal(shouldAskCodeRabbitApproval({ ...base, comments: [{ body: APPROVE_ASK_MARK('b'.repeat(40)) }] }).ok, true, 'an ask for an older head does not count');
    assert.equal(shouldAskCodeRabbitApproval({ ...base, crStatus: { state: 'silent' } }).ok, false);
    assert.equal(shouldAskCodeRabbitApproval({ ...base, crLatestState: 'APPROVED' }).ok, false);
    assert.equal(shouldAskCodeRabbitApproval({ ...base, openThreads: 1 }).ok, false);
    assert.equal(shouldAskCodeRabbitApproval({ ...base, checksGreen: false }).ok, false);
    assert.equal(shouldAskCodeRabbitApproval({ ...base, isImpPr: true }).ok, false);
    // more than one page of comments and no marker in the page read: do not risk a second ask
    assert.equal(shouldAskCodeRabbitApproval({ ...base, historyComplete: false }).ok, false);
});

// ── Carry-over across base-branch merges ──────────────────────────────────

const OLD = 'b'.repeat(40);
const marker = (sha, verdict, scope = 'full') => `<!-- bugbot sha=${sha} verdict=${verdict} scope=${scope} -->`;

test('latestPassedVerdict: latest trusted passing verdict on any commit, else null', () => {
    const t = { trustedAuthors: ['bot'] };
    const reviews = [
        { author: 'bot', commit: OLD, submittedAt: minsAgo(30), body: marker(OLD, 'approve'), url: 'u1' },
        { author: 'mallory', commit: HEAD, submittedAt: minsAgo(20), body: marker(HEAD, 'approve'), url: 'u2' },
        { author: 'bot', commit: OLD, submittedAt: minsAgo(10), body: marker(HEAD, 'approve'), url: 'u3' },
    ];
    // u2 is untrusted; u3's marker names a commit other than the one it was posted on.
    assert.deepEqual(latestPassedVerdict(reviews, t), { sha: OLD, verdict: 'approve', scope: 'full', url: 'u1' });
    const failing = [...reviews, { author: 'bot', commit: OLD, submittedAt: minsAgo(5), body: marker(OLD, 'request_changes'), url: 'u4' }];
    assert.equal(latestPassedVerdict(failing, t), null, 'a later request_changes is the latest word');
    assert.equal(latestPassedVerdict([{ author: 'bot', commit: OLD, submittedAt: minsAgo(1), body: marker(OLD, 'approve', 'partial') }], t), null);
});

test('ownChanges/sameOwnChanges: same edits against a moved base compare equal', () => {
    const before = ownChanges([{ filename: 'a.js', status: 'modified', patch: '@@ -10,3 +10,4 @@\n ctx\n-old\n+new\n+added' }]);
    const after = ownChanges([{ filename: 'a.js', status: 'modified', patch: '@@ -40,3 +40,4 @@\n other ctx\n-old\n+new\n+added' }]);
    assert.ok(sameOwnChanges(before, after));
    const edited = ownChanges([{ filename: 'a.js', status: 'modified', patch: '@@ -40,3 +40,4 @@\n-old\n+new\n+changed during the merge' }]);
    assert.equal(sameOwnChanges(before, edited), false, 'a merge that alters the PR lines does not carry');
    const extra = ownChanges([...[{ filename: 'a.js', status: 'modified', patch: '-old\n+new\n+added' }], { filename: 'b.js', status: 'added', patch: '+x' }]);
    assert.equal(sameOwnChanges(before, extra), false, 'a new file does not carry');
});

test('ownChanges: fails closed on a missing patch or a possibly truncated file list', () => {
    assert.equal(ownChanges([{ filename: 'big.js', status: 'modified', changes: 5000 }]), null);
    assert.equal(ownChanges(Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}`, status: 'modified', patch: '+x' }))), null);
    assert.equal(sameOwnChanges(null, null), false);
});

// ── Judge context ─────────────────────────────────────────────────────────

test('excerptLines: numbered window around a line, clamped to the file', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
    const ex = excerptLines(text, 140, 2).split('\n');
    assert.deepEqual(ex, ['138  line 138', '139  line 139', '140  line 140', '141  line 141', '142  line 142']);
    assert.equal(excerptLines('a\nb', null, 5), '1  a\n2  b');
});

test('citedLocations: repo paths with a line, deduped, no URLs or escapes', () => {
    const reply = 'On main, `app/lib/db.js:140` already checks it (see app/lib/db.js:140 and tests/unit/rotate.test.mjs:12). '
        + 'Not https://example.com/x.js:9, not ../secret.txt:1, not /etc/passwd.txt:2.';
    assert.deepEqual(citedLocations(reply), [
        { path: 'app/lib/db.js', line: 140 },
        { path: 'tests/unit/rotate.test.mjs', line: 12 },
    ]);
    assert.equal(citedLocations('a.js:1 b.js:2 c.js:3 d.js:4').length, 3);
});

test('ownChanges: lines that start with ++ or -- are content, not headers', () => {
    const a = ownChanges([{ filename: 'c.js', status: 'modified', patch: '@@ -1 +1,2 @@\n-reset();\n+++attempts;\n+++failures;' }]);
    const b = ownChanges([{ filename: 'c.js', status: 'modified', patch: '@@ -1 +1,2 @@\n-reset();\n+++attempts;\n+--failures;' }]);
    assert.equal(sameOwnChanges(a, b), false);
});

test('ownChanges: a patchless modified or added file fails closed; a removal compares by status', () => {
    assert.equal(ownChanges([{ filename: 'logo.png', status: 'modified', changes: 0 }]), null);
    assert.equal(ownChanges([{ filename: 'logo.png', status: 'added', changes: 0 }]), null);
    const removed = ownChanges([{ filename: 'old.bin', status: 'removed', changes: 0 }]);
    assert.ok(sameOwnChanges(removed, ownChanges([{ filename: 'old.bin', status: 'removed', changes: 0 }])));
});

test('citedLocations: a leading ./ is the same location', () => {
    assert.deepEqual(citedLocations('see ./src/check.js:140 and src/check.js:140'), [{ path: 'src/check.js', line: 140 }]);
});

test('decodeContents: keeps leading blank lines so line numbers stay exact', () => {
    const text = '\n\nconst x = 1;\n';
    const json = JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') });
    assert.equal(decodeContents(json), text);
    assert.equal(excerptLines(decodeContents(json), 3, 0), '3  const x = 1;');
    assert.equal(decodeContents(JSON.stringify({ type: 'file', encoding: 'none', content: '' })), null, 'too large for the contents API');
    assert.equal(decodeContents(JSON.stringify({ type: 'dir' })), null);
    assert.equal(decodeContents('not json'), null);
});

// ── settled findings ──
{
    const { settledFindings, withoutSettled, matchesSettled, THREAD_MARK: TM, ACCEPTED_MARK: AM } = await import('./bugbot-lib.mjs');
    const thread = (path, title, answer, judged = `${TM}${AM}\n**Resolved:** ok`) => ({
        path, isResolved: true,
        comments: [{ body: `${TM}\n**blocker** · ${title}\n\nwhy` }, { body: answer }, { body: judged }],
    });
    const pushback = thread('.github/workflows/deploy.yml', "Invalid concurrency option 'queue: max'", '<!-- imp-reply -->\nNot a bug: queue is documented.');
    const fixed = thread('src/a.js', 'Null check missing', '<!-- imp-reply -->\nFixed in abc123.');
    const kept = thread('src/b.js', 'Leaks handle', 'Not a bug', `${TM}\n**Still open:** no`);

    test('settledFindings: accepted pushbacks only, not fixes or kept threads', () => {
        const s = settledFindings([pushback, fixed, kept, { path: 'x', comments: [{ body: 'human' }] }]);
        assert.equal(s.length, 1);
        assert.equal(s[0].path, '.github/workflows/deploy.yml');
        assert.match(s[0].title, /queue: max/);
        assert.match(s[0].reply, /^Not a bug/);
    });

    test('withoutSettled drops a reworded repeat on the same file and recomputes the verdict', () => {
        const s = settledFindings([pushback]);
        const rv = { verdict: 'request_changes', counts: { blocker: 1, major: 0, minor: 1, nit: 0 }, findings: [
            { severity: 'blocker', file: '.github/workflows/deploy.yml', line: 47, title: "Invalid concurrency option 'queue: max'", detail: '' },
            { severity: 'minor', file: '.github/workflows/deploy.yml', line: 85, title: 'Smoke check retries 10 times', detail: '' },
        ] };
        const out = withoutSettled(rv, s);
        assert.equal(out.dropped.length, 1);
        assert.equal(out.rv.verdict, 'comment');
        assert.deepEqual(out.rv.counts, { blocker: 0, major: 0, minor: 1, nit: 0 });
    });

    test('matchesSettled ignores other files and unrelated titles', () => {
        const s = settledFindings([pushback]);
        assert.equal(matchesSettled({ file: 'other.yml', title: "Invalid concurrency option 'queue: max'" }, s), null);
        assert.equal(matchesSettled({ file: '.github/workflows/deploy.yml', title: 'Secret printed to the log' }, s), null);
    });

    test('withoutSettled is a no-op with nothing settled', () => {
        const rv = { verdict: 'approve', findings: [] };
        assert.equal(withoutSettled(rv, []).rv, rv);
    });
}

// ── evidence rule ──
{
    const { requireEvidence, diffLineSet } = await import('./bugbot-lib.mjs');
    const diff = ['diff --git a/w.yml b/w.yml', '--- a/w.yml', '+++ b/w.yml', '@@ -1,2 +1,3 @@', ' concurrency:', '+  queue: max', '+  run: rm -rf "$DIR"'].join('\n');
    const f = (severity, title, quote, detail = '') => ({ severity, file: 'w.yml', line: 2, title, quote, detail });

    test('diffLineSet keeps added and context lines, not headers', () => {
        const s = diffLineSet(diff);
        assert.ok(s.has('queue: max'));
        assert.ok(s.has('concurrency:'));
        assert.ok(![...s].some((l) => l.includes('w.yml')));
    });

    test('requireEvidence keeps a quoted, concrete blocker', () => {
        const rv = { verdict: 'request_changes', findings: [f('blocker', 'Deletes the wrong directory when DIR is empty', 'run: rm -rf "$DIR"')] };
        const out = requireEvidence(rv, diff);
        assert.equal(out.downgraded.length, 0);
        assert.equal(out.rv.verdict, 'request_changes');
    });

    test('requireEvidence downgrades a blocker with no or a made-up quote', () => {
        for (const q of ['', 'queue: forever']) {
            const out = requireEvidence({ verdict: 'request_changes', findings: [f('major', 'Something breaks', q)] }, diff);
            assert.equal(out.rv.findings[0].severity, 'minor');
            assert.equal(out.rv.verdict, 'comment');
            assert.match(out.downgraded[0].why, /no quoted/);
        }
    });

    test('requireEvidence downgrades an existence claim even when quoted', () => {
        const out = requireEvidence({ verdict: 'request_changes', findings: [f('blocker', "Invalid concurrency option 'queue: max'", '+  queue: max')] }, diff);
        assert.equal(out.rv.findings[0].severity, 'minor');
        assert.match(out.downgraded[0].why, /existence claim/);
        assert.match(out.rv.findings[0].detail, /Downgraded from blocker/);
    });

    test('requireEvidence leaves minors and nits alone', () => {
        const rv = { verdict: 'comment', findings: [f('minor', 'x', ''), f('nit', 'y', '')] };
        assert.equal(requireEvidence(rv, diff).rv, rv);
    });
}
