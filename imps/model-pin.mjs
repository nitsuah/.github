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

/** A pinned id is its own quota pool, so the id reserved is the id the run launches; a combo uses `pool`. */
export function quotaPool(model, pool) {
    return isComboModel(model) ? pool : { prefer: [], fallback: [model] };
}

/** The only ids a pinned run may request. No expected families means nothing can be vouched for. */
export function allowedRequestModels({ pinned = [], expected = [] } = {}) {
    const families = expected.map(modelFamily).filter(Boolean);
    const ids = (Array.isArray(pinned) ? pinned : []).map((m) => String(m || '').trim());
    return [...new Set(ids.filter((m) => m && !isComboModel(m) && families.includes(modelFamily(m))))];
}

/** More tool errors than this in a failed run earns one retry on another model (.github#388). */
export const RETRY_TOOL_ERRORS = 10;

/**
 * The model for the one retry of a failed run, or null. Only a pinned model other than the
 * failed one that has passed a gate qualifies (the latest pass wins), and a retry is never retried.
 */
export function retryModel({ row, allowed = [], rows = [], now = Date.now() } = {}) {
    if (!row || row.retryOf || row.gate?.pass !== false || !((row.metrics?.toolErrors ?? 0) > RETRY_TOOL_ERRORS)) return null;

    // Use the same six-hour completion window and three-failure bench rule as orderRequestModels.
    const gateAt = (r) => {
        const completed = Date.parse(r.gate?.at || '');
        return Number.isFinite(completed) ? completed : Date.parse(r.startedAt);
    };
    const recent = rows
        .filter((r) => {
            const at = gateAt(r);
            const age = now - at;
            return allowed.includes(r.model) && typeof r.gate?.pass === 'boolean'
                && Number.isFinite(at) && age >= 0 && age < BENCH_WINDOW_MS;
        })
        .sort((a, b) => gateAt(a) - gateAt(b));
    const state = new Map();
    for (const r of recent) {
        const current = state.get(r.model) || { streak: 0, benched: false, lastPassedAt: null };
        if (r.gate.pass) {
            current.streak = 0;
            current.benched = false;
            current.lastPassedAt = gateAt(r);
        } else {
            current.streak++;
            if (current.streak >= 3) current.benched = true;
        }
        state.set(r.model, current);
    }
    return [...state.entries()]
        .filter(([model, status]) => model !== row.model && !status.benched && status.lastPassedAt !== null)
        .sort((a, b) => a[1].lastPassedAt - b[1].lastPassedAt)
        .at(-1)?.[0] ?? null;
}

/**
 * Replays recent gate results from the ledger into the fallback policy: a model with three
 * straight failed gates is benched, and the last known good one is preferred instead.
 * Returns the whole list with that pick first, so the others stay as probe fallbacks.
 */
export function orderRequestModels(models = [], rows = [], now = Date.now()) {
    resetModelState();
    const gateAt = (r) => {
        const completed = Date.parse(r.gate?.at || '');
        return Number.isFinite(completed) ? completed : Date.parse(r.startedAt);
    };
    const recent = rows
        .filter((r) => {
            const at = gateAt(r);
            const age = now - at;
            return models.includes(r.model) && typeof r.gate?.pass === 'boolean'
                && Number.isFinite(at) && age >= 0 && age < BENCH_WINDOW_MS;
        })
        .sort((a, b) => gateAt(a) - gateAt(b));
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
