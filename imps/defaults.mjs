// Single source of truth for imps kit defaults.
// Import these from dispatch/imp/runner/rsi and keep STANDARD.md in sync via
// `node imps/check-defaults.mjs` (also covered by defaults.test.mjs).
//
// Do not put secrets, tokens, or machine-specific paths here.

/** @type {const} */
export const DEFAULTS = {
    // Gate: brief may override; this is the fallback when maxLines is omitted.
    maxLines: 180,

    // Hourly dispatcher pick/run limits
    max: 8,
    wip: 12,
    perRepo: 6,
    concurrency: 6,
    dailyCap: 100,
    quietHours: 6,

    // Fix rounds on an open imp PR before imp:needs-human
    fixMaxRounds: 3,

    // Repo cooldown after two straight gate failures (ms)
    cooldownMs: 12 * 3600_000,

    // Per-issue attempt cap: this many failed/killed runs on one issue (since its
    // latest brief) and the dispatcher stops, labels it imp:needs-human, and
    // comments once. A new brief comment gives it a fresh allowance.
    maxIssueFailures: 2,

    // Fail fast: stop a run that made this many tool calls without a single
    // Edit/Write (ends `no-edit-timeout`). Override in ~/.imps/config.json
    // (`noEditTurns`) or IMPS_NO_EDIT_TURNS; 0 turns the check off.
    noEditTurns: 20,

    // Cap total tool-call turns for a run (ends `killed-max-turns`). Override in
    // ~/.imps/config.json (`maxTurns`); 0 turns the check off.
    maxTurns: 60,

    // Dispatch lock freshness (ms): skip if a previous cycle still holds it
    lockMaxAgeMs: 3 * 3600_000,

    // Model quota: runs allowed per model per window, per machine. Lives in
    // IMPS_HOME (not the runner checkout) and refills every window, so a
    // counter that can finally persist cannot stop the fleet for good (#59).
    quotaPerWindow: 1000,
    quotaWindowMs: 24 * 3600_000,

    // Auto-merge: require this many clean merged imp PRs for the repo
    // (max of local ledger + GitHub-seeded history) before the runner will merge.
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
    // Kit self-work uses IMPS_CODE/<kitFolder> (a normal clone), never the runner checkout.
    kitRepo: 'nitsuah/.github',
    kitFolder: '.github',
    kitBranch: 'main',
    owner: 'nitsuah',

    // Scheduled tasks. Label watch is ON by default; kill with IMPS_LABEL_WATCH=0
    // or config.json "labelWatch": false.
    taskName: 'imps-dispatch',
    taskMinute: 7,
    labelWatchTaskName: 'imps-label-watch',
    labelWatchMinutes: 5,
    labelWatchDefault: true,
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
