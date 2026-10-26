// node --test imps/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateChecks, checksFingerprint, cleanMergesForRepo, mayAutoMerge } from './checks.mjs';
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
});

test('DEFAULTS expose the numbers STANDARD.md and CLI must agree on', () => {
    assert.equal(DEFAULTS.maxLines, 15);
    assert.equal(DEFAULTS.perRepo, 4);
    assert.equal(DEFAULTS.concurrency, 4);
    assert.equal(DEFAULTS.wip, 8);
    assert.equal(DEFAULTS.dailyCap, 15);
    assert.equal(DEFAULTS.autoMergeTrust, 3);
});
