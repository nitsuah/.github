# PMO handoff (staged, not yet live)

This folder is a staging area. Do **not** merge it as-is. Open a PR from this branch that:

1. Moves `pmo-handoff/workflows/pmo-hourly.yml` to `.github/workflows/pmo-hourly.yml` (new).
2. Moves `pmo-handoff/workflows/auto-update-branch.yml` to `.github/workflows/auto-update-branch.yml`, **replacing** the broken copy on `main`. The copy on `main` is an invalid workflow: it uses `secrets` in a step-level `if:`, so every push fails in 0s and the hourly job never runs. The staged file drops those `if:`s; `imps/auto-update-branch.mjs` already no-ops when `IMPS_GITHUB_TOKEN` is unset.
3. Leaves `imps/pmo.mjs` where it is (already at its real path on this branch).
4. Deletes the `pmo-handoff/` folder after the moves.

## What it does

`imps/pmo.mjs` (`pulse` | `merge` | `triage` | `all`) is a free, deterministic replacement for the hourly check-in. Dry-run is the default. The hourly workflow stays dry-run until the repo variable `PMO_LIVE` is set to `true` (or a `workflow_dispatch` with `live=true`).

- **pulse** — one "PMO pulse" issue in `nitsuah/.github`, edited in place; comments only when alerts change.
- **merge** — merges CLEAN, all-checks-green PRs from allow-listed authors; skips drafts, holds, CHANGES_REQUESTED (including CodeRabbit/bugbot), Dependabot majors, and owner-sensitive paths without `owner-approved`. Trailer: `Merged-by-agent: imp-pmo`.
- **triage** — optional; drafts `<!-- imp-brief-draft -->` rebriefs with a free Gemini key (public repos only).

This repo has no CHANGELOG; the PR should carry the `no-changelog` label.

## Austin-only setup (after the workflows land)

1. Repo secret `PMO_GITHUB_TOKEN`: a fine-grained PAT with access to every in-scope repo (see the header in `imps/pmo.mjs`). The default `GITHUB_TOKEN` cannot see other repos or security alerts.
2. Optional secret `GEMINI_API_KEY` (free AI Studio key) for triage.
3. After a clean dry-run, set repo variable `PMO_LIVE=true`.
4. Optional: `IMPS_GITHUB_TOKEN` so auto-update-branch can update dirty PR branches across repos.

Imps themselves still run on YOKAI/GHASTLY. This does not replace that.
