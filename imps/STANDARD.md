# Imps

Imps are headless `claude -p` workers, run through 9router, that each take **one GitHub issue to one small PR**. Install and recover with [`setup.ps1`](./setup.ps1) (see [`README.md`](./README.md)). Every default that used to drift between docs and code lives in [`defaults.mjs`](./defaults.mjs) — run `node imps/check-defaults.mjs` to keep this file honest. The long-term home is `motor-pool/docs/IMPS-PLAN.md`.

## Flow

```
brief.md ──► imp.mjs run ──► worktree + claude -p (clean env, 9router) ──► local commits
                                                                              │
              imp.mjs gate ◄──────────────────────────────────────────────────┘
              (tests in Docker, diff size, scope, deny paths, trailer)
                  │ pass                       │ fail
                  ▼                            ▼
              imp.mjs pr  → PR labelled `imp`          ledger → rsi.mjs / next RSI pass
                  │
              review.mjs → (earned trust + every check green) → squash merge
                           else leave open for a human / fix.mjs
```

## A brief

Front matter, then the issue-specific body. `PREAMBLE.md` is prepended to every brief.

```markdown
---
repo: fire
issue: 166
test: docker run --rm -v {wt}://app -v imp-nm-fire://app/node_modules -w //app node:22 sh -c "npm ci --no-audit --no-fund && npx vitest run --config config/vitest.config.ts"
format: docker run --rm -v {wt}://app -v imp-nm-fire://app/node_modules -w //app node:22 npx eslint --config config/eslint.config.mjs --fix app/lib
lint: docker run --rm -v {wt}://app -v imp-nm-fire://app/node_modules -w //app node:22 npx eslint --config config/eslint.config.mjs app/lib
maxLines: 60
allow: app/lib/, docs/CHANGELOG.md
---
## Issue nitsuah/fire#166
<the problem, where it is, what done looks like, and repo facts the imp would otherwise burn turns discovering>
```

Front matter values are parsed from the brief. The effective gate cap is `max(brief.maxLines, DEFAULTS.maxLines)` (150) plus any explicit fix-round slack: a brief cap below 150 is floored to 150, a higher cap is honored, and a non-numeric cap fails closed. `maxLines` counts the imp-authored added+deleted lines (runner formatting excluded). `allow` is the path prefixes the diff may touch. `{wt}` becomes the worktree path. Mount `node_modules` as a named volume (`imp-nm-<repo>`) so Linux installs never land in the Windows worktree. The runner runs `test` itself in the gate; the imp's own "tests pass" claim is never trusted. Front-matter values are taken verbatim; inline `#` comments are unsupported.

## The queue and the hourly dispatcher

GitHub issues are the queue; labels are the state.

| Label | Set by | Meaning |
| --- | --- | --- |
| `imp:ready` | Opus triage (daily) | The issue has a brief comment and may be taken |
| `imp:working` | dispatcher | An imp is on it now |
| `imp:pr` | dispatcher | An imp PR is open (the issue comment links it) |
| `imp:failed` | dispatcher | Gate failed; reasons are commented. It needs a new brief or a human |
| `imp:needs-human` | fix.mjs | Open PR needs a human (max fix rounds, conflict, or gate fail on fix) |

**The brief** is an issue comment whose first line is `<!-- imp-brief -->`, followed by the brief (front matter + body, optionally in a ```` ```markdown ```` fence). The newest such comment wins. Writing it on the issue keeps every brief reviewable, and the dispatcher needs no local state.

**`dispatch.mjs`** runs hourly with no LLM of its own:
1. It skips the cycle if the previous one is still running (`dispatch.lock` &lt; 3h), or if 9router doesn't answer a `MAX` probe.
2. It sweeps open `imp` PRs with `fix.mjs` first (skip `imp:needs-human`).
3. It picks up to `--max 5` `imp:ready` issues: **at most `--per-repo 6` per repo (counting its open imp PRs)**, and never past `--wip 12` open imp PRs in total. Review + CI are the bottleneck, so the dispatcher stops when the pile is full.
4. It prefers **quiet repos** (no open human PRs, no commit in the last 6 h). Within a repo, `bot:review` issues (already diagnosed) go before bugs, then oldest first.
5. It runs `--concurrency 6` repos at once through `imp.mjs run → gate → pr` (same-repo imps stay sequential so `imp-nm-<repo>` volumes don't race), then relabels and comments the result on the issue.
6. Optional `--rsi` (or `IMPS_RSI=1`) runs `rsi.mjs` after the cycle.

Each cycle appends to `~/.imps/dispatch.jsonl`. `node imps/dispatch.mjs --dry-run` prints the picks and changes nothing.

## Install, update, recover

**Default locations** (no personal paths committed):

| What | Windows default | Unix default | Env override |
| --- | --- | --- | --- |
| Kit checkout (runner; code only) | `%LOCALAPPDATA%\imps-runner` | `~/.local/share/imps-runner` | `IMPS_RUNNER` / `IMPS_KIT_PATH` |
| Durable state | `%USERPROFILE%\.imps` | `~/.imps` | `IMPS_HOME` |
| Repo checkouts / worktrees | `%USERPROFILE%\code` | `~/code` | `IMPS_CODE` |
| Kit self-work clone | `%USERPROFILE%\code\.github` | `~/code/.github` | under `IMPS_CODE` / `defaults.kitFolder` |

```powershell
pwsh -File imps/setup.ps1                          # doctor + runner + CODE/.github + hourly + label-watch
pwsh -File imps/setup.ps1 -RunnerPath 'D:\imps-runner' -SkipLabelWatch
pwsh -File imps/update.ps1                         # git fetch/reset runner only
pwsh -File imps/uninstall.ps1                      # tasks gone; state kept
pwsh -File imps/doctor.ps1
```

`setup` is idempotent: re-running repairs the runner checkout, ensures `IMPS_CODE/.github` exists (fetch only — no hard reset on that clone), and re-registers tasks without clobbering locks, logs, stats, ledger, or `config.json`. Bash twins: `setup.sh` / `update.sh` / `uninstall.sh`.

**Scheduling (Windows).** Task `imps-dispatch` runs `~/.imps/hourly.cmd` hourly at :07 via `conhost.exe --headless`. The wrapper resets the **runner** checkout to `origin/main` so **only merged kit code runs unattended**, then `node imps/dispatch.mjs`. Logs: `~/.imps/hourly.log`. Task `imps-label-watch` is **on by default** (every 5 minutes, same entrypoint; the lock prevents overlap) — a cheap stand-in for a webhook on new `imp:ready` labels. Kill: `-SkipLabelWatch`, `IMPS_LABEL_WATCH=0`, or `config.json` → `"labelWatch": false`.

**Kit self-work loop.** `nitsuah/.github` is a first-class target under `IMPS_CODE/.github`. When an imp or RSI improves the kit (ledger failures, gate rejections, prompt weaknesses), it works in its **own separate git worktree** of that clone — never the detached `imps-runner` checkout and never the main `CODE/.github` working tree — then opens a normal PR under the same gate and auto-merge rules. After merge, `update.ps1` / the hourly reset pulls `main` into the runner so the next cycle runs the improved kit. Goal: each run makes the next one better.

**Triage stays with the hypervisor (and RSI).** Opus can still brief by hand; `rsi.mjs` may also file capped `imp:ready` issues from ledger/journey signals. The hourly loop never calls a paid model.

## Limits (so an unattended day stays boring)

Source of truth: `defaults.mjs`. `node imps/check-defaults.mjs` fails if this table drifts.

| Limit | Value | Where |
| --- | --- | --- |
| Turn cap per model run | imp 60 (0 disables), fix round 25, reviewer 25 (it is told to answer by ~18) | `runClaude({ maxTurns })` |
| Wall clock per run | imp 25 min, fix 20, review 12 | `--minutes` |
| Imps per cycle | 5, up to 6 per repo, at most 6 repos at once (same-repo imps run in sequence) | `dispatch.mjs --max/--per-repo/--concurrency` |
| Open imp PRs | 12 in total, 6 per repo | `--wip`, `--per-repo`, `pickIssues` |
| Imp runs per 24 h / `--daily-cap` | 100 | `loopBudget` |
| Repo cooldown | 12 h (`defaults.cooldownMs`) after two straight gate failures in a repo | `loopBudget` |
| Attempts per issue | 2 failed/killed runs without a PR (since the latest brief), then `imp:needs-human` + one comment | `defaults.maxIssueFailures`, `issueFailures` |
| No-edit fail-fast | 20 tool calls with no Edit/Write, run ends `no-edit-timeout` | `defaults.noEditTurns`, `config.json` `noEditTurns`, `IMPS_NO_EDIT_TURNS` |
| Fix rounds per PR | 2, then `imp:needs-human` | `fix.mjs --max-rounds` |
| Auto-merge earned trust | 3 clean merges/repo (`max(ledger, GitHub seed)`) | `defaults.autoMergeTrust`, `checks.mjs` |
| Label-watch poll | every 5 min (default on) | `defaults.labelWatchDefault`, `IMPS_LABEL_WATCH=0` |
| RSI issues per day | 3 | `defaults.rsiDailyIssueCap` |

Each cycle logs `runsLast24h` and `cooldown`. A cooldown means the briefs for that repo need a look before more model time goes there.

## Guardrails

- **Clean environment.** The imp gets PATH and the 9router URL and key, nothing else. No Claude session tokens, no GitHub token.
- **No push.** The worktree's push URL is `no_push`. Only `imp.mjs pr` / `fix.mjs` push, and only after the gate passes.
- **Tool allowlist.** Read, Edit, Write, Glob, Grep, limited `git …`, and `node …/runtest.mjs` only. No raw `docker run` / host npm for the model (the **gate** runs the brief's Docker test/lint). No `gh` in the sandbox.
- **Formatting is the runner's job.** If the brief has `format:`, the gate runs it first and commits any change as a separate `style: … (imp runner)` commit. The model never spends turns on whitespace.
- **Gate.** Tests and `lint:` exit 0 (usually in Docker via the brief), at least one commit, every *imp* commit has the trailer, no uncommitted leftovers, the diff is within the effective cap (brief caps below the 150-line default are floored to 150; higher caps are honored; fix-round slack is explicit; malformed caps fail closed), every path is under `allow`, and no `.github/`, `.env*`, secrets or lockfiles. A PR whose diff is over 100 lines and touches no test file is never auto-merged (`bigUntestedDiff`): the larger cap is paired with a stricter merge rule. Kit self-work still denies `.github/workflows/` and secrets inside the `.github` repo itself.
  - **Nothing to run is not two failures.** If the imp left edits uncommitted and made no commit, the gate reports one reason, `edits left uncommitted` — not `no commits` plus `tests not run`. One cause, one RSI issue.
  - **Salvage an uncommitted run.** When the imp made no commit of its own and the brief test passes on the dirty tree, the runner stages and commits the work itself (`imp: work for #<issue> (committed by runner)`, with the trailer) and records `gate.autoCommitted`. Scope, deny, size and the test still run afterwards.
  - **Guardrails are denied paths.** `imps/defaults.mjs`, any `imps-config.yml`/`.yaml`, any `CODEOWNERS` and everything under `.github/` (workflows included) are refused by the gate, so an imp cannot widen the limits it is judged by. A brief with no `allow:` cannot touch `imps/` at all; kit self-work briefs name the `imps/` files they may change in `allow:` (`defaults.mjs` stays denied regardless).
  - **A bug fix must change code.** The dispatcher tags briefs for `bug`-labelled issues with `kind: bug`; for those the gate fails a diff made only of docs, TASKS/CHANGELOG/README or images (`no code change …`).
  - **Parent/epic issues are tracking-only.** Mark parent bodies with `<!-- imp-epic -->`; dispatch the smallest actionable child instead. A child PR closes only its child issue with `Fixes #child`; if it references the parent, use `Refs #parent`. Never use `Fixes #parent` unless every child and the parent's end-to-end/manual acceptance is complete; keep the parent open until then. After every child PR merge, verify the child's Done when against current default-branch code and focused tests/E2E; if any criterion or review finding was deferred, reopen the child for tracking or create a focused residual child and update the parent checklist before counting it complete.
  - **One PR per issue.** `prGuard` (run before claiming and again before pushing) refuses a closed issue, an open `imp/<n>-*` PR, a merged `imp/<n>-*` PR, or a merged PR whose body has the kit's own `Fixes #n` line. The sweep closes any open imp PR whose issue a merged imp PR already fixed and records `outcome: closed-duplicate`.
- **Guardrail values are human-only.** The gate denies `imps/defaults.mjs` and any `imps-config.yml`, so an imp can never raise its own limits (stash#311).
  - **No merge without a bound head.** `mergeReady` requires the checks to be green *and* GitHub's `headRefOid` to equal the commit the runner pushed — a push between the poll and the merge leaves the PR open.
- **Review + merge.** Imp PRs open labelled `imp`, saying `Fixes #n`. `review.mjs` posts a read-only COMMENT and a recomputed verdict. Auto-merge runs only when (1) verdict is `approve`, (2) **every** check from `gh pr checks` is finished and green for two stable polls (required *and* optional — never `gh pr merge --auto`, which ignores non-required reds; see stash#305), (3) the repo has **earned trust**: `max(ledger clean merges, GitHub-seeded count of past merged imp PRs that passed checks and were not reverted)`. Seed query errors fail closed. Otherwise the PR stays open for `fix.mjs` / a human. Kill switch: `IMPS_AUTO_MERGE=0`.

## What gets measured

`imp.mjs` writes one ledger row per run to `~/.imps/runs.jsonl`, and the full transcript to `~/.imps/runs/<id>.jsonl`.

| Field | Why it matters |
| --- | --- |
| `briefHash` | Ties every outcome to an exact prompt version (preamble + brief) |
| `model`, `metrics.served`, `metrics.modelSwitches` | What was asked for vs. what 9router served. A run served by a fallback model, or that switched model mid-run, isn't evidence about the prompt |
| `metrics.turns`, `durationMs`, `turnMs.{median,max}` | Effort and stalls |
| `metrics.tools`, `toolErrors`, `errorKinds`, `denials` | Where the imp fights its tools (edit-miss, denied, command-failed …) |
| `metrics.tokens.{input,cacheRead,cacheWrite,output}`, `costEstimateUsd` | Token cost. The USD figure is the CLI's list-price estimate, not what 9router actually charged |
| `metrics.end` | success / error_max_budget_usd / error_max_turns / killed-timeout |
| `gate.{pass,reasons,lines,files}` | The deterministic verdict |
| `pr`, `outcome`, `review` | Did it merge, and how much review churn did it take |
| `notes[]` | Human or Opus observations (`imp.mjs note`) |

## RSI

Two layers:

### Automated (`rsi.mjs`)

Bounded, gated self-improvement. Reads the ledger, `dispatch.jsonl`, and open `bot:journey` / `bot:review` issues; files at most `rsiDailyIssueCap` `imp:ready` issues per day (with briefs) against the kit or the product repo. Dedupes by title/key. Never proposes touching `.github/workflows/` or secrets. Journeys that are pure stale baselines are skipped (human/runner work).

```bash
node imps/rsi.mjs --dry-run
node imps/dispatch.mjs --rsi          # or IMPS_RSI=1 on the hourly tick
```

**Kill switch:** `IMPS_RSI=0` or `~/.imps/config.json` → `{"rsi": false}`.

### Manual (hypervisor)

After every few runs, and weekly once imps are routine:

1. `node imps/imp.mjs report` / `node imps/stats.mjs` print the tables.
2. Each recurring failure becomes **one line** under "Lessons from earlier runs" in `PREAMBLE.md`, or one gate rule in `lib.mjs`. Each lesson line cites the run ids it came from.
3. That change goes in its own PR (or an RSI-filed imp). Because the brief hash changes, the next runs show whether it helped.
4. Delete a lesson once ~10 runs pass without hitting that failure. The preamble stays short.

### Token review (hypervisor)

The paid-model daily pass is the one cost we control, so review it on the same cadence as the runs above (weekly, or after ~10 triage logs):

1. Read the `usage-start` / `usage-end` lines and the `tool calls ~n` totals in `stash/agent/logs/imps-triage.log`. Which sections spent the most?
2. For each, ask in order: can a **deterministic script** do it (like `precheck.mjs`, which skips the model on quiet days)? If not, can a **free 9router model** do it (summaries, label checks, dedupe by error signature, templated briefs)? Only judgment calls (a brief for a new kind of bug, a conflict, an oversight call) stay on the paid model.
3. Move one thing per review: write it as a kit script with a test, in its own PR, and delete that step from the triage prompt. Log the saving (calls or % of the 5-hour limit) next to the change.
4. Add the next candidate to the 'Known gaps' list below so it isn't forgotten. Current candidates: auto-bump `maxLines` on `diff N > M` gate failures, brief lint at post time, dedupe journey issues with the same error signature, replace the 5-min label-watch poll with a webhook on `imp:ready`.


Don't draw conclusions from runs served by a fallback model; note them and rerun on the intended model.

## Stash (and other thin wrappers)

Repos such as `nitsuah/stash` may call this kit through:

- `scripts/imp-run.ps1` → `node <kit>/imps/imp.mjs …`
- `scripts/imp-add-trailer.ps1`
- `.github/imps-config.yml` (`kit_path` left empty in git)
- `.github/imps-path.txt` (docs) / local `.imps/kit-path.txt`

**Contract this PR expects from stash (no wrapper CLI change if already portable):**

1. Resolve kit path as: `IMPS_KIT_PATH` → `<repo>/.imps/kit-path.txt` → config `kit_path`.
2. Point that path at the **detached runner** from `setup.ps1` (not a path inside the stash worktree).
3. Do not commit machine-specific paths. After setup, copy `~/.imps/kit-path.txt` into the repo's ignored `.imps/kit-path.txt` or set `IMPS_KIT_PATH` in the user environment / Task Scheduler.
4. Optional `vault_prompt` in `imps-config.yml` is exported by `imp-run.ps1` as `IMPS_VAULT_PROMPT`. The kit honors it via `resolveVaultPrompt()` (report / RSI footers / doctor) without injecting the playbook into worker prompts.
5. Diff caps come from each brief's `maxLines` / `defaults.mjs` — stash does not drive the kit gate with a repo-level `max_diff_lines` key.

## Review

After the dispatcher opens a PR, **`review.mjs`** runs one read-only pass through 9router in the imp's worktree and posts the result as a single GitHub **COMMENT** review. It never posts a GitHub APPROVE event and never merges by itself — `imp.mjs pr` owns the merge decision.

- **Inputs:** the issue, the brief, and the diff (capped at 60 KB; the reviewer can Read the rest).
- **Tools:** Read, Grep, Glob, plus the read-only git commands Claude Code allows by default. Edit and Write are denied, and so are PowerShell, web access and subagents (`runner.mjs` ALWAYS_DENY). Running tests or builds is denied.
- **Prompt:** `REVIEW.md`, maintained by RSI like `PREAMBLE.md`. It has required steps (read around each hunk, Grep every changed identifier, check TASKS.md) and severities, and it ends in a JSON block.
- **Verdict:** recomputed by the runner from the findings (`parseReview`): any blocker or major means `request_changes`, anything above nit means `comment`, otherwise `approve`. A model that says "approve" next to a blocker can't wave a PR through.
- **Ledger:** `review` on the run row holds the verdict, the model's own verdict, counts by severity, the findings, turns, minutes, tokens, served models and the posted URL. `imp.mjs report` shows it as `approve (0B/0M/0m)`.

Run it by hand with `node imps/review.mjs <run-id> [--dry-run]`.

**What it's for, and what it isn't** (first evals, 2026-10-22):

| PR | Result |
| --- | --- |
| fire#230, first prompt | 40 turns, 10 denied command attempts; one valid minor finding (TASKS.md not ticked; that was the brief's `allow:` scope) |
| fire#230, after the "you can't run commands" line | 5 turns, 0.8 min, 0 errors; approve, and it missed that TASKS.md finding. That's why the required steps were added |
| vigil#320 replayed at the imp's commit | **missed the `tsc` error CI caught**, and approved |

So the reviewer judges *meaning*: does it fix the issue, does it break callers, is the test real. Anything a tool can check (types, lint, tests, baselines) belongs in the gate. Measure the reviewer over time by comparing its findings with what CI, CodeRabbit and you later find on the same PRs.

## Fix rounds

**`fix.mjs <run-id> [--dry-run]`** answers review feedback and red CI on an imp's open PR with a 9router imp, so routine comments don't need the paid hypervisor.

1. **Collect, with no model:** unresolved review threads, new human comments, the imp reviewer's blocker/major findings, and failing checks (with a log excerpt).
2. **Filter the noise** (`feedbackItems`, tested): bot summaries, "review skipped" and rate-limit notices, deploy previews and Netlify's deploy checks, confirmations, and anything carrying an `<!-- imp-` marker (our own replies) never become items. **No items means no model runs.**
3. **Clear a stale CodeRabbit block:** if CodeRabbit's old `CHANGES_REQUESTED` is the only blocker, CI is green and every thread is resolved, post `@coderabbitai approve` once (`shouldAskCodeRabbitApprove`).
4. **Otherwise the imp decides each item** using `FIX.md`: **fix** (small and in scope), **pushback** (wrong, with evidence), or **skip** (right but out of scope; make it its own issue). It works in the PR's own worktree, fast-forwarded to the PR branch first. Then the gate runs again with `--slack 30` extra lines. Only the imp's own commits need the imp trailer, so a fix pushed by a human or the hypervisor doesn't fail it.
5. **Gate passes:** push to the PR branch, reply on every thread (`<!-- imp-fix -->`), and resolve the fixed and skipped threads. Pushback threads stay open for the reviewer to answer. **Gate fails:** reset the worktree, label `imp:needs-human`, and comment the reasons.
6. **After 2 rounds, or on a merge conflict:** label `imp:needs-human` and do nothing else.

Every round is appended to the run's `fixes[]` in the ledger: items, decisions with replies, gate result, turns, tokens and served model. **That's the training data for 9router's comment judgment.** The hypervisor reads the decisions, overrides any it disagrees with (by replying on the thread), and turns recurring misjudgements into `FIX.md` lines, the same RSI loop as `PREAMBLE.md` and `REVIEW.md`.

First live round (vigil#320, 2026-10-22): one CodeRabbit finding (the priority regex matched `P20` as P2). The imp decided **fix**: a 2-line regex change, 7 turns, 1.4 min, one model. The gate passed, it pushed `a8659a1`, replied, and resolved the thread. The first attempt was voided by a runner bug (the trailer check on a hypervisor commit), fixed in the same PR.

**The hourly dispatcher sweeps open imp PRs before it picks new issues** (approved by the owner 2026-10-22). It runs `fix.mjs` on each open `imp` PR that isn't labelled `imp:needs-human`. Pushes go only to the imp's own PR branch; there are 2 rounds at most; a conflict or a failed gate means `imp:needs-human`. A clean PR costs only `gh` calls, and each result is logged as a `fix-sweep` event in `dispatch.jsonl`. The hypervisor still gets Auto-fix events, and can override a decision or run `fix.mjs` by hand.

## Brief checklist (from CI misses)

- **TypeScript repos:** include `tsc --noEmit` in the brief's `test:`. vitest doesn't type-check, so vigil#320 passed the gate and then failed CI's `test` and `docker-smoke`.
- **Node/Docker diagnostics:** keep `npm ci` stdout/stderr visible in test commands; redirecting both streams to `/dev/null` can hide install failures that surface only as a later `test exit 1/2`. For focused Vitest runs, use `--reporter=verbose` and capture the first failing test name, assertion, and output; do not report only an exit code. Evidence: Fire #321/#326 and Vigil #368 (2026-10-31).
- **UI changes in a repo with journeys:** a visual change moves the screenshot baselines (vhs#87: the phone shelf shifted ~45 px, a 15% diff). Regenerate the affected baselines in the caller's Playwright image (`npx playwright test --update-snapshots <spec>`), look at the image, and commit them as a runner commit. Until the runner does this itself, the reviewer does it before marking the PR ready.

- **Behaviour or data changes ripple into tests and journeys.** Before briefing, grep `tests/` and `tests/journeys/` for the text, ids, selectors and numbers the fix changes (fire#236 stopped the demo seed triggering "Equity Concentration Risk"; the insights journey kept asserting it and went red on main). Put those files in `allow:`, name them in "The fix" and raise `maxLines`. If a journey screenshot moves, say the baselines are regenerated by the runner or the caller, not the imp. Triage also checks the nightly journeys after a merge: a new red journey on a repo with a recent imp merge is the imp's cost to fix, so file or brief it the same day.
- **No nested code fences in a brief.** `briefFromComments` takes everything up to the first closing fence, so an inner ```` ```js ```` block silently truncates the brief (vhs#77: the imp saw half the instructions and spent 40 turns exploring). Write inner code blocks with `~~~` fences. A brief missing its closing fence is not parsed at all (vigil#315: "front matter needs repo and issue"). After posting, check with `briefFromComments` + `parseBrief`, or look at the dispatcher's first run for the brief length.
- **Write the code into the brief when the edit is mechanical.** Briefs that say "restore the old behaviour" and leave the imp to find the markup make it explore until the turn cap (vhs#77, 41 tool calls, no edit). Give the exact function body and the exact lines, say "do not explore", and split anything that needs a design choice (new markup, layout) into its own issue.
- **Re-brief from the gate reasons.** When an issue goes `imp:failed` twice (vigil#276), read both gate reasons before writing the next brief. Tighten `allow:` and `maxLines`, quote the exact lines to change, and split the issue if it has two parts (vhs#77). Don't resend the same brief.
- **Don't brief what needs a decision you can make yourself.** Pick the obvious option from the issue and the code (the dashboard is the source of truth over the MCP) and write it into the brief. Only ask the owner for a call that is costly or hard to undo, and ask it as a multiple-choice question.

## Token savers and measuring them

`node imps/stats.mjs` prints the two tables on demand: open issues / bugs / PRs / imp labels per repo, and per-run token use (`--repos`, `--tokens`, `--since 24h|7d|all`, `--json`). Runs killed before a usage report show an estimated input (`~`: tool calls x median input per turn).  First baseline (18 runs, 2026-10-22/23): 10.3M input, median 30k per turn, 36% of it in runs that never passed the gate, 0 cache reads, and reviews averaging 501k input each.

What the kit does about it:

- **Context trim.** Workers start with `--disable-slash-commands --no-session-persistence --tools <only what they use>`. A trivial prompt went from 14.5k to 7.7k input tokens (-47%) with the same answer. `IMPS_NO_TRIM=1` turns it off. Compare `metrics.init` (tool / slash-command / skill counts) in the ledger across versions.
- **Fail fast.** An imp that makes `noEditTurns` tool calls (default 12, configurable) with no Edit/Write is stopped as `no-edit-timeout` (vhs#77 burned 41 calls exploring twice; the limit is `defaults.noEditTurns`, overridable in `config.json` or `IMPS_NO_EDIT_TURNS`, and is recorded as `metrics.noEditTurns`). `metrics.firstEditTurn` records when the first edit landed.
- **One-shot reviews.** `review.mjs` defaults to `--mode chat`: one `/v1/chat/completions` call with the diff, brief and issue in the prompt (about 5k input) instead of a read-only agent session (about 500k). It falls back to the agent session if the answer is unusable. `review.mode` in the ledger tells them apart.
- **Honest metrics.** Killed runs now record `turns` from tool calls and `unmetered: true` instead of zeros.

What 9router offers that we are not using yet (from its source, v0.5.104):

- **RTK** (on by default) compresses `tool_result` text (`git diff`, `grep`, `ls`) in requests, 20-40% of input per its README; **Headroom** (external `/v1/compress`) and **Caveman** (terse replies, up to 65% fewer output tokens) are off. Header `X-9Router-Token-Saver: off` bypasses all of them for one request. Worth an A/B on a real batch of runs, because our per-turn input is mostly resent context, not tool output.
- **No cache accounting.** Responses carry only `prompt_tokens` / `completion_tokens` (no cached-token field for the current `MAX` model), so cache hits cannot be measured through 9router today. The dashboard's `/api/usage/*` routes (stats, request-details, history) need a dashboard login, not the API key.
- **`MAX` is a reasoning model** and may put its reasoning in `content`. Keep `max_tokens` generous for chat calls and parse for the `json` block rather than expecting only JSON.
- **Baseline cost per call**: a one-line prompt cost 2.8k prompt tokens on `/v1/chat/completions`, so some system text is injected upstream.
- Other endpoints (`/v1/messages/count_tokens`, `/v1/embeddings`, `/v1/search`, `/v1/web/fetch`, `/v1/models`) are available for cheap pre-checks, issue dedupe and the model probe.

## Known gaps (next)

- **Baseline tests.** The gate fails on any failing test. It should also run the test command on `baseSha` and only count failures that are new. fire's server fail-fast tests time out locally while main's CI is green.
- **Model probe.** Runs 1–2 went through a 9router build that sent `MAX` to OpenRouter's free auto-router: 10–11 models and 43–65 switches per run. Rebuilt on v0.5.104, `MAX` serves one model (run 3: 0 switches, gate pass). Add a pre-run probe that holds the run if the served model changes mid-run (IMPS-PLAN D9).
- **Prompt caching.** Run 3 sent 1.57M input tokens with 0 cache reads for a 40-line fix. Find a 9router route for `MAX` that caches, or trim the context each turn resends.

## demonguard (lingering PRs)

`imp.mjs pr` decides about auto-merge once, when it opens a PR. A PR that was not ready then (CI still running, trust not yet earned, the reviewer never answered) used to sit open until the open-PR cap stalled dispatch. `demonguard.mjs` runs on every dispatch tick and gives each open imp PR exactly one action, chosen by the pure `assessPr()`:

| Action | When | What it does |
| --- | --- | --- |
| `merge` | imp review `approve`, every check green, repo trust earned, no open bot threads | squash-merge with `--match-head-commit`; the same rules as `imp.mjs pr`, applied later |
| `rereview` | no imp review recorded | reruns `review.mjs` (9router) |
| `dismiss-stale-review` | a bot's latest review is CHANGES_REQUESTED and none of its threads is open | dismisses it |
| `owner` | all good but trust is not earned | logged in the `demonguard` event's `owner` list; never merged |
| `needs-human` | red checks, conflicts or a non-approve review for over 24 h | labels the PR `imp:needs-human` |
| `wait` / `wait-fix` | too young (< 30 min), checks pending, or the fix-sweep is on it | nothing |

Each tick logs one `demonguard` event with the counts. It never uses `--admin`. Kill switch: `IMPS_DEMONGUARD=0`; manual: `node imps/demonguard.mjs --dry-run`.

## One retry with the failing output

A first gate failure used to end the attempt and wait for a human re-brief, even though the gate now records the exact test or lint output. When a run fails only on `tests exit N`, `lint exit N` and/or `edits left uncommitted` and that output was recorded, the dispatcher puts the issue back on `imp:ready` once (`retry-feedback` event) and the second attempt's brief gets a "Previous attempt failed" block with that output, framed as data, fenced, redacted and capped. Scope, trailer, size and "did nothing" failures are not retried. The per-issue attempt cap (2) and the daily cap still bound it. Kill switch: `IMPS_RETRY_FEEDBACK=0`.

## Repeat-failure guard (opt-in)

An advisory, per-run guard can nudge the worker when the same coarse tool error repeats. It is **off by default**.

- **Enable:** set `IMPS_REPEAT_FAILURE_GUARD=1` in the environment (not in `defaults.mjs`, not in `config.json`).
- **Launch mode when enabled:** the initial prompt is sent as a JSONL user message over stdin with `--input-format stream-json`; the default argv-prompt / stdin-ignored launch is unchanged when off.
- **What it tracks:** only the explicit allowlist of coarse `errorKind` values: `edit-miss`, `edit-unread`, `bad-tool-call`, `missing-path`, `command-failed`, `timeout`. `denied`, `other`, and any unknown strings are ignored.
- **Threshold:** on the **third** occurrence of the same kind in this run, a single advisory user message is injected containing only the normalized kind (e.g. `Repeated edit-miss: stop repeating the same failed operation, inspect current state, and change approach.`). No raw error text, tool arguments, file paths, prompt fragments, or secrets are ever included.
- **Bounds:** each counter saturates at 5; at most `allowlist.length` signatures are tracked; at most one nudge per kind per run. State is local to the `runClaude` invocation — no ledger, no file, no cross-run persistence.
- **Fail-open:** if the stdin write errors or backpressures, the guard disables itself for the rest of the run and the worker continues unchanged. The child process is never killed, the handler never throws, and no tool allowances, budgets, turn caps, gate, review, or merge behavior is altered.
- **Advisory only:** the guard cannot terminate a run, authorize a tool, widen scope, alter the diff/test gate, or influence PR/review/merge decisions.
