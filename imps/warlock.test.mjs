// The two breaks WARLOCK.md exists to catch: a runner that is not a clone,
// and an hourly.cmd that launches something else. Both are silent in
// production, so pin them here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'warlock.mjs');

function run(home, extraEnv = {}) {
    const r = spawnSync(process.execPath, [SCRIPT, '--json'], {
        encoding: 'utf8',
        env: { ...process.env, IMPS_HOME: home, IMPS_KIT_PATH: '', ...extraEnv },
    });
    return { code: r.status, json: JSON.parse(r.stdout), text: r.stdout + r.stderr };
}

const byName = (json, name) => json.results.find((r) => r.name === name);

test('a stub runner that is not a git checkout fails the topology check', () => {
    const home = mkdtempSync(join(tmpdir(), 'imps-warlock-'));
    try {
        const runner = join(home, 'runner');
        mkdirSync(join(runner, 'imps'), { recursive: true });
        writeFileSync(join(runner, 'imps', 'dispatch.mjs'), "console.log('stub');\n");
        writeFileSync(join(home, 'kit-path.txt'), runner);

        const { code, json } = run(home);

        assert.equal(byName(json, 'runner has imps/dispatch.mjs').ok, true, 'the file check alone must not be enough');
        const repo = byName(json, 'runner is a git checkout');
        assert.equal(repo.ok, false);
        assert.match(repo.detail, /no \.git/);
        assert.equal(code, 1);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('hourly.cmd that launches a different path fails', () => {
    const home = mkdtempSync(join(tmpdir(), 'imps-warlock-'));
    try {
        const runner = join(home, 'runner');
        mkdirSync(join(runner, 'imps'), { recursive: true });
        writeFileSync(join(runner, 'imps', 'dispatch.mjs'), 'export {};\n');
        writeFileSync(join(home, 'kit-path.txt'), runner);
        writeFileSync(join(home, 'hourly.cmd'), 'set IMPS_KIT_PATH=' + join(home, 'somewhere-else') + '\nnode imps\\dispatch.mjs\n');

        const { json } = run(home);

        const pointed = byName(json, 'hourly.cmd points at the runner');
        assert.equal(pointed.ok, false);
        assert.match(pointed.detail, /somewhere-else/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('no kit-path and no env var is reported, not guessed', () => {
    const home = mkdtempSync(join(tmpdir(), 'imps-warlock-'));
    try {
        const { code, json } = run(home);
        const known = byName(json, 'runner path known');
        assert.equal(known.ok, false);
        assert.match(known.detail, /kit-path\.txt/);
        assert.equal(code, 1);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('Unix dispatch scheduler topology counts exactly one active dispatch scheduler', () => {
    if (process.platform === 'win32') return;
    const home = mkdtempSync(join(tmpdir(), 'imps-warlock-'));
    try {
        const hourly = join(home, 'hourly.sh');
        for (const fixture of [
            { cronLines: ['0 * * * * ' + hourly], systemdActive: false, count: 1 },
            { cronLines: [], systemdActive: true, count: 1 },
            { cronLines: ['0 * * * * ' + hourly], systemdActive: true, count: 2 },
            { cronLines: ['0 * * * * ' + hourly, '30 * * * * ' + hourly], systemdActive: false, count: 2 },
            { cronLines: [], systemdActive: false, count: 0 },
        ]) {
            const { json } = run(home, { IMPS_WARLOCK_TEST_MODE: '1', IMPS_WARLOCK_TEST_FIXTURE: JSON.stringify(fixture) });
            const result = byName(json, 'exactly one dispatch task');
            assert.equal(result.ok, fixture.count === 1);
            assert.equal((result.detail.match(/cron: hourly\.sh/g) || []).length + Number(result.detail.includes('systemd: imps-hourly.timer')), fixture.count);
        }
    } finally { rmSync(home, { recursive: true, force: true }); }
});