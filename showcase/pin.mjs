#!/usr/bin/env node
// Prints the commit-pinned, integrity-checked tag that loads showcase/expand.js.
//   node showcase/pin.mjs [commit]    default: the last commit on origin/main that changed it
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const FILE = 'showcase/expand.js';

/** The tag for `commit`, hashed from the exact bytes the CDN serves for it. */
export function pinnedTag(commit, content) {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`need a full commit SHA, got "${commit}"`);
    const hash = createHash('sha384').update(content).digest('base64');
    return `<script src="https://cdn.jsdelivr.net/gh/nitsuah/.github@${commit}/${FILE}" integrity="sha384-${hash}" crossorigin="anonymous" defer></script>`;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const git = (...args) => execFileSync('git', args);
    const last = process.argv[2] ? `${process.argv[2]}^{commit}` : String(git('log', '-1', '--format=%H', 'origin/main', '--', FILE)).trim();
    if (!last) { console.error(`no commit on origin/main changed ${FILE}; run git fetch origin, or pass a commit`); process.exit(1); }
    const commit = String(git('rev-parse', '--verify', last)).trim();
    console.log(pinnedTag(commit, git('show', `${commit}:${FILE}`)));
}
