import test from 'node:test';
import assert from 'node:assert/strict';
import { servedModelId, modelFamily, expectedFamilies, checkServedModel, probeServedModel, mismatchLine, MODEL_MISMATCH_MARK } from './served-model.mjs';

// Fixture responses shaped like the router's chat completion. No live calls, no keys.
const bodyOnly = { id: 'chatcmpl-1', model: 'nvidia/nemotron-3-super', choices: [{ message: { content: 'o' } }] };
const bodyGlm = { id: 'chatcmpl-2', model: 'glm-4.7-flash', choices: [{ message: { content: 'o' } }] };
const noModelBody = { id: 'chatcmpl-3', choices: [{ message: { content: 'o' } }] };

const fakeFetch = (body, { status = 200, headers = {} } = {}) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
});

test('servedModelId reads the body model field first', () => {
    assert.deepEqual(servedModelId({ body: bodyOnly, headers: new Headers({ 'x-model': 'other' }) }), { id: 'nvidia/nemotron-3-super', source: 'body' });
});

test('servedModelId falls back to x-served-model, then x-model, for Headers and plain objects', () => {
    assert.deepEqual(servedModelId({ body: noModelBody, headers: new Headers({ 'x-served-model': 'glm-4.7-flash' }) }), { id: 'glm-4.7-flash', source: 'header:x-served-model' });
    assert.deepEqual(servedModelId({ body: noModelBody, headers: new Headers({ 'X-Model': 'glm-4.7-flash' }) }), { id: 'glm-4.7-flash', source: 'header:x-model' });
    assert.deepEqual(servedModelId({ body: {}, headers: { 'X-Served-Model': 'abc-1' } }), { id: 'abc-1', source: 'header:x-served-model' });
});

test('servedModelId reports none for malformed or empty responses', () => {
    assert.deepEqual(servedModelId({ body: null, headers: null }), { id: '', source: 'none' });
    assert.deepEqual(servedModelId({ body: { model: 42 }, headers: {} }), { id: '', source: 'none' });
    assert.deepEqual(servedModelId(), { id: '', source: 'none' });
});

test('modelFamily normalizes prefixes, case and versions', () => {
    assert.equal(modelFamily('glm-4.7-flash'), 'glm');
    assert.equal(modelFamily('nvidia/Nemotron-3-super'), 'nemotron');
    assert.equal(modelFamily('cc/claude-sonnet-4-5-20250929'), 'claude');
    assert.equal(modelFamily(''), '');
    assert.equal(modelFamily(undefined), '');
});

test('expectedFamilies reads config, else the env list', () => {
    assert.deepEqual(expectedFamilies({ expectedModelFamilies: ['Nemotron-3', 'claude'] }, {}), ['nemotron', 'claude']);
    assert.deepEqual(expectedFamilies({}, { IMPS_EXPECT_MODEL_FAMILY: 'nemotron, glm' }), ['nemotron', 'glm']);
    assert.deepEqual(expectedFamilies({}, {}), []);
});

test('checkServedModel: match, family mismatch, and cases it cannot judge', () => {
    assert.equal(checkServedModel({ served: 'nvidia/nemotron-3-super', expected: ['nemotron'] }).verdict, 'match');
    const bad = checkServedModel({ served: 'glm-4.7-flash', expected: ['nemotron'] });
    assert.equal(bad.ok, false);
    assert.equal(bad.verdict, 'mismatch');
    assert.equal(bad.family, 'glm');
    assert.equal(checkServedModel({ served: 'glm-4.7-flash', expected: [] }).verdict, 'no-expectation');
    assert.equal(checkServedModel({ served: '', expected: ['nemotron'] }).verdict, 'unknown-served');
    assert.equal(checkServedModel({ served: '', expected: ['nemotron'] }).ok, true);
});

test('probeServedModel: served id in the body matches', async () => {
    const r = await probeServedModel({ baseUrl: 'http://router.test/v1/', key: 'k', expected: ['nemotron'], fetchImpl: fakeFetch(bodyOnly) });
    assert.equal(r.ok, true);
    assert.equal(r.verdict, 'match');
    assert.equal(r.source, 'body');
});

test('probeServedModel: served id only in a header is accepted', async () => {
    const ok = await probeServedModel({ baseUrl: 'http://router.test', expected: ['glm'], fetchImpl: fakeFetch(noModelBody, { headers: { 'x-served-model': 'glm-4.7-flash' } }) });
    assert.equal(ok.verdict, 'match');
    assert.equal(ok.source, 'header:x-served-model');
    const bad = await probeServedModel({ baseUrl: 'http://router.test', expected: ['nemotron'], fetchImpl: fakeFetch(noModelBody, { headers: { 'x-model': 'glm-4.7-flash' } }) });
    assert.equal(bad.ok, false);
    assert.equal(bad.source, 'header:x-model');
});

test('probeServedModel: family mismatch in the body hard-fails with the dispatch marker', async () => {
    const r = await probeServedModel({ baseUrl: 'http://router.test', model: 'MAX', expected: ['nemotron'], fetchImpl: fakeFetch(bodyGlm) });
    assert.equal(r.ok, false);
    assert.equal(r.verdict, 'mismatch');
    const line = mismatchLine(r);
    assert.ok(line.startsWith(MODEL_MISMATCH_MARK));
    assert.match(line, /requested MAX, served glm-4\.7-flash \(family glm\), expected nemotron/);
});

test('probeServedModel: network failure, http error and unreadable body do not read as a mismatch', async () => {
    const down = await probeServedModel({ baseUrl: 'http://router.test', expected: ['nemotron'], fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(down.verdict, 'unreachable');
    assert.equal(down.ok, true);
    const http = await probeServedModel({ baseUrl: 'http://router.test', expected: ['nemotron'], fetchImpl: fakeFetch({}, { status: 503 }) });
    assert.equal(http.verdict, 'unreachable');
    const bad = await probeServedModel({ baseUrl: 'http://router.test', expected: ['nemotron'], fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new Error('bad json'); } }) });
    assert.equal(bad.verdict, 'unknown-served');
    assert.equal(bad.ok, true);
});

test('probeServedModel sends a minimal bounded request and never returns the key', async () => {
    let seen;
    const r = await probeServedModel({
        baseUrl: 'http://router.test/v1', key: 'secret-key', model: 'MAX', expected: ['nemotron'],
        fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200, headers: new Headers(), json: async () => bodyOnly }; },
    });
    assert.equal(seen.url, 'http://router.test/v1/chat/completions');
    assert.equal(JSON.parse(seen.init.body).max_tokens, 1);
    assert.ok(!JSON.stringify(r).includes('secret-key'));
});

test('imp.mjs stops before quota and dispatch puts a mismatch back on imp:ready', async () => {
    const { readFileSync } = await import('node:fs');
    const imp = readFileSync(new URL('./imp.mjs', import.meta.url), 'utf8');
    assert.ok(imp.indexOf('probeServedModel(') < imp.indexOf('reserveQuota(MODEL_POOL, o.modelStrategy'), 'probe runs before quota is reserved');
    const dispatch = readFileSync(new URL('./dispatch.mjs', import.meta.url), 'utf8');
    assert.match(dispatch, /run\.out\.includes\(MODEL_MISMATCH_MARK\)[\s\S]{0,400}relabel\(repo, number, 'imp:ready', \['imp:working'\]\)/);
});
