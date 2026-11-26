// node --test imps/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    evaluateChecks,
    checksFingerprint,
    mergeReady,
    cleanMergesForRepo,
    mayAutoMerge,
    bigUntestedDiff,
    revertedImpNumbers,
    countGithubSeedTrust,
    earnedTrustCount,
    labelWatchEnabled,
    fetchGithubSeedTrust,
    riskMergeGate, prRisk, fetchPrPaths, fetchAckEvents, ownerAcknowledged, dropStaleAck,
} from './checks.mjs';
import { DEFAULTS } from './defaults.mjs';

test('evaluateChecks: empty / pending / red / green', () => {
    assert.equal(evaluateChecks([]).green, false);
    assert.match(evaluateChecks([]).reason, /no checks/);
    const pending = evaluateChecks([{ name: 'CI', state: 'PENDING' }, { name: 'lint', state: 'SUCCESS' }]);
    assert.equal(pending.green, false);
    assert.match(pending.reason, /still running/);
    const red = evaluateChecks([
        { name: 'CI', state: 'SUCCESS' },
        { name: 'Products CI', state: 'FAILURE' },
    ]);
    assert.equal(red.green, false);
    assert.match(red.reason, /Products CI:FAILURE/);
    assert.equal(
        evaluateChecks([
            { name: 'CI', state: 'SUCCESS' },
            { name: 'Products', state: 'SKIPPED' },
            { name: 'other', state: 'NEUTRAL' },
        ]).green,
        true,
    );
});

test('evaluateChecks never treats a non-required failure as green (stash#305)', () => {
    // Same shape as stash#305: required-looking CI green, Products CI red.
    const r = evaluateChecks([
        { name: 'Install & syntax check', state: 'SUCCESS' },
        { name: 'Validate packages', state: 'FAILURE' },
    ]);
    assert.equal(r.green, false);
    assert.ok(r.bad.some((b) => /Validate packages/.test(b)));
});

test('checksFingerprint is order-independent', () => {
    const a = [{ name: 'b', state: 'SUCCESS' }, { name: 'a', state: 'SUCCESS' }];
    const b = [{ name: 'a', state: 'success' }, { name: 'b', state: 'SUCCESS' }];
    assert.equal(checksFingerprint(a), checksFingerprint(b));
});

test('cleanMergesForRepo and mayAutoMerge enforce earned trust', () => {
    const rows = [
        { repo: 'stash', outcome: 'merged', gate: { pass: true }, review: { verdict: 'approve' } },
        { repo: 'stash', outcome: 'merged', gate: { pass: true }, review: { verdict: 'approve' } },
        { repo: 'stash', outcome: 'merged', gate: { pass: false }, review: { verdict: 'approve' } },
        { repo: 'fire', outcome: 'merged', gate: { pass: true }, review: { verdict: 'approve' } },
    ];
    assert.equal(cleanMergesForRepo(rows, 'stash'), 2);
    assert.equal(mayAutoMerge({ risk: 'low', repo: 'stash', reviewVerdict: 'approve', rows, trust: 3 }).ok, false);
    assert.match(mayAutoMerge({ risk: 'low', repo: 'stash', reviewVerdict: 'approve', rows, trust: 3 }).reason, /2\/3/);
    assert.equal(mayAutoMerge({ risk: 'low', repo: 'stash', reviewVerdict: 'approve', rows, trust: 2 }).ok, true);
    assert.equal(mayAutoMerge({ risk: 'low', repo: 'stash', reviewVerdict: 'comment', rows, trust: 0 }).ok, false);
    assert.equal(mayAutoMerge({ risk: 'low', repo: 'stash', reviewVerdict: 'approve', rows, trust: 0, autoMergeEnv: '0' }).ok, false);
    assert.equal(mayAutoMerge({ risk: 'low', repo: 'stash', reviewVerdict: 'approve', rows, trust: 'three' }).ok, false);
    assert.equal(mayAutoMerge({ risk: 'low', repo: 'stash', reviewVerdict: 'approve', rows, trust: NaN }).ok, false);
});

test('mayAutoMerge fails closed on githubSeedError', () => {
    const r = mayAutoMerge({
        risk: 'low',
        repo: 'stash',
        reviewVerdict: 'approve',
        rows: [],
        trust: 0,
        githubSeedError: 'gh pr list failed',
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /trust seed failed/);
});

test('mayAutoMerge uses max(ledger, github) seed', () => {
    const rows = [
        { repo: 'stash', outcome: 'merged', gate: { pass: true }, review: { verdict: 'approve' } },
    ];
    // Ledger alone is 1; github seed 3 → trust met.
    assert.equal(
        mayAutoMerge({ risk: 'low', repo: 'stash', reviewVerdict: 'approve', rows, trust: 3, githubCount: 3 }).ok,
        true,
    );
    // Ledger 1, github 0 → still short.
    assert.equal(
        mayAutoMerge({ risk: 'low', repo: 'stash', reviewVerdict: 'approve', rows, trust: 3, githubCount: 0 }).ok,
        false,
    );
});

test('earnedTrustCount is max and rejects nonsense', () => {
    assert.equal(earnedTrustCount({ ledgerCount: 2, githubCount: 5 }), 5);
    assert.equal(earnedTrustCount({ ledgerCount: 4, githubCount: 1 }), 4);
    assert.ok(Number.isNaN(earnedTrustCount({ ledgerCount: -1, githubCount: 1 })));
    assert.ok(Number.isNaN(earnedTrustCount({ ledgerCount: 'x', githubCount: 1 })));
});

test('revertedImpNumbers detects Reverts #N and Revert "title"', () => {
    const merged = [
        { number: 10, title: 'imp: fix foo', body: '', mergedAt: '2026-01-01' },
        { number: 11, title: 'imp: fix bar', body: '', mergedAt: '2026-01-02' },
        { number: 12, title: 'Revert "imp: fix foo"', body: 'Reverts #10', mergedAt: '2026-01-03' },
    ];
    const rev = revertedImpNumbers(merged);
    assert.ok(rev.has(10));
    assert.equal(rev.has(11), false);
});

test('countGithubSeedTrust counts green un-reverted imp merges only', () => {
    const green = [{ name: 'CI', state: 'SUCCESS' }];
    const red = [{ name: 'CI', state: 'FAILURE' }];
    const prs = [
        { number: 1, title: 'a', mergedAt: '2026-01-01', labels: ['imp'], checks: green },
        { number: 2, title: 'b', mergedAt: '2026-01-02', labels: ['imp'], checks: red },
        { number: 3, title: 'c', mergedAt: '2026-01-03', labels: ['imp'], checks: [] }, // fail closed: empty
        { number: 4, title: 'd', mergedAt: '2026-01-04', labels: ['other'], checks: green },
        { number: 5, title: 'e', mergedAt: '2026-01-05', labels: [{ name: 'imp' }], checks: green },
        { number: 6, title: 'Revert "a"', body: 'Reverts #1', mergedAt: '2026-01-06', labels: [], checks: green },
    ];
    // #1 reverted, #2 red, #3 empty, #4 not imp, #5 green → 1
    assert.equal(countGithubSeedTrust(prs), 1);
});

test('fetchGithubSeedTrust fail-closed, happy path, and paginates past page 1', () => {
    assert.equal(fetchGithubSeedTrust('', { run: () => ({ code: 0, out: '[]', err: '' }) }).error, 'repoSlug and run() required');

    const boom = fetchGithubSeedTrust('nitsuah/stash', {
        run: () => ({ code: 1, out: '', err: 'api down' }),
    });
    assert.equal(boom.count, 0);
    assert.match(boom.error, /api down|gh api pulls/);

    const calls = [];
    const ok = fetchGithubSeedTrust('nitsuah/stash', {
        need: 1,
        pageSize: 100,
        run: (args) => {
            calls.push(args);
            if (args[0] === 'api') {
                return {
                    code: 0,
                    out: JSON.stringify([
                        {
                            number: 7,
                            title: 'imp: ok',
                            body: '',
                            mergedAt: '2026-02-01T00:00:00Z',
                            labels: ['imp'],
                        },
                        {
                            number: 8,
                            title: 'human',
                            body: '',
                            mergedAt: '2026-02-02T00:00:00Z',
                            labels: [],
                        },
                    ]),
                    err: '',
                };
            }
            if (args[0] === 'pr' && args[1] === 'checks') {
                return { code: 0, out: JSON.stringify([{ name: 'CI', state: 'SUCCESS' }]), err: '' };
            }
            return { code: 1, out: '', err: 'unexpected' };
        },
    });
    assert.equal(ok.error, null);
    assert.equal(ok.count, 1);
    assert.equal(calls.filter((a) => a[0] === 'pr' && a[1] === 'checks').length, 1);

    // Page 1 has only non-imp merges; page 2 has the clean imp — must paginate.
    let pages = 0;
    const paged = fetchGithubSeedTrust('nitsuah/stash', {
        need: 1,
        pageSize: 2,
        maxPages: 5,
        run: (args) => {
            if (args[0] === 'api') {
                pages++;
                const url = args.find((a) => /[?&]page=\d+/.test(a)) || '';
                const page = Number((url.match(/[?&]page=(\d+)/) || [])[1] || 1);
                if (page === 1) {
                    return {
                        code: 0,
                        out: JSON.stringify([
                            { number: 20, title: 'human a', mergedAt: '2026-03-02', labels: [] },
                            { number: 19, title: 'human b', mergedAt: '2026-03-01', labels: [] },
                        ]),
                        err: '',
                    };
                }
                return {
                    code: 0,
                    out: JSON.stringify([
                        { number: 10, title: 'imp: old', mergedAt: '2026-01-01', labels: ['imp'] },
                    ]),
                    err: '',
                };
            }
            if (args[0] === 'pr' && args[1] === 'checks') {
                return { code: 0, out: JSON.stringify([{ name: 'CI', state: 'SUCCESS' }]), err: '' };
            }
            return { code: 1, out: '', err: 'unexpected' };
        },
    });
    assert.equal(paged.error, null);
    assert.equal(paged.count, 1);
    assert.ok(pages >= 2, `expected pagination, got ${pages} page fetch(s)`);
});

test('labelWatchEnabled defaults on with kill switches', () => {
    assert.equal(labelWatchEnabled({}, {}), true);
    assert.equal(labelWatchEnabled({}, { IMPS_LABEL_WATCH: '0' }), false);
    assert.equal(labelWatchEnabled({}, { IMPS_LABEL_WATCH: 'false' }), false);
    assert.equal(labelWatchEnabled({ labelWatch: false }, {}), false);
    assert.equal(labelWatchEnabled({ labelWatch: true }, { IMPS_LABEL_WATCH: '0' }), false);
    assert.equal(DEFAULTS.labelWatchDefault, true);
});

test('DEFAULTS expose the numbers STANDARD.md and CLI must agree on', () => {
    assert.equal(DEFAULTS.maxLines, 180);
    assert.equal(DEFAULTS.perRepo, 6);
    assert.equal(DEFAULTS.concurrency, 6);
    assert.equal(DEFAULTS.wip, 12);
    assert.equal(DEFAULTS.dailyCap, 100);
    assert.equal(DEFAULTS.autoMergeTrust, 3);
    assert.equal(DEFAULTS.kitFolder, '.github');
    assert.equal(DEFAULTS.kitRepo, 'nitsuah/.github');
});

test('mergeReady requires green checks on the commit actually at the head (#55)', () => {
    // stash#305: many green checks, one failure
    const stash305 = [
        { name: 'Validate packages: SUCCESS', state: 'SUCCESS' },
        { name: 'Validate packages', state: 'FAILURE' },
        { name: 'test', state: 'SUCCESS' },
    ];
    const g = evaluateChecks(stash305);
    const bad = mergeReady({ headSha: 'abc', pushedHead: 'abc', checks: stash305 });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, g.reason);

    const moved = mergeReady({ headSha: 'abc', pushedHead: 'def', checks: [{ name: 'test', state: 'SUCCESS' }] });
    assert.equal(moved.ok, false);
    assert.equal(moved.reason, 'head moved since the checks ran');

    const none = mergeReady({ headSha: '', pushedHead: '', checks: [] });
    assert.equal(none.ok, false);
    assert.equal(none.reason, 'no head sha');

    const empty = mergeReady({ headSha: 'abc', pushedHead: 'abc', checks: [] });
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, evaluateChecks([]).reason);

    assert.deepEqual(mergeReady({ headSha: 'abc', pushedHead: 'abc', checks: [{ name: 'test', state: 'SUCCESS' }] }), { ok: true });
});

test('imps folder has no gh pr merge --auto calls (#55)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
    // Match actual gh pr merge --auto calls, not comments/docs or words in strings
    // Use [\s\S]* to match across newlines between merge and --auto
    // Require 'gh' or 'pr' to be at call position, not in comments/strings
    const forbidden = /(?:sh|spawnSync|execSync|run)\([\s\S]*?['"]gh['"]\s*,\s*['"]pr['"]\s*,\s*['"]merge['"][\s\S]*?['"]--auto['"]/;
    for (const f of files) {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        const match = content.match(forbidden);
        assert.equal(match, null, `${f} contains forbidden auto-merge call: ${match?.[0]}`);
    }
});

test('a diff over 100 lines with no test file is never auto-merged', () => {
    const rows = [{ repo: 'stash', outcome: 'merged', gate: { pass: true }, review: { verdict: 'approve' } }];
    const base = { repo: 'stash', reviewVerdict: 'approve', rows, trust: 1 };
    assert.equal(mayAutoMerge({ risk: 'low', ...base, gate: { lines: 130, files: ['app/a.js'] } }).ok, false);
    assert.match(mayAutoMerge({ risk: 'low', ...base, gate: { lines: 130, files: ['app/a.js'] } }).reason, /no test file/);
    assert.equal(mayAutoMerge({ risk: 'low', ...base, gate: { lines: 130, files: ['app/a.js', 'tests/unit/a.test.mjs'] } }).ok, true);
    assert.equal(mayAutoMerge({ risk: 'low', ...base, gate: { lines: 100, files: ['app/a.js'] } }).ok, true, 'at the line, not over');
    assert.equal(mayAutoMerge({ risk: 'low', ...base }).ok, true, 'no gate info: unchanged behaviour');
    assert.equal(bigUntestedDiff({ lines: 101, files: ['x.py', 'test_x.py'] }), false);
    assert.equal(bigUntestedDiff({ lines: 101, files: [] }), true);
    assert.equal(bigUntestedDiff({ lines: 101, files: ['app/a.js', 'tests/fixtures/input.json'] }), true, 'a fixture is not a test file');
    assert.equal(bigUntestedDiff({ lines: 101, files: ['app/a.js', 'tests/unit/a.mjs'] }), false);
});

test('mayAutoMerge: only risk:low is ever auto-merged, and a missing class fails closed', () => {
    const rows = [{ repo: 'r', outcome: 'merged', gate: { pass: true }, review: { verdict: 'approve' } }];
    const ask = (risk) => mayAutoMerge({ repo: 'r', reviewVerdict: 'approve', rows, trust: 1, autoMergeEnv: '1', risk });
    assert.equal(ask('low').ok, true);
    for (const risk of ['medium', 'high', 'LOW', undefined, null]) assert.equal(ask(risk).ok, false, String(risk));
    assert.match(ask('medium').reason, /never auto-merged/);
});

const HEAD = 'a'.repeat(40);
const approval = { sha: HEAD, verdict: 'approve', scope: 'full' };
const merge = (over) => riskMergeGate({ checksGreen: true, headSha: HEAD, ...over });

test('riskMergeGate low: green checks and no open thread', () => {
    assert.equal(merge({ risk: 'low' }).ok, true);
    assert.equal(merge({ risk: 'low', checksGreen: false }).ok, false);
    assert.equal(merge({ risk: 'low', openThreads: 1 }).ok, false);
});

test('riskMergeGate medium: needs a full bugbot approve of this head, plus green CI', () => {
    assert.equal(merge({ risk: 'medium', bugbot: approval }).ok, true);
    assert.equal(merge({ risk: 'medium', bugbot: approval, checksGreen: false }).ok, false);
    for (const bugbot of [null, { ...approval, verdict: 'comment' }, { ...approval, verdict: 'request_changes' }, { ...approval, scope: 'partial' }, { ...approval, sha: 'b'.repeat(40) }])
        assert.equal(merge({ risk: 'medium', bugbot }).ok, false, JSON.stringify(bugbot));
});

test('riskMergeGate high: both reviews of the head and the owner acknowledgement', () => {
    const all = { risk: 'high', bugbot: approval, crApprovedHead: true, ownerAcked: true };
    assert.equal(merge(all).ok, true);
    for (const missing of [{ bugbot: null }, { crApprovedHead: false }, { ownerAcked: false }, { checksGreen: false }])
        assert.equal(merge({ ...all, ...missing }).ok, false, JSON.stringify(missing));
    assert.equal(merge({ ...all, ownerAcked: false }).needsHuman, false, 'both reviews are in: it only waits for the acknowledgement');
    assert.equal(merge({ ...all, crApprovedHead: false }).needsHuman, true);
    assert.equal(merge({ ...all, risk: 'unheard-of', ownerAcked: false }).ok, false, 'an unknown class is treated as high');
});

test('prRisk takes the highest of paths, run record and labels; unreadable paths are high', () => {
    assert.equal(prRisk({ paths: ['README.md'] }), 'low');
    assert.equal(prRisk({ paths: ['README.md'], recorded: 'medium' }), 'medium');
    assert.equal(prRisk({ paths: ['README.md'], labels: [{ name: 'risk:high' }] }), 'high');
    assert.equal(prRisk({ paths: ['src/auth.ts'], recorded: 'low', labels: ['risk:low'] }), 'high', 'a label cannot lower it');
    assert.equal(prRisk({ paths: ['README.md'], error: 'boom' }), 'high');
});

test('fetchPrPaths reads both names of a rename and reports every failure', () => {
    const run = (out, code = 0) => () => ({ code, out, err: code ? 'nope' : '' });
    assert.deepEqual(fetchPrPaths('o/r', 1, { run: run('docs/a.md\tsrc/auth.ts\nb.md\t') }).paths, ['docs/a.md', 'src/auth.ts', 'b.md']);
    assert.equal(fetchPrPaths('o/r', 1, { run: run('', 1) }).error, 'nope');
    assert.ok(fetchPrPaths('o/r', 1, { run: run('') }).error);
    assert.ok(fetchPrPaths('o/r', 1, { run: run(Array(3000).fill('a.md').join('\n')) }).error);
});

test('ownerAcknowledged: the label counts only when an owner added it last', () => {
    const labels = [{ name: 'risk-ack' }];
    const by = (actor, event = 'labeled') => ({ event, actor });
    const ack = (events, l = labels) => ownerAcknowledged({ labels: l, events, owners: ['Nitsuah'] });
    assert.equal(ack([by('nitsuah')]), true);
    assert.equal(ack([by('nitsuah'), by('someone', 'unlabeled'), by('someone')]), false);
    assert.equal(ack([by('github-actions[bot]')]), false);
    assert.equal(ack([]), false);
    assert.equal(ack([by('nitsuah')], []), false, 'the label must still be there');
    assert.deepEqual(fetchAckEvents('o/r', 1, { run: () => ({ code: 1, out: '', err: 'x' }) }), []);
    assert.deepEqual(fetchAckEvents('o/r', 1, { run: () => ({ code: 0, out: 'labeled\tnitsuah\n' }) }), [{ event: 'labeled', actor: 'nitsuah' }]);
});

test('dropStaleAck removes a present risk-ack and throws when the removal fails', () => {
    const calls = [];
    const run = (code) => (args) => { calls.push(args); return { code, out: '', err: 'nope' }; };
    assert.equal(dropStaleAck('o/r', 1, [{ name: 'risk:high' }], { run: run(1) }), false);
    assert.equal(calls.length, 0, 'nothing to remove');
    assert.equal(dropStaleAck('o/r', 1, [{ name: 'risk-ack' }], { run: run(0) }), true);
    assert.deepEqual(calls[0], ['pr', 'edit', '1', '-R', 'o/r', '--remove-label', 'risk-ack']);
    assert.throws(() => dropStaleAck('o/r', 1, ['risk-ack'], { run: run(1) }), /nothing is pushed/);
});
