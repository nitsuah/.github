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
2. It picks up to `--max 5` `imp:ready` issues: **one per repo**, never in a repo that already has an `imp` PR open, and never past `--wip 8` open imp PRs in total. Your review is the bottleneck, so the dispatcher stops when the review pile is full.
3. It prefers **quiet repos** (no open human PRs, no commit in the last 6 h). Within a repo, `bot:review` issues (already diagnosed) go before bugs, then oldest first.
4. It runs `--concurrency 3` imps at once through `imp.mjs run → gate → pr`, then relabels and comments the result on the issue.

Each cycle appends to `~/.imps/dispatch.jsonl`. `node imps/dispatch.mjs --dry-run` prints the picks and changes nothing.

**Scheduling (Windows).** The Task Scheduler task `imps-dispatch` runs `~/.imps/hourly.cmd` at :07 every hour. The wrapper first resets a dedicated checkout (`~/code/imps-runner`) to `origin/main`, so **only merged, reviewed kit code runs unattended**. Output goes to `~/.imps/hourly.log`. When this moves into motor-pool (IMPS-PLAN PR 3), the same loop becomes the `imp-runner` service, and a second runner on the desktop just claims from the same labels.

**Triage stays with the hypervisor.** Opus reads new issues once a day and either posts a brief and adds `imp:ready`, or labels the issue for a human. It also re-briefs `imp:failed` issues, using the gate reasons and the PREAMBLE lessons. The hourly loop never calls a paid model.

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

## Brief checklist (from CI misses)

- **TypeScript repos:** include `tsc --noEmit` in the brief's `test:`. vitest doesn't type-check, so vigil#320 passed the gate and then failed CI's `test` and `docker-smoke`.
- **UI changes in a repo with journeys:** a visual change moves the screenshot baselines (vhs#87: the phone shelf shifted ~45 px, a 15% diff). Regenerate the affected baselines in the caller's Playwright image (`npx playwright test --update-snapshots <spec>`), look at the image, and commit them as a runner commit. Until the runner does this itself, the reviewer does it before marking the PR ready.

## Known gaps (next)

- **Baseline tests.** The gate fails on any failing test. It should also run the test command on `baseSha` and only count failures that are new. fire's server fail-fast tests time out locally while main's CI is green.
- **Model probe.** Runs 1–2 went through a 9router build that sent `MAX` to OpenRouter's free auto-router: 10–11 models and 43–65 switches per run. Rebuilt on v0.5.104, `MAX` serves one model (run 3: 0 switches, gate pass). Add a pre-run probe that holds the run if the served model changes mid-run (IMPS-PLAN D9).
- **Prompt caching.** Run 3 sent 1.57M input tokens with 0 cache reads for a 40-line fix. Find a 9router route for `MAX` that caches, or trim the context each turn resends.
