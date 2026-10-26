# Imps

Headless Claude workers (via [9router](https://github.com/nitsuah)) that turn **one GitHub issue into one small PR**. The contract is [`STANDARD.md`](./STANDARD.md). Defaults live in one place: [`defaults.mjs`](./defaults.mjs).

Sibling system: [`../journeys/`](../journeys/) — nightly Playwright tests that file `bot:journey` / `bot:review` issues with **no AI at night**. Imps fix the small diagnosed ones; green journey nights confirm the fix.

## Fresh machine (Windows — first class)

```powershell
# From any clone of nitsuah/.github (or after cloning it once):
gh repo clone nitsuah/.github $env:TEMP\github-kit
pwsh -File $env:TEMP\github-kit\imps\setup.ps1
```

That:

1. Checks node, git, `gh auth`, Docker, and 9router reachability (prints fixes if anything is missing).
2. Installs a **detached** kit at `%LOCALAPPDATA%\imps-runner` (override with `-RunnerPath` or `$env:IMPS_RUNNER`).
3. Keeps durable state in `%USERPROFILE%\.imps` (ledger, locks, logs, config) — **never** wiped by update/re-run.
4. Writes `hourly.cmd` and registers the `imps-dispatch` Scheduled Task (hourly at :07).

Optional: `-EnableLabelWatch` also registers a 5‑minute tick (still gated by the dispatch lock). `-SkipTask` installs the kit only.

```powershell
pwsh -File $env:LOCALAPPDATA\imps-runner\imps\doctor.ps1   # health check
pwsh -File $env:LOCALAPPDATA\imps-runner\imps\update.ps1    # pull latest kit
pwsh -File $env:LOCALAPPDATA\imps-runner\imps\uninstall.ps1 # remove tasks; keeps state
```

Unix (cheap equivalent): `./imps/setup.sh`, `update.sh`, `uninstall.sh`.

## How it runs (event-driven design)

```
hourly tick (:07) ──► dispatch.lock? ──► 9router MAX probe
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
| Label watch (optional) | Extra 5‑min tick; lock still prevents overlap |

Defaults (from `defaults.mjs`): per-repo **4**, concurrency **4**, wip **8**, daily **15**, maxLines fallback **15**, auto-merge trust **3** clean merges.

## Auto-merge safety

After review **approve**, the runner waits until **every** check returned by `gh pr checks` is finished and green for two consecutive polls, re-checks once more, then **squash-merges immediately**. It does **not** use `gh pr merge --auto` (that only waits for *required* checks — the stash#305 failure mode).

Per-repo **earned trust**: auto-merge stays off until the ledger shows N clean merged imp PRs for that repo (`DEFAULTS.autoMergeTrust`, kill with `IMPS_AUTO_MERGE=0`).

## Self-improvement (RSI)

```powershell
node imps/rsi.mjs --dry-run
# enable on the hourly tick:
#   node imps/dispatch.mjs --rsi
#   or IMPS_RSI=1
```

`rsi.mjs` turns recurring gate failures, fix-loop `needs-human` spikes, and open `bot:journey` / `bot:review` issues into capped `imp:ready` issues with briefs. Kill switch: `IMPS_RSI=0` or `~/.imps/config.json` → `"rsi": false`. Still inside the normal gate / path deny / caps.

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
```
