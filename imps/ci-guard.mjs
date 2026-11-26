#!/usr/bin/env node
// The CI half of the risk controls, run by .github/workflows/risk-guard.yml on a
// caller's pull request. It reads the PR through the API and never checks out or
// runs the PR's code. Rules: imps/STANDARD.md § Risk controls.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDocPath } from './lib.mjs';
import { prRisk, fetchPrPaths, fetchAckEvents, ownerAcknowledged, RISK_ACK_LABEL } from './checks.mjs';

export const NO_CHANGELOG_LABEL = 'no-changelog';
const CHANGELOG = /^(docs\/)?CHANGELOG\.md$/i;

/** Why the PR fails the guard; an empty list passes. `error` is a failed file listing. */
export function guardFailures({ paths = [], error = null, labels = [], ackEvents = [], owners = [] } = {}) {
    const failures = [];
    if (error) failures.push(`could not read the PR's files: ${error}`);
    else if (paths.some((p) => !isDocPath(p)) && !paths.some((p) => CHANGELOG.test(p)) && !labels.includes(NO_CHANGELOG_LABEL))
        failures.push(`non-docs files changed but CHANGELOG.md (or docs/CHANGELOG.md) did not. Add a line, or label the PR ${NO_CHANGELOG_LABEL}.`);
    // Classed from the paths as well as the label, so removing `risk:high` changes nothing.
    if (prRisk({ paths, error, labels }) === 'high' && !ownerAcknowledged({ labels, events: ackEvents, owners }))
        failures.push(`risk:high needs the ${RISK_ACK_LABEL} label, added by an owner (${owners.join(', ')}).`);
    return failures;
}

function main(env = process.env) {
    const slug = env.GUARD_REPO;
    const number = Number(env.GUARD_PR);
    if (!slug || !Number.isInteger(number) || number < 1) throw new Error('GUARD_REPO and GUARD_PR are required');
    const run = (args) => {
        const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
        return { code: r.status ?? 1, out: String(r.stdout || '').trim(), err: String(r.stderr || r.error?.message || '').trim() };
    };
    // Read live: the event payload is stale on a re-run.
    const view = run(['api', `repos/${slug}/pulls/${number}`, '--jq', '.labels[].name']);
    if (view.code) throw new Error(`could not read the PR's labels: ${view.err}`);
    const failures = guardFailures({
        ...fetchPrPaths(slug, number, { run }),
        labels: view.out.split('\n').filter(Boolean),
        ackEvents: fetchAckEvents(slug, number, { run }),
        owners: String(env.GUARD_OWNERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    for (const f of failures) console.log(`::error title=Risk guard::${f}`);
    console.log(failures.length ? `risk guard failed (${failures.length})` : 'risk guard passed');
    process.exitCode = failures.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
