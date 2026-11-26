// node --test imps/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseRsiConfig,
    rsiEnabled,
    gateSignature,
    proposeRsiIssues,
    recordModelGateResult,
    selectModel,
    resetModelState,
} from './rsi-lib.mjs';

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

test('rsiDue: flag and env win, config.rsi runs once per UTC day', async () => {
    const { rsiDue } = await import('./rsi-lib.mjs');
    const now = Date.UTC(2026, 10, 19, 12);
    assert.equal(rsiDue({ flag: true, now }), true);
    assert.equal(rsiDue({ env: { IMPS_RSI: '0' }, flag: true, now }), false);
    assert.equal(rsiDue({ config: {}, now }), false);
    assert.equal(rsiDue({ config: { rsi: true }, dispatchLines: [], now }), true);
    assert.equal(rsiDue({ config: { rsi: true }, dispatchLines: ['{"at":"2026-11-19T01:00:00Z","event":"rsi","code":0}'], now }), false);
    assert.equal(rsiDue({ config: { rsi: true }, dispatchLines: ['{"at":"2026-11-18T23:00:00Z","event":"rsi","code":0}'], now }), true);
});

test('proposeRsiIssues files a struggling repo first with a memory-file brief and a stable title', () => {
    const struggling = [{ repo: 'skyview', runs: 4, merged: 0, passed: 0, gated: 3, notes: ['2 runs here ended with work not committed.'], samples: ['skyview#234'], week: '2026-W47' }];
    const out = proposeRsiIssues({ struggling, dailyCap: 3 });
    assert.equal(out[0].kind, 'struggle');
    assert.equal(out[0].title, 'imps RSI: imps keep failing in skyview');
    assert.match(out[0].brief, /allow: imps\/memory\/skyview\.md/);
    assert.equal(proposeRsiIssues({ struggling, openRsi: [{ title: 'imps RSI: imps keep failing in skyview' }] }).filter((p) => p.kind === 'struggle').length, 0);
});

test('model fallback: failure streak 1, 2, 3 and bench', () => {
    resetModelState();
    // Streak 1
    recordModelGateResult('nemotron', false);
    assert.equal(selectModel(['nemotron']), 'nemotron');
    // Streak 2
    recordModelGateResult('nemotron', false);
    assert.equal(selectModel(['nemotron']), 'nemotron');
    // Streak 3 -> benched
    recordModelGateResult('nemotron', false);
    assert.equal(selectModel(['nemotron']), null);
});

test('model fallback: pass resets streak and records last-known-good', () => {
    resetModelState();
    recordModelGateResult('nemotron', false);
    recordModelGateResult('nemotron', false);
    recordModelGateResult('nemotron', true); // pass resets
    assert.equal(selectModel(['nemotron']), 'nemotron');
    // Verify it's last-known-good
    recordModelGateResult('nemotron', false);
    recordModelGateResult('nemotron', false);
    recordModelGateResult('nemotron', false); // benched again
    recordModelGateResult('recursive/flint', true); // another model passes
    assert.equal(selectModel(['nemotron', 'recursive/flint']), 'recursive/flint');
});

test('model fallback: skips benched models in preference order', () => {
    resetModelState();
    recordModelGateResult('nemotron', false);
    recordModelGateResult('nemotron', false);
    recordModelGateResult('nemotron', false); // benched
    recordModelGateResult('recursive/flint', false);
    recordModelGateResult('recursive/flint', false);
    recordModelGateResult('recursive/flint', false); // benched
    recordModelGateResult('particle-ai', true); // passes
    // Should pick particle-ai (first non-benched in list)
    assert.equal(selectModel(['nemotron', 'recursive/flint', 'particle-ai']), 'particle-ai');
});

test('model fallback: falls back to last-known-good when all preferred are benched', () => {
    resetModelState();
    recordModelGateResult('nemotron', true); // last-known-good
    recordModelGateResult('recursive/flint', false);
    recordModelGateResult('recursive/flint', false);
    recordModelGateResult('recursive/flint', false); // benched
    // nemotron not in preferred list, but is last-known-good
    assert.equal(selectModel(['recursive/flint', 'particle-ai']), 'nemotron');
});

test('model fallback: no known-good returns null when all preferred benched', () => {
    resetModelState();
    recordModelGateResult('nemotron', false);
    recordModelGateResult('nemotron', false);
    recordModelGateResult('nemotron', false); // benched
    recordModelGateResult('recursive/flint', false);
    recordModelGateResult('recursive/flint', false);
    recordModelGateResult('recursive/flint', false); // benched
    // No model has ever passed, all preferred are benched
    assert.equal(selectModel(['nemotron', 'recursive/flint']), null);
});
