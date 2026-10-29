// node --test imps/demonguard.test.mjs   (no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessPr, HUMAN_AFTER_MS, MIN_AGE_MS } from './demonguard.mjs';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const green = [{ name: 'ci', state: 'SUCCESS' }];
const base = { now: NOW, createdAt: ago(2 * 3600_000), state: 'OPEN', mergeState: 'CLEAN', checks: green, verdict: 'approve', trust: { ok: true, reason: 'earned trust 3/3' } };
const act = (over) => assessPr({ ...base, ...over }).action;

test('a PR that is closed, merged or too young is left alone', () => {
    assert.equal(act({ state: 'MERGED' }), 'none');
    assert.equal(act({ state: 'CLOSED' }), 'none');
    assert.equal(act({ createdAt: ago(MIN_AGE_MS - 60_000) }), 'wait');
});

test('approved + green + earned trust merges; without trust it goes to the owner queue and is never merged', () => {
    assert.equal(act({}), 'merge');
    const r = assessPr({ ...base, trust: { ok: false, reason: 'earned trust 1/3 clean merges for vhs' } });
    assert.equal(r.action, 'owner');
    assert.match(r.reason, /1\/3/);
});

test('checks gate the merge: pending waits, red waits then escalates after a day, none yet waits', () => {
    assert.equal(act({ checks: [{ name: 'ci', state: 'IN_PROGRESS' }] }), 'wait');
    assert.equal(act({ checks: [] }), 'wait');
    assert.equal(act({ checks: [{ name: 'ci', state: 'FAILURE' }] }), 'wait');
    assert.equal(act({ checks: [{ name: 'ci', state: 'FAILURE' }], createdAt: ago(HUMAN_AFTER_MS + 1) }), 'needs-human');
});

test('a missing review is rerun; a non-approve review is left to the fix-sweep, then a human after a day', () => {
    assert.equal(act({ verdict: undefined }), 'rereview');
    assert.equal(act({ verdict: 'request_changes' }), 'wait-fix');
    assert.equal(act({ verdict: 'request_changes', createdAt: ago(HUMAN_AFTER_MS + 1) }), 'needs-human');
});

test('merge conflicts wait for the fix-sweep and escalate after a day', () => {
    assert.equal(act({ mergeState: 'DIRTY' }), 'wait-fix');
    assert.equal(act({ mergeState: 'DIRTY', createdAt: ago(HUMAN_AFTER_MS + 1) }), 'needs-human');
});

test('a bot CHANGES_REQUESTED with no open thread is dismissed; with open threads the PR waits', () => {
    assert.equal(act({ botChangesRequested: true, openThreads: 0 }), 'dismiss-stale-review');
    assert.equal(act({ botChangesRequested: true, openThreads: 2 }), 'wait');
});

test('the order matters: conflicts and a stale bot review are handled before the merge decision', () => {
    assert.equal(act({ mergeState: 'DIRTY', botChangesRequested: true }), 'wait-fix');
    assert.notEqual(act({ botChangesRequested: true, openThreads: 0 }), 'merge');
});
