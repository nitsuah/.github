#!/usr/bin/env node
// Fail if STANDARD.md / README / CLI headers disagree with defaults.mjs.
//   node imps/check-defaults.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from './defaults.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const std = readFileSync(join(HERE, 'STANDARD.md'), 'utf8');
const readme = readFileSync(join(HERE, 'README.md'), 'utf8');
const dispatch = readFileSync(join(HERE, 'dispatch.mjs'), 'utf8');
const errors = [];

const need = [
    [`per-repo ${DEFAULTS.perRepo}`, new RegExp(`--per-repo\\s+${DEFAULTS.perRepo}`)],
    [`concurrency ${DEFAULTS.concurrency}`, new RegExp(`--concurrency\\s+${DEFAULTS.concurrency}`)],
    [`wip ${DEFAULTS.wip}`, new RegExp(`--wip\\s+${DEFAULTS.wip}`)],
    [`daily-cap ${DEFAULTS.dailyCap}`, new RegExp(`${DEFAULTS.dailyCap}[^\\n]*--daily-cap|--daily-cap[^\\n]*${DEFAULTS.dailyCap}`, 'i')],
    [`maxLines default ${DEFAULTS.maxLines}`, new RegExp(`maxLines[^\\n]*default[^\\n]*${DEFAULTS.maxLines}|default[^\\n]*${DEFAULTS.maxLines}[^\\n]*maxLines`, 'i')],
    [`autoMergeTrust ${DEFAULTS.autoMergeTrust}`, new RegExp(`(earned.?trust|autoMergeTrust)[^\\n]*${DEFAULTS.autoMergeTrust}|${DEFAULTS.autoMergeTrust}[^\\n]*(clean merged|autoMergeTrust|earned)`, 'i')],
    ['maxTurns ' + DEFAULTS.maxTurns, new RegExp('Turn cap per model run[^\\n]*imp ' + DEFAULTS.maxTurns)],
    ['noEditTurns ' + DEFAULTS.noEditTurns, new RegExp('No-edit fail-fast[^\\n]*' + DEFAULTS.noEditTurns + ' tool calls')],
];

for (const [label, re] of need) {
    if (!re.test(std)) errors.push(`STANDARD.md missing/outdated: ${label}`);
}
if (!readme.includes(`maxLines fallback **${DEFAULTS.maxLines}**`)) {
    errors.push(`README.md missing/outdated: maxLines fallback ${DEFAULTS.maxLines}`);
}

// dispatch header comment should match DEFAULTS
const header = dispatch.split('\n').slice(0, 12).join('\n');
if (!header.includes(`--per-repo ${DEFAULTS.perRepo}`)) errors.push(`dispatch.mjs header --per-repo != ${DEFAULTS.perRepo}`);
if (!header.includes(`--concurrency ${DEFAULTS.concurrency}`)) errors.push(`dispatch.mjs header --concurrency != ${DEFAULTS.concurrency}`);

if (errors.length) {
    console.error(errors.map((e) => `✗ ${e}`).join('\n'));
    process.exit(1);
}
console.log(`defaults ok (maxLines=${DEFAULTS.maxLines} perRepo=${DEFAULTS.perRepo} concurrency=${DEFAULTS.concurrency} trust=${DEFAULTS.autoMergeTrust})`);
