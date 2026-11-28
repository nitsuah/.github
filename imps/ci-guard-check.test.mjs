import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_NAME, createCheckRun, completeCheckRun } from './ci-guard-check.mjs';

const apiUrl = 'https://api.github.com';
const repo = 'nitsuah/vhs';
const token = 'app-installation-token';
const sha = 'a'.repeat(40);

test('creates an in-progress check under the dedicated App token', async () => {
    let request;
    const result = await createCheckRun({
        apiUrl, repo, token, headSha: sha, pullRequest: 248,
        detailsUrl: 'https://github.com/nitsuah/vhs/actions/runs/123',
        fetchImpl: async (url, options) => {
            request = { url, options };
            return { ok: true, json: async () => ({ id: 987 }) };
        },
    });

    assert.equal(result.id, 987);
    assert.equal(request.url, `${apiUrl}/repos/${repo}/check-runs`);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.Authorization, `Bearer ${token}`);
    const body = JSON.parse(request.options.body);
    assert.equal(body.name, CHECK_NAME);
    assert.equal(body.head_sha, sha);
    assert.equal(body.status, 'in_progress');
    assert.equal(body.external_id, 'risk-guard-pr-248');
});

test('completes the same App check with a success or failure conclusion', async () => {
    let request;
    await completeCheckRun({
        apiUrl, repo, token, checkRunId: 987, conclusion: 'failure',
        summary: 'The no-changelog rule failed.',
        fetchImpl: async (url, options) => {
            request = { url, options };
            return { ok: true, json: async () => ({ id: 987, status: 'completed' }) };
        },
    });

    assert.equal(request.url, `${apiUrl}/repos/${repo}/check-runs/987`);
    assert.equal(request.options.method, 'PATCH');
    const body = JSON.parse(request.options.body);
    assert.equal(body.status, 'completed');
    assert.equal(body.conclusion, 'failure');
    assert.equal(body.output.title, 'Risk guard failed');
});

test('rejects malformed inputs and failed GitHub API responses', async () => {
    await assert.rejects(
        createCheckRun({ apiUrl, repo, token, headSha: 'short', fetchImpl: async () => ({ ok: true, json: async () => ({ id: 1 }) }) }),
        /40-character commit SHA/,
    );
    await assert.rejects(
        completeCheckRun({ apiUrl, repo, token, checkRunId: 1, conclusion: 'cancelled', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }),
        /success or failure/,
    );
    await assert.rejects(
        createCheckRun({ apiUrl, repo, token, headSha: sha, fetchImpl: async () => ({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ message: 'Resource not accessible' }) }) }),
        /403: Resource not accessible/,
    );
});
