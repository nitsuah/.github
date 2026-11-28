import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateFailureSignatures, runOutcome, writeTelemetry } from './telemetry.mjs';

const base = { runId: 'imp_20261031_135', repo: 'nitsuah/.github', event: 'run-end', outcome: 'worker-error', failureSignatures: { 'command-failed': 3, other: 1 } };
const tempHome = (t) => { const home = mkdtempSync(join(tmpdir(), 'imps-telemetry-')); t.after(() => rmSync(home, { recursive: true, force: true })); return home; };
const setFlag = (t, value) => { const old = process.env.IMPS_TOOL_TELEMETRY; process.env.IMPS_TOOL_TELEMETRY = value; t.after(() => old === undefined ? delete process.env.IMPS_TOOL_TELEMETRY : process.env.IMPS_TOOL_TELEMETRY = old); };
const events = (home) => readFileSync(join(home, 'telemetry.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('flag off is a no-op', (t) => {
    setFlag(t, 'off'); const home = tempHome(t);
    assert.equal(writeTelemetry({ ...base, home }), false);
    assert.equal(existsSync(join(home, 'telemetry.jsonl')), false);
});

test('append-only schema has null usage/cost', (t) => {
    setFlag(t, 'on'); const home = tempHome(t);
    assert.equal(writeTelemetry({ ...base, home }), true);
    assert.equal(writeTelemetry({ ...base, home, event: 'gate-end', outcome: 'gate-pass', failureSignatures: [] }), true);
    const [run, gate] = events(home);
    assert.deepEqual(Object.keys(run), ['schema', 'runId', 'repo', 'event', 'at', 'outcome', 'failureSignatures', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'estimatedCostUsd']);
    assert.equal(run.schema, 1); assert.equal(run.runId, base.runId); assert.match(run.at, /^\d{4}-\d{2}-\d{2}T/);
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'estimatedCostUsd']) assert.equal(run[k], null);
    assert.equal(gate.event, 'gate-end'); assert.equal(gate.outcome, 'gate-pass');
});

test('raw text and unlisted fields are omitted', (t) => {
    setFlag(t, 'on'); const home = tempHome(t);
    writeTelemetry({ ...base, home, failureSignatures: { 'command-failed': 2, 'token=secret': 1, other: 1 }, prompt: 'private prompt', stderr: 'raw secret', transcript: '/private/transcript.jsonl' });
    const raw = readFileSync(join(home, 'telemetry.jsonl'), 'utf8');
    assert.doesNotMatch(raw, /secret|private prompt|transcript\.jsonl/);
    assert.deepEqual(events(home)[0].failureSignatures, [{ kind: 'command-failed', count: 2 }, { kind: 'other', count: 1 }]);
});

test('signature kinds and counts are bounded', (t) => {
    setFlag(t, 'on'); const home = tempHome(t);
    const kinds = ['edit-miss', 'edit-unread', 'bad-tool-call', 'denied', 'missing-path', 'command-failed', 'timeout', 'other'];
    writeTelemetry({ ...base, home, failureSignatures: Object.fromEntries(kinds.map((k) => [k, 5000])) });
    const signatures = events(home)[0].failureSignatures;
    assert.equal(signatures.length, 8); assert.ok(signatures.every((x) => x.count <= 999));
});

test('gate failures map to coarse categories; worker outcomes are allowlisted', () => {
    const s = gateFailureSignatures(['outside scope app/private/token.js', 'diff 234 lines > 110', 'tests exit 1', 'lint exit 2', 'commit missing imp trailer', 'edits left uncommitted']);
    assert.deepEqual(s.map((x) => x.kind), ['gate-commit-trailer', 'gate-diff-size', 'gate-edits-uncommitted', 'gate-lint-failure', 'gate-scope', 'gate-test-failure']);
    assert.doesNotMatch(JSON.stringify(s), /private|token\.js|234|exit 1/);
    assert.equal(runOutcome({ end: 'success', isError: false }), 'worker-success');
    assert.equal(runOutcome({ end: 'spawn-failed', isError: true }), 'worker-spawn-failed');
    assert.equal(runOutcome({ end: 'unrecognized-secret', isError: true }), 'worker-error');
});

test('telemetry write errors fail open', (t) => {
    setFlag(t, 'on'); const home = tempHome(t); const file = join(home, 'not-a-directory');
    writeFileSync(file, 'occupied');
    assert.equal(writeTelemetry({ ...base, home: file }), false);
});
