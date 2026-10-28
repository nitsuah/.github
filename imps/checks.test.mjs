// node --test imps/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    evaluateChecks,
    checksFingerprint,
    mergeReady,
    cleanMergesForRepo,
    mayAutoMerge,
    revertedImpNumbers,
    countGithubSeedTrust,
    earnedTrustCount,
    labelWatchEnabled,
    fetchGithubSeedTrust,
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
    assert.equal(mayAutoMerge({ repo: 'stash', reviewVerdict: 'approve', rows, trust: 3 }).ok, false);
    assert.match(mayAutoMerge({ repo: 'stash', reviewVerdict: 'approve', rows, trust: 3 }).reason, /2\/3/);
    assert.equal(mayAutoMerge({ repo: 'stash', reviewVerdict: 'approve', rows, trust: 2 }).ok, true);
    assert.equal(mayAutoMerge({ repo: 'stash', reviewVerdict: 'comment', rows, trust: 0 }).ok, false);
    assert.equal(mayAutoMerge({ repo: 'stash', reviewVerdict: 'approve', rows, trust: 0, autoMergeEnv: '0' }).ok, false);
    assert.equal(mayAutoMerge({ repo: 'stash', reviewVerdict: 'approve', rows, trust: 'three' }).ok, false);
    assert.equal(mayAutoMerge({ repo: 'stash', reviewVerdict: 'approve', rows, trust: NaN }).ok, false);
});

test('mayAutoMerge fails closed on githubSeedError', () => {
    const r = mayAutoMerge({
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
        mayAutoMerge({ repo: 'stash', reviewVerdict: 'approve', rows, trust: 3, githubCount: 3 }).ok,
        true,
    );
    // Ledger 1, github 0 → still short.
    assert.equal(
        mayAutoMerge({ repo: 'stash', reviewVerdict: 'approve', rows, trust: 3, githubCount: 0 }).ok,
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
    assert.equal(DEFAULTS.maxLines, 80);
    assert.equal(DEFAULTS.perRepo, 6);
    assert.equal(DEFAULTS.concurrency, 6);
    assert.equal(DEFAULTS.wip, 12);
    assert.equal(DEFAULTS.dailyCap, 60);
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
