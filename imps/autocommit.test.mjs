// The runner commits an imp's in-scope work itself (#256).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoCommitScoped, RUNNER_COMMIT_TRAILER } from './runner.mjs';

const run = (wt, ...args) => spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8' });

function repo() {
    const wt = mkdtempSync(join(tmpdir(), 'autocommit-'));
    run(wt, 'init', '-q', '-b', 'main');
    run(wt, 'config', 'user.email', 'imp@example.com');
    run(wt, 'config', 'user.name', 'imp');
    run(wt, 'config', 'commit.gpgsign', 'false');
    mkdirSync(join(wt, 'src'));
    writeFileSync(join(wt, 'src', 'a.js'), 'export const a = 1;\n');
    writeFileSync(join(wt, 'package-lock.json'), '{}\n');
    run(wt, 'add', '-A');
    run(wt, 'commit', '-q', '-m', 'base');
    return wt;
}

test('autoCommitScoped commits edited and new in-scope files with the imp trailer', () => {
    const wt = repo();
    try {
        writeFileSync(join(wt, 'src', 'a.js'), 'export const a = 2;\n');
        writeFileSync(join(wt, 'src', 'b.test.js'), 'export {};\n');
        const r = autoCommitScoped(wt, ['src/'], 256);
        assert.equal(r.pass, true, r.reason);
        assert.deepEqual([...r.paths].sort(), ['src/a.js', 'src/b.test.js']);
        assert.equal(run(wt, 'status', '--porcelain').stdout.trim(), '');
        assert.equal(run(wt, 'rev-list', '--count', 'HEAD').stdout.trim(), '2');
        const msg = run(wt, 'log', '-1', '--format=%B').stdout;
        assert.match(msg, /^imp: work for #256 \(runner commit\)/);
        assert.equal(msg.trimEnd().split(/\r?\n/).at(-1), RUNNER_COMMIT_TRAILER);
    } finally { rmSync(wt, { recursive: true, force: true }); }
});

test('autoCommitScoped refuses a tree it cannot leave clean (an allowed lockfile edit stays denied)', () => {
    const wt = repo();
    try {
        writeFileSync(join(wt, 'src', 'a.js'), 'export const a = 3;\n');
        writeFileSync(join(wt, 'package-lock.json'), '{"x":1}\n');
        const r = autoCommitScoped(wt, ['src/', 'package-lock.json'], 256);
        assert.equal(r.pass, false);
        assert.match(r.reason, /not clean/);
        assert.deepEqual(r.paths, ['src/a.js']);
    } finally { rmSync(wt, { recursive: true, force: true }); }
});

test('autoCommitScoped does nothing when no changed path is in scope or the tree is clean', () => {
    const wt = repo();
    try {
        assert.equal(autoCommitScoped(wt, ['src/'], 256).pass, false);
        writeFileSync(join(wt, 'other.txt'), 'x\n');
        const r = autoCommitScoped(wt, ['src/'], 256);
        assert.equal(r.pass, false);
        assert.match(r.reason, /no in-scope/);
        assert.equal(run(wt, 'rev-list', '--count', 'HEAD').stdout.trim(), '1');
    } finally { rmSync(wt, { recursive: true, force: true }); }
});
