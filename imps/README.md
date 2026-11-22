# Imps

Headless Claude workers (via [9router](https://github.com/nitsuah)) that turn **one GitHub issue into one small PR**. The contract is [`STANDARD.md`](./STANDARD.md). Defaults live in one place: [`defaults.mjs`](./defaults.mjs).

Sibling system: [`../journeys/`](../journeys/) — nightly Playwright tests that file `bot:journey` / `bot:review` issues with **no AI at night**. Imps fix the small diagnosed ones; green journey nights confirm the fix.

**One warlock per machine, many imps per machine, many machines.** The warlock is the single `dispatch.mjs` cycle; the imp-runner is the kit it executes; imps are the workers. Read [`WARLOCK.md`](./WARLOCK.md) before installing on a second machine, and run `node imps/warlock.mjs` when the queue looks stuck.

## Fresh machine (Windows — first class)

```powershell
# From any clone of nitsuah/.github (or after cloning it once):
gh repo clone nitsuah/.github $env:TEMP\github-kit
pwsh -File $env:TEMP\github-kit\imps\setup.ps1
```

That:

1. Checks node, git, `gh auth`, Docker, and 9router reachability (prints fixes if anything is missing).
2. Installs a **detached** kit at `%LOCALAPPDATA%\imps-runner` (override with `-RunnerPath` or `$env:IMPS_RUNNER`).
3. Clones `nitsuah/.github` into `%USERPROFILE%\code\.github` (`IMPS_CODE`) for **kit self-work** — imps never edit the runner checkout.
4. Keeps durable state in `%USERPROFILE%\.imps` (ledger, locks, logs, config) — **never** wiped by update/re-run.
5. Writes `hourly.cmd` + `label-watch.cmd` and registers `imps-dispatch` (hourly :07, plus 2 min after logon) and `imps-label-watch` (every 5 min).

Kill switches: `-SkipLabelWatch` / `IMPS_LABEL_WATCH=0` / config `"labelWatch": false`. `-SkipTask` installs the kit only.
The **groomer** is opt-in: setup registers `imps-groom` only with `-WithGroomer`. It drafts briefs every 3 hours and promotes only the ones that pass its safety checks (see [Groomer (opt-in)](#groomer-opt-in)).

```powershell
pwsh -File $env:LOCALAPPDATA\imps-runner\imps\doctor.ps1   # health check (incl. topology)
pwsh -File $env:LOCALAPPDATA\imps-runner\imps\update.ps1    # pull latest kit into the runner
pwsh -File $env:LOCALAPPDATA\imps-runner\imps\uninstall.ps1 # remove tasks; keeps state
```

## Fresh machine (macOS / Linux)

```bash
gh repo clone nitsuah/.github /tmp/github-kit
bash /tmp/github-kit/imps/setup.sh
```

Same four steps, same layout (`~/.local/share/imps-runner`, `~/.imps` state). Scheduling is a crontab when `crontab` exists (`7 * * * *` plus `@reboot sleep 120`), and a **systemd user timer** (`imps-hourly.timer` at :07 and 2 min after boot, `imps-label-watch.timer` every 5 min) otherwise — run `loginctl enable-linger "$USER"` so the timers survive logout. If neither exists, setup says so instead of half-succeeding.

## Configure 9router (new machine)

Keep the router URL and key in **OS user-level environment variables**, not in `~/.claude/settings.json`. The router-specific names win, and the generic `ANTHROPIC_*` names in the ambient environment are distrusted (a desktop session often has `ANTHROPIC_BASE_URL=https://api.anthropic.com`). Exact order, first hit wins:

- **URL:** env `NINEROUTER_URL` (`/v1` added if missing) → `settings.json` `env.ANTHROPIC_BASE_URL` → `settings.json` `env.NINEROUTER_URL` (`/v1` added) → env `ANTHROPIC_BASE_URL` (only if its host is not `anthropic.com`) → `http://localhost:20128/v1`.
- **Key:** env `NINEROUTER_KEY` → `settings.json` `env.NINEROUTER_KEY` → `settings.json` `env.ANTHROPIC_API_KEY` → env `ANTHROPIC_API_KEY` (only when the URL itself came from env `ANTHROPIC_BASE_URL`).
- **Guard:** a URL on `anthropic.com` is never used and no key is sent to it; the kit falls back to the default URL with no key, so the probe fails loudly.

Existing machines that only have `settings.json` keep working, and `settings.json` may be missing or have no `env` block. Only the resolved URL and key reach an imp's environment (nothing else from your session). `doctor.ps1`, `setup.*` and `warlock.mjs` say where each came from and never print the key; `doctor.ps1` also tells you when a key is saved at User scope but not set in the current session.

Windows (PowerShell; the prompt keeps the key out of history and the console):

```powershell
[Environment]::SetEnvironmentVariable('NINEROUTER_URL', 'http://localhost:20128/v1', 'User')
$k = Read-Host 'NINEROUTER_KEY' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($k))
[Environment]::SetEnvironmentVariable('NINEROUTER_KEY', $plain, 'User'); Remove-Variable plain, k
```

Task Scheduler tasks only see new user variables after you **sign out and back in** (or reboot); open a new terminal for interactive shells. Then run `doctor.ps1`.

macOS / Linux: `export NINEROUTER_KEY=...` (and optionally `NINEROUTER_URL`) in `~/.profile` (login shells; cron does not read it, so prefix the crontab line or use `environment.d`), or for systemd user timers put `NINEROUTER_KEY=...` in `~/.config/environment.d/imps.conf` and re-login. Keep that file `chmod 600`. `setup.sh` reports where it found the URL and key.

### Served-model identity guard

The router answers with the model that actually served a request. Set the family you expect (`~/.imps/config.json` `"expectedModelFamilies": ["nemotron"]`, or `IMPS_EXPECT_MODEL_FAMILY=nemotron`) and `imp.mjs run` makes one minimal probe (`max_tokens: 1`) before it reserves quota or creates a worktree. The served id is read from the response body `model` field, else an `x-served-model` / `x-model` header (both accepted until the real 9router field is confirmed with one local `curl`). If the served model is a different family (for example `glm-4.7-flash` for a Nemotron expectation) the run stops with `served model mismatch`, and dispatch puts the issue back on `imp:ready` without consuming an attempt. A router that is unreachable or returns no model id is reported, not treated as a mismatch. With no expectation configured nothing is probed. Logic and fixtures: `served-model.mjs` / `served-model.test.mjs`.

## What lives where

| Path | What | Reset by updates? |
| --- | --- | --- |
| runner checkout (`imps-runner`) | the kit — code only | **yes**, `reset --hard origin/main` every cycle |
| `IMPS_CODE` clone (`~/code/.github`) | base for kit self-work worktrees | no (fetched only) |
| `~/.imps` (`IMPS_HOME`) | ledger, logs, locks, `config.json`, `model_quota.json` | **never** — machine state |

Quota is machine state on purpose: the runner is reset every cycle, so a counter there could neither survive a cycle nor stop the fleet. It refills on a rolling window (`quotaPerWindow` / `quotaWindowMs`).

**Deploying several machines:** the wrappers pull `origin/main` themselves, so a merged kit change reaches every machine on its next cycle. A failed reset aborts non-zero, and `imps/preflight.mjs` runs first, so a stub or truncated checkout fails loudly instead of no-op'ing. The two things auto-update does *not* cover — the generated `hourly.*` wrapper (re-run setup when `warlock.mjs` says it is stale) and `~/.imps` state — are both checked by `warlock.mjs`. Turn on `"heartbeat": true` in `config.json` (or `IMPS_HEARTBEAT=1`) and each machine updates one issue, `imps heartbeat: <machine>`, so "alive and current" is one `gh issue list`.

## How it runs (event-driven design)

```
hourly (:07) + label-watch (*/5) ──► dispatch.lock? ──► 9router MAX probe
                                         │ no                │ down → skip
                                         ▼                   ▼
                                    fix-sweep open `imp` PRs (≤2 rounds → imp:needs-human)
                                         │
                                    pick imp:ready issues (quiet repos, bot:review first)
                                         │  caps: max / per-repo / wip / daily-cap / cooldown
                                         ▼
                                    imp.mjs run → gate → pr → review
                                         │
                                    earned trust + every check green? → squash merge
                                         else leave open
                                         │
                                    demonguard (lingering imp PRs) → bugbot (any PR CodeRabbit
                                    can't review: inline threads + `bugbot` status; lifts CodeRabbit's
                                    stale block only after its own review passed)
```

| Signal | Behaviour |
| --- | --- |
| Lock file `~/.imps/dispatch.lock` | Skip if held by a live pid; a dead pid, a pre-boot lock, or &lt; 3h age is cleared and the cycle runs |
| 9router probe | Wait up to 10 min with backoff before giving up a cycle (boot, provider blip) |
| WIP / daily caps | Stop when the review pile or 24h run budget is full |
| Repo cooldown | 24h pause after two straight gate failures |
| Issue attempt cap | 2 failed/killed runs on one issue (since its latest brief) → `imp:needs-human` and one comment; a new brief comment resets it |
| One PR per issue | closed issue, open/merged `imp/<n>-*` PR, or a merged PR that closes it → skip; open duplicates of a merged fix are closed by the sweep |
| No-edit fail-fast | `noEditTurns` (default 12, `config.json` / `IMPS_NO_EDIT_TURNS`) tool calls with no edit → run ends `no-edit-timeout` |
| `no-brief` | an `imp:ready` issue with no brief gets one explanatory comment (not repeated) |
| Label watch (default on) | Extra 5‑min tick for new `imp:ready`; lock still prevents overlap |

Defaults (from `defaults.mjs`): per-repo **6**, concurrency **6**, wip **12**, daily **60**, maxLines fallback **180**, auto-merge trust **3** clean merges.

## Ledger outcomes

`runs.jsonl` rows get `outcome` filled as PR state is observed: `open` → `merged` | `abandoned` (closed unmerged) | `closed-duplicate` (closed by the sweep). Each cycle reconciles up to 40 rows still `open`. Older rows may say `closed`. Rows also carry `authorModel` (first served model), and the PR body has an `Authored by model` line.

## Auto-merge safety

After review **approve**, the runner waits until **every** check returned by `gh pr checks` is finished and green for two consecutive polls, re-checks once more, then **squash-merges immediately**. It does **not** use `gh pr merge --auto` (that only waits for *required* checks — the stash#305 failure mode).

Per-repo **earned trust**: `max(local ledger clean merges, GitHub-seeded history)`. The seed counts past merged `imp` PRs whose checks were all green and that were not later reverted. Seed query errors **fail closed** (no auto-merge). Threshold: `DEFAULTS.autoMergeTrust`. Kill: `IMPS_AUTO_MERGE=0`.

## Kit self-work loop

Each run should make the next one better. When RSI (or a human brief) targets the kit (`repo: .github`):

1. Work happens in a **separate git worktree** under `IMPS_CODE/.github-…`, never in the detached `imps-runner` checkout and never in the main `IMPS_CODE/.github` working tree.
2. The PR goes through the same gate, review, earned-trust, and auto-merge rules as any product repo.
3. After merge, `update.ps1` / the hourly wrapper resets the **runner** to `origin/main` so the next unattended cycle runs the improved kit.

## Self-improvement (RSI)

```powershell
node imps/rsi.mjs --dry-run
# enable on the hourly tick:
#   node imps/dispatch.mjs --rsi
#   or IMPS_RSI=1
```

`rsi.mjs` turns recurring gate failures, fix-loop `needs-human` spikes, and open `bot:journey` / `bot:review` issues into capped `imp:ready` issues with briefs (including kit briefs against `.github`). Kill switch: `IMPS_RSI=0` or `~/.imps/config.json` → `"rsi": false`. Still inside the normal gate / path deny / caps.

## Groomer (opt-in)

`groom.mjs` drafts briefs every 3 hours, up to `groomDailyIssueCap` (25) a day, for open issues with no `imp:*` label that a trusted author filed (the owner, plus `groomTrustedAuthors`); no `bug`/`enhancement` label is needed. It skips untrusted, security/audit/design and epic or multi-phase issues before drafting, so they cannot use up the cap (`groom-select.mjs`). The drafting prompt gets the repo file list (one `git/trees` call, images and build output dropped, capped at 400 paths), the files the issue names (up to 4, from the default branch) and the brief checklist, and it copies the test command and style of the repo's newest trusted brief. Each draft then goes through `groom-promote.mjs`, which is fail-closed:

- **Promoted** (posted as a real `<!-- imp-brief -->` with `imp:ready`, so the next dispatch cycle runs it) only when all of these hold: the issue author is the owner or in `groomTrustedAuthors`; no security label; no security term (auth, token, secret, webhook, payment, crypto, session, permission, injection and similar) in the issue or the brief, unless the owner wrote the issue (filing it without a `security` label is the owner's call); brieflint finds no problem; `repo:`/`issue:` match; `maxLines` is within the cap; no `depends:`; the brief names its target file without hedging (no "(or similar …)" / "(or wherever …)"), at least one allow: path outside package.json/CHANGELOG/README/TASKS/ROADMAP and `docs/`/`tests/` is on the default branch, and every `npm` step in the test command runs where there is a package.json. The steps are walked in order, following `cd` (scoped to `( … )` subshells, with `.`/`..` resolved). A subdirectory goes in as `cd <dir> &&` inside `sh -c`, because `-w` must be `/app` for the sandbox shape. Those two existence checks only run when the repo tree is fetched in full; if the `git/trees` call fails or GitHub truncates the tree, only the hedge check runs, so they are a guard, not a guarantee; and every `test:`/`lint:`/`format:` is the sandboxed Docker shape (worktree at `/app`, the repo's own `imp-nm-<repo>` volume, an allowlisted `node`/`python`/`golang`/`rust` image, no other flags or mounts, no `$`, backticks, `%`, `!` or backslashes).
- **Held** otherwise: posted as an `imp-brief-draft` comment listing every failed check, with `imp:needs-brief`. Copy it as an `<!-- imp-brief -->` and add `imp:ready` to run it.

Because it writes to GitHub, the task is **off by default**:

```powershell
pwsh -File imps/setup.ps1 -WithGroomer   # registers imps-groom (every 3 h from 06:07)
$env:IMPS_GROOM = '1'; node imps/groom.mjs --dry-run   # one-off manual run: prints what it would promote or hold
```

- `groomEnabled()` is true only when `IMPS_GROOM=1`. The scheduled `groom.cmd` sets it itself, so the task is the opt-in.
- Without `-WithGroomer`, `setup.ps1` does not register the task (and removes a previously registered one).
- Config (`~/.imps/config.json`): `"groomAutoPromote": false` holds every draft; `"groomTrustedAuthors": [...]` adds issue authors; `"groomRequireQuiet": true` grooms only repos with no open PRs and no commits for `quietHours`; `"groomDailyIssueCap"` overrides the cap. `"groomOwnerKeywordHold": true` holds the owner's issues for security terms too.
- Kill switches: `IMPS_GROOM=0` / `false` (checked first in the wrapper), `-SkipGroomer` (deprecated; off is the default), or `~/.imps/config.json` `"groom": false`, which wins even when `IMPS_GROOM=1`.
- `warlock.mjs` reports the task as informational and does not fail when it is absent.

## Recover a broken runner

```powershell
pwsh -File <any-checkout>\imps\setup.ps1   # repair/update in place
# or
pwsh -File <any-checkout>\imps\uninstall.ps1 -RemoveRunner
pwsh -File <any-checkout>\imps\setup.ps1
```

State in `~/.imps` survives. Only the detached kit checkout is reset to `origin/main`.

## Stash wrappers

Repos that call the kit through thin wrappers (`scripts/imp-run.ps1`, `.github/imps-config.yml`, `.github/imps-path.txt`) should point at the runner:

1. `$env:IMPS_KIT_PATH` = runner path, **or**
2. `<repo>/.imps/kit-path.txt` (gitignored) containing the absolute runner path, **or**
3. `kit_path` in `.github/imps-config.yml` (leave empty in git; set locally only).

**Vault playbook.** Stash sets `IMPS_VAULT_PROMPT` from `vault_prompt:` (e.g. `agent/prompts/IMPS.md`). The kit resolves it via `resolveVaultPrompt()` (env → `~/.imps/config.json` `vaultPrompt`) and surfaces it in `imp.mjs report`, `rsi.mjs` issue footers, and `doctor.ps1`. It is **not** injected into worker prompts (token cost). Setup accepts `-VaultPrompt` / `IMPS_VAULT_PROMPT` to persist the path in config for the hourly task.

No change to wrapper *CLI* contract is required if they already resolve `IMPS_KIT_PATH` → `imps/imp.mjs`. See STANDARD.md § Stash.

## Watching a run

Live view of the imps without a second window. `watch.mjs` is read-only (no writes, no network, no spawns) and reads only the tail of `~/.imps/dispatch.jsonl`, `runs.jsonl` and the running imps' transcripts, so it costs the same after a year of history.

**In a Claude Code session (status line).** Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"$(tr -d '\\r\\n' < \"${IMPS_HOME:-$HOME/.imps}/kit-path.txt\")/imps/statusline.mjs\"",
    "refreshInterval": 5
  }
}
```

`statusline.mjs` shows the imps (health, squares: blue running, red needs you, yellow PR waiting, dim □ queued, then 24 h ▪ green PR / red fail) and, when `security-program/vuln` is present, the vuln pipeline: full rows while it has open PRs, workers or something that needs you, one dim line when idle (`IMPS_VULN_DIR` moves it, `IMPS_VULN=0` hides it). `watch.mjs --statusline` still prints the imps-only rows. Claude Code runs this under Git Bash on Windows, so `%VAR%` does not expand; the command resolves the kit from `kit-path.txt` (setup writes it with CRLF, hence the `tr`). Verified in a real `claude` 2.1.312 session on Windows 11. Rows: cycle state (running + elapsed from `dispatch.lock`, queue, picked, quota used), one lane per running imp (`repo#issue  elapsed  turns  tool errors  last tool`), then the latest dispatch events (PR green, gate-fail/error red, fix-sweep cyan). Anything read from files is sanitized and truncated; Bash shows only its first word.

**In a spare pane (full screen).** `node imps/watch.mjs` redraws at 1 Hz; `q` quits. Flags for both modes: `--once` (one frame, no TTY), `--home <dir>` (default `IMPS_HOME` or `~/.imps`), `--no-color`.

## Tests

```bash
node --test imps/*.test.mjs
node imps/check-defaults.mjs   # STANDARD.md/README.md vs defaults.mjs
node imps/warlock.mjs          # this machine's topology (WARLOCK.md)
```
