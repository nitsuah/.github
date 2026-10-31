import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EVENTS = new Set(['run-end', 'gate-end']);
const RUN_OUTCOMES = new Set(['worker-success', 'worker-error', 'worker-timeout', 'worker-killed', 'worker-no-edit-timeout', 'worker-spawn-failed', 'worker-other']);
const FAILURE_KINDS = new Set([
    'edit-miss', 'edit-unread', 'bad-tool-call', 'denied', 'missing-path', 'command-failed', 'timeout', 'other',
    'gate-test-failure', 'gate-test-not-run', 'gate-lint-failure', 'gate-scope', 'gate-diff-size', 'gate-commit-trailer',
    'gate-no-commits', 'gate-edits-uncommitted', 'gate-no-code-change', 'gate-manual-fail', 'gate-other',
]);
const MAX_FAILURES = 8;
const MAX_COUNT = 999;
const safeId = (value) => /^[a-zA-Z0-9_-]{1,80}$/.test(String(value ?? '')) ? String(value) : 'unknown';
const safeRepo = (value) => /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(String(value ?? '')) ? String(value) : 'unknown/unknown';
const safeOutcome = (event, outcome) => event === 'gate-end' ? (outcome === 'gate-pass' ? 'gate-pass' : 'gate-fail') : (RUN_OUTCOMES.has(outcome) ? outcome : 'worker-other');

function normalizeFailureSignatures(input) {
    const entries = Array.isArray(input) ? input.map((x) => [x?.kind, x?.count]) : (input && typeof input === 'object' ? Object.entries(input) : []);
    const counts = new Map();
    for (const [rawKind, rawCount] of entries) {
        const kind = String(rawKind ?? ''), count = Number(rawCount);
        if (!FAILURE_KINDS.has(kind) || !Number.isFinite(count) || count <= 0) continue;
        counts.set(kind, Math.min(MAX_COUNT, (counts.get(kind) || 0) + Math.max(1, Math.trunc(count))));
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_FAILURES).map(([kind, count]) => ({ kind, count }));
}

/** Convert gate reasons to fixed categories; never persist reason text or paths. */
export function gateFailureSignatures(reasons = []) {
    const kinds = new Set();
    for (const r of Array.isArray(reasons) ? reasons : []) {
        if (r === 'edits left uncommitted') kinds.add('gate-edits-uncommitted');
        else if (r === 'no commits') kinds.add('gate-no-commits');
        else if (r.startsWith('denied path ') || r.startsWith('outside scope ')) kinds.add('gate-scope');
        else if (r.startsWith('diff ')) kinds.add('gate-diff-size');
        else if (r === 'commit missing imp trailer') kinds.add('gate-commit-trailer');
        else if (r === 'no code change (docs/screenshot-only diff) for a bug fix') kinds.add('gate-no-code-change');
        else if (r === 'tests not run') kinds.add('gate-test-not-run');
        else if (r.startsWith('tests exit ')) kinds.add('gate-test-failure');
        else if (r.startsWith('lint exit ')) kinds.add('gate-lint-failure');
    }
    if (!kinds.size && reasons?.length) kinds.add('gate-other');
    return [...kinds].sort().slice(0, MAX_FAILURES).map((kind) => ({ kind, count: 1 }));
}

export function runOutcome(metrics = {}) {
    const end = String(metrics.end || '');
    if (end === 'success' && !metrics.isError) return 'worker-success';
    if (end === 'spawn-failed') return 'worker-spawn-failed';
    if (end === 'no-edit-timeout') return 'worker-no-edit-timeout';
    if (/timeout/i.test(end)) return 'worker-timeout';
    if (/killed/i.test(end)) return 'worker-killed';
    return metrics.isError ? 'worker-error' : 'worker-other';
}

/** Append one metadata-only event; all failures are fail-open. */
export function writeTelemetry({ home = process.env.IMPS_HOME || join(homedir(), '.imps'), runId, repo, event, outcome, failureSignatures } = {}) {
    if (process.env.IMPS_TOOL_TELEMETRY !== 'on' || !EVENTS.has(event)) return false;
    try {
        const record = {
            schema: 1, runId: safeId(runId), repo: safeRepo(repo), event, at: new Date().toISOString(),
            outcome: safeOutcome(event, outcome), failureSignatures: normalizeFailureSignatures(failureSignatures),
            inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, estimatedCostUsd: null,
        };
        mkdirSync(home, { recursive: true });
        appendFileSync(join(home, 'telemetry.jsonl'), JSON.stringify(record) + '\n', { encoding: 'utf8' });
        return true;
    } catch {
        return false;
    }
}
