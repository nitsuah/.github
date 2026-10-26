// A claim with no lease is the multi-machine failure mode (#60): the machine
// that took the issue dies, the label stays, and no other machine can release
// it because runs.jsonl is per machine. A heartbeat is the only honest
// liveness signal a label can carry (#67), and its age is the TTL (#69).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimBody, latestClaim, staleClaim, parseClaim, claimExpired, CLAIM_MARK, CLAIM_HEARTBEAT_TTL_MS } from './lib.mjs';

const HOUR = 3600_000;
const at = (ms) => new Date(ms).toISOString();
const claimed = (when, who = 'MACHINE-A', beat = when) => [{
    body: claimBody({ machine: who, at: at(when), startedAt: at(when), heartbeatAt: at(beat) }),
    createdAt: at(when),
}];

test('a fresh claim from another machine is not reclaimed', () => {
    const now = 10 * HOUR;
    assert.equal(staleClaim({ labels: ['imp:working'], comments: claimed(now - HOUR), machine: 'B', now }), null);
});

test('a claim whose heartbeat stopped past the TTL is reclaimed', () => {
    const now = 10 * HOUR;
    const why = staleClaim({ labels: ['imp:working'], comments: claimed(now - 3 * HOUR), machine: 'B', now });
    assert.match(why, /claimed by MACHINE-A/);
    assert.match(why, /no heartbeat/);
});

test('a long run that keeps its heartbeat is never stolen', () => {
    const now = 10 * HOUR;
    // Started six hours ago, still beating a minute ago: alive, not stranded.
    const comments = claimed(now - 6 * HOUR, 'A', now - 60_000);
    assert.equal(staleClaim({ labels: ['imp:working'], comments, machine: 'B', now }), null);
});

test('this machine is never reclaimed, however old the claim', () => {
    const now = 10 * HOUR;
    const comments = claimed(now - 48 * HOUR, 'B');
    assert.equal(staleClaim({ labels: ['imp:working'], comments, ledgerHasRow: true, machine: 'B', now }), null);
});

test('a ledger row here keeps the claim alive while the run may still be going', () => {
    const now = 10 * HOUR;
    const comments = claimed(now - CLAIM_HEARTBEAT_TTL_MS - HOUR, 'A');
    assert.equal(staleClaim({ labels: ['imp:working'], comments, ledgerHasRow: true, machine: 'B', now }), null);
});

test('a ledger row with endedAt does not protect the claim from another machine', () => {
    const now = 10 * HOUR;
    const comments = claimed(now - CLAIM_HEARTBEAT_TTL_MS - HOUR, 'A');
    assert.match(staleClaim({ labels: ['imp:working'], comments, ledgerHasRow: true, ledgerRow: { endedAt: new Date().toISOString() }, machine: 'B', now }), /claimed by A/);
});

test('a claim from this machine with no local row is reclaimable (crashed before row creation)', () => {
    const now = 10 * HOUR;
    const comments = claimed(now - CLAIM_HEARTBEAT_TTL_MS - HOUR, 'B');
    assert.match(staleClaim({ labels: ['imp:working'], comments, ledgerHasRow: false, machine: 'B', now }), /no local row/);
});

test('a claim from this machine with a row that has endedAt is reclaimable (run finished)', () => {
    const now = 10 * HOUR;
    const comments = claimed(now - CLAIM_HEARTBEAT_TTL_MS - HOUR, 'B');
    assert.match(staleClaim({ labels: ['imp:working'], comments, ledgerHasRow: true, ledgerRow: { endedAt: new Date().toISOString() }, machine: 'B', now }), /run ended/);
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
    assert.match(latest.body, /Imp claim: \*\*B\*\*/);
    assert.ok(latest.body.startsWith(CLAIM_MARK));
});

test('parseClaim reads the hidden JSON line', () => {
    const c = parseClaim(claimBody({ machine: 'DESKTOP-X', startedAt: at(1000), heartbeatAt: at(2000), pr: 'https://x/1' }));
    assert.deepEqual({ machine: c.machine, startedAt: c.startedAt, heartbeatAt: c.heartbeatAt, pr: c.pr }, {
        machine: 'DESKTOP-X', startedAt: at(1000), heartbeatAt: at(2000), pr: 'https://x/1',
    });
    assert.equal(c.legacy, false);
});

test('parseClaim falls back to the prose form, and is null for anything else', () => {
    const old = parseClaim(`${CLAIM_MARK}\nClaimed by \`OLD-BOX\` as \`imp_1\` at ${at(5)}. Released when the run ends;`);
    assert.equal(old.machine, 'OLD-BOX');
    assert.equal(old.legacy, true);
    assert.equal(parseClaim('<!-- imp-brief -->\nnope'), null);
    assert.equal(parseClaim(''), null);
});

test('parseClaim survives a corrupted JSON line instead of throwing', () => {
    const c = parseClaim(`${CLAIM_MARK}\n<!-- imp-claim-meta {"machine":"X", -->\nImp claim: **X**, started ${at(1)}.`);
    assert.equal(c.machine, 'X'); // prose still there
});

test('claimExpired is true only past the TTL, and never for a missing clock', () => {
    const now = 10 * HOUR;
    assert.equal(claimExpired({ heartbeatAt: at(now - CLAIM_HEARTBEAT_TTL_MS - 1) }, now), true);
    assert.equal(claimExpired({ heartbeatAt: at(now - CLAIM_HEARTBEAT_TTL_MS + 1000) }, now), false);
    assert.equal(claimExpired({ heartbeatAt: '' }, now), false);
    assert.equal(claimExpired(null, now), false);
});

// ── the per-machine cycle lock (#68) ──────────────────────────────────────
import { lockBody, lockIsStale, routerWaitDelays } from './lib.mjs';

const live = () => true;
const dead = () => false;

test('a lock held by a live pid on this host is not stale', () => {
    const now = 10 * HOUR;
    const text = lockBody({ pid: 1234, host: 'BOX', startedAt: at(now - 60_000) });
    assert.equal(lockIsStale({ text, now, host: 'BOX', bootTimeMs: now - 5 * HOUR, alive: live }), null);
});

test('a lock whose pid died is stale', () => {
    const now = 10 * HOUR;
    const text = lockBody({ pid: 1234, host: 'BOX', startedAt: at(now - 60_000) });
    assert.equal(lockIsStale({ text, now, host: 'BOX', bootTimeMs: now - 5 * HOUR, alive: dead }), 'pid-dead');
});

test('another host\'s lock is judged by age, never by a pid we cannot see', () => {
    const now = 10 * HOUR;
    const text = lockBody({ pid: 1234, host: 'OTHER', startedAt: at(now - 60_000) });
    assert.equal(lockIsStale({ text, now, host: 'BOX', bootTimeMs: now - 5 * HOUR, alive: dead }), null);
});

test('a lock from before the last boot is stale however recent its mtime', () => {
    const now = 10 * HOUR;
    const text = lockBody({ pid: 1234, host: 'BOX', startedAt: at(now - 5 * HOUR) });
    assert.equal(lockIsStale({ text, now, host: 'BOX', bootTimeMs: now - HOUR, alive: live }), 'before-boot');
});

test('a legacy plain-PID lock falls back to mtime', () => {
    const now = 10 * HOUR;
    assert.equal(lockIsStale({ text: '1234', mtimeMs: now - 1000, now, host: 'BOX', bootTimeMs: now - HOUR, alive: live, maxAgeMs: HOUR }), null);
    assert.equal(lockIsStale({ text: '1234', mtimeMs: now - 2 * HOUR, now, host: 'BOX', bootTimeMs: 0, alive: live, maxAgeMs: HOUR }), 'expired');
    assert.equal(lockIsStale({ text: '1234', mtimeMs: now - 5 * HOUR, now, host: 'BOX', bootTimeMs: now - HOUR, alive: live }), 'before-boot');
});

test('a live lock is still expired once it is older than the backstop', () => {
    const now = 10 * HOUR;
    const text = lockBody({ pid: 1234, host: 'BOX', startedAt: at(now - 4 * HOUR) });
    assert.equal(lockIsStale({ text, now, host: 'BOX', bootTimeMs: now - 5 * HOUR, alive: live }), 'expired');
});

// ── 9router backoff (#65) ─────────────────────────────────────────────────
test('backoff doubles, caps, and never overruns the window', () => {
    const d = routerWaitDelays();
    assert.equal(d[0], 15_000);
    assert.deepEqual(d, [15_000, 30_000, 60_000, 120_000, 120_000, 120_000, 120_000]); // 585s of the 600s window
    assert.ok(d.reduce((a, b) => a + b, 0) <= 600_000);
    assert.ok(routerWaitDelays({ windowMs: 600_000, firstMs: 15_000, maxMs: 120_000 }).reduce((a, b) => a + b, 0) <= 600_000);
});

test('a zero window means no waiting', () => {
    assert.deepEqual(routerWaitDelays({ windowMs: 0 }), []);
});

test('a claim with a PR is not reclaimed', () => {
    const now = 10 * HOUR;
    const comments = claimed(now - 48 * HOUR, 'A');
    // Add a PR to the claim body
    const claimWithPr = [{
        body: claimBody({ machine: 'A', at: at(now - 48 * HOUR), startedAt: at(now - 48 * HOUR), heartbeatAt: at(now - 48 * HOUR), pr: 'https://github.com/nitsuah/.github/pull/123' }),
        createdAt: at(now - 48 * HOUR),
    }];
    assert.equal(staleClaim({ labels: ['imp:working'], comments: claimWithPr, machine: 'B', now }), null);
});
