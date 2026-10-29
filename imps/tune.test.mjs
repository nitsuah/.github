// node --test imps/tune.test.mjs   (no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_SAMPLES, percentile, readLedgerRows, sizeOnlyShare, suggestMaxLines, suggestions } from './tune.mjs';

test('percentile picks from the sorted values and ignores non-numbers', () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 10);
    assert.equal(percentile([NaN, undefined, 7], 0.5), 7);
    assert.equal(percentile([], 0.5), null);
});

test('suggestMaxLines needs enough samples, rounds the p90 up to 10 and stays within 60-200', () => {
    assert.equal(suggestMaxLines([40, 50]), null, `fewer than ${MIN_SAMPLES} samples: no opinion`);
    const dist = [10, 20, 30, 40, 46, 50, 60, 70, 95, 138];
    assert.equal(suggestMaxLines(dist), 140, 'p90 is 138 here, rounded up to 140');
    assert.equal(suggestMaxLines(Array(12).fill(5)), 60, 'floor');
    assert.equal(suggestMaxLines(Array(12).fill(900)), 200, 'ceiling');
});

test('sizeOnlyShare counts failed runs whose only reasons are diff size', () => {
    const g = (reasons) => ({ gate: { pass: false, reasons } });
    const rows = [g(['diff 136 lines > 100']), g(['diff 70 lines > 60', 'tests exit 1']), g(['lint exit 2']), { gate: { pass: true, reasons: [] } }];
    const s = sizeOnlyShare(rows);
    assert.equal(s.n, 1);
    assert.equal(s.of, 3);
});

test('suggestions reports the maxLines evidence from passing runs only', () => {
    const run = (i, lines, pass = true) => ({ id: `imp_${i}`, repo: 'r', startedAt: '2026-10-29T00:00:00Z', gate: { pass, lines, reasons: pass ? [] : ['x'] }, metrics: { turns: 10 + i, durationMs: 120000 } });
    const rows = [...[10, 20, 30, 40, 46, 50, 60, 70, 95, 138].map((l, i) => run(i, l)), run(99, 900, false)];
    const [maxLines] = suggestions(rows, { now: Date.parse('2026-10-29T12:00:00Z') });
    assert.equal(maxLines.suggested, 140);
    assert.match(maxLines.evidence, /p90 138, max 138 lines over 10 passing runs/);
});

test('readLedgerRows reads the ledger without creating anything and skips a half-written last line', () => {
    const home = mkdtempSync(join(tmpdir(), 'imps-tune-'));
    try {
        assert.deepEqual(readLedgerRows(join(home, 'nope')), [], 'a missing home is an empty ledger');
        assert.equal(existsSync(join(home, 'nope')), false, 'reading must not create the directory');
        writeFileSync(join(home, 'runs.jsonl'), ['{"id":"imp_1"}', '{"id":"imp_2"}', '{"id":"imp_3","ga'].join('\n'));
        assert.deepEqual(readLedgerRows(home).map((r) => r.id), ['imp_1', 'imp_2']);
        assert.deepEqual(readdirSync(home), ['runs.jsonl'], 'nothing else was written');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('importing the helpers without a script path (node -e) does not throw', () => {
    const url = new URL('./tune.mjs', import.meta.url).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { suggestMaxLines } from ${JSON.stringify(url)}; console.log(suggestMaxLines(Array(12).fill(40)))`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '60');
});
