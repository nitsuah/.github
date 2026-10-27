#!/usr/bin/env node
// Does this checkout look like a real imps kit?
//   node imps/preflight.mjs        # exit 1 and say what is missing
//
// Separate from the rest because it must not import anything: the point is to
// run before a runtime that a truncated or stubbed checkout cannot support.
// A stub `dispatch.mjs` used to satisfy the hourly wrapper's existence check
// and produce exit-0 no-ops forever (#62).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Files a checkout must have before any run is meaningful.
const REQUIRED = ['dispatch.mjs', 'imp.mjs', 'runner.mjs', 'lib.mjs', 'defaults.mjs', 'precheck.mjs', 'runtest.mjs', 'fix.mjs', 'PREAMBLE.md', 'STANDARD.md'];

const missing = REQUIRED.filter((f) => !existsSync(join(HERE, f)));

// A stub is small; a real dispatch.mjs is thousands of bytes. Catches the exact
// file that fooled the wrapper, and any future placeholder of the same shape.
const thin = REQUIRED.map((f) => join(HERE, f))
    .filter((p) => existsSync(p) && p.endsWith('.mjs') && readFileSync(p, 'utf8').trim().length < 200);

if (missing.length || thin.length) {
    for (const f of missing) console.error(`!! missing ${join(HERE, f)}`);
    for (const f of thin) console.error(`!! ${f} is too small to be the real kit (stub or truncated)`);
    console.error('!! this checkout is not a usable imps kit — re-run setup.ps1/setup.sh with a fresh -RunnerPath');
    process.exit(1);
}
