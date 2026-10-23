# Imps

Imps are headless `claude -p` workers, run through 9router, that each take **one GitHub issue to one draft PR**. This kit is the smoke-test version: it runs by hand from a Claude Code session, and every run is measured so the prompt and the gate improve before imps move into motor-pool loops. The target architecture is `motor-pool/docs/IMPS-PLAN.md`.

## Flow

```
brief.md ──► imp.mjs run ──► worktree + claude -p (clean env, 9router) ──► local commits
                                                                              │
              imp.mjs gate ◄──────────────────────────────────────────────────┘
              (tests in Docker, diff size, scope, deny paths, trailer)
                  │ pass                       │ fail
                  ▼                            ▼
              imp.mjs pr  → draft PR, label `imp`     ledger row + note → next RSI pass
                  │
              CodeRabbit + @nitsuah review → imp.mjs outcome
```

## A brief

Front matter, then the issue-specific body. `PREAMBLE.md` is prepended to every brief.

```markdown
---
repo: fire
issue: 166
test: docker run --rm -v {wt}://app -v imp-nm-fire://app/node_modules -w //app node:22 sh -c "npm ci --no-audit --no-fund >/dev/null 2>&1 && npx vitest run --config config/vitest.config.ts"
format: docker run --rm -v {wt}://app -v imp-nm-fire://app/node_modules -w //app node:22 npx eslint --config config/eslint.config.mjs --fix app/lib
lint: docker run --rm -v {wt}://app -v imp-nm-fire://app/node_modules -w //app node:22 npx eslint --config config/eslint.config.mjs app/lib
maxLines: 40
allow: app/lib/, docs/CHANGELOG.md
---
## Issue nitsuah/fire#166
<the problem, where it is, what done looks like, and repo facts the imp would otherwise burn turns discovering>
```

Front matter values are taken verbatim, so don't add trailing `#` comments. `repo` is the folder under `~/code`. `maxLines` is the imp's added+deleted lines (runner formatting excluded). `allow` is the path prefixes the diff may touch. `{wt}` becomes the worktree path. Mount `node_modules` as a named volume (`imp-nm-<repo>`) so Linux installs never land in the Windows worktree. The runner runs `test` itself in the gate; the imp's own "tests pass" claim is never trusted.

## The queue and the hourly dispatcher

GitHub issues are the queue; labels are the state.

| Label | Set by | Meaning |
| --- | --- | --- |
| `imp:ready` | Opus triage (daily) | The issue has a brief comment and may be taken |
| `imp:working` | dispatcher | An imp is on it now |
| `imp:pr` | dispatcher | A draft PR is open (the issue comment links it) |
| `imp:failed` | dispatcher | Gate failed; reasons are commented. It needs a new brief or a human |

**The brief** is an issue comment whose first line is `<!-- imp-brief -->`, followed by the brief (front matter + body, optionally in a ```` ```markdown ```` fence). The newest such comment wins. Writing it on the issue keeps every brief reviewable, and the dispatcher needs no local state.

**`dispatch.mjs`** runs hourly with no LLM of its own:
1. It skips the cycle if the previous one is still running, or if 9router doesn't answer a `MAX` probe.
2. It picks up to `--max 5` `imp:ready` issues: **at most `--per-repo 2` per repo (counting its open imp PRs)**, and never past `--wip 8` open imp PRs in total. Your review is the bottleneck, so the dispatcher stops when the review pile is full.
3. It prefers **quiet repos** (no open human PRs, no commit in the last 6 h). Within a repo, `bot:review` issues (already diagnosed) go before bugs, then oldest first.
4. It runs `--concurrency 3` imps at once through `imp.mjs run → gate → pr`, then relabels and comments the result on the issue.

Each cycle appends to `~/.imps/dispatch.jsonl`. `node imps/dispatch.mjs --dry-run` prints the picks and changes nothing.

**Scheduling (Windows).** The Task Scheduler task `imps-dispatch` runs `~/.imps/hourly.cmd` at :07 every hour. It launches through `conhost.exe --headless cmd.exe /d /c "…\hourly.cmd"`, so no console window appears (the same pattern as `Sync 9router fork`). Every process the kit spawns also passes `windowsHide: true`. The wrapper first resets a dedicated checkout (`~/code/imps-runner`) to `origin/main`, so **only merged, reviewed kit code runs unattended**. Output goes to `~/.imps/hourly.log`. When this moves into motor-pool (IMPS-PLAN PR 3), the same loop becomes the `imp-runner` service, and a second runner on the desktop just claims from the same labels.

**Triage stays with the hypervisor.** Opus reads new issues once a day and either posts a brief and adds `imp:ready`, or labels the issue for a human. It also re-briefs `imp:failed` issues, using the gate reasons and the PREAMBLE lessons. The hourly loop never calls a paid model.

## Limits (so an unattended day stays boring)

| Limit | Value | Where |
| --- | --- | --- |
| Turn cap per model run | imp 40, fix round 25, reviewer 25 (it is told to answer by ~18) | `runClaude({ maxTurns })`. Enforced by the runner, because this CLI ignores `--max-turns`. Runs end `killed-max-turns` |
| Wall clock per run | imp 25 min, fix 20, review 12 | `--minutes` |
| Imps per cycle | 5, up to 2 per repo, at most 3 repos at once (same-repo imps run in sequence) | `dispatch.mjs --max/--concurrency` |
| Open imp PRs | 8 in total, 2 per repo | `--wip`, `--per-repo`, `pickIssues` |
| Imp runs per 24 h | 15 | `--daily-cap`, `loopBudget` |
| Repo cooldown | 24 h after two straight gate failures in a repo | `loopBudget` |
| Fix rounds per PR | 2, then `imp:needs-human` | `fix.mjs --max-rounds` |

Each cycle logs `runsLast24h` and `cooldown`. A cooldown means the briefs for that repo need a look (daily triage) before more model time goes there.

## Guardrails

- **Clean environment.** The imp gets PATH and the 9router URL and key, nothing else. No Claude session tokens, no GitHub token.
- **No push.** The worktree's push URL is `no_push`. Only `imp.mjs pr` pushes, and only after the gate passes.
- **Tool allowlist.** Read, Edit, Write, Glob, Grep, `git status|diff|add|commit|log|checkout --`, `docker run`. No `gh`, no host npm/node.
- **Formatting is the runner's job.** If the brief has `format:`, the gate runs it first and commits any change as a separate `style: … (imp runner)` commit. The model never spends turns on whitespace.
- **Gate.** Tests (filter by path prefix, not exact filename) and `lint:` exit 0 in Docker, at least one commit, every commit has the imp trailer, no uncommitted leftovers, the diff is within `maxLines` (default 80), every path is under `allow`, and no `.github/`, `.env*`, secrets or lockfiles.
- **Review.** Imp PRs open as **drafts** labelled `imp`, saying `Fixes #n`. They're never auto-merged. Marking the draft "ready for review" is your +1, and CodeRabbit reviews it like any other PR. Once imps run unattended, they move to a GitHub App identity (IMPS-PLAN D5), so a ruleset can require your approval on `imp` PRs; you can't approve PRs pushed under your own account.

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

After every few runs, and weekly once imps are routine:

1. `node imps/imp.mjs report` prints a per-run table plus the tool-error kinds and gate failures that recur.
2. Each recurring failure becomes **one line** under "Lessons from earlier runs" in `PREAMBLE.md`, or one gate rule in `lib.mjs`. Each lesson line cites the run ids it came from.
3. That change goes in its own PR. Because the brief hash changes, the next runs show whether it helped.
4. Delete a lesson once ~10 runs pass without hitting that failure. The preamble stays short.

### Token review (hypervisor)

The paid-model daily pass is the one cost we control, so review it on the same cadence as the runs above (weekly, or after ~10 triage logs):

1. Read the `usage-start` / `usage-end` lines and the `tool calls ~n` totals in `stash/agent/logs/imps-triage.log`. Which sections spent the most?
2. For each, ask in order: can a **deterministic script** do it (like `precheck.mjs`, which skips the model on quiet days)? If not, can a **free 9router model** do it (summaries, label checks, dedupe by error signature, templated briefs)? Only judgment calls (a brief for a new kind of bug, a conflict, an oversight call) stay on the paid model.
3. Move one thing per review: write it as a kit script with a test, in its own PR, and delete that step from the triage prompt. Log the saving (calls or % of the 5-hour limit) next to the change.
4. Add the next candidate to the 'Known gaps' list below so it isn't forgotten. Current candidates: merge passing imp PRs as a script, auto-bump `maxLines` on `diff N > M` gate failures, brief lint at post time, dedupe journey issues with the same error signature.


Don't draw conclusions from runs served by a fallback model; note them and rerun on the intended model.

## Review

After the dispatcher opens a draft PR, **`review.mjs`** runs one read-only `claude -p` pass through 9router in the imp's worktree and posts the result as a single GitHub **COMMENT** review. It never approves, never blocks, and never merges.

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
- **UI changes in a repo with journeys:** a visual change moves the screenshot baselines (vhs#87: the phone shelf shifted ~45 px, a 15% diff). Regenerate the affected baselines in the caller's Playwright image (`npx playwright test --update-snapshots <spec>`), look at the image, and commit them as a runner commit. Until the runner does this itself, the reviewer does it before marking the PR ready.

- **Behaviour or data changes ripple into tests and journeys.** Before briefing, grep `tests/` and `tests/journeys/` for the text, ids, selectors and numbers the fix changes (fire#236 stopped the demo seed triggering "Equity Concentration Risk"; the insights journey kept asserting it and went red on main). Put those files in `allow:`, name them in "The fix" and raise `maxLines`. If a journey screenshot moves, say the baselines are regenerated by the runner or the caller, not the imp. Triage also checks the nightly journeys after a merge: a new red journey on a repo with a recent imp merge is the imp's cost to fix, so file or brief it the same day.
- **No nested code fences in a brief.** `briefFromComments` takes everything up to the first closing fence, so an inner ```` ```js ```` block silently truncates the brief (vhs#77: the imp saw half the instructions and spent 40 turns exploring). Write inner code blocks with `~~~` fences. A brief missing its closing fence is not parsed at all (vigil#315: "front matter needs repo and issue"). After posting, check with `briefFromComments` + `parseBrief`, or look at the dispatcher's first run for the brief length.
- **Write the code into the brief when the edit is mechanical.** Briefs that say "restore the old behaviour" and leave the imp to find the markup make it explore until the turn cap (vhs#77, 41 tool calls, no edit). Give the exact function body and the exact lines, say "do not explore", and split anything that needs a design choice (new markup, layout) into its own issue.
- **Re-brief from the gate reasons.** When an issue goes `imp:failed` twice (vigil#276), read both gate reasons before writing the next brief. Tighten `allow:` and `maxLines`, quote the exact lines to change, and split the issue if it has two parts (vhs#77). Don't resend the same brief.
- **Don't brief what needs a decision you can make yourself.** Pick the obvious option from the issue and the code (the dashboard is the source of truth over the MCP) and write it into the brief. Only ask the owner for a call that is costly or hard to undo, and ask it as a multiple-choice question.

## Known gaps (next)

- **Baseline tests.** The gate fails on any failing test. It should also run the test command on `baseSha` and only count failures that are new. fire's server fail-fast tests time out locally while main's CI is green.
- **Model probe.** Runs 1–2 went through a 9router build that sent `MAX` to OpenRouter's free auto-router: 10–11 models and 43–65 switches per run. Rebuilt on v0.5.104, `MAX` serves one model (run 3: 0 switches, gate pass). Add a pre-run probe that holds the run if the served model changes mid-run (IMPS-PLAN D9).
- **Prompt caching.** Run 3 sent 1.57M input tokens with 0 cache reads for a 40-line fix. Find a 9router route for `MAX` that caches, or trim the context each turn resends.
