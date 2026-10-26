// Pure helpers for CI check evaluation and earned-trust auto-merge.
// No I/O. Tested in checks.test.mjs.
import { DEFAULTS } from './defaults.mjs';

const PENDING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED']);
const GREEN = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL', 'pass', 'skipping']);

/**
 * Evaluate `gh pr checks --json name,state` (or equivalent) for merge readiness.
 * Every returned check must be finished and green. Empty list is not green yet
 * (checks often appear after the PR opens). Pending is never mergeable.
 * Non-required failing checks block merge — unlike `gh pr merge --auto`, which
 * only waits for branch-protection required checks (stash#305 lesson).
 *
 * @param {Array<{name?: string, state?: string}>} checks
 * @returns {{ green: boolean, reason?: string, pending: string[], bad: string[] }}
 */
export function evaluateChecks(checks = []) {
    if (!Array.isArray(checks) || !checks.length) {
        return { green: false, reason: 'has no checks yet', pending: [], bad: [] };
    }
    const pending = checks.filter((c) => PENDING.has(String(c.state || '').toUpperCase()) || PENDING.has(String(c.state || '')));
    if (pending.length) {
        return {
            green: false,
            reason: `still running (${pending.map((c) => c.name || '?').join(', ')})`,
            pending: pending.map((c) => c.name || '?'),
            bad: [],
        };
    }
    // Normalise: SUCCESS etc. are uppercase from gh; tolerate pass/skipping from older exports.
    const stillBad = checks.filter((c) => {
        const s = String(c.state || '');
        return !GREEN.has(s) && !GREEN.has(s.toUpperCase());
    });
    if (stillBad.length) {
        return {
            green: false,
            reason: `not green (${stillBad.map((c) => `${c.name}:${c.state}`).join(', ')})`,
            pending: [],
            bad: stillBad.map((c) => `${c.name}:${c.state}`),
        };
    }
    return { green: true, pending: [], bad: [] };
}

/**
 * Fingerprint a check list so we can require N consecutive identical green polls
 * before merging (late-starting workflows won't be skipped).
 */
export function checksFingerprint(checks = []) {
    return [...checks]
        .map((c) => `${c.name || '?'}:${String(c.state || '').toUpperCase()}`)
        .sort()
        .join('|');
}

/**
 * How many clean (gate pass + review approve + outcome merged) imp PRs this
 * repo has in the ledger. Used for earned-trust auto-merge.
 */
export function cleanMergesForRepo(rows = [], repo) {
    return rows.filter(
        (r) =>
            r.repo === repo &&
            r.outcome === 'merged' &&
            r.gate?.pass &&
            (!r.review || (!r.review.error && r.review.verdict === 'approve')),
    ).length;
}

/**
 * Should this run's PR be auto-merged?
 * Requires: review approve, all checks green, and earned trust for the repo.
 * Kill switch: IMPS_AUTO_MERGE=0 or trust threshold Infinity.
 *
 * @param {{ repo: string, review?: { verdict?: string, error?: string }, rows?: object[], trust?: number, autoMergeEnv?: string }} opts
 */
export function mayAutoMerge({
    repo,
    reviewVerdict,
    rows = [],
    trust = DEFAULTS.autoMergeTrust,
    autoMergeEnv = process.env.IMPS_AUTO_MERGE,
} = {}) {
    if (autoMergeEnv === '0' || autoMergeEnv === 'false') {
        return { ok: false, reason: 'auto-merge disabled (IMPS_AUTO_MERGE=0)' };
    }
    if (reviewVerdict !== 'approve') {
        return { ok: false, reason: `review was ${reviewVerdict || 'missing'}, not approve` };
    }
    const n = cleanMergesForRepo(rows, repo);
    if (n < trust) {
        return {
            ok: false,
            reason: `earned trust ${n}/${trust} clean merges for ${repo}; leaving PR open for a human`,
        };
    }
    return { ok: true, reason: `earned trust ${n}/${trust}` };
}

export { PENDING, GREEN };
