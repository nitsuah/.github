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
repo: fire                       # folder under ~/code
issue: 166
test: docker run --rm -v {wt}://app -v imp-nm-fire://app/node_modules -w //app node:22 sh -c "npm ci --no-audit --no-fund >/dev/null 2>&1 && npx vitest run --config config/vitest.config.ts"
maxLines: 40                     # gate: total added+deleted lines
allow: app/lib/, docs/CHANGELOG.md   # gate: path prefixes the diff may touch
---
## Issue nitsuah/fire#166
<the problem, where it is, what done looks like, and repo facts the imp would otherwise burn turns discovering>
```

`{wt}` becomes the worktree path. Mount `node_modules` as a named volume (`imp-nm-<repo>`) so Linux installs never land in the Windows worktree. The runner runs `test` itself in the gate; the imp's own "tests pass" claim is never trusted.

## Guardrails

- **Clean environment.** The imp gets PATH and the 9router URL and key, nothing else. No Claude session tokens, no GitHub token.
- **No push.** The worktree's push URL is `no_push`. Only `imp.mjs pr` pushes, and only after the gate passes.
- **Tool allowlist.** Read, Edit, Write, Glob, Grep, `git status|diff|add|commit|log|checkout --`, `docker run`. No `gh`, no host npm/node.
- **Gate.** Tests exit 0 in Docker, at least one commit, every commit has the imp trailer, no uncommitted leftovers, the diff is within `maxLines` (default 80), every path is under `allow`, and no `.github/`, `.env*`, secrets or lockfiles.
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

## Known gaps (next)

- **Baseline tests.** The gate fails on any failing test. It should also run the test command on `baseSha` and only count failures that are new. fire's server fail-fast tests time out locally while main's CI is green.
- **Pin a real model.** Both fire#166 runs went through `MAX` while 9router was in fallback: 10–11 free models, 43–65 switches, 0 cache reads. Add a pre-run probe that holds the run when the served model isn't the intended one (IMPS-PLAN D9).
