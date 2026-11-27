# Imps

Imps are headless `claude -p` workers, run through 9router, that each take **one GitHub issue to one small PR**. Install and recover with [`setup.ps1`](./setup.ps1) (see [`README.md`](./README.md)). Every default that used to drift between docs and code lives in [`defaults.mjs`](./defaults.mjs) — run `node imps/check-defaults.mjs` to keep this file honest. The long-term home is `motor-pool/docs/IMPS-PLAN.md`.

## Flow

```
brief.md ──► imp.mjs run ──► worktree + claude -p (clean env, 9router) ──► local commits
                                                                              │
              imp.mjs gate ◄──────────────────────────────────────────────────┘
              (declared test/lint commands, diff size, scope, deny paths, trailer)
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
allow: app/lib/
---
## Issue nitsuah/fire#166
<the problem, where it is, what done looks like, and repo facts the imp would otherwise burn turns discovering>
```

**Changelog exclusion:** `CHANGELOG.md` and all release-note files are forbidden in every imp diff. Never include them in `allow:` or ask an imp to add release notes; the owner handles release notes after merge.

**Required front matter:** `repo` and `issue` **must** be present in the YAML front matter and must exactly match the target repository slug and issue number. The dispatcher validates this before any imp run starts; on mismatch it logs `invalid-brief`, relabels the issue `imp:failed`, and posts a correction comment. It does not create a ledger run/claim or increment the issue attempt count.

Front matter values are parsed from the brief. The effective gate cap is `max(brief.maxLines, DEFAULTS.maxLines)` (180) plus any explicit fix-round slack: a brief cap below 180 is floored to 180, a higher cap is honored, and a non-numeric cap fails closed. `maxLines` counts the imp-authored added+deleted lines (runner formatting excluded) outside test files. Test files (`tests/`, `tests_playwright/`, `e2e/`, `*.test.*`, `*.spec.*`) have their own cap, `maxTestLines`, which defaults to twice the effective `maxLines`; a brief that asks for several test scenarios no longer fails on size (vhs#169). `repo:` is the bare repo name; the owner's `owner/repo` slug is accepted as the same repo. For a repo under another configured owner (`owners` in `~/.imps/config.json`), write the full `Owner/name`: that is its identity in the queue, locks and ledger, and its checkout is `IMPS_CODE/Owner__name` (or `IMPS_CODE/name` when that clone's origin is the same slug). `allow` is the path prefixes the diff may touch. `{wt}` becomes the worktree path. The gate executes `test:` and `lint:` literally as shell commands in the worktree (`spawnSync` with `gateShell()`); it does **not** add a Docker wrapper. Prefer the repository's native focused command (for example, `npm test -- <focused-file>`) when the runner toolchain is available. Include `docker run` explicitly only when the brief requires a containerized toolchain; then use the canonical single-slash container paths: `-v {wt}:/app -v imp-nm-<repo>:/app/node_modules -w /app` (omit the named volume when no Node install is needed). This keeps Linux installs out of a Windows worktree; keep the container target and working directory exactly `/app`. A shell exit 127 is the command-not-found class: verify the exact executable and capture stderr rather than treating it as an assertion failure. The gate runs the declared test/lint commands itself; the imp's own "tests pass" claim is never trusted. Before choosing `npm ci` or `npm run` commands, verify that the target workdir contains `package.json` and that each named script exists; for Node-native repos without a manifest, use the documented `node` commands rather than generic npm scripts. Front-matter values are taken verbatim; inline `#` comments are unsupported.

## The queue and the hourly dispatcher

GitHub issues are the queue; labels are the state.

| Label | Set by | Meaning |
| --- | --- | --- |
| `imp:ready` | owner, or `groom.mjs` every 3 h when a draft passes `groom-promote.mjs` (the daily Opus triage was retired 2026-10-30) | A valid current brief is present, declared dependencies are closed/merged, and no known issue-level gate blocks it; eligible for dispatcher selection (global caps may still defer) |
| `imp:working` | dispatcher | An imp is on it now |
| `imp:pr` | dispatcher | An imp PR is open (the issue comment links it) |
| `imp:failed` | dispatcher | Gate failed; reasons are commented. It needs a new brief or a human |
| `imp:needs-human` | fix.mjs | Open PR needs a human (max fix rounds, conflict, or gate fail on fix) |

Before applying `imp:ready`, verify the current default-branch code/tests, canonical brief metadata and executable commands, exact allowlist/diff cap, dependencies, active claims/open PRs, and known repo cooldown or human/visual/production gates. The dispatcher parses the raw front-matter `depends:` value with `parseDepends` (not a YAML parser): start each comma item with a reference such as `#318` or `vigil#12`; do not quote the value or put prose before the first reference (`depends: "fire#444"` will not parse). If a note is needed, append it after a semicolon (`depends: #444; must merge before dispatch`); the parser stops at the semicolon. Prose such as `part 2 of #439` is not a dependency. Leave blocked issues unlabelled so the queue count represents genuinely dispatchable work.

**The brief** is an issue comment whose first line is `<!-- imp-brief -->`, followed by the brief (front matter + body, optionally in a ```` ```markdown ```` fence). The newest such comment wins. Writing it on the issue keeps every brief reviewable, and the dispatcher needs no local state.

**`dispatch.mjs`** runs hourly with no LLM of its own:
1. It skips the cycle if the previous one is still running (`dispatch.lock` &lt; 3h), or if 9router doesn't answer a `MAX` probe. **Overflow:** once the running cycle has held the lock for `overflowAfterMs` (15 min), a tick starts one pick-only cycle instead (`dispatch-overflow.lock`). It skips steps 2 and 6 and all housekeeping, and never picks a repo the other cycle lists as `busy` in its lock, so same-repo imps still never overlap. A single slow run used to hold every tick for hours (2026-11-19: 2.5 h of skipped ticks). Kill switch: `IMPS_OVERFLOW=0`. A cycle that picks nothing still runs RSI and the heartbeat (it used to exit first, so an idle machine never beat).
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
| Wall clock per run | imp 15 min (`defaults.runMinutes`), fix 20, review 12 | `--minutes` |
| Overflow cycle | after the main cycle has held the lock 15 min (`defaults.overflowAfterMs`), one pick-only cycle on repos it isn't touching. Locks are created exclusively and released only by their owner; each cycle publishes its busy repos (imps and fix rounds) and its unstarted picks, which count against the other cycle's daily cap. Run ids carry the repo (`imp_<time>_<issue>_<repo>`). Lock updates are atomic (temp file + rename); the protocol is `locks.mjs` | `config.json` `overflowAfterMs`, `IMPS_OVERFLOW=0` |
| Imps per cycle | 5, up to 6 per repo, at most 6 repos at once (same-repo imps run in sequence) | `dispatch.mjs --max/--per-repo/--concurrency` |
| Open imp PRs | 12 in total, 6 per repo | `--wip`, `--per-repo`, `pickIssues` |
| Imp runs per 24 h / `--daily-cap` | 100 (`dailyCap` in `~/.imps/config.json` overrides) | `loopBudget` |
| Repo cooldown | 24 h (`defaults.cooldownMs`; `cooldownMs` in `~/.imps/config.json` overrides, 0 turns it off) after two straight gate failures in a repo | `loopBudget` |
| Attempts per issue | 2 failed/killed runs without a PR (since the latest brief), then `imp:needs-human` + one comment | `defaults.maxIssueFailures`, `issueFailures` |
| No-edit fail-fast | 20 tool calls with no Edit/Write, run ends `no-edit-timeout` | `defaults.noEditTurns`, `config.json` `noEditTurns`, `IMPS_NO_EDIT_TURNS` |
| Fix rounds per PR | 2, then `imp:needs-human` | `fix.mjs --max-rounds` |
| Auto-merge earned trust | 3 clean merges/repo (`max(ledger, GitHub seed)`) | `defaults.autoMergeTrust`, `checks.mjs` |
| Label-watch poll | every 5 min (default on) | `defaults.labelWatchDefault`, `IMPS_LABEL_WATCH=0` |
| RSI issues per day | 3 | `defaults.rsiDailyIssueCap` |

Each cycle logs `runsLast24h` and `cooldown`. A cooldown means the briefs for that repo need a look before more model time goes there.

## Risk controls

Code decides these from the changed paths. No model's verdict lowers a class, and a failed lookup counts as high.

| Class | Paths (`riskClass` in `lib.mjs`) |
| --- | --- |
| `high` | auth, session, OAuth/OIDC, token, JWT, crypto, secret and CSP words in a source path; payments, billing, Plaid, Stripe; `next.config.*`, `middleware.*`, headers files; migrations, `*.sql`, `schema.prisma`; `.github/workflows/` and actions; Dockerfile and compose; wrangler, Netlify, Vercel and Cloudflare config, `_headers`, `_redirects`; `.env*`; `CODEOWNERS`; anything under `security/`; a lockfile change with no manifest change |
| `medium` | any other non-test source. Also Markdown that instructs an agent (`CLAUDE.md`, `AGENTS.md`, `SKILL.md`, `PREAMBLE.md`, `REVIEW.md`, `BUGBOT.md`, `FIX.md`), manifests, `requirements*.txt`, `.mdx`, `.svg` |
| `low` | only tests, docs, CHANGELOG and TASKS. The word and headers-file rules skip these; the path rules (workflows, `security/`, Dockerfile and the like) do not |

A brief's `risk:` front matter raises the class and never lowers it; an unknown value is `high`.

| Control | Rule | Enforced by |
| --- | --- | --- |
| Record | the class is stored as `risk` on the run row (a later gate never lowers it) and the PR is labelled `risk:<class>`; demonguard and fix rounds re-apply it | `imp.mjs gate` / `pr`, `fix.mjs`, `demonguard.mjs` |
| Named high paths | the gate fails a high-risk path unless `allow:` has that exact path, or a prefix that is itself sensitive (`src/auth/`, not `src/`). Commits only a human pushed are exempt, as for scope | `gate` |
| Auto-merge | only `risk:low`, on top of the review, green-check and earned-trust rules. A missing class fails closed | `mayAutoMerge`, `assessPr` |
| Merging `medium` | green CI, no open thread and a full-scope bugbot `approve` on the head commit. `comment` is not enough, including a verdict cleared by answering its threads: that PR needs a new commit and review, or a person | `bugbot.mjs merge-check` |
| Merging `high` | never automatic. Labelled `imp:needs-human` when it opens, and by demonguard while CodeRabbit and bugbot have not both approved the head. Only a person removes the label, since other failures set it too. Even with both approvals `merge-check` also needs `risk-ack`, last added by the owner | `imp.mjs pr`, `demonguard.mjs`, `merge-check` |
| Acknowledgement | a fix round removes `risk-ack` before it pushes, and pushes nothing if that fails | `fix.mjs` |
| CI: CHANGELOG | a PR that changes a non-docs file (tests included) without adding or modifying the current root `CHANGELOG.md` or `docs/CHANGELOG.md` fails, unless labelled `no-changelog`; other paths, renamed-away paths and deleted files do not qualify | `risk-guard.yml` → `ci-guard.mjs` |
| CI: high risk | a PR that is `risk:high`, by label or by its paths, fails without an owner's `risk-ack` | `risk-guard.yml` → `ci-guard.mjs` |

**Adopting the CI guard:** copy `repo-health/templates/risk-guard.yml` to the repo's `.github/workflows/` and pin it to a `nitsuah/.github` main SHA, as for repo-health; the guard code is checked out at that same SHA. It reads the PR through the API and never checks out its code. The check blocks merges only where branch protection requires it, and a PR that edits the caller file runs the edited version (such a PR is `risk:high`). Imp diffs may not touch the CHANGELOG, so an imp PR that changes non-docs files waits for a person to add the line or `no-changelog`; the fix round ignores this check.

**Every merge by a person or session runs `node imps/bugbot.mjs merge-check <owner/repo#n>` first.** The two automatic paths (`imp.mjs pr`, demonguard) merge only `risk:low` imp PRs, under their own rules above. It exits 0 only when the review gate (§ Bugbot) and the table above both pass. It prints the head SHA: merge in the same command, with `--match-head-commit <sha>`, and never with `--auto`. The head binding catches a new commit, not a label or review changed in the seconds between; only branch protection can close that gap. An `imp:needs-human` PR is skipped by the fix sweep and demonguard, so a high-risk one is finished by hand.

## Guardrails

- **Clean environment.** The imp gets PATH and the 9router URL and key, nothing else. No Claude session tokens, no GitHub token.
- **No push.** The worktree's push URL is `no_push`. Only `imp.mjs pr` / `fix.mjs` push, and only after the gate passes.
- **Tool allowlist.** Read, Edit, Write, Glob, Grep, limited `git …`, and `node …/runtest.mjs` only. No raw `docker run` / host npm for the model (the **gate** runs the brief's Docker test/lint). No `gh` in the sandbox.
- **Formatting is the runner's job.** If the brief has `format:`, the gate runs it first and commits any change as a separate `style: … (imp runner)` commit. The model never spends turns on whitespace.
- **Gate.** Tests and `lint:` exit 0 (usually in Docker via the brief), at least one commit, every *imp* commit has the trailer, no uncommitted leftovers, the diff is within the effective cap (brief caps below the 180-line default are floored to 180; higher caps are honored; fix-round slack is explicit; malformed caps fail closed), every path the imp's own commits touched is under `allow` (a fix round does not count paths changed only by a human commit pushed to the PR branch, such as a CHANGELOG line added for merge; fire#527), and no `.github/`, `.env*`, secrets or lockfiles. A PR whose diff is over 100 lines and touches no test file is never auto-merged (`bigUntestedDiff`): the larger cap is paired with a stricter merge rule. Kit self-work still denies `.github/workflows/` and secrets inside the `.github` repo itself.
  The gate also rejects unresolved conflict markers (`<<<<<<< `, exactly seven `=` with optional trailing whitespace, and `>>>>>>> `) that appear in **added** diff lines; it emits one deterministic reason per affected path.
  It scans added hunk lines only (not file headers, context, or deletions) and normalizes `a/` / `b/` prefixes plus Git C-style quoted paths (named/octal escapes) to repo-relative paths, decoding the collected bytes as UTF-8 once.
  `+++` / `---` file headers are recognized only outside hunks; added header-like content inside a hunk remains content, and `\ No newline at end of file` does not end the active hunk. Marker-like text in removed/context lines or ordinary source strings is ignored.
- **Dependency/lockfile sync.** For any dependency PR or task that changes a manifest (`package.json`, `pyproject.toml`, etc.) or a lockfile, run the repository's declared package manager's clean/frozen install before tests (`npm ci`; `bun install --frozen-lockfile`; `pnpm install --frozen-lockfile`; `yarn install --immutable`). Keep matching manifests and lockfiles synchronized; a manifest-only bump is not ready, and no check run is not validation. The Imp gate denies common lockfiles by exact name (see `DENY` in `imps/lib.mjs`); do not bypass it or create an `imp:ready` brief that requires one. Route dependency updates to Dependabot/maintainer until a narrow lockfile exception is explicitly approved.
  - **Nothing to run is not two failures.** If the imp left edits uncommitted and made no commit, the gate reports one reason, `edits left uncommitted` — not `no commits` plus `tests not run`. One cause, one RSI issue.
  - **Runner commit first (#256).** When the worktree is dirty, the runner first stages the changed paths inside `allow:` that the gate does not deny and makes one `imp: work for #N (runner commit)` commit with the imp trailer, so a model that stops with edits in the tree (Nemotron) no longer ends as `commit-recovery-failed`. It counts only if the tree is clean afterwards; otherwise the model recovery below still runs. Recorded as `commitRecovery.method: runner`. Kill switch: `IMPS_RUNNER_COMMIT=0`.
  - **One-shot commit recovery.** If the worktree is dirty when the gate begins, the runner issues one bounded commit-only prompt (read/status/diff/add/commit/log; no Edit/Write, tests, or push). It may stage only allowlisted paths and must include the required trailer. The runner verifies a new non-empty HEAD commit and clean `git status --porcelain` before the normal formatter/test/lint/scope/deny/size/trailer gates run. Recovery is protected by an atomic per-run claim (10-minute stale lease); a concurrent gate exits as `commit-recovery-in-progress` without starting another prompt. If recovery fails, the ledger records `commit-recovery-failed`, the dispatcher retries `imp:working` removal up to three times and writes a failure marker that prevents stale-claim requeue until a newer claim exists, and the outcome is excluded from issue-attempt and repo-cooldown accounting. No concurrent prompt is issued; a stale claim may be reclaimed only after its lease expires.
  - **Guardrails are denied paths.** `imps/defaults.mjs`, any `imps-config.yml`/`.yaml`, any `CODEOWNERS` and everything under `.github/` (workflows included) are refused by the gate, so an imp cannot widen the limits it is judged by. A brief with no `allow:` cannot touch `imps/` at all; kit self-work briefs name the `imps/` files they may change in `allow:` (`defaults.mjs` stays denied regardless).
  - **A bug fix must change code.** The dispatcher tags briefs for `bug`-labelled issues with `kind: bug`; for those the gate fails a diff made only of docs, TASKS/CHANGELOG/README or images (`no code change …`).
  - **Parent/epic issues are tracking-only.** Mark parent bodies with `<!-- imp-epic -->`; dispatch the smallest actionable child instead. A child PR closes only its child issue with `Fixes #child`; if it references the parent, use `Refs #parent`. Never use `Fixes #parent` unless every child and the parent's end-to-end/manual acceptance is complete; keep the parent open until then. After every child PR merge, verify the child's Done when against current default-branch code and focused tests/E2E; if any criterion or review finding was deferred, reopen the child for tracking or create a focused residual child and update the parent checklist before counting it complete.
  - **One PR per issue.** `prGuard` (run before claiming and again before pushing) refuses a closed issue, an open `imp/<n>-*` PR, a merged `imp/<n>-*` PR, or a merged PR whose body has the kit's own `Fixes #n` line. The sweep closes any open imp PR whose issue a merged imp PR already fixed and records `outcome: closed-duplicate`.
- **Guardrail values are human-only.** The gate denies `imps/defaults.mjs` and any `imps-config.yml`, so an imp can never raise its own limits (stash#311).
  - **No merge without a bound head.** `mergeReady` requires the checks to be green *and* GitHub's `headRefOid` to equal the commit the runner pushed — a push between the poll and the merge leaves the PR open.
- **Review + merge.** Imp PRs open labelled `imp`, saying `Fixes #n`. `review.mjs` posts a read-only COMMENT and a recomputed verdict. Auto-merge runs only for `risk:low` (§ Risk controls), and only when (1) verdict is `approve`, (2) **every** check from `gh pr checks` is finished and green for two stable polls (required *and* optional — never `gh pr merge --auto`, which ignores non-required reds; see stash#305), (3) the repo has **earned trust**: `max(ledger clean merges, GitHub-seeded count of past merged imp PRs that passed checks and were not reverted)`. Seed query errors fail closed. Otherwise the PR stays open for `fix.mjs` / a human. Kill switch: `IMPS_AUTO_MERGE=0`.

- **Workflow approval is a human gate, not a check result.** If a check is `action_required` / waiting for approval and the run has **zero jobs**, do not classify it as pending, running, or green; do not repeatedly rerun it or merge. Record the exact PR head and run, then request maintainer approval/re-run. After approval, verify the resulting required checks complete successfully on that exact head. If approval is withheld, leave the PR open.

## What gets measured

`imp.mjs` writes one ledger row per run to `~/.imps/runs.jsonl`, and the full transcript to `~/.imps/runs/<id>.jsonl`.

| Field | Why it matters |
| --- | --- |
| `briefHash` | Ties every outcome to an exact prompt version (preamble + brief) |
| `model`, `metrics.served`, `metrics.modelSwitches` | What was asked for vs. what 9router served. A run served by a fallback model, or that switched model mid-run, isn't evidence about the prompt |
| `servedCheck` | Post-run audit of every served model against `expectedModelFamilies` (#256): `{ok, verdict, models, unexpected}`. An out-of-list model fails the gate (`served model mismatch: …`) and prints the same line to stderr; with no expectation configured nothing is judged |
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

With `"rsi": true` in `~/.imps/config.json` the dispatcher also runs it once a UTC day at the end of a cycle (`rsiDue`). Before 2026-11-19 nothing read that setting, so RSI never ran on the hourly loop.

Sources, in order: recurring gate-failure signatures; **repos where imps keep failing** (at least 4 recent runs and under 35% merged, from `memory.mjs strugglingRepos`), whose brief asks for `imps/memory/<repo>.md`; fix rounds escalating to needs-human; journey/review findings.

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

- **Inputs:** the brief (first, labelled as the scope), the issue (as background), and the diff (capped at 60 KB; the reviewer can Read the rest). Where the issue body and the brief disagree, the brief wins: issue bodies often hold an older brief, and vhs#192 was blocked for following its corrected one (2026-11-19).
- **Order (cheapest first):** one tool-less completion (`--mode chat`, the default). If it has no JSON block, one more completion with 16k output tokens and an "only the block" ask. Only then one read-only agent session (25 turns). If that also ends without the block, its notes go to one tool-less completion that only writes the verdict. The second 25-turn agent session is gone: on vhs#181 both sessions explored the same files and ran out of turns (2026-11-19).
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
5. **Gate passes:** push to the PR branch, reply on every thread (`<!-- imp-fix -->`), and resolve the fixed and skipped threads. Pushback threads stay open for the reviewer to answer (bugbot answers its own; see § Bugbot). **Gate fails:** reset the worktree, label `imp:needs-human`, and comment the reasons.
6. **After 2 rounds, or on a merge conflict:** label `imp:needs-human` and do nothing else.

Every round is appended to the run's `fixes[]` in the ledger: items, decisions with replies, gate result, turns, tokens and served model. **That's the training data for 9router's comment judgment.** The hypervisor reads the decisions, overrides any it disagrees with (by replying on the thread), and turns recurring misjudgements into `FIX.md` lines, the same RSI loop as `PREAMBLE.md` and `REVIEW.md`.

First live round (vigil#320, 2026-10-22): one CodeRabbit finding (the priority regex matched `P20` as P2). The imp decided **fix**: a 2-line regex change, 7 turns, 1.4 min, one model. The gate passed, it pushed `a8659a1`, replied, and resolved the thread. The first attempt was voided by a runner bug (the trailer check on a hypervisor commit), fixed in the same PR.

**The hourly dispatcher sweeps open imp PRs before it picks new issues** (approved by the owner 2026-10-22). It runs `fix.mjs` on each open `imp` PR that isn't labelled `imp:needs-human`. Pushes go only to the imp's own PR branch; there are 2 rounds at most; a conflict or a failed gate means `imp:needs-human`. A clean PR costs only `gh` calls, and each result is logged as a `fix-sweep` event in `dispatch.jsonl`. The hypervisor still gets Auto-fix events, and can override a decision or run `fix.mjs` by hand.

## Brief checklist (from CI misses)

- **Removing or moving an element:** check whether CSS selects it by position (`:first-child`, `:nth-child`, `:last-child`) and which tests and journeys assert it; put those files in `allow:` and say how they change (fire#482: deleting the first banner block shifted every `nth-child` rule and hid Annual Income).
- **Imports:** name the imports the new code needs and confirm each package is already a dependency (motor-pool#150 imported `yaml`, which the repo cannot resolve).
- **Base test and lint:** the brief's `test:` must pass on the unchanged base except for the behaviour the issue changes, and its `lint:` must exit 0 on the unchanged base and cover only files in `allow:` (a lint failure in a file the imp may not touch cannot be fixed; motor-pool#168, motor-pool#150, darkmoon#497). A test or lint that already fails cannot gate the fix.
- **Final newline:** the runner now adds a missing final newline to every file the imp changed, in its formatter commit (`eol.mjs`), since repos with pre-commit's end-of-file-fixer failed CI on it (motor-pool#205, #213).
- **TypeScript repos:** include `tsc --noEmit` in the brief's `test:`. vitest doesn't type-check, so vigil#320 passed the gate and then failed CI's `test` and `docker-smoke`.
- **Node/Docker diagnostics:** keep `npm ci` stdout/stderr visible in test commands; redirecting both streams to `/dev/null` can hide install failures that surface only as a later `test exit 1/2`. For focused Vitest runs, use `--reporter=verbose` and capture the first failing test name, assertion, and output; do not report only an exit code. Evidence: Fire #321/#326 and Vigil #368 (2026-10-31).
- **UI changes in a repo with journeys:** a visual change moves the screenshot baselines (vhs#87: the phone shelf shifted ~45 px, a 15% diff). Refresh them with a `mode: script` brief (see "Brief preflight and script briefs") whose test runs `--update-snapshots=changed` in the caller's Playwright image and then a no-update soak. Write the `=`: a bare `--update-snapshots <spec>` makes Playwright read the spec path as the mode and reject it (vhs#178). Look at the old and new images before queueing, and list every regenerated PNG in `allow:` (Playwright stops a journey at its first failed screenshot, so later steps are often stale too).

- **Behaviour or data changes ripple into tests and journeys.** Before briefing, grep `tests/` and `tests/journeys/` for the text, ids, selectors and numbers the fix changes (fire#236 stopped the demo seed triggering "Equity Concentration Risk"; the insights journey kept asserting it and went red on main). Put those files in `allow:`, name them in "The fix" and raise `maxLines`. If a journey screenshot moves, say the baselines are regenerated by the runner or the caller, not the imp. Triage also checks the nightly journeys after a merge: a new red journey on a repo with a recent imp merge is the imp's cost to fix, so file or brief it the same day.
- **No nested code fences in a brief.** `briefFromComments` takes everything up to the first closing fence, so an inner ```` ```js ```` block silently truncates the brief (vhs#77: the imp saw half the instructions and spent 40 turns exploring). Write inner code blocks with `~~~` fences. A brief missing its closing fence is not parsed at all (vigil#315: "front matter needs repo and issue"). After posting, check with `briefFromComments` + `parseBrief`, or look at the dispatcher's first run for the brief length.
- **Write the code into the brief when the edit is mechanical.** Briefs that say "restore the old behaviour" and leave the imp to find the markup make it explore until the turn cap (vhs#77, 41 tool calls, no edit). Give the exact function body and the exact lines, say "do not explore", and split anything that needs a design choice (new markup, layout) into its own issue.
- **Re-brief from the gate reasons.** When an issue goes `imp:failed` twice (vigil#276), read both gate reasons before writing the next brief. Tighten `allow:` and `maxLines`, quote the exact lines to change, and split the issue if it has two parts (vhs#77). Don't resend the same brief.
- **Don't brief what needs a decision you can make yourself.** Pick the obvious option from the issue and the code (the dashboard is the source of truth over the MCP) and write it into the brief. Only ask the owner for a call that is costly or hard to undo, and ask it as a multiple-choice question.

## Token savers and measuring them

`node imps/stats.mjs` prints the two tables on demand: open issues / bugs / PRs / imp labels per repo, and per-run token use (`--repos`, `--tokens`, `--since 24h|7d|all`, `--json`). Runs killed before a usage report show an estimated input (`~`: tool calls x median input per turn).  First baseline (18 runs, 2026-10-22/23): 10.3M input, median 30k per turn, 36% of it in runs that never passed the gate, 0 cache reads, and reviews averaging 501k input each.

What the kit does about it:

- **Context trim.** Workers start with `--disable-slash-commands --no-session-persistence --tools <only what they use>`. A trivial prompt went from 14.5k to 7.7k input tokens (-47%) with the same answer. `IMPS_NO_TRIM=1` turns it off. Compare `metrics.init` (tool / slash-command / skill counts) in the ledger across versions.
- **Fail fast.** An imp that makes `noEditTurns` tool calls (default 20, configurable) with no Edit/Write is stopped as `no-edit-timeout` (vhs#77 burned 41 calls exploring twice; the limit is `defaults.noEditTurns`, overridable in `config.json` or `IMPS_NO_EDIT_TURNS`, and is recorded as `metrics.noEditTurns`). `metrics.firstEditTurn` records when the first edit landed.
- **One-shot reviews.** `review.mjs` defaults to `--mode chat`: one `/v1/chat/completions` call with the diff, brief and issue in the prompt (about 5k input) instead of a read-only agent session (about 500k). It falls back to the agent session if the answer is unusable. `review.mode` in the ledger tells them apart.
- **Honest metrics.** Killed runs now record `turns` from tool calls and `unmetered: true` instead of zeros.

What 9router offers that we are not using yet (from its source, v0.5.104):

- **RTK** (on by default) compresses `tool_result` text (`git diff`, `grep`, `ls`) in requests, 20-40% of input per its README; **Headroom** (external `/v1/compress`) and **Caveman** (terse replies, up to 65% fewer output tokens) are off. Header `X-9Router-Token-Saver: off` bypasses all of them for one request. Worth an A/B on a real batch of runs, because our per-turn input is mostly resent context, not tool output.
- **No cache accounting.** Responses carry only `prompt_tokens` / `completion_tokens` (no cached-token field for the current `MAX` model), so cache hits cannot be measured through 9router today. The dashboard's `/api/usage/*` routes (stats, request-details, history) need a dashboard login, not the API key.
- **`MAX` is a reasoning model** and may put its reasoning in `content`. Keep `max_tokens` generous for chat calls and parse for the `json` block rather than expecting only JSON.
- **Baseline cost per call**: a one-line prompt cost 2.8k prompt tokens on `/v1/chat/completions`, so some system text is injected upstream.
- Other endpoints (`/v1/messages/count_tokens`, `/v1/embeddings`, `/v1/search`, `/v1/web/fetch`, `/v1/models`) are available for cheap pre-checks, issue dedupe and the model probe.

## Brief preflight and script briefs

Half of 2026-11-19's failed runs could never have passed, whatever the model did. Three checks now run before any model time:

- **Structure, at dispatch** (`briefProblem`, also in `brieflint.mjs`): a brief needs a `test:` command (vhs#180 had none and ended "tests not run"). It must name something to change, either an `allow:` list or a file path in the body; reviews, audits and epics are not imp work (ats-fill#176). And `mode:` must be `agent` or `script`. A failing brief is labelled `imp:failed` with the reason, and no run starts.
- **Base preflight, in `imp.mjs run`:** the brief's `test:` runs once on the unchanged base before the model starts. A command that cannot run at all ends the run as `brief-broken` within seconds, and the dispatcher labels the issue `imp:failed` with the reason (`brokenCommandSignature`: exit 125/126/127, an invalid or unknown option, a missing npm script, a failing docker build). An ordinary failing or missing test is expected on a bug's base and is only recorded (`baseTest` on the run row). Phrases count only at a line start in the first 20 lines of output, so a failing test that prints one is not misread. The issue comment carries only the category; the raw output stays in the local ledger (`baseTest.tail`), since it can echo arguments. The run is capped at 20 min (`defaults.preflightMinutes`, which also caps a script run) and a timeout ends `brief-broken`. The worktree is reset afterwards. Kill switch: `IMPS_BASE_PREFLIGHT=0`.
- **`mode: script`:** for mechanical changes that a command makes (screenshot baselines, generated files), the runner runs the brief's `test:` and commits the changed files inside `allow:` itself. Everything outside `allow:` is restored or deleted. There is no model run and no quota, and the commit subject comes from `commit:` in the front matter. The gate then runs as usual: it re-runs the command, so the command must be reproducible, and output it leaves outside `allow:` is cleaned before the dirty check. The PR still gets a review, and auto-merge still needs earned trust. A script run that fails or commits nothing is labelled `imp:failed` with the runner's reason (exit code, timeout, "changed no allowed file", "git commit failed"), not the gate's bare "no commits"; raw output stays in the local ledger.

```markdown
---
repo: vhs
issue: 178
mode: script
test: docker build -f {wt}/config/Dockerfile.playwright -t vhs-journeys {wt} && docker run --rm -e CI=true -v {wt}/tests/journeys:/work/tests/journeys vhs-journeys npm run test:journeys -- --update-snapshots=changed tests/journeys/collection.spec.js && docker run --rm -e CI=true -v {wt}/tests/journeys:/work/tests/journeys vhs-journeys npm run test:journeys -- --retries 0 --repeat-each 3 tests/journeys/collection.spec.js
lint: echo "PNG-only change"
maxLines: 20
allow: tests/journeys/__screenshots__/collection.spec.js/
commit: test(journeys): refresh collection baselines
---
Refresh the collection baselines after #174's stats-chip row (old and new images compared on main).
```

## Per-repo memory

Every imp prompt gets a "What we know about this repo" section after the gate limits (`memory.mjs`, called from `runner.loadBrief`). Nothing in it needs a model:

1. **Ledger notes:** up to 8 lines computed from this machine's last 12 runs in the repo. Each names a count and the rule that avoids it: work left uncommitted, tests failing at the gate, lint failures, size-cap misses, files the runner had to revert, turn-cap or no-edit stalls, denied commands, missing paths, Edit misses, scratch files.
2. **Curated lessons:** `imps/memory/<repo>.md` in the kit, capped at 1,200 characters. Written by hand or by an RSI "imps keep failing in <repo>" issue. See `imps/memory/README.md`.
3. **Repo docs digest:** which of `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `CONTRIBUTING.md` the repo has, plus their rule-like bullets (conventions, tests, lint, never/always), capped at 1,000 characters.

The section is around 1.5 KB (about 400 tokens) and is resent every turn, so each source stays capped. A broken ledger line or unreadable doc drops the section instead of failing the run.

## Uptime watchdog

A machine that runs dispatch should set `"heartbeat": true` in `~/.imps/config.json`; `heartbeat.mjs` then rewrites the `imps heartbeat: <machine>` issue in this repo at the end of every cycle. The hourly `imps-watchdog` workflow labels a heartbeat older than 4 h `imps:down` and mentions the owner once, then clears the label when it is fresh again. Label `imps:retired` on a machine that no longer runs imps. Why: on 2026-10-28 the loop stopped (9router down, then the task left disabled) and nothing noticed for 21 days.

## Commit-recovery hygiene

Before commit recovery and before its verification, the runner deletes untracked files outside the brief's `allow:` (never tracked files, never anything when `allow:` is empty) and records them as `strayRemoved` on the run. vhs#169 finished its work but left a scratch file under a mangled Windows path, so recovery could not verify a clean tree. Tracked files with uncommitted edits outside `allow:` are restored to HEAD the same way (`outOfScopeReverted`): such an edit could only fail the gate, and fire#483 committed its fix, left a stray `config/eslint.config.mjs` edit, and failed recovery with "no new commit".

## Known gaps (next)

- **Baseline tests.** The gate fails on any failing test. It should also run the test command on `baseSha` and only count failures that are new. fire's server fail-fast tests time out locally while main's CI is green.
- **Model probe.** Runs 1–2 went through a 9router build that sent `MAX` to OpenRouter's free auto-router: 10–11 models and 43–65 switches per run. Rebuilt on v0.5.104, `MAX` serves one model (run 3: 0 switches, gate pass). Add a pre-run probe that holds the run if the served model changes mid-run (IMPS-PLAN D9).
- **Prompt caching.** Run 3 sent 1.57M input tokens with 0 cache reads for a 40-line fix. Find a 9router route for `MAX` that caches, or trim the context each turn resends.

## demonguard (lingering PRs)

`imp.mjs pr` decides about auto-merge once, when it opens a PR. A PR that was not ready then (CI still running, trust not yet earned, the reviewer never answered) used to sit open until the open-PR cap stalled dispatch. `demonguard.mjs` runs on every dispatch tick and gives each open imp PR exactly one action, chosen by the pure `assessPr()`:

| Action | When | What it does |
| --- | --- | --- |
| `merge` | `risk:low`, imp review `approve`, every check green, repo trust earned, no open bot threads | squash-merge with `--match-head-commit`; the same rules as `imp.mjs pr`, applied later |
| `rereview` | no imp review recorded | reruns `review.mjs` (9router) |
| `dismiss-stale-review` | a bot's latest review is CHANGES_REQUESTED and none of its threads is open | dismisses it |
| `owner` | all good but trust is not earned, or the PR is not `risk:low` | logged in the `demonguard` event's `owner` list; never merged |
| `needs-human` | red checks, conflicts or a non-approve review for over 24 h; at once for `risk:high` without both a CodeRabbit and a bugbot approval of the head | labels the PR `imp:needs-human` |
| `wait` / `wait-fix` | too young (< 30 min), checks pending, or the fix-sweep is on it | nothing |

Each tick logs one `demonguard` event with the counts. It never uses `--admin`. Kill switch: `IMPS_DEMONGUARD=0`; manual: `node imps/demonguard.mjs --dry-run`.

## Bugbot (fallback review when CodeRabbit stalls)

CodeRabbit is the primary reviewer on every PR. Its free tier runs out often (review quota, hourly chat limit), and a PR then waits an hour or more with nothing reviewing its latest commit (2026-11-21: most of a day's swarm wait was this). `bugbot.mjs` runs on every dispatch tick, after demonguard, over **every open PR in the owner's repos** (imp, swarm and human PRs alike; not drafts, not bot-authored, not `security-program`/`9router`, not labelled `bugbot:skip`).

**It only reviews.** It never edits code, pushes or merges. Fixing stays with the PR's owner: on an imp PR the fix-sweep takes the threads one by one (fix, pushback or skip, `FIX.md`); on any other PR the hypervisor answers them the same way it answers CodeRabbit.

Per PR, each tick, decided by the pure functions in `bugbot-lib.mjs`:

| CodeRabbit on the head commit (`codeRabbitStatus`) | Bugbot |
| --- | --- |
| `reviewed`: it reviewed this exact commit, or says it already did | nothing; CodeRabbit is working |
| `working`: its check is still pending (under 45 min) | nothing yet |
| `waiting`: the head is younger than the grace period (20 min) | nothing yet |
| `rate-limited`: its latest note after the push is a rate-limit / review-limit / paused notice | reviews now |
| `silent`: no review of the head after the grace period | reviews |
| `absent`: CodeRabbit never touched the PR | reviews |

**The review:** one streamed 9router completion (`chat({ stream: true })`: a non-streamed completion over 5 minutes dies on Node's 300 s headers timeout as `fetch failed`) with `BUGBOT.md` (adversarial: bugs, security, tests a wrong implementation would still pass, broken callers, leftovers), the PR description, its linked issues and the diff, answering in `REVIEW.md`'s JSON. The verdict is recomputed by `parseReview` (any blocker or major means `request_changes`). Findings above nit that point at a line in the diff are posted as **inline review threads**, like CodeRabbit's; the rest go in the summary. The summary carries `<!-- bugbot sha=<head> verdict=<v> -->`, and a **`bugbot` commit status** goes on the head: failure for `request_changes`, success otherwise. The threads carry no `<!-- imp-` marker, so the fix round picks them up as feedback. One review per head commit; a new push gets a new review if CodeRabbit is still stalled. **Guards (from CodeRabbit's review of #320):** a marker only counts on a review written by the bugbot account (the `gh` user, plus `bugbot.trustedAuthors`) and submitted on the head commit, so a pasted marker cannot pass the gate. A diff over 60 KB is reviewed but marked `scope=partial`, and its status stays failure, so a truncated review never counts as a pass. A failed `gh pr diff` posts nothing. Checks or threads beyond one page fail closed. A status write that failed is restored from the posted review on the next sweep. A running CodeRabbit check wins over any rate-limit notice. Every unresolved thread counts as open, outdated or not. The head's arrival time is the later of its commit date and when bugbot first saw the SHA (`~/.imps/bugbot-heads.json`), so an old commit pushed now still gets the full grace period. Threads are read as the original finding plus the latest 30 replies. Dismissal touches only the CodeRabbit reviews the assessment saw (older commits), each re-read first. `status` exits non-zero when bugbot is disabled. Limits: 4 reviews per sweep, 6 per PR per 24 h (`~/.imps/config.json` → `bugbot`: `graceMinutes`, `pendingMaxMinutes`, `maxPerSweep`, `perPrPerDay`, `skipRepos`, `skipLabel`).

**Answering replies on its own threads** (`threadsAwaitingBugbot`): each sweep, before any new review, bugbot reads its unresolved threads where someone else had the last word (a fix round's "Fixed in …" or "Pushing back", or a human). One small 9router judgement per thread, given the file's change between the finding's original commit and the head (where any claimed fix must be) plus its current diff, plus **the file at the PR head** around the thread's line and up to three `path:line` locations the replies cite (`excerptLines`, `citedLocations`; code that predates the PR counts as evidence, so a reply pointing at unchanged lines is not kept open just because they are outside the diff), decides **accept** (reply and resolve: the fix is in, or the pushback holds) or **keep** (reply and leave it open). Its comments carry `<!-- bugbot-thread -->` so it knows its own last word; a pushback no longer waits for a human just because bugbot raised it. These judgements share the sweep's budget. An accepted reply carries `<!-- bugbot-accepted -->`, so a resolve that failed is retried on the next sweep without another judgement. When every finding of a `request_changes` head verdict has been answered and resolved (fixed or accepted pushback) and the review had no blocker/major it could not place inline, bugbot posts a cleared verdict (`comment`) for the same head and sets its status to success: an accepted pushback no longer needs a new commit to unblock the PR.

**Settled findings stay settled** (`settledFindings`, `withoutSettled`): a finding whose pushback bugbot accepted is settled for that PR. A new review of a later head lists them in the prompt as "do not raise again", and drops any finding on the same file whose title shares most of its words (Jaccard ≥ 0.5) before posting, logging `bugbot-settled-dropped`. Threads accepted as "Fixed in …" are not settled, so a regression of a real fix is still caught (vhs#208: the same false blocker came back on the next head).

**Blockers need evidence** (`requireEvidence`): a `blocker` or `major` must carry a `quote` that matches an added or context line of the diff, or it is posted as `minor`. A claim that a key, option, flag or API is invalid or does not exist is `minor` at most, since the reviewer model's knowledge may be stale. Both downgrades are noted on the finding and logged as `bugbot-downgraded`. The PMO tick also has Opus check every bugbot `request_changes` on an open PR before anyone acts on it.

**Carrying a verdict over a base-branch merge** (`latestPassedVerdict`, `ownChanges`, `sameOwnChanges`): a new head with no verdict, while CodeRabbit is stalled, first checks whether it only brought the base branch in. Bugbot takes its latest *passing*, full-scope, trusted verdict on an earlier commit and compares the PR's own changes (`compare/<base>...<sha>`: per file, only added and removed lines, so the same edits against a moved base match) at that commit and at the head. Identical: it posts a marker review on the head saying so, links the original verdict, and sets the status; the gate then reads it like any other. Anything else (a merge that changed the PR's lines, a new file, a patch GitHub omits, 300+ files, an unreadable compare) fails closed into a normal review. This keeps a CHANGELOG-only merge from main from costing a full re-review (five times on 2026-11-21/22).

**Lifting CodeRabbit's block** (`shouldDismissCodeRabbit`): CodeRabbit's last `CHANGES_REQUESTED` is dismissed through the API only when all of these hold. A working CodeRabbit is never overridden.
- CodeRabbit is stalled on the head (`rate-limited`, `silent` or `absent`).
- Bugbot reviewed that exact head and did not request changes.
- No review thread is open (bugbot's, CodeRabbit's or anyone's).
- Every check is green (bugbot's own status and CodeRabbit's check are left out).

**Asking CodeRabbit to approve** (`shouldAskCodeRabbitApproval`): when CodeRabbit reviewed the head, its old `CHANGES_REQUESTED` is the only blocker, no thread is open and checks are green, bugbot comments `@coderabbitai approve` once per head (a hidden `<!-- bugbot-approve-ask sha=… -->` marks it, so there is no local state). Imp PRs are skipped: the fix round already asks for them.

**The review gate for merging** (`reviewGate`, `node imps/bugbot.mjs status <owner/repo#n>` prints it and exits 0 only when it passes): checks green, no open thread, and either CodeRabbit approved the head, or CodeRabbit reviewed the head without requesting changes on it (repos with CodeRabbit approvals disabled only ever get `COMMENTED` reviews, and refuse `@coderabbitai approve`), or, while CodeRabbit is stalled, bugbot passed the head. This is the "clean independent review" the hypervisor and swarm require before merging a non-imp PR; imp PRs keep demonguard's rules and gain bugbot's threads on top.

**In the status line** (`statusline.mjs`, read-only from `bugbot.jsonl`): one dim `○ bugbot idle · 24h N reviews · N lifted · last … · swept …` line when quiet, or full rows while it is busy, blocks a PR or erred in the last hour: `● bugbot · 24h N reviews · N ⛔ · N ✓ · N partial · threads N✓ N✗ · N CodeRabbit blocks lifted`, then `✗ repo#n 2 blocking │ repo#n partial`. Each sweep logs a `bugbot-sweep` heartbeat and writes `~/.imps/bugbot-open.json` so the line only lists PRs still open.

Events go to `~/.imps/bugbot.jsonl` (`bugbot-review` with verdict, counts, inline count, served model and tokens; `bugbot-dismiss`; `bugbot-skip`; `bugbot-error`). Kill switch: `IMPS_BUGBOT=0`. By hand: `node imps/bugbot.mjs review <owner/repo#n> [--force] [--dry-run]` (`--force` reviews even when CodeRabbit is not stalled), `node imps/bugbot.mjs sweep --dry-run`.

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


## Merge attribution and owner review

Every agent-initiated squash merge must include a commit-body trailer identifying the actor:
- Imp automation: `Merged-by-agent: imp-<machine>` (use the machine recorded for the run; never invent an identity).
- Interactive agents: `Merged-by-agent: <ChatGPT|Claude|Grok>`.

Preserve the original squash commit list and every distinct `Co-Authored-By:` trailer when supplying a custom merge body. Do not replace existing attribution with the agent trailer alone.

Sensitive changes require explicit owner approval before merge: `.github/workflows/**`, `**/auth/**`, `**/security/**`, `SECURITY.md`, lockfiles, or PRs labeled `security`/`auth`. The owner approval marker is `owner-approved`. CI green is not a substitute for owner approval on these paths.
