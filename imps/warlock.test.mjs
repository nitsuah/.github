// The two breaks WARLOCK.md exists to catch: a runner that is not a clone,
// and an hourly.cmd that launches something else. Both are silent in
// production, so pin them here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'warlock.mjs');

function run(home) {
    const r = spawnSync(process.execPath, [SCRIPT, '--json'], {
        encoding: 'utf8',
        env: { ...process.env, IMPS_HOME: home, IMPS_KIT_PATH: '' },
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

const helperSource = readFileSync(SCRIPT, 'utf8').match(/export function countDispatchSchedulers[\\s\\S]*?\\n}/)?.[0];
assert.ok(helperSource, 'scheduler topology helper is exported');
const countDispatchSchedulers = runInNewContext('(' + helperSource.replace(/^export /, '') + ')');

test('Unix dispatch scheduler topology counts exactly one active dispatch scheduler', () => {
    const hourly = '/home/imps/hourly.sh';
    const cases = [
        { cron: ['0 * * * * ' + hourly, '0 5 * * * /home/imps/label-watch.sh'], systemd: false, count: 1 },
        { cron: [], systemd: true, count: 1 },
        { cron: ['0 * * * * ' + hourly], systemd: true, count: 2 },
        { cron: ['0 * * * * ' + hourly, '30 * * * * ' + hourly], systemd: false, count: 2 },
        { cron: [], systemd: false, count: 0 },
    ];
    for (const fixture of cases) {
        const result = countDispatchSchedulers(fixture.cron, hourly, fixture.systemd);
        assert.equal(result.count, fixture.count);
        assert.equal(result.names.length, fixture.count);
    }
    assert.deepEqual(countDispatchSchedulers(cases[3].cron, hourly, false).names, ['cron: hourly.sh #1', 'cron: hourly.sh #2']);
});
