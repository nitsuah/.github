// The imp worktree's push lock. Linked worktrees share .git/config, so
// `git remote set-url --push origin no_push` run inside one also disabled push
// in the owner's main checkout and in every scheduled job that pushes from it.
// The lock lives in the worktree's own config (config.worktree) instead.
import { git as runGit } from './runner.mjs';

const KEY = 'remote.origin.pushurl';
const LOCK = 'no_push';
const UNSET_NOTHING = 5; // `git config --unset-all` found no matching value

function must(r, what) {
    if (r.code) throw new Error(`${what}: ${r.err}`);
    return r;
}

export function lockPush(wt, git = runGit) {
    must(git(wt, 'config', 'extensions.worktreeConfig', 'true'), 'could not enable worktree config');
    // Heal a lock an older kit left in the shared config. Only that exact value:
    // a real push URL set by the owner stays.
    const heal = git(wt, 'config', '--local', '--unset-all', KEY, `^${LOCK}$`);
    if (heal.code && heal.code !== UNSET_NOTHING) throw new Error(`could not clear the shared push lock: ${heal.err}`);
    must(git(wt, 'config', '--worktree', '--replace-all', KEY, LOCK), 'could not disable push');
    // pushurl is multi-valued: a shared one would still receive the push.
    const urls = must(git(wt, 'remote', 'get-url', '--push', '--all', 'origin'), 'could not read push URLs').out;
    if (urls !== LOCK) throw new Error(`could not disable push: origin still pushes to ${urls.split('\n').join(', ')}`);
}

/** Lift the lock for one `git push`, then put it back whether or not the push worked. */
export function pushUnlocked(wt, args, git = runGit) {
    // A worktree made by an older kit has no worktree-level lock yet.
    lockPush(wt, git);
    must(git(wt, 'config', '--worktree', '--unset-all', KEY), 'could not lift the push lock');
    try {
        return git(wt, 'push', ...args);
    } finally {
        lockPush(wt, git);
    }
}
