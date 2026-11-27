#!/usr/bin/env node
// Create the required status under the dedicated GitHub App identity.
// GitHub Actions jobs cannot spoof this check because branch protection pins
// the required context to the separate Nitsuah Risk Guard App.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CHECK_NAME = 'Nitsuah Risk Guard';

function headers(token) {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
}

function validate({ apiUrl, repo, token }) {
    if (!apiUrl || !/^https?:\/\//.test(apiUrl)) throw new Error('GITHUB_API_URL is required');
    if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error('GUARD_REPO must be owner/repo');
    if (!token) throw new Error('CHECK_APP_TOKEN is required');
}

async function request(fetchImpl, url, options) {
    const response = await fetchImpl(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`GitHub check-run API returned ${response.status}: ${payload.message || response.statusText || 'request failed'}`);
    }
    return payload;
}

export async function createCheckRun({
    apiUrl,
    repo,
    token,
    headSha,
    pullRequest,
    detailsUrl = '',
    fetchImpl = fetch,
}) {
    validate({ apiUrl, repo, token });
    if (!/^[0-9a-f]{40}$/i.test(headSha || '')) throw new Error('GUARD_HEAD_SHA must be a 40-character commit SHA');
    const body = {
        name: CHECK_NAME,
        head_sha: headSha,
        status: 'in_progress',
        external_id: `risk-guard-pr-${pullRequest || 'unknown'}`,
        output: {
            title: 'Risk guard running',
            summary: 'Evaluating the pull request using the pinned shared guard.',
        },
    };
    if (detailsUrl) body.details_url = detailsUrl;
    return request(fetchImpl, `${apiUrl}/repos/${repo}/check-runs`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify(body),
    });
}

export async function completeCheckRun({
    apiUrl,
    repo,
    token,
    checkRunId,
    conclusion,
    summary,
    fetchImpl = fetch,
}) {
    validate({ apiUrl, repo, token });
    if (!/^\d+$/.test(String(checkRunId || ''))) throw new Error('CHECK_RUN_ID must be numeric');
    if (!['success', 'failure'].includes(conclusion)) throw new Error('CHECK_CONCLUSION must be success or failure');
    return request(fetchImpl, `${apiUrl}/repos/${repo}/check-runs/${checkRunId}`, {
        method: 'PATCH',
        headers: headers(token),
        body: JSON.stringify({
            status: 'completed',
            conclusion,
            output: {
                title: conclusion === 'success' ? 'Risk guard passed' : 'Risk guard failed',
                summary: String(summary || 'See the trusted workflow run for details.'),
            },
        }),
    });
}

async function main(env = process.env) {
    const common = {
        apiUrl: env.GITHUB_API_URL,
        repo: env.GUARD_REPO,
        token: env.CHECK_APP_TOKEN,
    };
    if (env.CHECK_MODE === 'start') {
        const result = await createCheckRun({
            ...common,
            headSha: env.GUARD_HEAD_SHA,
            pullRequest: env.GUARD_PR,
            detailsUrl: env.GITHUB_RUN_ID
                ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GUARD_REPO}/actions/runs/${env.GITHUB_RUN_ID}`
                : '',
        });
        if (!result.id) throw new Error('GitHub did not return a check-run id');
        if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required to pass the check-run id');
        appendFileSync(env.GITHUB_OUTPUT, `check_run_id=${result.id}\n`);
        return;
    }
    if (env.CHECK_MODE === 'finish') {
        await completeCheckRun({
            ...common,
            checkRunId: env.CHECK_RUN_ID,
            conclusion: env.CHECK_CONCLUSION,
            summary: env.CHECK_SUMMARY,
        });
        return;
    }
    throw new Error('CHECK_MODE must be start or finish');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
