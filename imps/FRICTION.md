# Friction log

Where the imps process needed hand-holding, or got stuck on the same gate twice. Add a
row when a human had to step in; mark it fixed when a PR closes it. RSI reads recurring
rows here as signal (`rsi.mjs`), so keep the **cause** column specific.

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

## Who writes the briefs? (gap, not yet built)

The warlock (`dispatch.mjs`) never writes a brief. `WARLOCK.md`: no LLM of its own, it reads
the queue and spawns imps. `STANDARD.md`: `imp:ready` is set by "Opus triage (daily)", i.e. a
hypervisor/human pass, and `rsi.mjs` only files capped issues from ledger and journey signals
(the kit's own failures). Nothing grooms the ordinary open issues that no one is working on.

What that cost on this machine: 8 `imp:ready` issues at first look, one without a brief that
starved the cycle (#4), and no way to tell which of the rest are safe first runs (several are
"security review" audits, which are not PR-shaped).

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
