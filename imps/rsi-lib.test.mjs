// node --test imps/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRsiConfig, rsiEnabled, gateSignature, proposeRsiIssues } from './rsi-lib.mjs';

test('rsiEnabled kill switch', () => {
    assert.equal(rsiEnabled({}, {}), true);
    assert.equal(rsiEnabled({ rsi: false }, {}), false);
    assert.equal(rsiEnabled({}, { IMPS_RSI: '0' }), false);
    assert.equal(rsiEnabled({ rsi: true }, { IMPS_RSI: 'false' }), false);
});

test('parseRsiConfig tolerates bad JSON', () => {
    assert.deepEqual(parseRsiConfig(''), {});
    assert.deepEqual(parseRsiConfig('{'), {});
    assert.equal(parseRsiConfig('{"rsi":false,"rsiDailyIssueCap":1}').rsiDailyIssueCap, 1);
});

test('gateSignature normalises numbers and paths', () => {
    assert.equal(gateSignature('diff 129 lines > 40'), 'diff N lines > N');
    assert.equal(gateSignature('outside scope app/lib/x.js'), 'outside scope <path>');
});

test('proposeRsiIssues: recurring gates, journeys, caps, dedupe', () => {
    const rows = [
        { repo: 'fire', issue: 1, gate: { reasons: ['diff 100 lines > 40'] } },
        { repo: 'fire', issue: 2, gate: { reasons: ['diff 90 lines > 40'] } },
        { repo: 'vhs', issue: 3, gate: { reasons: ['diff 80 lines > 40'] } },
    ];
    const journeys = [
        { repo: 'vigil', number: 9, title: 'Login button broken', body: 'click fails\ntest: docker run --rm node:22 true\n', labels: ['bot:journey'] },
        { repo: 'ats-fill', number: 152, title: 'stale visual baseline', body: 'screenshot', labels: ['bot:journey'] },
        { repo: 'fire', number: 10, title: 'already briefed', body: '<!-- imp-brief -->\nok', labels: ['bot:journey'] },
        { repo: 'vhs', number: 11, title: 'no test command', body: 'broken somehow', labels: ['bot:journey'] },
    ];
    const a = proposeRsiIssues({ rows, journeyIssues: journeys, minRecurrence: 3, dailyCap: 2 });
    assert.equal(a.length, 2);
    assert.equal(a[0].kind, 'gate');
    assert.match(a[0].brief, /allow: imps\/PREAMBLE/);
    assert.match(a[0].brief, /test: node --test/);
    assert.equal(a[1].kind, 'journey');
    assert.equal(a[1].repo, 'vigil');
    assert.match(a[1].brief, /test: docker run/);
    // Baseline / already-briefed / missing-test skipped.
    const b = proposeRsiIssues({ rows, journeyIssues: journeys, minRecurrence: 3, dailyCap: 10 });
    assert.ok(!b.some((p) => p.repo === 'ats-fill'));
    assert.ok(!b.some((p) => /already briefed/.test(p.title)));
    assert.ok(!b.some((p) => /no test command/.test(p.title)));
    // Dedupe by filedKeys / open titles.
    const c = proposeRsiIssues({
        rows, journeyIssues: [], minRecurrence: 3, dailyCap: 5,
        filedKeys: [a[0].key], openRsi: [{ title: a[0].title }],
    });
    assert.equal(c.length, 0);
    // testsByRepo fills in when the issue body has no test:
    const d = proposeRsiIssues({
        rows: [], journeyIssues: [{ repo: 'vhs', number: 11, title: 'no test command', body: 'broken', labels: ['bot:journey'] }],
        dailyCap: 5, testsByRepo: { vhs: 'npm test' },
    });
    assert.equal(d.length, 1);
    assert.match(d[0].brief, /test: npm test/);
});

test('proposeRsiIssues: fix needs-human signal', () => {
    const dispatchLog = [
        { event: 'fix-sweep', result: 'needs-human' },
        { event: 'fix-sweep', result: 'max-rounds' },
        { event: 'fix-sweep', result: 'needs-human after conflict' },
    ];
    const p = proposeRsiIssues({ dispatchLog, minRecurrence: 3, dailyCap: 1 });
    assert.equal(p.length, 1);
    assert.equal(p[0].kind, 'fix');
});
