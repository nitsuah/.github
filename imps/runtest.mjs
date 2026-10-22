#!/usr/bin/env node
// The only test command an imp may run: `node <kit>/imps/runtest.mjs`, no
// arguments. It finds the run whose worktree is the current directory and
// runs that brief's `test:` then `lint:` exactly as written, so the imp never
// needs (or gets) a general `docker run` permission. Exit code 0 only if both pass.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { rows, loadBrief } from './runner.mjs';

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
    const r = spawnSync(cmd, { cwd: run.worktree, shell: true, stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    console.log(`── ${name} exit ${r.status}`);
    if (r.status !== 0) code = r.status ?? 1;
}
if (!meta.test && !meta.lint) console.log('runtest: this brief has no test or lint command');
process.exit(code);
