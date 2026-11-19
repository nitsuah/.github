import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoStats, repoNotes, curatedMemory, docsDigest, memorySection, strugglingRepos, isoWeek, CURATED_CAP } from './memory.mjs';

const run = (i, over = {}) => ({ id: `r${i}`, repo: 'fire', issue: 100 + i, startedAt: `2026-11-0${i}T00:00:00Z`, metrics: { turns: 10 + i, end: 'success', errorKinds: {} }, ...over });

test('repoStats counts merges, gate passes and recurring reasons for one repo only', () => {
    const rows = [
        run(1, { outcome: 'merged', gate: { pass: true, reasons: [] } }),
        run(2, { gate: { pass: false, reasons: ['no commits'] }, metrics: { turns: 40, end: 'killed-max-turns', errorKinds: { denied: 6 } } }),
        run(3, { gate: { pass: false, reasons: ['diff 300 lines > 180', 'outside scope config/eslint.config.mjs'] } }),
        { ...run(4), repo: 'vhs' },
    ];
    const s = repoStats(rows, 'fire');
    assert.equal(s.runs, 3);
    assert.equal(s.merged, 1);
    assert.equal(s.passed, 1);
    assert.equal(s.gated, 3);
    assert.equal(s.reasons['diff N lines > N'], 1);
    assert.equal(s.reverted['config/eslint.config.mjs'], 1);
    assert.equal(s.errs.denied, 6);
});

test('repoNotes turns recurring failures into concrete rules and stays capped', () => {
    const rows = [1, 2, 3, 4, 5].map((i) => run(i, {
        gate: { pass: false, reasons: ['no commits', 'tests exit 1', 'diff 400 lines > 180'] },
        outOfScopeReverted: ['config/eslint.config.mjs'],
        strayRemoved: ['test-output.txt'],
        metrics: { turns: 60, end: 'killed-max-turns', errorKinds: { denied: 3, 'missing-path': 2, 'edit-miss': 1 } },
    }));
    const notes = repoNotes(rows, 'fire');
    assert.match(notes[0], /^Last 5 runs here: 0 merged, 0\/5 passed the gate/);
    assert.ok(notes.some((n) => /not committed/.test(n)));
    assert.ok(notes.some((n) => /failed their tests/.test(n)));
    assert.ok(notes.some((n) => /size cap/.test(n)));
    assert.ok(notes.some((n) => /config\/eslint\.config\.mjs/.test(n)));
    assert.ok(notes.some((n) => /turn cap/.test(n)));
    assert.ok(notes.length <= 8);
    assert.deepEqual(repoNotes([], 'fire'), []);
});

test('curatedMemory reads imps/memory/<repo>.md, strips comments, caps, and refuses odd names', () => {
    const files = { 'kit/memory/fire.md': '<!-- note -->\n- lesson one\n' + 'x'.repeat(2000) };
    const read = (p) => files[p.replaceAll('\\', '/')];
    const exists = (p) => p.replaceAll('\\', '/') in files;
    const text = curatedMemory('kit', 'fire', read, exists);
    assert.ok(text.startsWith('- lesson one'));
    assert.equal(text.length, CURATED_CAP);
    assert.equal(curatedMemory('kit', '../etc', read, exists), '');
    assert.equal(curatedMemory('kit', 'vhs', read, exists), '');
});

test('docsDigest keeps rule-like bullets from agent docs and names the files', () => {
    const files = {
        'wt/AGENTS.md': '# Intro\n- not kept\n## Conventions\n- Use escHtml for innerHTML\n- No build step\n## History\n- not kept either\n',
    };
    const read = (p) => files[p.replaceAll('\\', '/')];
    const exists = (p) => p.replaceAll('\\', '/') in files;
    const d = docsDigest('wt', read, exists);
    assert.match(d, /`AGENTS\.md`/);
    assert.match(d, /- Use escHtml for innerHTML/);
    assert.doesNotMatch(d, /not kept/);
    assert.equal(docsDigest('none', read, exists), '');
});

test('memorySection is empty with nothing to say and headed otherwise', () => {
    assert.equal(memorySection({ rows: [], repo: 'fire', kitDir: 'nowhere', wt: 'nowhere', exists: () => false }), '');
    const s = memorySection({ rows: [run(1, { outcome: 'merged', gate: { pass: true, reasons: [] } })], repo: 'fire', exists: () => false });
    assert.match(s, /^## What we know about this repo/);
    assert.match(s, /### From earlier imp runs in fire/);
});

test('strugglingRepos flags low merge rates with enough runs, worst first, weekly key', () => {
    const rows = [
        ...[1, 2, 3, 4].map((i) => run(i, { gate: { pass: false, reasons: ['no commits'] } })),
        ...[1, 2, 3, 4].map((i) => ({ ...run(i, { outcome: 'merged', gate: { pass: true, reasons: [] } }), repo: 'stash' })),
        { ...run(1), repo: 'gcp' },
    ];
    const s = strugglingRepos(rows, { now: Date.UTC(2026, 10, 19) });
    assert.deepEqual(s.map((x) => x.repo), ['fire']);
    assert.equal(s[0].week, '2026-W47');
    assert.ok(s[0].samples.length > 0);
    assert.equal(isoWeek(Date.UTC(2026, 0, 1)), '2026-W01');
});

test('stripComments leaves no comment opener behind, even nested or unterminated', async () => {
    const { stripComments } = await import('./memory.mjs');
    assert.equal(stripComments('a<!-- x -->b'), 'ab');
    assert.equal(stripComments('a<!<!-- x -->-- y -->b'), 'ab');
    assert.equal(stripComments('a<!-- open'), 'a open');
    assert.ok(!stripComments('<!<!--- -->-- -->--').includes('<!--'));
});
