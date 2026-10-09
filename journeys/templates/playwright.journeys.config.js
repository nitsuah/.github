// @ts-check
// Journeys config: extends the repo's Playwright config. Contract:
// https://github.com/nitsuah/.github/blob/main/journeys/STANDARD.md
// Adjust the require path and testDir to the repo layout.
const path = require('path');
const base = require('./playwright.config.js');

module.exports = {
    ...base,
    testDir: '../tests/journeys',
    // Linux-only baselines (always generated in the Playwright Docker image).
    snapshotPathTemplate:
        '{testDir}/__screenshots__/{testFilePath}/{testName}/{arg}{ext}',
    // A missing baseline fails in CI instead of being silently written.
    updateSnapshots: process.env.CI ? 'none' : 'missing',
    // The journeys share one server and one demo DB.
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0, // pass-on-retry = flaky, not an issue
    reporter: [
        ['list'],
        ['json', { outputFile: path.resolve(__dirname, '../journeys-report/report.json') }],
    ],
    expect: {
        toHaveScreenshot: {
            // Starts at 0 on purpose: soak at 0 (`--repeat-each 3`), read the largest
            // diff, then set this per app: ~1000 for canvas charts (fire), ~20 for
            // DOM-only apps (vigil). Exact text and numbers are asserted with
            // toHaveText instead. See STANDARD.md § Writing a journey.
            maxDiffPixels: 0,
            animations: 'disabled',
            caret: 'hide',
            scale: 'css',
        },
    },
    use: {
        ...(base.use || {}),
        viewport: { width: 1440, height: 900 },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
};
