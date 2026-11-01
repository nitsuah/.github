// Quota is per-machine state in IMPS_HOME with a rolling window (#59). The two
// bugs these pin: a quota file inside the runner checkout (wiped by the hourly
// reset, and dirty-tree'ing the checkout so updates refuse to run), and a
// counter with no refill (which, once it can persist, would stop the fleet for
// good).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Probe the module in a child process so IMPS_HOME is settled before runner.mjs
// computes QUOTA at import time.
function probe(home, body) {
    const spec = pathToFileURL(join(HERE, 'runner.mjs')).href;
    const src = `import { pickModel, reserveQuota, decrementQuota, MODEL_POOL } from ${JSON.stringify(spec)};
const out = (v) => process.stdout.write(JSON.stringify(v));
${body}`;
    const r = spawnSync(process.execPath, ['--input-type=module', '--eval', src], {
        encoding: 'utf8',
        env: { ...process.env, IMPS_HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
}

const home = () => mkdtempSync(join(tmpdir(), 'imps-quota-'));

test('quota file lives in IMPS_HOME and is not tracked in the kit checkout', () => {
    const h = home();
    try {
        probe(h, 'decrementQuota("MAX", 1000); out({});');
        assert.ok(existsSync(join(h, 'model_quota.json')), 'expected IMPS_HOME/model_quota.json');
        // A leftover copy from an older install may still sit in the checkout;
        // what matters is that git does not own it (so a reset cannot restore a
        // stale counter, and the checkout cannot go dirty over it).
        const tracked = spawnSync('git', ['ls-files', '--error-unmatch', 'imps/model_quota.json'], {
            cwd: dirname(HERE),
            encoding: 'utf8',
        });
        assert.notEqual(tracked.status, 0, 'imps/model_quota.json must not be tracked');
    } finally {
        rmSync(h, { recursive: true, force: true });
    }
});

test('fallback strategy reserves MAX first while available; prefer uses the free model first', () => {
    const h = home();
    try {
        const fallback = probe(
            h,
            'const t = 1000; out({ picked: reserveQuota(MODEL_POOL, "fallback", t) });',
        );
        assert.equal(fallback.picked, 'MAX');

        const prefer = probe(
            h,
            'const t = 1000; out({ picked: reserveQuota(MODEL_POOL, "prefer", t) });',
        );
        assert.equal(prefer.picked, 'openrouter/free');
    } finally {
        rmSync(h, { recursive: true, force: true });
    }
});

test('a counter refills in the next window instead of stopping the fleet', () => {
    const h = home();
    try {
        // Same window: exhaust MAX down to zero by writing a spent counter.
        writeFileSync(join(h, 'model_quota.json'), JSON.stringify({ MAX: { used: 999, window: 0 } }));
        const spent = probe(
            h,
            'const t = 1000; for (let i = 0; i < 20; i++) decrementQuota("MAX", t); out({ picked: pickModel(MODEL_POOL, "fallback", t), reserved: reserveQuota(MODEL_POOL, "fallback", t) });',
        );
        assert.equal(spent.picked, 'openrouter/free', 'fallback strategy should use the free model only after MAX is exhausted');
        assert.equal(spent.reserved, 'openrouter/free', 'reservation should follow the configured fallback order');
        const stored = JSON.parse(readFileSync(join(h, 'model_quota.json'), 'utf8'));
        assert.equal(stored['openrouter/free'].used, 1);

        // One window later the same stored counter is stale, so MAX is back.
        const later = 1000 + 24 * 3600_000;
        const refreshed = probe(h, `out({ picked: pickModel(MODEL_POOL, "fallback", ${later}) });`);
        assert.equal(refreshed.picked, 'MAX');
    } finally {
        rmSync(h, { recursive: true, force: true });
    }
});

test('decrementing is contained: never below zero, never above the cap', () => {
    const h = home();
    try {
        probe(h, 'for (let i = 0; i < 5; i++) decrementQuota("MAX", 1); out({});');
        const stored = JSON.parse(readFileSync(join(h, 'model_quota.json'), 'utf8'));
        assert.equal(stored.MAX.used, 5);
    } finally {
        rmSync(h, { recursive: true, force: true });
    }
});
