#!/usr/bin/env node
// tune: derive the kit's thresholds from what the ledger says happened, instead of guessing them.
//   node tune.mjs [--since 7d|24h|all] [--json]
// Prints each threshold with its current value, the value the data supports, and the evidence. It never
// writes anything: defaults.mjs is a guardrail file that only a reviewed PR may change.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULTS } from './defaults.mjs';
import { isSizeOnlyFailure } from './lib.mjs';

// Not runner.mjs's rows(): importing runner.mjs runs its start-up code, which creates directories under IMPS_HOME.
// A read-only report must not write anything, and must still work when that directory cannot be created.
export function readLedgerRows(home = process.env.IMPS_HOME || join(homedir(), '.imps')) {
    const file = join(home, 'runs.jsonl');
    if (!existsSync(file)) return [];
    const out = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            out.push(JSON.parse(line));
        } catch { /* a half-written last line */ }
    }
    return out;
}

export function percentile(values, p) {
    const a = values.filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return null;
    return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}

const roundUp = (n, step) => Math.ceil(n / step) * step;
export const MIN_SAMPLES = 10;

/**
 * The diff cap a brief gets when it does not set one. A cap that a fifth or more of the *passing* runs
 * would have exceeded refuses good work, so take the p90 of passing diffs, rounded up to 10, within [60, 200].
 */
export function suggestMaxLines(passingLines = []) {
    if (passingLines.length < MIN_SAMPLES) return null;
    return Math.min(200, Math.max(60, roundUp(percentile(passingLines, 0.9), 10)));
}

/** Share of failed gated runs that failed only on diff size: how much an automatic cap fix could recover. */
export function sizeOnlyShare(gatedRows = []) {
    const failed = gatedRows.filter((r) => r.gate && !r.gate.pass);
    if (!failed.length) return { share: 0, n: 0, of: 0 };
    const n = failed.filter((r) => isSizeOnlyFailure(r.gate)).length;
    return { share: n / failed.length, n, of: failed.length };
}

/** Everything the report shows, from ledger rows. Pure. */
export function suggestions(all = [], { now = Date.now(), sinceMs = 0 } = {}) {
    const gated = all.filter((r) => /^imp_\d/.test(r.id) && r.gate && (!sinceMs || now - Date.parse(r.startedAt) < sinceMs));
    const passing = gated.filter((r) => r.gate.pass);
    const lines = passing.map((r) => r.gate.lines).filter(Number.isFinite);
    const out = [];
    const maxLines = suggestMaxLines(lines);
    out.push({
        name: 'maxLines (brief fallback)', current: DEFAULTS.maxLines, suggested: maxLines,
        evidence: lines.length ? `p50 ${percentile(lines, 0.5)}, p90 ${percentile(lines, 0.9)}, max ${Math.max(...lines)} lines over ${lines.length} passing runs` : 'no passing runs yet',
    });
    const so = sizeOnlyShare(gated);
    out.push({ name: 'size-only gate failures', current: null, suggested: null, evidence: `${so.n} of ${so.of} failed runs failed only on diff size (${Math.round(so.share * 100)}%)` });
    const mins = passing.map((r) => (r.metrics?.durationMs || 0) / 60000).filter((m) => m > 0);
    if (mins.length) out.push({ name: 'passing run length', current: null, suggested: null, evidence: `p50 ${percentile(mins, 0.5).toFixed(1)} min, p90 ${percentile(mins, 0.9).toFixed(1)} min over ${mins.length} runs` });
    const turns = passing.map((r) => r.metrics?.turns).filter(Number.isFinite);
    if (turns.length) out.push({ name: 'passing run turns', current: null, suggested: null, evidence: `p50 ${percentile(turns, 0.5)}, p90 ${percentile(turns, 0.9)} over ${turns.length} runs` });
    return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { values: o } = parseArgs({ options: { since: { type: 'string', default: 'all' }, json: { type: 'boolean', default: false } } });
    const sinceMs = { all: 0, '24h': 864e5, '7d': 7 * 864e5 }[o.since];
    if (sinceMs === undefined) throw new Error('--since must be 24h, 7d or all');
    const s = suggestions(readLedgerRows(), { sinceMs });
    if (o.json) console.log(JSON.stringify(s, null, 2));
    else {
        for (const x of s) {
            const verdict = x.suggested == null || x.current == null ? '' : x.suggested === x.current ? '  ok' : `  -> suggest ${x.suggested}`;
            console.log(`${x.name}: ${x.current ?? '-'}${verdict}\n    ${x.evidence}`);
        }
    }
}
