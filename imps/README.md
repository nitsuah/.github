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

Keep the router URL and key in **OS user-level environment variables**, not in `~/.claude/settings.json`. The kit reads, in order: URL = `ANTHROPIC_BASE_URL`, else `NINEROUTER_URL` (a missing `/v1` is added), else `http://localhost:20128/v1`; key = `NINEROUTER_KEY`, else `ANTHROPIC_API_KEY`. For each, the environment wins and `settings.json` `env` is the fallback, so existing machines keep working. `settings.json` may be missing or have no `env` block. Only the resolved URL and key reach an imp's environment (nothing else from your session). `doctor.ps1` and `warlock.mjs` say whether each came from `env` or `settings`, and never print the key.

Windows (PowerShell; the prompt keeps the key out of history and the console):

```powershell
[Environment]::SetEnvironmentVariable('NINEROUTER_URL', 'http://localhost:20128/v1', 'User')
$k = Read-Host 'NINEROUTER_KEY' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($k))
[Environment]::SetEnvironmentVariable('NINEROUTER_KEY', $plain, 'User'); Remove-Variable plain, k
```

Task Scheduler tasks only see new user variables after you **sign out and back in** (or reboot); open a new terminal for interactive shells. Then run `doctor.ps1`.

macOS / Linux: `export NINEROUTER_KEY=...` (and optionally `NINEROUTER_URL`) in `~/.profile` (login shells; cron does not read it, so prefix the crontab line or use `environment.d`), or for systemd user timers put `NINEROUTER_KEY=...` in `~/.config/environment.d/imps.conf` and re-login. Keep that file `chmod 600`. `setup.sh` reports where it found the URL and key.

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

Defaults (from `defaults.mjs`): per-repo **4**, concurrency **4**, wip **8**, daily **15**, maxLines fallback **80**, auto-merge trust **3** clean merges.

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

## Tests

```bash
node --test imps/*.test.mjs
node imps/check-defaults.mjs   # STANDARD.md vs defaults.mjs
node imps/warlock.mjs          # this machine's topology (WARLOCK.md)
```
