// node --test imps/tune.test.mjs   (no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_SAMPLES, percentile, sizeOnlyShare, suggestMaxLines, suggestions } from './tune.mjs';

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
