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
            maxDiffPixelRatio: 0.01,
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
