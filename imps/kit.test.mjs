// Kit-wide guards for the bug class seen in dispatch.jsonl: a name used but never
// imported or declared (`isGitDirty is not defined`, `MACHINE is not defined`)
// only blows up at runtime, mid-cycle. Plus the no-edit fail-fast knob.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from './defaults.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(HERE, f), 'utf8');
const exported = (f) => new Set([...src(f).matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+(\w+)/gm)].map((m) => m[1]));

test('every named import from a sibling module resolves to an export', () => {
    for (const f of readdirSync(HERE).filter((x) => x.endsWith('.mjs') && !x.endsWith('.test.mjs'))) {
        for (const m of src(f).matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w.-]+\.mjs)'/g)) {
            const have = exported(m[2]);
            for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean))
                assert.ok(have.has(name), `${f} imports ${name} from ${m[2]}, which does not export it`);
        }
    }
});

test('dispatch.mjs declares MACHINE, which the claim heartbeat and stranded-claim sweep use', () => {
    assert.match(src('dispatch.mjs'), /\bconst MACHINE\b/);
});

test('imp.mjs imports isGitDirty, which the ledger row provenance calls', () => {
    assert.match(src('imp.mjs'), /import \{[^}]*\bisGitDirty\b[^}]*\} from '\.\/runner\.mjs'/);
    assert.ok(exported('runner.mjs').has('isGitDirty'));
});

test('no-edit fail-fast is on by default and configurable', async () => {
    assert.equal(DEFAULTS.noEditTurns, 20);
    const { resolveNoEditTurns } = await import('./runner.mjs');
    assert.equal(resolveNoEditTurns({}, {}), 20);
    assert.equal(resolveNoEditTurns({ noEditTurns: 12 }, {}), 12);
    assert.equal(resolveNoEditTurns({ noEditTurns: 12 }, { IMPS_NO_EDIT_TURNS: '5' }), 5);
    assert.equal(resolveNoEditTurns({ noEditTurns: 0 }, {}), 0); // 0 turns it off
    assert.equal(resolveNoEditTurns({}, { IMPS_NO_EDIT_TURNS: '' }), 20); // empty is unset, not 0
    assert.equal(resolveNoEditTurns({ noEditTurns: 7 }, { IMPS_NO_EDIT_TURNS: '  ' }), 7);
    assert.equal(resolveNoEditTurns({}, { IMPS_NO_EDIT_TURNS: '0' }), 0); // explicit 0 still disables
    assert.equal(resolveNoEditTurns({ noEditTurns: 'x' }, {}), 20); // junk falls back
});

test('max-turn cap is configurable and zero disables it', async () => {
    assert.equal(DEFAULTS.maxTurns, 60);
    const { resolveMaxTurns } = await import('./runner.mjs');
    assert.equal(resolveMaxTurns({}, {}), 60);
    assert.equal(resolveMaxTurns({ maxTurns: 25 }), 25);
    assert.equal(resolveMaxTurns({ maxTurns: 0 }), 0);
    assert.equal(resolveMaxTurns({ maxTurns: '0' }), 0);
    assert.equal(resolveMaxTurns({ maxTurns: '' }), 60);
    assert.equal(resolveMaxTurns({ maxTurns: 'invalid' }), 60);
});


test('dispatch skips missing target checkouts before pickIssues and logs only locally', () => {
    const dispatch = src('dispatch.mjs');
    const preflightAt = dispatch.indexOf('targetCheckout(i.repo');
    const pickAt = dispatch.indexOf('const batch = pickIssues');
    assert.ok(preflightAt >= 0, 'dispatcher invokes the checkout preflight');
    assert.ok(pickAt > preflightAt, 'preflight occurs before pickIssues slot accounting');
    assert.match(dispatch, /event: 'skip-missing-checkout'/);
    assert.match(dispatch, /const codeRoot = resolveImpsCodeRoot\(\)/);
    assert.match(dispatch, /queuedBeforePreflight: queuedRaw\.length/);
    const preflightBlock = dispatch.slice(preflightAt, pickAt);
    assert.doesNotMatch(preflightBlock, /\b(?:comment|relabel|work)\s*\(/, 'missing checkout handling must not comment, relabel, or claim');
});
