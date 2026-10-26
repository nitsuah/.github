// Pure helpers for CI check evaluation and earned-trust auto-merge.
// No I/O (except callers that seed from gh). Tested in checks.test.mjs.
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
 * May the runner merge right now? The checks must describe the commit that is
 * actually at the head: a push after the poll invalidates the green result (#55).
 */
export function mergeReady({ headSha, pushedHead, checks = [] } = {}) {
    if (!headSha) return { ok: false, reason: 'no head sha' };
    if (headSha !== pushedHead) return { ok: false, reason: 'head moved since the checks ran' };
    const ev = evaluateChecks(checks);
    if (!ev.green) return { ok: false, reason: ev.reason };
    return { ok: true };
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
 * repo has in the local ledger.
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
 * Mark which merged imp PRs were later reverted.
 * A revert is a later merged PR whose title/body references `Reverts #N` /
 * `Revert "…"` matching the original, or an explicit `reverts` number list.
 *
 * @param {Array<{number:number, title?:string, body?:string, mergedAt?:string}>} mergedImps
 * @param {Array<{number:number, title?:string, body?:string, mergedAt?:string}>} [laterMerged]
 * @returns {Set<number>}
 */
export function revertedImpNumbers(mergedImps = [], laterMerged = mergedImps) {
    const reverted = new Set();
    const byNumber = new Map(mergedImps.map((p) => [p.number, p]));
    for (const p of laterMerged) {
        const text = `${p.title || ''}\n${p.body || ''}`;
        for (const m of text.matchAll(/\b[Rr]everts?\s+#(\d+)\b/g)) {
            const n = Number(m[1]);
            if (byNumber.has(n)) reverted.add(n);
        }
        // Classic GitHub revert title: Revert "original title"
        const revTitle = (p.title || '').match(/^Revert\s+["“](.+)["”]\s*$/i);
        if (revTitle) {
            for (const [n, orig] of byNumber) {
                if ((orig.title || '').trim() === revTitle[1].trim()) reverted.add(n);
            }
        }
    }
    return reverted;
}

/**
 * Count GitHub-seed trust: merged `imp` PRs whose checks were all green and
 * that were not later reverted. Pure: callers supply the PR list.
 *
 * @param {Array<{number:number, title?:string, body?:string, mergedAt?:string|null, checks?:Array<{name?:string,state?:string}>, labels?:string[]}>} prs
 * @returns {number}
 */
export function countGithubSeedTrust(prs = []) {
    const mergedImps = prs.filter((p) => p.mergedAt && (p.labels || []).some((l) => l === 'imp' || l?.name === 'imp'));
    const reverted = revertedImpNumbers(mergedImps, prs.filter((p) => p.mergedAt));
    let n = 0;
    for (const p of mergedImps) {
        if (reverted.has(p.number)) continue;
        const ev = evaluateChecks(p.checks || []);
        // Historical: empty checks on an old merge is not trust (fail closed).
        if (!ev.green) continue;
        n++;
    }
    return n;
}

/**
 * Combine local ledger clean merges with GitHub-seeded history.
 * Uses max() so a fresh machine inherits GitHub history without double-counting
 * the same merges once they also appear in the ledger.
 */
export function earnedTrustCount({ ledgerCount = 0, githubCount = 0 } = {}) {
    const a = Number(ledgerCount);
    const b = Number(githubCount);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) return NaN;
    return Math.max(a, b);
}

/**
 * Should this run's PR be auto-merged?
 * Requires: review approve, all checks green, and earned trust for the repo.
 * Kill switch: IMPS_AUTO_MERGE=0.
 * Fail closed when githubSeedError is set (trust seed query failed).
 *
 * @param {{ repo: string, reviewVerdict?: string, rows?: object[], trust?: number, githubCount?: number, githubSeedError?: string|null, autoMergeEnv?: string }} opts
 */
export function mayAutoMerge({
    repo,
    reviewVerdict,
    rows = [],
    trust = DEFAULTS.autoMergeTrust,
    githubCount = 0,
    githubSeedError = null,
    autoMergeEnv = process.env.IMPS_AUTO_MERGE,
} = {}) {
    if (autoMergeEnv === '0' || autoMergeEnv === 'false') {
        return { ok: false, reason: 'auto-merge disabled (IMPS_AUTO_MERGE=0)' };
    }
    if (reviewVerdict !== 'approve') {
        return { ok: false, reason: `review was ${reviewVerdict || 'missing'}, not approve` };
    }
    if (githubSeedError) {
        return { ok: false, reason: `trust seed failed (${githubSeedError}); leaving PR open for a human` };
    }
    const threshold = Number(trust);
    if (!Number.isFinite(threshold) || threshold < 0) {
        return { ok: false, reason: `invalid autoMergeTrust (${trust}); leaving PR open for a human` };
    }
    const n = earnedTrustCount({
        ledgerCount: cleanMergesForRepo(rows, repo),
        githubCount,
    });
    if (!Number.isFinite(n) || !(n >= threshold)) {
        return {
            ok: false,
            reason: `earned trust ${n}/${threshold} clean merges for ${repo} (ledger+github seed); leaving PR open for a human`,
        };
    }
    return { ok: true, reason: `earned trust ${n}/${threshold}` };
}

/** Whether the 5-minute label-watch tick is enabled (default on). */
export function labelWatchEnabled(config = {}, env = process.env) {
    if (env.IMPS_LABEL_WATCH === '0' || env.IMPS_LABEL_WATCH === 'false') return false;
    if (config.labelWatch === false) return false;
    return config.labelWatch !== undefined ? !!config.labelWatch : DEFAULTS.labelWatchDefault;
}

/**
 * I/O: seed trust for one repo from GitHub merged `imp` PR history.
 * `run(args)` should invoke `gh` and return `{ code, out, err }` (same shape as runner `sh`).
 * Fail closed: any gh/parse error → `{ count: 0, error: string }`.
 *
 * Paginates newest-first through closed/merged PRs until `need` clean merges are
 * proven (or pages are exhausted). Newest-first means any later revert of a
 * counted PR appears in an earlier page and is already in the set.
 *
 * @param {string} repoSlug owner/name
 * @param {{ run: (args: string[]) => { code: number|null, out: string, err: string }, need?: number, pageSize?: number, maxPages?: number }} opts
 * @returns {{ count: number, error: string|null }}
 */
export function fetchGithubSeedTrust(
    repoSlug,
    {
        run,
        need = DEFAULTS.autoMergeTrust,
        pageSize = 100,
        maxPages = 10,
    } = {},
) {
    if (!repoSlug || typeof run !== 'function') {
        return { count: 0, error: 'repoSlug and run() required' };
    }
    const target = Number(need);
    const want = Number.isFinite(target) && target > 0 ? target : DEFAULTS.autoMergeTrust;
    try {
        const enriched = [];
        for (let page = 1; page <= maxPages; page++) {
            // Closed pulls, newest updated first; jq keeps only merged ones.
            const list = run([
                'api',
                `-X`, 'GET',
                `repos/${repoSlug}/pulls?state=closed&sort=updated&direction=desc&per_page=${pageSize}&page=${page}`,
                '--jq',
                '[.[] | select(.merged_at != null) | {number, title, body, mergedAt: .merged_at, labels: [.labels[].name]}]',
            ]);
            if (list.code) return { count: 0, error: list.err || `gh api pulls page ${page} failed` };
            let prs;
            try {
                prs = JSON.parse(list.out || '[]');
            } catch {
                return { count: 0, error: `invalid gh api pulls json (page ${page})` };
            }
            if (!Array.isArray(prs)) return { count: 0, error: `gh api pulls page ${page} was not an array` };
            if (!prs.length) break;

            for (const p of prs) {
                const labels = (p.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
                const row = {
                    number: p.number,
                    title: p.title,
                    body: p.body,
                    mergedAt: p.mergedAt,
                    labels,
                    checks: [],
                };
                if (p.mergedAt && labels.includes('imp')) {
                    const c = run([
                        'pr', 'checks', String(p.number), '-R', repoSlug, '--json', 'name,state',
                    ]);
                    if (c.code) {
                        return { count: 0, error: `gh pr checks #${p.number} failed: ${c.err || c.code}` };
                    }
                    try {
                        row.checks = JSON.parse(c.out || '[]');
                    } catch {
                        return { count: 0, error: `invalid checks json for #${p.number}` };
                    }
                    if (!Array.isArray(row.checks)) {
                        return { count: 0, error: `checks for #${p.number} was not an array` };
                    }
                }
                enriched.push(row);
            }

            const soFar = countGithubSeedTrust(enriched);
            if (soFar >= want) return { count: soFar, error: null };
            // A short page means no further results from the API.
            if (prs.length < pageSize) break;
        }
        return { count: countGithubSeedTrust(enriched), error: null };
    } catch (e) {
        return { count: 0, error: e?.message || String(e) };
    }
}

export { PENDING, GREEN };
