// Request-side model pinning (.github#392). A router combo (`MAX`) can fall through to a free
// auto-router that serves any model, and the post-run audit then throws the whole run away.
// So when expected families are configured, a run asks for one concrete model id, chosen from a
// list filtered by the SAME families the audit checks: an off-list model is never requested.
import { modelFamily, probeServedModel } from './served-model.mjs';
import { recordModelGateResult, selectModel, resetModelState } from './rsi-lib.mjs';

/** Only failures this recent bench a model: the "one batch" of .github#371. */
export const BENCH_WINDOW_MS = 6 * 3600_000;

/** A router combo or alias (`MAX`, `or-free`) has no provider prefix; the router picks behind it. */
export function isComboModel(id) {
    return !String(id || '').includes('/');
}

/** The only ids a pinned run may request. No expected families means nothing can be vouched for. */
export function allowedRequestModels({ pinned = [], expected = [] } = {}) {
    const families = expected.map(modelFamily).filter(Boolean);
    const ids = (Array.isArray(pinned) ? pinned : []).map((m) => String(m || '').trim());
    return [...new Set(ids.filter((m) => m && !isComboModel(m) && families.includes(modelFamily(m))))];
}

/**
 * Replays recent gate results from the ledger into the fallback policy: a model with three
 * straight failed gates is benched, and the last known good one is preferred instead.
 * Returns the whole list with that pick first, so the others stay as probe fallbacks.
 */
export function orderRequestModels(models = [], rows = [], now = Date.now()) {
    resetModelState();
    const recent = rows
        .filter((r) => models.includes(r.model) && typeof r.gate?.pass === 'boolean' && now - Date.parse(r.startedAt) < BENCH_WINDOW_MS)
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    for (const r of recent) recordModelGateResult(r.model, r.gate.pass);
    const pick = selectModel(models, models[0]) ?? models.find((m) => selectModel([m], m) === m) ?? models[0];
    resetModelState();
    return pick ? [pick, ...models.filter((m) => m !== pick)] : [];
}

/**
 * The first candidate that answers with an expected family. If none answers, the first
 * unreachable one is returned so the run reports router trouble itself; if every candidate
 * served another family, the result is that mismatch (`ok: false`).
 */
export async function probeCandidates(candidates, opts = {}, probe = probeServedModel) {
    let unreachable = null;
    let mismatch = null;
    for (const model of candidates) {
        const r = { ...(await probe({ ...opts, model })), model };
        if (!r.ok) mismatch ||= r;
        else if (r.verdict === 'unreachable') unreachable ||= r;
        else return r;
    }
    return unreachable || mismatch;
}

/** Claude Code also makes background calls under its own default model names: pin those too. */
export function pinnedModelEnv(env, model) {
    if (isComboModel(model)) return env;
    const names = ['ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL'];
    return { ...env, ...Object.fromEntries(names.map((n) => [n, model])) };
}
