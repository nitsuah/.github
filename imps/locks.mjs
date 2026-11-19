// Dispatch lock protocol: exclusive create, guarded stale takeover, owner-only
// release and atomic updates. Kept out of dispatch.mjs (a top-level script) so
// it can be tested against a temp directory (#298 review, 2026-11-19).
import { readFileSync, writeFileSync, statSync, rmSync, renameSync } from 'node:fs';

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A lock's text and mtime, or null when it is gone (another cycle can exit between any two reads). */
export function readLock(file) {
    try {
        return { text: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs };
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
}

/** True when `file` still records `owner` ({ pid, startedAt }). */
export function lockOwnedBy(file, owner) {
    const st = readLock(file);
    if (!st) return false;
    try {
        const j = JSON.parse(st.text);
        return j.pid === owner.pid && j.startedAt === owner.startedAt;
    } catch {
        return false;
    }
}

/** Exclusive create: false if the file exists, so two ticks can never both hold one lock. */
export function createLockExclusive(file, info) {
    try {
        writeFileSync(file, JSON.stringify(info), { flag: 'wx' });
        return true;
    } catch (e) {
        if (e.code === 'EEXIST') return false;
        throw e;
    }
}

/**
 * Replace a lock's contents atomically: write a temp file beside it and rename
 * it over, so a reader never sees a truncated lock (and an empty busy list).
 * Windows can refuse the rename while a reader has the file open, so retry briefly.
 * `rename` is injectable so tests can check the lock is untouched until it runs.
 */
export function writeLockAtomic(file, info, { tries = 10, delayMs = 25, rename = renameSync } = {}) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(info));
    for (let n = 1; ; n++) {
        try {
            rename(tmp, file);
            return;
        } catch (e) {
            if (n >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
                rmSync(tmp, { force: true });
                throw e;
            }
            pause(delayMs);
        }
    }
}

/**
 * Remove a stale lock under a short exclusive guard, and only if it is still the
 * stale lock that was read (`seen`): without the guard, two ticks that both saw
 * it stale could each delete it, and the second would delete the first one's
 * fresh lock. Returns true when this call removed it.
 */
export function clearStaleLock(file, seen, { owner, guardMaxAgeMs = 60_000, now = Date.now() } = {}) {
    const guard = `${file}.guard`;
    const g = readLock(guard);
    if (g && now - g.mtimeMs > guardMaxAgeMs) rmSync(guard, { force: true }); // a crashed clearer
    if (!createLockExclusive(guard, owner || { pid: process.pid })) return false;
    try {
        const current = readLock(file);
        if (!current || current.text !== seen.text) return false;
        rmSync(file, { force: true });
        return true;
    } finally {
        rmSync(guard, { force: true });
    }
}

/**
 * Take `file` if it is free or stale. `staleOf(state)` returns why a lock is
 * stale, or null when it is live. `onCleared(why, state)` hears about each
 * stale lock removed. Returns true when the caller now holds the lock.
 */
export function acquireLock(file, info, staleOf, { onCleared = () => {}, attempts = 3 } = {}) {
    for (let n = 0; n < attempts; n++) {
        if (createLockExclusive(file, info)) return true;
        const st = readLock(file);
        if (!st) continue; // released between the create and the read: try again
        const why = staleOf(st);
        if (!why) return false; // live
        if (clearStaleLock(file, st, { owner: info })) onCleared(why, st);
    }
    return false;
}

/** Remove `file` only if `owner` still holds it. Returns true when removed. */
export function releaseLock(file, owner) {
    if (!lockOwnedBy(file, owner)) return false;
    rmSync(file, { force: true });
    return true;
}
