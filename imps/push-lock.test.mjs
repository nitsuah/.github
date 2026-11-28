// Real git, real linked worktrees: the bug was in how git shares config between them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockPush, pushUnlocked } from './push-lock.mjs';

const git = (wt, ...args) => {
    const r = spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8', windowsHide: true });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const ok = (wt, ...args) => {
    const r = git(wt, ...args);
    assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.err}`);
    return r.out;
};

/** A bare remote, the owner's clone of it, and one linked imp worktree. */
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'pushlock-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const remote = join(root, 'remote.git');
    const main = join(root, 'main');
    const wt = join(root, 'imp');
    ok(root, 'init', '-q', '--bare', remote);
    ok(root, 'init', '-q', main);
    ok(main, 'config', 'user.name', 'test');
    ok(main, 'config', 'user.email', 'test@example.invalid');
    ok(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    ok(main, 'remote', 'add', 'origin', remote);
    ok(main, 'worktree', 'add', '-q', wt, '-b', 'imp/1');
    return { remote, main, wt };
}
const pushUrls = (dir) => ok(dir, 'remote', 'get-url', '--push', '--all', 'origin');

test('lockPush blocks the imp worktree and leaves the main checkout able to push', (t) => {
    const { remote, main, wt } = fixture(t);
    lockPush(wt, git);
    assert.equal(pushUrls(wt), 'no_push');
    assert.notEqual(git(wt, 'push', '-q', 'origin', 'imp/1').code, 0);
    assert.equal(pushUrls(main), remote);
    ok(main, 'push', '-q', 'origin', 'HEAD:refs/heads/from-main');
});

test('lockPush heals the shared lock an older kit left behind', (t) => {
    const { remote, main, wt } = fixture(t);
    ok(wt, 'remote', 'set-url', '--push', 'origin', 'no_push');
    assert.equal(pushUrls(main), 'no_push');
    lockPush(wt, git);
    assert.equal(pushUrls(main), remote);
    assert.equal(pushUrls(wt), 'no_push');
});

test('lockPush is repeatable', (t) => {
    const { wt } = fixture(t);
    lockPush(wt, git);
    lockPush(wt, git);
    assert.equal(pushUrls(wt), 'no_push');
});

test('lockPush fails closed when a shared push URL would still receive the push', (t) => {
    const { remote, main, wt } = fixture(t);
    ok(main, 'config', 'remote.origin.pushurl', remote);
    assert.throws(() => lockPush(wt, git), /still pushes to/);
    assert.equal(ok(main, 'config', '--local', 'remote.origin.pushurl'), remote);
});

test('pushUnlocked pushes the branch, then locks the worktree again', (t) => {
    const { remote, main, wt } = fixture(t);
    lockPush(wt, git);
    assert.equal(pushUnlocked(wt, ['-q', '-u', 'origin', 'imp/1'], git).code, 0);
    ok(remote, 'rev-parse', '--verify', 'refs/heads/imp/1');
    assert.equal(pushUrls(wt), 'no_push');
    assert.equal(pushUrls(main), remote);
});

test('pushUnlocked locks again when the push fails', (t) => {
    const { main, remote, wt } = fixture(t);
    lockPush(wt, git);
    assert.notEqual(pushUnlocked(wt, ['-q', 'origin', 'no-such-branch'], git).code, 0);
    assert.equal(pushUrls(wt), 'no_push');
    assert.equal(pushUrls(main), remote);
});
