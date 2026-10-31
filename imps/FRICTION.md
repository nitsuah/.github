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
| 14 | 2026-10-31 | cross-repo readiness recovery | Safe, unowned `imp:failed` work in Fire #318/#330/#339/#381 and Vigil #373 was not dispatchable; prior runs exceeded diff caps, left edits uncommitted, or exited with tests failing, while dependency/index notes were stale | briefs combined distinct behaviors or omitted exact call-site/test-fixture changes; the attempt cap only resets from a replacement formal `<!-- imp-brief -->`, so unchanged requeues repeat the failure | observed: manual groomer rebriefed 5 issues; Vigil #373 was split into pure mapping and merge helper #406; #319/#383/#370/#371/#394 remain blocked by dependencies; automation gap tracked in #116 |
| 15 | 2026-10-31 | readiness recovery follow-up | Fire UI #168/#172/#173, integration umbrellas #262/#139 and security reviews #213/#176 carried stale ready/failed labels despite visual, security, or live-account gates; Skyview #215, VHS #124, Vigil #373 and Motor-pool #125 had failed/stale briefs; Fire #335 was a deferred medium feature | a ready label was not backed by a current, bounded formal brief or the task still needed evidence/approval; #124's 45-line cap and #125's 110-line cap were below their regression-fixture scope | corrected dispatch state: rebriefed #215/#124/#373/#125 with current code, focused tests/lint, allowlists, invariants, realistic caps and commit trailer; #168 remains human-gated for visual acceptance; #262/#139/#213/#176 moved to `imp:needs-human`; #335's failed label was cleared and it remains deferred under #222; #124 is now an explicit prerequisite for #113 confidence semantics; Motor-pool #125 is ready after closed #124 |

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

- Fire #318: the prior Imp attempt still lacks its exact assertion/diagnostic, but maintenance recovered the bounded shared normalizer in [PR #392](https://github.com/nitsuah/fire/pull/392). Its first CI head failed only on Prettier import formatting; corrected in head `91a010fa3aba72e722e508fb7dfd8ac632a5671b`, exact-head checks pending. `imp:failed` was removed, `imp:pr` set; #319 remains blocked until merge.
- Fire #330: repeated Imp attempts stalled on uncommitted edits/tests or an undersized diff cap; the task remained a safe pure-model change with no active claim or PR. Maintenance recovered it in [PR #394](https://github.com/nitsuah/fire/pull/394) using only `app/lib/quick-start.js` and `tests/unit/quick-start.test.mjs`; exact-head CI is pending. #331 remains blocked until #330 merges. Prefer a bounded direct recovery over another unchanged retry.
- Skyview #215: after the prior out-of-scope attempt, the replacement brief ended at `lint exit 2`, no PR. The safe direct implementation landed in PR #217 (merge `d3b6b810729ac741499fbccdd0da0cdae3aa51a6`); exact-head Unit Tests, Playwright Tests, and Docker Smoke all passed, and #215 is closed.
- Dispatch evidence note: for test/lint failures, the issue comment should preserve the exact command, exit code, first failing assertion/diagnostic, and file/line when available. An exit-code-only summary is not enough to safely correct a brief.
- Size-only recoveries: Darkmoon #494 (88 lines against 80) and VHS #124 (87 against 45) were rebriefed to 100-line caps after confirming the same bounded allowlists. This supports the existing #122 proposal but does not change retry policy; #122 remains owner-gated.


### Parent epic and recovery follow-up (2026-10-31)

- Vigil #361 was a decomposition parent with children #400/#401/#402. [PR #408](https://github.com/nitsuah/vigil/pull/408) merged with `Fixes #361` in the merge message and auto-closed the parent even though #400's no-`repoUrl` fallback and the full E2E journey were incomplete. The parent was reopened; #401/#402 are closed as covered, #400's residual is in [PR #411](https://github.com/nitsuah/vigil/pull/411), and [#410](https://github.com/nitsuah/vigil/issues/410) is `imp:ready` for the missing journey assertions. Shared guard tracked in [#145](https://github.com/nitsuah/.github/issues/145).
- Vigil #356 recovered from the formatter-expanded PR: [PR #407](https://github.com/nitsuah/vigil/pull/407) was reduced to 46 changed lines, the indexed-read/malformed-list findings were fixed, exact-head CI/Docker Smoke/E2E passed, and it merged as `cf011a110774c7628f419dfa068b6c33a2a90009`. The immediate PR is complete; the owner-gated #143 policy remains unchanged.
- VHS #123 exact-head CI/CodeQL/Showcase Lock are green; Journeys failed only three screenshot comparisons. The CI artifact shows the intended stats-chip changes and owner approval is recorded for those three baselines. The snapshot refresh/commit and 3-run soak still require the Docker Playwright path; do not weaken thresholds or merge while Journeys is red.
