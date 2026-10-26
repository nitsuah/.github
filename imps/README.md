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
5. Writes `hourly.cmd` + `label-watch.cmd` and registers `imps-dispatch` (hourly :07) and `imps-label-watch` (every 5 min).

Kill switches: `-SkipLabelWatch` / `IMPS_LABEL_WATCH=0` / config `"labelWatch": false`. `-SkipTask` installs the kit only.

```powershell
pwsh -File $env:LOCALAPPDATA\imps-runner\imps\doctor.ps1   # health check
pwsh -File $env:LOCALAPPDATA\imps-runner\imps\update.ps1    # pull latest kit into the runner
pwsh -File $env:LOCALAPPDATA\imps-runner\imps\uninstall.ps1 # remove tasks; keeps state
```

Unix (cheap equivalent): `./imps/setup.sh`, `update.sh`, `uninstall.sh`.

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
| Lock file `~/.imps/dispatch.lock` | Skip if &lt; 3h old (one cycle at a time) |
| 9router probe | Skip the whole cycle if `MAX` doesn't answer |
| WIP / daily caps | Stop when the review pile or 24h run budget is full |
| Repo cooldown | 24h pause after two straight gate failures |
| Label watch (default on) | Extra 5‑min tick for new `imp:ready`; lock still prevents overlap |

Defaults (from `defaults.mjs`): per-repo **4**, concurrency **4**, wip **8**, daily **15**, maxLines fallback **40**, auto-merge trust **3** clean merges.

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
