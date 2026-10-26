// Single source of truth for imps kit defaults.
// Import these from dispatch/imp/runner/rsi and keep STANDARD.md in sync via
// `node imps/check-defaults.mjs` (also covered by defaults.test.mjs).
//
// Do not put secrets, tokens, or machine-specific paths here.

/** @type {const} */
export const DEFAULTS = {
    // Gate: brief may override; this is the fallback when maxLines is omitted.
    maxLines: 15,

    // Hourly dispatcher pick/run limits
    max: 5,
    wip: 8,
    perRepo: 4,
    concurrency: 4,
    dailyCap: 15,
    quietHours: 6,

    // Fix rounds on an open imp PR before imp:needs-human
    fixMaxRounds: 2,

    // Repo cooldown after two straight gate failures (ms)
    cooldownMs: 24 * 3600_000,

    // Dispatch lock freshness (ms): skip if a previous cycle still holds it
    lockMaxAgeMs: 3 * 3600_000,

    // Auto-merge: require this many clean merged imp PRs for the repo (ledger)
    // before the runner will merge. Below that, PR stays open for a human.
    autoMergeTrust: 3,

    // waitForChecks: consecutive all-green polls before merge (catches late starters)
    checkStablePolls: 2,
    checkPollMs: 30_000,
    checkTries: 40,

    // RSI self-improvement: max new imp:ready issues filed per day
    rsiDailyIssueCap: 3,
    // Recurring gate-failure signature must appear at least this often
    rsiMinRecurrence: 3,

    // Kit / state locations (overridable by env). Runner is code; HOME is state.
    // Windows setup uses %LOCALAPPDATA%\imps-runner; Unix uses ~/.local/share/imps-runner.
    kitRepo: 'nitsuah/.github',
    kitBranch: 'main',
    owner: 'nitsuah',

    // Scheduled task
    taskName: 'imps-dispatch',
    taskMinute: 7,
    labelWatchTaskName: 'imps-label-watch',
    labelWatchMinutes: 5,
};

/** Human-readable table for docs / doctor output. */
export function defaultsTable(d = DEFAULTS) {
    return [
        ['maxLines (brief fallback)', String(d.maxLines)],
        ['--max / --wip / --per-repo / --concurrency', `${d.max} / ${d.wip} / ${d.perRepo} / ${d.concurrency}`],
        ['--daily-cap', String(d.dailyCap)],
        ['quietHours', String(d.quietHours)],
        ['fixMaxRounds', String(d.fixMaxRounds)],
        ['autoMergeTrust (clean merges before auto-merge)', String(d.autoMergeTrust)],
        ['rsiDailyIssueCap', String(d.rsiDailyIssueCap)],
        ['kitRepo @ kitBranch', `${d.kitRepo} @ ${d.kitBranch}`],
    ];
}
