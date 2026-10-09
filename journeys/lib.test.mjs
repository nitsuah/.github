// node --test journeys/*.test.mjs   (no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    errorClass, fingerprint, failingStep, flattenReport, failureOf, readMarker,
    issueBody, issueTitle, plan, bugsMarkdown, coverage, pickImages, FP_MARK, META_MARK, journeyId,
} from './lib.mjs';

test('errorClass is coarse and stable across noisy messages', () => {
    const a = errorClass('Error: expect(locator).toHaveText(expected) failed\n\nExpected: "$25.75"\nReceived: "$25.70"');
    const b = errorClass('Error: expect(locator).toHaveText(expected) failed\n\nExpected: "$9"\nReceived: "$1"');
    assert.equal(a, 'expect:toHaveText');
    assert.equal(a, b);
    assert.equal(errorClass('Error: expect(locator).not.toBeVisible() failed'), 'expect:not.toBeVisible');
    assert.equal(errorClass('TimeoutError: locator.click: Timeout 5000ms exceeded.'), 'timeout:locator.click');
    assert.equal(errorClass('Error: page.goto: Timeout 30000ms exceeded.'), 'timeout:page.goto');
    assert.equal(errorClass('Error: expect(page).toHaveScreenshot(expected) failed\n  1234 pixels (ratio 0.02 of all image pixels) are different.'), 'visual-diff');
    assert.equal(errorClass('TypeError: Cannot read properties of undefined (reading \'x\')'), 'TypeError');
    assert.equal(errorClass('anything', 'timedOut'), 'test-timeout');
    assert.equal(errorClass("Error: A snapshot doesn't exist at /work/tests/x/a.png, writing actual."), 'missing-baseline');
    assert.equal(errorClass('Error: bad file /a/b/c.json here'), errorClass('Error: bad file /d/e.json here'));
    assert.equal(errorClass('Error: seeded 3 rows, wanted 4'), errorClass('Error: seeded 7 rows, wanted 9'));
    assert.equal(errorClass('\u001b[31mTimeoutError\u001b[39m: locator.fill: Timeout 1ms exceeded'), 'timeout:locator.fill');
});

test('fingerprint changes with step/class but not with message noise', () => {
    const base = { repo: 'o/r', file: 'a.spec.js', journey: 'J', step: 'S', errClass: 'expect:toHaveText' };
    assert.equal(fingerprint(base), fingerprint({ ...base }));
    assert.notEqual(fingerprint(base), fingerprint({ ...base, step: 'T' }));
    assert.notEqual(fingerprint(base), fingerprint({ ...base, errClass: 'visual-diff' }));
    assert.match(fingerprint(base), /^[0-9a-f]{12}$/);
});

test('failingStep returns the deepest erroring step path', () => {
    const steps = [
        { title: 'open', steps: [] },
        { title: 'log a sale', error: { message: 'x' }, steps: [{ title: 'fill form', error: { message: 'x' } }] },
    ];
    assert.equal(failingStep(steps), 'log a sale › fill form');
    assert.equal(failingStep([{ title: 'ok' }]), null);
});

// Shape of Playwright's JSON reporter output (trimmed).
const report = {
    suites: [
        {
            title: 'side-hustle.spec.js',
            file: 'side-hustle.spec.js',
            specs: [
                {
                    title: 'reseller logs a sale',
                    file: 'side-hustle.spec.js',
                    tags: ['@feature:platform-fee-calculator', '@area:app'],
                    tests: [
                        {
                            projectName: 'chromium',
                            status: 'unexpected',
                            results: [
                                {
                                    status: 'failed',
                                    error: { message: 'Error: expect(locator).toHaveText(expected) failed' },
                                    steps: [{ title: 'compute profit', error: { message: 'boom' } }],
                                    attachments: [
                                        { name: 'screenshot', contentType: 'image/png', path: '/t/test-failed-1.png' },
                                        { name: 'compute-profit-diff.png', contentType: 'image/png', path: '/t/compute-profit-diff.png' },
                                        { name: 'trace', contentType: 'application/zip', path: '/t/trace.zip' },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
            suites: [
                {
                    title: 'Projections',
                    file: 'side-hustle.spec.js',
                    specs: [
                        { title: 'flips a preset', file: 'side-hustle.spec.js', tags: ['feature:growth-presets'], tests: [{ projectName: 'chromium', status: 'expected', results: [{ status: 'passed' }] }] },
                        { title: 'retries', file: 'side-hustle.spec.js', tags: [], tests: [{ projectName: 'chromium', status: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] }] },
                    ],
                },
            ],
        },
    ],
};

test('flattenReport walks files and describes', () => {
    const recs = flattenReport(report);
    assert.equal(recs.length, 3);
    assert.equal(recs[0].journey, 'reseller logs a sale');
    assert.deepEqual(recs[0].features, ['platform-fee-calculator']);
    assert.equal(recs[1].journey, 'Projections › flips a preset');
    assert.deepEqual(recs[1].features, ['growth-presets']);
    assert.equal(recs[2].status, 'flaky');
    assert.equal(journeyId(recs[1]), 'side-hustle.spec.js › Projections › flips a preset [chromium]');
});

test('failureOf + issue body round-trips markers', () => {
    const [r] = flattenReport(report);
    const f = failureOf('o/r', r);
    assert.equal(f.step, 'compute profit');
    assert.equal(f.errClass, 'expect:toHaveText');
    const meta = { journey: f.journeyId, firstSeen: '2026-10-08', lastSeen: '2026-10-08', occurrences: 1, reopens: 0, greens: 0 };
    const body = issueBody(f, meta, { runUrl: 'https://x/run', greenRuns: 3, images: [] });
    assert.equal(readMarker(body, FP_MARK), f.fp);
    assert.deepEqual(readMarker(body, META_MARK), meta);
    assert.match(issueTitle(f), /^\[journey\] reseller logs a sale › compute profit: expect:toHaveText$/);
});

test('pickImages orders actual/diff/expected and drops non-images', () => {
    const imgs = pickImages(flattenReport(report)[0].attachments);
    assert.deepEqual(imgs.map((i) => i.path), ['/t/compute-profit-diff.png', '/t/test-failed-1.png']);
});

test('plan: create, dedup, reopen, green count and close', () => {
    const recs = flattenReport(report);
    const f = failureOf('o/r', recs[0]);
    const passingId = journeyId(recs[1]);
    const today = '2026-10-09';
    // new failure, listed twice → one create
    let p = plan({ failures: [f, f], records: recs, issues: [], greenRuns: 3, maxNew: 5, today });
    assert.deepEqual(p.actions.map((a) => a.kind), ['create']);
    // already open → update, counts up
    const open = { number: 7, state: 'open', fp: f.fp, labels: [], meta: { journey: f.journeyId, firstSeen: '2026-10-01', occurrences: 2, reopens: 0, greens: 1 } };
    p = plan({ failures: [f], records: recs, issues: [open], greenRuns: 3, maxNew: 5, today });
    assert.equal(p.actions[0].kind, 'update');
    assert.equal(p.actions[0].meta.occurrences, 3);
    assert.equal(p.actions[0].meta.greens, 0);
    // closed → reopen
    p = plan({ failures: [f], records: recs, issues: [{ ...open, state: 'closed' }], greenRuns: 3, maxNew: 5, today });
    assert.equal(p.actions[0].kind, 'reopen');
    assert.equal(p.actions[0].meta.reopens, 1);
    // journey passed → green, then close at N
    const g = { number: 8, state: 'open', fp: 'aaaaaaaaaaaa', labels: [], meta: { journey: passingId, greens: 1 } };
    p = plan({ failures: [], records: recs, issues: [g], greenRuns: 3, maxNew: 5, today });
    assert.deepEqual(p.actions.map((a) => [a.kind, a.meta.greens]), [['green', 2]]);
    p = plan({ failures: [], records: recs, issues: [{ ...g, meta: { ...g.meta, greens: 2 } }], greenRuns: 3, maxNew: 5, today });
    assert.equal(p.actions[0].kind, 'close');
    // journey that didn't run (or was flaky) is left alone
    const gone = { ...g, meta: { journey: 'deleted.spec.js › x [chromium]', greens: 2 } };
    assert.equal(plan({ failures: [], records: recs, issues: [gone], greenRuns: 3, maxNew: 5, today }).actions.length, 0);
    // max-new holds back extras
    const f2 = { ...f, fp: 'bbbbbbbbbbbb' };
    p = plan({ failures: [f, f2], records: recs, issues: [], greenRuns: 3, maxNew: 1, today });
    assert.equal(p.actions.length, 1);
    assert.equal(p.deferred.length, 1);
});

test('plan: harness issue goes green once journeys run again', () => {
    const recs = flattenReport(report);
    const h = { number: 9, state: 'open', fp: 'cccccccccccc', labels: [], meta: { journey: '(harness)', greens: 0 } };
    assert.equal(plan({ failures: [], records: recs, issues: [h], greenRuns: 3, maxNew: 5, today: 'x' }).actions[0].kind, 'green');
    assert.equal(plan({ failures: [], records: [], issues: [h], greenRuns: 3, maxNew: 5, today: 'x' }).actions.length, 0);
});

test('bugsMarkdown groups open issues by area', () => {
    const md = bugsMarkdown({
        repo: 'o/r',
        generatedAt: '2026-10-09',
        runUrl: 'u',
        issues: [
            { number: 3, state: 'open', title: '[journey] a › b: visual-diff', labels: ['bot:journey', 'area:app'], meta: { lastSeen: '2026-10-09' } },
            { number: 4, state: 'open', title: 'Pages hero video has no poster', labels: ['bot:review', 'area:site'] },
            { number: 5, state: 'closed', title: 'gone', labels: ['bot:journey'] },
        ],
    });
    assert.match(md, /## app[\s\S]*#3[\s\S]*## site[\s\S]*#4/);
    assert.doesNotMatch(md, /#5/);
    assert.match(md, /_\(journey · last seen 2026-10-09\)_/);
});

test('coverage counts only user-visible spots.json features', () => {
    const recs = flattenReport(report);
    const c = coverage(recs, [
        { id: 'platform-fee-calculator' },
        { id: 'growth-presets' },
        { id: 'express-server', visual: 'none' },
        { id: 'chaos-mode' },
    ]);
    assert.deepEqual([c.covered, c.total], [2, 3]);
    assert.deepEqual(c.uncovered, ['chaos-mode']);
    assert.equal(coverage(recs, null), null);
});
