import test from 'node:test';
import assert from 'node:assert/strict';
import { isComboModel, allowedRequestModels, orderRequestModels, probeCandidates, pinnedModelEnv, quotaPool } from './model-pin.mjs';
import { readFileSync } from 'node:fs';
import { auditServed } from './served-model.mjs';
import { DEFAULTS } from './defaults.mjs';

const expected = ['nemotron', 'north', 'laguna', 'minimax', 'gpt', 'deepseek'];
const A = 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free';
const B = 'groq/openai/gpt-oss-120b';
const now = Date.parse('2026-11-26T12:00:00Z');
const row = (model, pass, minutesAgo) => ({ model, gate: { pass }, startedAt: new Date(now - minutesAgo * 60_000).toISOString() });

test('an off-list model id, a combo and the free auto-router are never requestable', () => {
    const pinned = [A, 'openrouter/openrouter/free', 'openrouter/recursive/flint-v1.0:free', 'openrouter/particle-ai/particle-1:free', 'MAX', 'or-free', '', B, A];
    assert.deepEqual(allowedRequestModels({ pinned, expected }), [A, B]);
    assert.deepEqual(allowedRequestModels({ pinned, expected: [] }), []);
    assert.deepEqual(allowedRequestModels({ pinned: 'nope', expected }), []);
});

test('every default pinned model passes the same audit the gate runs', () => {
    assert.deepEqual(allowedRequestModels({ pinned: DEFAULTS.pinnedModels, expected }), DEFAULTS.pinnedModels);
    assert.equal(auditServed({ served: DEFAULTS.pinnedModels, expected }).ok, true);
});

test('three straight recent gate failures bench a model; older or broken streaks do not', () => {
    assert.deepEqual(orderRequestModels([A, B], [], now), [A, B]);
    assert.deepEqual(orderRequestModels([A, B], [row(A, false, 30), row(A, false, 20), row(A, false, 10)], now), [B, A]);
    assert.deepEqual(orderRequestModels([A, B], [row(A, false, 30), row(A, true, 20), row(A, false, 10)], now), [A, B]);
    assert.deepEqual(orderRequestModels([A, B], [row(A, false, 500), row(A, false, 450), row(A, false, 400)], now), [A, B]);
});

test('with every model benched the list is kept, never emptied', () => {
    const rows = [A, B].flatMap((m) => [row(m, false, 30), row(m, false, 20), row(m, false, 10)]);
    assert.deepEqual(orderRequestModels([A, B], rows, now).sort(), [A, B].sort());
    assert.deepEqual(orderRequestModels([], rows, now), []);
});

test('probeCandidates takes the first reachable match, else unreachable, else the mismatch', async () => {
    const probe = (by) => async ({ model }) => by[model];
    const match = { ok: true, verdict: 'match' };
    const down = { ok: true, verdict: 'unreachable' };
    const bad = { ok: false, verdict: 'mismatch' };
    assert.equal((await probeCandidates([A, B], {}, probe({ [A]: down, [B]: match }))).model, B);
    assert.equal((await probeCandidates([A, B], {}, probe({ [A]: bad, [B]: down }))).model, B);
    assert.equal((await probeCandidates([A, B], {}, probe({ [A]: bad, [B]: bad }))).ok, false);
});

test('the pinned id is what gets reserved and launched, in the run and in commit recovery', () => {
    const combo = { prefer: [], fallback: ['MAX'] };
    assert.deepEqual(quotaPool(A, combo).fallback, [A]);
    assert.equal(quotaPool('MAX', combo), combo);
    assert.doesNotMatch(readFileSync(new URL('./imp.mjs', import.meta.url), 'utf8'), /reserveQuota\(MODEL_POOL/);
});

test('background model names are pinned for a concrete id and untouched for a combo', () => {
    const env = { PATH: 'x' };
    assert.equal(pinnedModelEnv(env, 'MAX'), env);
    assert.equal(pinnedModelEnv(env, A).ANTHROPIC_DEFAULT_HAIKU_MODEL, A);
    assert.equal(isComboModel('or-free'), true);
    assert.equal(isComboModel(A), false);
});
