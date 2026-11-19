// Dispatch lock protocol, against a real temp directory (#298 review).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock, writeLockAtomic, clearStaleLock, readLock, lockOwnedBy } from './locks.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'imps-lock-'));
const me = { pid: 101, startedAt: '2026-11-19T12:00:00Z' };
const you = { pid: 202, startedAt: '2026-11-19T12:01:00Z' };
const neverStale = () => null;
const alwaysStale = () => 'pid-dead';

test('acquireLock: two acquires on one file, only the first succeeds', () => {
    const f = join(dir(), 'dispatch.lock');
    assert.equal(acquireLock(f, me, neverStale), true);
    assert.equal(acquireLock(f, you, neverStale), false);
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).pid, me.pid);
});

test('acquireLock: a live lock is not taken over', () => {
    const f = join(dir(), 'dispatch.lock');
    writeFileSync(f, JSON.stringify(you));
    assert.equal(acquireLock(f, me, neverStale), false);
    assert.ok(lockOwnedBy(f, you));
});

test('acquireLock: a stale lock is cleared once and replaced by the caller', () => {
    const f = join(dir(), 'dispatch.lock');
    writeFileSync(f, JSON.stringify(you));
    const cleared = [];
    assert.equal(acquireLock(f, me, (st) => (JSON.parse(st.text).pid === you.pid ? 'pid-dead' : null), { onCleared: (why) => cleared.push(why) }), true);
    assert.deepEqual(cleared, ['pid-dead']);
    assert.ok(lockOwnedBy(f, me));
    // A second tick that still thinks it is stale does not remove the fresh lock.
    assert.equal(clearStaleLock(f, { text: JSON.stringify(you) }), false);
    assert.ok(lockOwnedBy(f, me));
});

test('clearStaleLock: a held guard blocks a second clearer; a crashed guard expires', () => {
    const d = dir();
    const f = join(d, 'dispatch.lock');
    writeFileSync(f, JSON.stringify(you));
    writeFileSync(`${f}.guard`, '{}');
    assert.equal(clearStaleLock(f, readLock(f)), false);
    assert.ok(existsSync(f));
    assert.equal(clearStaleLock(f, readLock(f), { now: Date.now() + 120_000 }), true);
    assert.equal(existsSync(f), false);
    assert.equal(existsSync(`${f}.guard`), false);
});

test('releaseLock: only the owner can release', () => {
    const f = join(dir(), 'dispatch.lock');
    assert.equal(acquireLock(f, me, alwaysStale), true);
    assert.equal(releaseLock(f, you), false);
    assert.ok(existsSync(f));
    assert.equal(releaseLock(f, me), true);
    assert.equal(existsSync(f), false);
});

test('writeLockAtomic: replaces contents in one step and leaves no temp file', () => {
    const d = dir();
    const f = join(d, 'dispatch.lock');
    acquireLock(f, me, neverStale);
    writeLockAtomic(f, { ...me, busy: ['vhs'] });
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')).busy, ['vhs']);
    assert.ok(lockOwnedBy(f, me));
    assert.deepEqual(readdirSync(d), ['dispatch.lock']);
});
