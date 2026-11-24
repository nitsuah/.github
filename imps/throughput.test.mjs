// Brief preflight, script mode and overflow-cycle helpers (2026-11-19 throughput pass).
import test from 'node:test';
import assert from 'node:assert/strict';
import { briefProblem, validateBriefMeta, brokenCommandSignature, inScopeChanged, lockBusyRepos, mayOverflow, pendingPicks, SIGNATURE_HEAD_LINES } from './lib.mjs';
import { lintBrief } from './brieflint.mjs';

const NL = String.fromCharCode(10);
const brief = (front, body = 'Fix the bug in src/app.js') => ['---', ...front, '---', body].join(NL);

test('briefProblem: a brief with no test command is rejected before any run (vhs#180)', () => {
    assert.match(briefProblem(brief(['repo: vhs', 'issue: 180', 'allow: src/'])), /no `test:`/);
    assert.match(validateBriefMeta(brief(['repo: vhs', 'issue: 180']), 'vhs', 180), /no `test:`/);
});

test('briefProblem: a brief that names no file is not imp work (ats-fill#176)', () => {
    const epic = brief(['repo: ats-fill', 'issue: 176', 'test: npm test'], 'Audit OAuth state, extension storage and profile-data scopes.');
    assert.match(briefProblem(epic), /names no file/);
    assert.equal(briefProblem(brief(['repo: a', 'issue: 1', 'test: npm test'], 'Change `validate()` in lib/form.ts.')), null);
    assert.equal(briefProblem(brief(['repo: a', 'issue: 1', 'test: npm test', 'allow: src/'], 'No path here.')), null);
    assert.equal(briefProblem(brief(['repo: a', 'issue: 1', 'test: npm test'], 'Edit README.md.')), null);
});

test('briefProblem: bare and extensionless file names count as named files', () => {
    for (const body of ['Fix the loop in foo.c.', 'Append a line to notes.txt', 'Pin the base image in the Dockerfile.', 'Add a lint target to the Makefile']) {
        assert.equal(briefProblem(brief(['repo: a', 'issue: 1', 'test: make test'], body)), null, body);
    }
    assert.match(briefProblem(brief(['repo: a', 'issue: 1', 'test: npm test'], 'Tighten things up, e.g. the auth flow, i.e. the login.')), /names no file/);
});

test('briefProblem: mode must be agent or script, and script needs allow', () => {
    assert.match(briefProblem(brief(['repo: a', 'issue: 1', 'test: npm test', 'mode: magic', 'allow: x/'])), /mode/);
    assert.match(briefProblem(brief(['repo: a', 'issue: 1', 'test: npm test', 'mode: script'])), /needs an `allow:`/);
    assert.equal(briefProblem(brief(['repo: a', 'issue: 1', 'test: npm test', 'mode: script', 'allow: tests/'])), null);
    assert.equal(briefProblem(brief(['repo: a', 'issue: 1', 'test: npm test', 'mode: agent'])), null);
});

test('brieflint reports the dispatcher structural check too', () => {
    const r = lintBrief(brief(['repo: a', 'issue: 1', 'test: npm test', 'maxLines: 40', 'allow: x/', 'mode: script2']));
    assert.ok(r.problems.some((p) => /mode/.test(p)), r.problems.join(' | '));
});

test('brokenCommandSignature: catches a command that cannot run, ignores ordinary test failures', () => {
    // vhs#178: Playwright read the first spec path as --update-snapshots' mode.
    const pw = "error: option '-u, --update-snapshots [mode]' argument 'tests/journeys/collection.spec.js' is invalid. Allowed choices are all, changed, missing, none, default.";
    assert.match(brokenCommandSignature(1, pw), /invalid option argument/);
    assert.match(brokenCommandSignature(1, 'npm error Missing script: "test:e2e"'), /npm script/);
    assert.match(brokenCommandSignature(127, ''), /exit 127/);
    assert.match(brokenCommandSignature(1, '#5 ERROR: failed to solve: failed to read dockerfile'), /docker build/);
    // skyview#253: node:22 has no Playwright browsers, so the base test can never pass.
    const noBrowser = ['Running 1 test using 1 worker', '', '  1) [chromium] › a.spec.ts:5:3 › x', '', "    Error: browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell"].join(NL);
    assert.match(brokenCommandSignature(1, noBrowser), /without its browsers/);
    // A custom PLAYWRIGHT_BROWSERS_PATH and launchPersistentContext get the same classification.
    assert.match(brokenCommandSignature(1, "Error: browserType.launch: Executable doesn't exist at /tmp/pw-browsers/chromium-1/chrome"), /without its browsers/);
    assert.match(brokenCommandSignature(1, "Error: browserType.launchPersistentContext: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1/chrome"), /without its browsers/);
    assert.equal(brokenCommandSignature(0, noBrowser), null);
    assert.equal(brokenCommandSignature(0, pw), null);
    assert.equal(brokenCommandSignature(1, '  1 failed' + NL + '  expect(received).toBe(expected)'), null);
    assert.equal(brokenCommandSignature(1, 'No tests found, exiting with code 1'), null);
    assert.equal(brokenCommandSignature(1, "Error: Cannot find module './new-helper'"), null);
    assert.match(brokenCommandSignature(1, 'bash: playwrite: command not found'), /does not exist/);
});

test('brokenCommandSignature: a failing test that prints a launcher phrase mid-output is not broken', () => {
    // Indented assertion output, and a phrase past the first lines, are test output, not launcher errors.
    assert.equal(brokenCommandSignature(1, ['Running 3 tests', '  1 failed', "    Expected: \"error: unknown option '--x'\"", '    Received: "bash: foo: command not found"'].join(NL)), null);
    const late = [...Array.from({ length: SIGNATURE_HEAD_LINES }, (_, n) => `ok ${n}`), 'error: unknown option --x'].join(NL);
    assert.equal(brokenCommandSignature(1, late), null);
});

test('brokenCommandSignature returns a category, never the raw output line', () => {
    const r = brokenCommandSignature(1, "error: unknown option '--token=ghp_SECRET123'");
    assert.ok(r && !r.includes('SECRET'), r);
});

test('pendingPicks: picks with no ledger row since the cycle began count against the cap', () => {
    const lock = JSON.stringify({ pid: 1, startedAt: '2026-11-19T12:00:00Z', picks: ['vhs#1', 'fire#2', 'vhs#3'] });
    const rows = [
        { repo: 'vhs', issue: 1, startedAt: '2026-11-19T12:05:00Z' },
        { repo: 'fire', issue: 2, startedAt: '2026-11-19T11:00:00Z' },
    ];
    assert.equal(pendingPicks(lock, rows), 2);
    assert.equal(pendingPicks(JSON.stringify({ pid: 1 }), rows), 0);
    assert.equal(pendingPicks('', rows), 0);
});

test('inScopeChanged: tracked edits and new files inside allow, nothing else', () => {
    const porcelain = [' M tests/shots/a.png', '?? tests/shots/new.png', ' M src/app.js', '?? test-results/x.txt', 'R  old.png -> tests/shots/b.png', '!! node_modules/'].join(NL);
    assert.deepEqual(inScopeChanged(porcelain, ['tests/shots/']), ['tests/shots/a.png', 'tests/shots/new.png', 'tests/shots/b.png']);
    assert.deepEqual(inScopeChanged(porcelain, []), []);
});

test('lockBusyRepos reads the busy list and tolerates legacy locks', () => {
    assert.deepEqual(lockBusyRepos(JSON.stringify({ pid: 1, busy: ['vhs', 'fire'] })), ['vhs', 'fire']);
    assert.deepEqual(lockBusyRepos(JSON.stringify({ pid: 1 })), []);
    assert.deepEqual(lockBusyRepos('1234'), []);
    assert.deepEqual(lockBusyRepos(''), []);
});

test('mayOverflow: only after the main cycle has run a while, and only one overflow at a time', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    const main = (minAgo) => JSON.stringify({ pid: 1, startedAt: new Date(now - minAgo * 60_000).toISOString() });
    assert.equal(mayOverflow({ mainText: main(5), now, overflowAfterMs: 15 * 60_000 }), false);
    assert.equal(mayOverflow({ mainText: main(20), now, overflowAfterMs: 15 * 60_000 }), true);
    // A live overflow cycle blocks a second one; a stale one does not.
    assert.equal(mayOverflow({ mainText: main(20), now, overflowAfterMs: 15 * 60_000, overflow: 'x', staleCheck: () => null }), false);
    assert.equal(mayOverflow({ mainText: main(20), now, overflowAfterMs: 15 * 60_000, overflow: 'x', staleCheck: () => 'pid-dead' }), true);
    // 0 turns it off; a legacy PID-only lock falls back to its mtime.
    assert.equal(mayOverflow({ mainText: main(90), now, overflowAfterMs: 0 }), false);
    assert.equal(mayOverflow({ mainText: '1234', mainMtimeMs: now - 30 * 60_000, now, overflowAfterMs: 15 * 60_000 }), true);
});
