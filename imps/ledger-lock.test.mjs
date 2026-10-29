// node --test imps/ledger-lock.test.mjs   (no deps)
// The ledger is written by several processes at once (dispatcher, imps, fix-sweeps). update() rewrites the whole
// file and imp.mjs appends a row at run start; without a lock an append between update()'s read and rename is lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = pathToFileURL(join(HERE, 'runner.mjs')).href;

const worker = (home, id, k) => new Promise((resolve, reject) => {
    const code = `
        import { appendRow, update } from ${JSON.stringify(RUNNER)};
        for (let i = 0; i < ${k}; i++) {
            appendRow({ id: 'imp_w${id}_' + i, repo: 'r', issue: 1, n: 0 });
            update('imp_w${id}_' + i, { n: 1 });
            update('imp_counter', (r) => ({ n: r.n + 1 }));
        }`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, IMPS_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`worker ${id} exited ${c}: ${err.slice(-400)}`))));
});

test('concurrent appends and updates from several processes lose nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'imps-lock-'));
    try {
        writeFileSync(join(home, 'runs.jsonl'), JSON.stringify({ id: 'imp_counter', repo: 'r', issue: 0, n: 0 }) + '\n');
        const N = 5, K = 20;
        await Promise.all(Array.from({ length: N }, (_, w) => worker(home, w, K)));
        const rows = readFileSync(join(home, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
        const counter = rows.find((r) => r.id === 'imp_counter');
        assert.equal(rows.length, 1 + N * K, 'every appended row survived');
        assert.equal(counter.n, N * K, 'every counter increment survived');
        assert.ok(rows.filter((r) => r.id.startsWith('imp_w')).every((r) => r.n === 1), 'every per-row update survived');
        assert.equal(existsSync(join(home, 'runs.jsonl.lock')), false, 'the lock file is released');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('a lock left by a dead process is broken, not waited on', async () => {
    const home = mkdtempSync(join(tmpdir(), 'imps-lock-'));
    try {
        writeFileSync(join(home, 'runs.jsonl'), JSON.stringify({ id: 'imp_x', repo: 'r', issue: 1 }) + '\n');
        writeFileSync(join(home, 'runs.jsonl.lock'), String(2 ** 22 + 4242)); // no such pid
        const t0 = Date.now();
        await new Promise((resolve, reject) => {
            const code = `import { update } from ${JSON.stringify(RUNNER)}; update('imp_x', { ok: true });`;
            const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, IMPS_HOME: home }, stdio: 'ignore' });
            p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`))));
        });
        assert.ok(Date.now() - t0 < 10_000, 'did not wait out the stale-lock timeout');
        assert.equal(JSON.parse(readFileSync(join(home, 'runs.jsonl'), 'utf8').trim()).ok, true);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
