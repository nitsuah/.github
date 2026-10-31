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
| 15 | 2026-10-31 | readiness recovery follow-up | Fire UI #168/#172/#173 and integration umbrellas #262/#139 carried stale ready/failed labels despite visual, security, or live-account gates; Skyview #215, VHS #124 and Vigil #373 had failed/stale briefs | a ready label was not backed by a current, bounded formal brief or the task still needed evidence/approval; the #124 45-line cap was below the required regression scope | corrected dispatch state: rebriefed #215/#124/#373 with current code, focused tests/lint, allowlists, invariants, realistic caps and commit trailer; #168 remains human-gated for visual acceptance; #262/#139 moved to `imp:needs-human`; #124 is now an explicit prerequisite for #113 confidence semantics |

## Who writes the briefs? (gap, not yet built)

The warlock (`dispatch.mjs`) never writes a brief. `WARLOCK.md`: no LLM of its own, it reads
the queue and spawns imps. `STANDARD.md`: `imp:ready` is set by "Opus triage (daily)", i.e. a
hypervisor/human pass, and `rsi.mjs` only files capped issues from ledger and journey signals
(the kit's own failures). Nothing grooms the ordinary open issues that no one is working on.

What that cost on this machine: 8 `imp:ready` issues at first look, one without a brief that
starved the cycle (#4), and no way to tell which of the rest are safe first runs (several are
"security review" audits, which are not PR-shaped).

Readiness recovery evidence (2026-10-31): a manual pass rebriefed five safe, unowned failures across Fire/Vigil. The recurring fixes were not blind retries: re-read default-branch code and claims/PRs, verify dependencies, make the allowlist/test/lint/maxLines explicit, state data/security invariants and the commit trailer, and post a replacement formal brief before restoring `imp:ready`. Split mapping, merge, and integration when the combined brief repeatedly exceeds its budget. Keep the groomer draft-first; only promote after the same eligibility checks.


Follow-up evidence (2026-10-31): three more safe, unowned failures were recovered with replacement formal briefs—Skyview #215 (CSV formula neutralization, 85-line cap), VHS #124 (contradictory identifier evidence, 100-line cap), and Vigil #373 (pure ruleset mapping, 140-line cap). These are not blind retries: each brief names the current files, focused commands, invariant, dependency, and required trailer. The same sweep removed false `imp:ready` state from Fire #168/#172/#173, #262, and #139 where visual approval, live provider evidence, or security architecture review remains a real gate.

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
