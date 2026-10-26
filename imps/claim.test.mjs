// A claim with no lease is the multi-machine failure mode (#60): the machine
// that took the issue dies, the label stays, and no other machine can release
// it because runs.jsonl is per machine. These pin the three conditions a
// reclaim needs and the ones that must never trigger it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimBody, latestClaim, staleClaim, CLAIM_MARK, CLAIM_TTL_MS } from './lib.mjs';

const HOUR = 3600_000;
const at = (ms) => new Date(ms).toISOString();
const claimed = (when, who = 'MACHINE-A') => [{ body: claimBody({ machine: who, at: at(when) }), createdAt: at(when) }];

test('a fresh claim from another machine is not reclaimed', () => {
    const now = 10 * HOUR;
    assert.equal(staleClaim({ labels: ['imp:working'], comments: claimed(now - HOUR), machine: 'B', now }), null);
});

test('a claim older than the TTL from another machine is reclaimed', () => {
    const now = 10 * HOUR;
    const why = staleClaim({ labels: ['imp:working'], comments: claimed(now - CLAIM_TTL_MS - HOUR), machine: 'B', now });
    assert.match(why, /claimed by MACHINE-A/);
});

test('this machine is never reclaimed, however old the claim', () => {
    const now = 10 * HOUR;
    const comments = claimed(now - 48 * HOUR, 'B');
    assert.equal(staleClaim({ labels: ['imp:working'], comments, machine: 'B', now }), null);
});

test('a ledger row here keeps the claim alive while the run may still be going', () => {
    const now = 10 * HOUR;
    const comments = claimed(now - CLAIM_TTL_MS - HOUR, 'A');
    assert.equal(staleClaim({ labels: ['imp:working'], comments, ledgerHasRow: true, machine: 'B', now }), null);
});

test('imp:working with no claim comment is reclaimed once stale — pre-lease claims', () => {
    const now = 10 * HOUR;
    // No comment at all is the old behaviour, before claims were written down.
    assert.match(staleClaim({ labels: ['imp:working'], comments: [], machine: 'B', now }), /no claim comment/);
});

test('an issue not on imp:working is never touched', () => {
    const now = 10 * HOUR;
    assert.equal(staleClaim({ labels: ['imp:ready'], comments: claimed(now - 48 * HOUR), machine: 'B', now }), null);
});

test('latestClaim finds the newest claim, not the brief or a reclaim', () => {
    const comments = [
        { body: '<!-- imp-brief -->\nbrief' },
        { body: claimBody({ machine: 'A', at: at(1) }) },
        { body: '<!-- imp-reclaim -->\nreclaiming' },
        { body: claimBody({ machine: 'B', at: at(2) }) },
    ];
    const latest = latestClaim(comments);
    assert.match(latest.body, /Claimed by `B`/);
    assert.ok(latest.body.startsWith(CLAIM_MARK));
});
