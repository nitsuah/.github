#!/usr/bin/env node
// The only test command an imp may run: `node <kit>/imps/runtest.mjs`, no
// arguments. It finds the run whose worktree is the current directory and
// runs that brief's `test:` then `lint:` exactly as written, so the imp never
// needs (or gets) a general `docker run` permission. Exit code 0 only if both pass.
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, fstatSync, readSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { rows, loadBrief, gateShell } from './runner.mjs';
import { lastLines } from './lib.mjs';

// The last 256 KiB of a file (enough for 60 lines of any normal log), without reading the whole thing.
function readTail(path, bytes = 256 * 1024) {
    const fd = openSync(path, 'r');
    try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - bytes);
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        return buf.toString('utf8');
    } finally {
        closeSync(fd);
    }
}

const here = resolve(process.cwd()).replaceAll('\\', '/').toLowerCase();
const run = rows()
    .filter((r) => r.worktree && resolve(r.worktree).replaceAll('\\', '/').toLowerCase() === here && r.brief)
    .pop();
if (!run) {
    console.error(`runtest: no imp run uses ${process.cwd()} as its worktree`);
    process.exit(2);
}
const { meta } = loadBrief(run.brief, run.worktree);
let code = 0;
for (const [name, cmd] of [['test', meta.test], ['lint', meta.lint]]) {
    if (!cmd) continue;
    console.log(`── ${name}: ${cmd}`);
    // Only the tail is printed: a full vitest/eslint log per re-run is what filled the imps' context and turn budget.
    // Output goes to a file in a private temp directory, not a pipe: no buffer limit can turn a passing command into a failure,
    // the file is created exclusively and owner-only, and only the end is read back.
    const dir = mkdtempSync(join(tmpdir(), 'runtest-'));
    const outPath = join(dir, `${name}.log`);
    let tail = '';
    let status;
    try {
        const fd = openSync(outPath, 'wx', 0o600);
        const r = spawnSync(cmd, { cwd: run.worktree, shell: gateShell(), stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
        closeSync(fd);
        status = r.status;
        tail = readTail(outPath);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    console.log(lastLines(tail));
    console.log(`── ${name} exit ${status}`);
    if (status !== 0) code = status ?? 1;
}
if (!meta.test && !meta.lint) console.log('runtest: this brief has no test or lint command');
process.exit(code);
