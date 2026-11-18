// Served-model identity guard (.github#258). The router answers with the model that actually
// served a request; if that is a different model FAMILY than the one we expect, the run must not
// start (hard fail, issue back on imp:ready, no attempt consumed).
//
// Where the served id lives is not confirmed against the real 9router yet, so both places are
// accepted: the response body `model` field, else an `x-served-model` / `x-model` header.
// Never logs or returns prompts, keys or response content: only the two model ids.

export const SERVED_MODEL_HEADERS = ['x-served-model', 'x-model'];
export const MODEL_MISMATCH_MARK = 'served model mismatch';

function headerValue(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return String(headers.get(name) || '').trim();
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    return key ? String(headers[key] || '').trim() : '';
}

/** Served model id from the response body `model` field, else an x-served-model / x-model header. */
export function servedModelId({ body, headers } = {}) {
    const fromBody = body && typeof body === 'object' && typeof body.model === 'string' ? body.model.trim() : '';
    if (fromBody) return { id: fromBody, source: 'body' };
    for (const name of SERVED_MODEL_HEADERS) {
        const v = headerValue(headers, name);
        if (v) return { id: v, source: `header:${name}` };
    }
    return { id: '', source: 'none' };
}

/**
 * Model family of an id: lowercase, provider prefix ("cc/", "openrouter/x/") dropped, then the first
 * alphabetic token. "glm-4.7-flash" -> "glm", "nvidia/Nemotron-3-super" -> "nemotron",
 * "claude-sonnet-4-5-20250929" -> "claude".
 */
export function modelFamily(id) {
    const last = String(id || '').trim().toLowerCase().split('/').pop();
    return (last.match(/^[a-z]+/) || [''])[0];
}

/** Families the run may be served by: config.expectedModelFamilies, else IMPS_EXPECT_MODEL_FAMILY (comma list). */
export function expectedFamilies(config = {}, env = {}) {
    const raw = Array.isArray(config.expectedModelFamilies) ? config.expectedModelFamilies : String(env.IMPS_EXPECT_MODEL_FAMILY || '').split(',');
    return raw.map((f) => modelFamily(f)).filter(Boolean);
}

/**
 * Compare a served id with the expected families. Only a known served id from a different family
 * is a mismatch; no expectation or no served id cannot be judged and is reported, not failed.
 */
export function checkServedModel({ served, expected = [] } = {}) {
    const families = expected.map(modelFamily).filter(Boolean);
    const id = String(served || '').trim();
    if (!families.length) return { ok: true, verdict: 'no-expectation', served: id };
    if (!id) return { ok: true, verdict: 'unknown-served', served: '', expected: families };
    const family = modelFamily(id);
    if (families.includes(family)) return { ok: true, verdict: 'match', served: id, family };
    return { ok: false, verdict: 'mismatch', served: id, family, expected: families };
}

/**
 * One minimal, bounded completion through the router (same OpenAI-format endpoint as chat()).
 * Returns { ok, verdict, served, source, ... }; a network or HTTP failure is verdict 'unreachable',
 * which is not a mismatch (the normal run reports router trouble itself).
 */
export async function probeServedModel({ baseUrl, key, model = 'MAX', expected = [], fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
    let res;
    let body = {};
    try {
        res = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key || ''}` },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1, stream: false }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        body = await res.json().catch(() => ({}));
    } catch (e) {
        return { ok: true, verdict: 'unreachable', served: '', source: 'none', error: String(e.message || e).slice(0, 120) };
    }
    if (!res.ok) return { ok: true, verdict: 'unreachable', served: '', source: 'none', error: `http-${res.status}` };
    const { id, source } = servedModelId({ body, headers: res.headers });
    return { ...checkServedModel({ served: id, expected }), source, requested: model };
}

/** The line imp.mjs prints and dispatch.mjs matches, so the issue goes back to imp:ready. */
export function mismatchLine(r) {
    return `${MODEL_MISMATCH_MARK}: requested ${r.requested || '?'}, served ${r.served} (family ${r.family}), expected ${r.expected.join('/')}; run stopped before any attempt`;
}
