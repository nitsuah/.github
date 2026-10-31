# Friction log

Where the imps process needed hand-holding, or got stuck on the same gate twice. Add a
row when a human had to step in; mark it fixed when a PR closes it. Nothing reads this
file automatically: `rsi.mjs` works from the ledger, `dispatch.jsonl` and open
`bot:journey` / `bot:review` issues, not from here. Feeding recurring rows to RSI is a
proposal, not behavior. Keep the **cause** column specific so a human can.

| # | Date | Where | Symptom | Cause | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-10-28 | new machine, inventory | `setup.ps1`/`doctor.ps1` need `pwsh`; only Windows PowerShell 5.1 was installed | nothing checks for pwsh 7 before the instructions say to run it | open: doc step only |
| 2 | 2026-10-28 | new machine, Claude CLI | `irm https://claude.ai/install.ps1 \| iex` was blocked by the auto-mode classifier; the `npm i -g` fallback skipped the package postinstall | piping a remote script into `iex` is flagged; npm 11 does not run install scripts unless allowed | fixed in docs/doctor: use `npm i -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code` |
| 3 | 2026-10-28 | `dispatch.mjs` first dry run | crash `ENOENT runs.jsonl` | one read of the ledger used `readFileSync`; the rest used the safe `readLedger()` | fixed |
| 4 | 2026-10-28 | first live cycle | `imp:ready` issue with no brief at the head of the queue used the only `--max 1` slot; cycle picked nothing, every hour | the brief check ran after `pickIssues` had already spent the slot | fixed: pick in batches until slots hold issues with briefs |
| 5 | 2026-10-28 | first live cycle | `run-error`, issue relabelled `imp:failed`, comment "Imp run didn't start" | repo not cloned under `IMPS_CODE`; setup does not clone tracked repos | fixed in doctor (checks every repo with an `imp:ready` issue); open: `setup.ps1` could offer to clone them |
| 6 | 2026-10-28 | second live cycle | imp "ran" for 4 ms, `gate-fail: no commits, tests not run`, issue `imp:failed` with a comment blaming the imp | `claude.exe` missing at the hardcoded `%APPDATA%\npm\...` path; spawn error was swallowed and counted as the issue's failure | fixed: `resolveClaudeBin`, `spawn-failed` end state, not counted by the attempt cap, issue returned to `imp:ready`, doctor check |
| 7 | 2026-10-28 | choosing a first test issue | could not point the dispatcher at one issue; had to relabel others and infer the pick from a dry run | no selection flag | fixed: `--only repo#N,...` |
| 8 | 2026-10-28 | log reading | `label-cleanup` is logged the same in dry and live runs, so the log cannot say whether labels were actually removed | event has no `dry` field | open |
| 10 | 2026-10-28 | gate, first real imp run | imp edited `auth.js` (11 turns, `success`), gate said `edits left uncommitted; tests exit 2`, issue `imp:failed` | gate/`runtest.mjs` ran the brief's `sh -c '... && ...'` through `shell: true` = cmd.exe, which does not group single quotes; the container's `sh` died before any test ran. The same command under Git Bash exits 0 | fixed: `gateShell()` (Git Bash, `IMPS_SHELL` override), doctor check |
| 9 | 2026-10-28 | scheduled tasks | user env vars (9router key) are visible to Task Scheduler only after sign-out/in; until then every scheduled cycle skips "9router not up" | Windows reads user env at logon | open: doctor could warn when the task's logon predates the vars |
| 11 | 2026-10-28 | imp PR quality (vhs#103) | with the broken gate shell the imp could not run tests, finished anyway, and its PR body is its last message ("the test command failed due to a syntax error...") under the generic title `imp: work for #102 (committed by runner)`; the diff itself had two blockers | the imp is told to verify with `runtest.mjs` but nothing stops it from ending with a red or unrun test; PR title/summary come from the final text, not the work | open: refuse to open a PR when the imp's last test run failed; title from the issue; summary from the diff. Worked as designed: the imp reviewer caught both blockers and nothing auto-merged |
| 12 | 2026-10-28 | gate size accounting | `Gate: 0 lines in src/modules/auth.js` for a +12/-5 diff | `runGate` read `impHead` before the runner's auto-commit existed, then measured the size as `baseSha..impHead`, which is empty when the imp left its edits uncommitted. So `maxLines` never saw an auto-committed change: an oversized diff would have passed the size gate | fixed: `impHead` is re-read after the auto-commit |
| 13 | 2026-10-28 | live visibility | the only way to see what an imp was doing was tailing raw `dispatch.jsonl` / `runs/<id>.jsonl` | no live view existed | fixed: `watch.mjs --statusline` (Claude Code status line) and full-screen `watch.mjs`; see README "Watching a run" |
| 14 | 2026-10-31 | cross-repo readiness recovery | Safe, unowned `imp:failed` work in Fire #318/#330/#339/#381 and Vigil #373 was not dispatchable; prior runs exceeded diff caps, left edits uncommitted, or exited with tests failing, while dependency/index notes were stale | briefs combined distinct behaviors or omitted exact call-site/test-fixture changes; the attempt cap only resets from a replacement formal `<!-- imp-brief -->`, so unchanged requeues repeat the failure | observed: manual groomer rebriefed 5 issues; Vigil #373 was split into pure mapping and merge helper #406; Fire #319 is now `imp:ready` after #318 merged; Fire #381 has since merged as PR #396; #383 is `imp:ready` after its previous lint-gate failure; its replacement test-only brief is dependency-satisfied by merged #381, and #370 remains `imp:ready`, #371 waits on #370; Vigil #394 remains blocked on Vigil #373 and #406 (not the Fire PR #394); automation gap tracked in .github#116 |
| 15 | 2026-10-31 | readiness recovery follow-up | Fire UI #168/#172/#173, integration umbrellas #262/#139 and security reviews #213/#176 carried stale ready/failed labels despite visual, security, or live-account gates; Skyview #215, VHS #124, Vigil #373 and Motor-pool #125 had failed/stale briefs; Fire #335 was a deferred medium feature | a ready label was not backed by a current, bounded formal brief or the task still needed evidence/approval; #124's 45-line cap and #125's 110-line cap were below their regression-fixture scope | corrected dispatch state: rebriefed #215/#124/#373/#125 with current code, focused tests/lint, allowlists, invariants, realistic caps and commit trailer; #168 remains human-gated for visual acceptance; #262/#139/#213/#176 moved to `imp:needs-human`; #335's failed label was cleared and it remains deferred under #222; #124 has since merged via PR #128 (`1c5c020`), satisfying #113's scorer prerequisite; proposal-only child #125 is now `imp:ready` and #126/#127 remain blocked in order; Motor-pool #125 is ready after closed #124 |
| 16 | 2026-10-31 | Fire #321 Etsy hosted outcome | repeated Imp attempts failed only the size gate (162 > 140, then 184 > 180); no PR and tests never ran | the previous cap was set from the first diff but remained below the actual four-file implementation + regression tests + docs update; replacement brief keeps the allowlist and raises the cap to 230 with explicit privacy invariants and focused commands | recovered: new formal brief resets the attempt cap and #321 is `imp:ready`; not an unchanged retry |
| 17 | 2026-10-31 | Fire #331 Quick Start card | Imp exited after 13 turns with no commits and no tests; dependency #330 was already merged and there were no tool errors | the broad UI + Playwright scope crossed implementation and acceptance-test boundaries; split the dedicated browser test into #398, narrowed #331 to the four-file UI implementation with explicit privacy/localStorage invariants and focused commands | recovered by replacement brief + decomposition: #331 is `imp:ready`; #398 waits on #331; no unchanged retry |
| 18 | 2026-10-31 | Fire #367 eBay card-state UI | first exact-head E2E run found a stale Connect-visible assertion in the unconfigured test server; second run passed all UI tests but repo-wide Prettier failed on the corrected assertion | the expected behavior changed to hide Connect when `configured:false`; the test assertion and formatting were updated without changing OAuth, sync, or screenshot baselines | recovered and merged via Fire PR #397 (`891e029e`), final exact-head CI #41168595019 passed `test` and `e2e-ui`; hosted outcome child #326 is now `imp:ready` |
| 19 | 2026-10-31 | `.github` dependency brief parser | Prose after a valid `depends:` list was parsed as extra blockers; `motor-pool#125` deadlocked because `#126 follows this child` was interpreted as a dependency | `parseDepends` scanned every `#N` in the whole string instead of only the leading comma-separated reference list before `;` | fixed in PR #160 (`aedd5f9`); exact-head Imp kit run `41173442972` passed the unit and syntax steps (215 passed, 2 skipped, 0 failed); trailing prose is ignored |
| 20 | 2026-10-31 | Fire #326 hosted eBay outcome | Imp left edits uncommitted and the focused test command exited 1; the failure comment omitted the first failing assertion/diagnostic | the earlier brief named a broad five-file outcome task but did not pin exact helper semantics and storage cases; replacement brief now defines normalized outcome helpers, fake-storage tests, and asks for the first failure output if a test fails | rebriefed and `imp:ready`; no implementation PR yet |
| 21 | 2026-10-31 | Vigil #368 unknown security state | Prior attempt left edits uncommitted/tests exited 2; the diagnostic was not captured | The done-when required type-safe DB/API propagation of `boolean | 'unknown'`, but the four-file allowlist omitted `lib/sync.ts`, `types/repo.ts`, and API mapping files; current-main inspection exposed the scope mismatch | replacement nine-file brief posted with explicit nullable-DB/unknown-API contract and per-probe 200/404/403 tests; `imp:ready` |

## Who writes the briefs? (gap, not yet built)

The warlock (`dispatch.mjs`) never writes a brief. `WARLOCK.md`: no LLM of its own, it reads
the queue and spawns imps. `STANDARD.md`: `imp:ready` is set by "Opus triage (daily)", i.e. a
hypervisor/human pass, and `rsi.mjs` only files capped issues from ledger and journey signals
(the kit's own failures). Nothing grooms the ordinary open issues that no one is working on.

What that cost on this machine: 8 `imp:ready` issues at first look, one without a brief that
starved the cycle (#4), and no way to tell which of the rest are safe first runs (several are
"security review" audits, which are not PR-shaped).

Readiness recovery evidence (2026-10-31): a manual pass rebriefed five safe, unowned failures across Fire/Vigil. The recurring fixes were not blind retries: re-read default-branch code and claims/PRs, verify dependencies, make the allowlist/test/lint/maxLines explicit, state data/security invariants and the commit trailer, and post a replacement formal brief before restoring `imp:ready`. Split mapping, merge, and integration when the combined brief repeatedly exceeds its budget. Keep the groomer draft-first; only promote after the same eligibility checks.


Follow-up evidence (2026-10-31): four safe, unowned failures were recovered with replacement formal briefs—Skyview #215 (CSV formula neutralization, 85-line cap), VHS #124 (contradictory identifier evidence, 100-line cap), Vigil #373 (pure ruleset mapping, 140-line cap), and Motor-pool #125 (runtime GPU visibility with fixture-only probes, 250-line cap). These are not blind retries: each brief names current files, focused commands, invariants, dependencies, and the required trailer. The same sweep removed false `imp:ready` state from Fire #168/#172/#173, #262, and #139; security reviews #213/#176 are human-gated; and #335 is deferred by its parent epic rather than left in the failed queue.

### Proposal: a groomer stage

`groom.mjs`, run by the warlock on a slow cadence (daily, off by default, `"groom": true`):

1. **Find**: open issues with no `imp:*` label, no open PR referencing them, in repos with no
   open human PR and a quiet period (same `busy()` rule `pickIssues` uses). Skip `security`,
   `needs-human` and anything touching `.github/workflows/` or secrets (the RSI deny list).
2. **Screen**: reject what is not PR-shaped (audits, "investigate", no verifiable outcome).
   Prefer `bug` and small `enhancement`.
3. **Draft**: one plain completion through 9router (`chat()`, as reviews already do), with the
   repo's `TASKS.md`/README for context, writing a brief in the `STANDARD.md` format.
4. **Lint**: reuse the brief parser; refuse briefs with no `test:`/`allow:` or a scope over the
   gate's `maxLines` (the "brief lint at post time" candidate already listed in `WARLOCK.md`).
5. **Post**: as `<!-- imp-brief -->` plus label `imp:ready` only for `bug`/small kinds under
   a daily cap (like `rsiDailyIssueCap`); everything else gets a `<!-- imp-brief-draft -->`
   comment and `imp:needs-brief` for a human to promote. Dedupe by issue number and brief hash.
6. **Measure**: a groomed brief that fails the gate twice feeds back into the screen rules,
   the same way RSI reads gate-failure signatures.

Open questions for the maintainer: auto-label `imp:ready` or always draft-first for the first
weeks? Which kinds count as "small"? Should audit/security issues get their own non-PR imp
(report-only) instead of being screened out?


### Failure-evidence follow-up (2026-10-31)

- Fire #318: maintenance recovered the shared `normalizeSpanYears` helper in [PR #392](https://github.com/nitsuah/fire/pull/392), merged as `e8e9578e766d99d4fc6ddc538c95298ee47fdb7a` after exact-head CI (lint, coverage tests, build) and E2E UI passed; Netlify deploy-preview status was success. The stale CodeRabbit review was dismissed only after all three findings were verified and inline threads resolved. Fire #319 was rebriefed to the merged 1–120 range and restored to `imp:ready` for server-side parity tests; its dependency is now satisfied.
- Fire #330: repeated Imp attempts stalled on uncommitted edits/tests or an undersized diff cap; the safe pure-model task had no active claim or PR. Maintenance recovered it in [PR #394](https://github.com/nitsuah/fire/pull/394), merged as `8c66acadd0e529e08cd7261c2b0a6dae569bf44e` after exact-head CI (lint, coverage tests, build) and E2E UI passed; Netlify deploy preview was success. The stale `imp:failed` label was removed. Child #331 is now unblocked and has a corrected six-step/mobile-overflow `imp:ready` brief; #332 remains blocked on #331. Prefer a bounded direct recovery over another unchanged retry.
- Motor-pool #125: the first recovery raised the cap after `358 > 250`, but the next attempt failed the allowlist gate by creating out-of-scope `test/fixtures/...` files; no tests completed and no PR exists. The new formal brief keeps the exact two-file allowlist (`scripts/detect-profile.ps1`, `test/detect-profile.Tests.ps1`), embeds fixture JSON inline, forbids fixture files, uses a 260-line cap, and restores `imp:ready` only after the formal-brief attempt-cap reset. #126 remains blocked until #125 passes and merges.
- Skyview #215: after the prior out-of-scope attempt, the replacement brief ended at `lint exit 2`, no PR. The safe direct implementation landed in PR #217 (merge `d3b6b810729ac741499fbccdd0da0cdae3aa51a6`); exact-head Unit Tests, Playwright Tests, and Docker Smoke all passed, and #215 is closed.
- Dispatch evidence note: for test/lint failures, the issue comment should preserve the exact command, exit code, first failing assertion/diagnostic, and file/line when available. An exit-code-only summary is not enough to safely correct a brief.
- Size-only recoveries: Darkmoon #494 (88 lines against 80) and VHS #124 (87 against 45) were rebriefed to 100-line caps after confirming the same bounded allowlists. This supports the existing #122 proposal but does not change retry policy; #122 remains owner-gated.


### Parent epic and recovery follow-up (2026-10-31)

- Fire #240 CoinTracker lifecycle: [Fire PR #396](https://github.com/nitsuah/fire/pull/396) merged the `confirm` default-off gate at `37c365d`; exact-head CI passed. The default-path regression was kept as a separate test-only child: #383 now has a replacement brief for omitted and explicit `confirm: false` plus existing-row refresh, and #370's one-wallet confirmation helper is independently `imp:ready` after #381. #371 waits on #370; keep #369/#240 open until the regression test and end-to-end Add/Dismiss journey complete.

- Vigil #361 was a decomposition parent with children #400/#401/#402. [PR #408](https://github.com/nitsuah/vigil/pull/408) merged with `Fixes #361` in the merge message and auto-closed the parent even though #400's no-`repoUrl` fallback and the full E2E journey were incomplete. The parent was reopened; #401/#402 are closed as covered, #400's residual is in [PR #411](https://github.com/nitsuah/vigil/pull/411), and [#410](https://github.com/nitsuah/vigil/issues/410) is `imp:ready` for the missing journey assertions. Shared guard tracked in [#145](https://github.com/nitsuah/.github/issues/145).
- Vigil #356 recovered from the formatter-expanded PR: [PR #407](https://github.com/nitsuah/vigil/pull/407) was reduced to 46 changed lines, the indexed-read/malformed-list findings were fixed, exact-head CI/Docker Smoke/E2E passed, and it merged as `cf011a110774c7628f419dfa068b6c33a2a90009`. The immediate PR is complete; the owner-gated #143 policy remains unchanged.
- VHS #123 exact-head CI/CodeQL/Showcase Lock are green; Journeys failed only three screenshot comparisons. The CI artifact shows the intended stats-chip changes and owner approval is recorded for those three baselines. The snapshot refresh/commit and 3-run soak still require the Docker Playwright path; do not weaken thresholds or merge while Journeys is red.
### Imp guard / exact-head CI follow-up (2026-10-31)

- `.github` repeated-failure guard: PR #153 merged as `10a5859` without exact-head check runs. Independent review found the default-off argv prompt order had changed and the opt-in initial prompt was written only after child `close`, so the feedback path was not delivered. PR #155 reopened #147, restored the original argv order, sent the stream-json prompt on `spawn`, and made stdin backpressure/errors fail open; it merged as `1759afd7` with exact-head run `41169939286` passing 213/213 tests and all module syntax checks.
- The new PR-safe `imps/**` workflow landed in PR #154 as `fc4168f3`; exact-head run `41169653651` passed 208/208 tests plus syntax checks. Its first run surfaced a Windows-only `hourly.cmd` fixture assumption on Ubuntu; the test now selects `hourly.cmd`/`set` on Windows and `hourly.sh`/`export` elsewhere.
- `.github#145` dispatcher epic guard: PR #150 skips `<!-- imp-epic -->` parents before brief lookup/pick accounting and merged as `854976f1` after exact-head run `41170112901` passed 214/214 tests and all module syntax checks. Vigil #361 already carries the marker; `imps/STANDARD.md` and `PREAMBLE.md` require child-only `Fixes` and keep parents open through manual/E2E acceptance.
- Darkmoon #495: prior attempt stopped at the diff gate (`231 > 100`) without a PR. The replacement three-file brief now uses `maxLines: 260`, focused TypeScript/Vitest/ESLint commands, and read-only/dev-only invariants; #495 is `imp:ready` and #496 remains blocked on it.

### Brief cap floor (2026-10-31)

- `.github` PR #156 merged as `ecae8867f5b0f20a3b0b7f201bb1727d712c38c4` after seven size-only gate failures across motor-pool #125, VHS #124, Darkmoon #494/#495, Vigil #406, and Fire #321/#326. `effectiveMaxLines()` now floors brief caps at `DEFAULTS.maxLines` (150), preserves higher caps, adds fix-round slack after the floor, and leaves malformed caps fail-closed. Exact-head Imp kit run `41171398024` succeeded (213 pass, 2 skipped, 0 fail). This corrects brief sizing only; size-only retry policy #122 and post-format budget policy #143 remain owner-gated.

### Child acceptance after PR closure (2026-10-31)

- Fire #338 exposed a lifecycle gap: PR #368 merged as `ccf41a3` and auto-closed the child after adding state/markup, but the current default branch still had no visible profile-panel toggle or `saveChaosProfile` / `clearChaosProfile` handlers. The PR's exact-head CI run `40992503422` succeeded, while review findings for both missing behaviors were explicitly marked "Not in this PR." The child was reopened for tracking, focused follow-up #399 is `imp:ready`, and #340 remains blocked on #399. Lesson: verify every child's acceptance against the merged code; a green PR and auto-closed issue do not prove the user journey is complete.


### Dependency reference parser recovery (2026-10-31)

The dependency parser now treats `depends:` as an explicit leading reference list, not arbitrary prose. A reference is accepted only at the start of a comma-separated item before the first semicolon; issue numbers in explanatory text no longer create implicit blockers. This prevents false cycles while preserving `#N`, `repo#N`, and `owner/repo#N` forms. The fix is in [PR #160](https://github.com/nitsuah/.github/pull/160), merged as `aedd5f9`; exact-head Imp kit run `41173442972` passed.


### Fire browser-only outcome task diagnostics (2026-10-31)

Fire #321 (hosted Etsy) and #326 (hosted eBay) both produced failure comments that said edits were left uncommitted and tests exited 1 without the first failing assertion/output. The replacement briefs now pin helper contracts, fake-storage edge cases, focused commands, and explicitly require the first diagnostic to be captured on failure. This is a repeatable observability/brief-quality failure, not evidence that the two provider implementations share one code defect.


### Trace data-flow before setting an Imp allowlist (2026-10-31)

Vigil #368's acceptance crossed GitHub probe → sync persistence → Repo type → API mapping → SecuritySection. A UI-only allowlist could not satisfy the stated type-safety requirement. When a brief's done-when includes DB/API consumers, trace the concrete data path first and allowlist those files; preserve existing nullable DB columns when appropriate, map unknown explicitly at the API/UI boundary, and avoid changing unrelated score policy or mutation/authorization boundaries.

### Motor-pool #125 fixture allowlist recovery (2026-10-31)

The latest failure was a brief/scope mismatch, not a test or runtime defect: the Imp generated `test/fixtures/...` files outside the two-file allowlist. The replacement brief explicitly forbids fixture files and uses inline JSON fixtures in the test harness. Do not broaden to a recursive fixture-directory allowlist by default; keep the test seam in the allowlisted harness unless a separate test-data artifact is justified. A new formal `<!-- imp-brief -->` resets the attempt cap; unchanged requeues do not. #126 stays blocked on #125.


### Responsive duplicate DOM in Playwright journeys (2026-10-31)

Vigil #410's first Journeys run [41180536657](https://github.com/nitsuah/vigil/actions/runs/41180536657) failed because the unfiltered `[data-tour="issues"]` locator matched both desktop and mobile DOM instances. The fixture data and card were present; this was a Playwright strict-mode ambiguity, not a missing component. The test was corrected in [PR #414](https://github.com/nitsuah/vigil/pull/414) with `[data-tour="issues"]:visible`; exact-head Journeys [41180659506](https://github.com/nitsuah/vigil/actions/runs/41180659506) passed, and no screenshot baselines changed.

For future journey briefs, scope responsive duplicate components to the visible/active viewport or intended container. Do not weaken assertions or use arbitrary `nth()` solely to silence strict mode.
