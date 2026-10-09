---
name: journeys
description: Run the low-inference "AI user" loop on a repo — a one-time AI review pass that files distinct, evidence-backed bug issues, then deterministic nightly Playwright journeys that file/dedup/auto-close `bot:journey` issues with no AI. Use when someone says "/journeys", "review the app and file issues", "QA pass", "use the product like a user", "add journeys", "nightly journeys", "AI user", "fix the bot:journey issue", or "journey metrics".
---

# /journeys

AI uses the product once and writes the bot once. After that, a deterministic Playwright script runs every night with no AI, and plain code files, dedups, verifies and closes the issues. Think OSRS essence-mining bots.

- **Contract** (lifecycle, labels, fingerprints, metrics): [journeys/STANDARD.md](https://github.com/nitsuah/.github/blob/main/journeys/STANDARD.md) in `nitsuah/.github`. Read it once per session.
- **Playbook, inventory, run log:** `~/code/stash/agent/prompts/JOURNEYS.md`.
- **Reference implementation:** `nitsuah/fire` (`tests/journeys/`, `.github/workflows/journeys.yml`, `visual-docs.yml`).

```
/journeys [repo] [mode] [args]
```

| Mode | Does | AI? |
|---|---|---|
| `review` | Use the app, Pages site and promo like a new user; file one `bot:review` issue per distinct defect | yes, once |
| `adopt` | Fixture + journeys + baselines + soak + nightly caller + docs, one PR | yes, once |
| `add <feature>` | One more journey for a shipped feature | yes, once |
| `fix <issue#>` | Reproduce and fix a `bot:journey` issue; PR says `Refs #N` | yes, once |
| `status` | BUGS.md, open bot issues, last runs, coverage, across repos | no |

Default: `review` when the repo has no `tests/journeys/`, otherwise `status`.

## Always, before anything else

1. **Worktree:** `git worktree add ../<repo>-wt-journeys -b feat/journeys-<topic> origin/main`. Never branch in the shared checkout. Run every npm/node/Playwright command in Docker (the repo's Playwright image, pinned to `@playwright/test`).
2. Read the repo's README and FEATURES.md, plus `promo/spots.json` if it exists. Its feature ids are the `@feature:` tags. With no spots.json, run `/promo audit` (vigil `showcase apply`) first.
3. **Demo data only.** Use the repo's fictional seed (`promo/demo-seed.js` or equivalent). Never touch the user's real DB, accounts or browser profile. Check that the seed itself has no real people's names or wallets.

## `review`: the pass that files the issues

1. Start the app in Docker on the demo seed and confirm the seed actually rendered. An API seed can drop server-owned fields (fire#174).
2. **Run a scripted tour, not a click-through.** Write one Playwright script (scratchpad, run in the repo's image with `--network container:<app>`) that, at **1440×900 and 390×844**:
   - visits every tab/page and saves a screenshot,
   - logs console errors, `pageerror`s and every ≥400 response,
   - lists elements whose right edge passes the viewport (page-level horizontal scroll vs. table scroll wrappers),
   - checks service-worker registration and anything else browser-only.

   Read the screenshots yourself. Most real finds are visual or semantic: clipped legends, labels colliding with hints, checkboxes floating away from their labels, truncated selects, cramped phone forms, the same number differing between two screens, advice that's wrong for the data (a "single-stock" warning on a total-market ETF).
3. Do the same for the **Pages site** (links HEAD-checked, images and videos load, no 375px scroll, alt text) and the **promo material** (spots.json spots, posters, share copy, frames of the hero video). Numbers must agree across scenes and with the app.
4. **Confirm before filing.** Each finding needs either a cause in code (`file:line`, ideally the arithmetic: "(236,230 + 5,200) / 325,347 = 74.2%: crypto counted as equity") or two reproductions. Drop anything that only happens in an embedded/preview browser.
5. **File one issue per distinct defect.** Ensure the labels exist (`bot:review`, `bug`, `area:<app|site|promo|docs|mcp|api>`). The format:
   - Title: `[area/path] symptom in the user's words`, e.g. `[app/insights] "Equities are 74% of NW" disagrees with Asset Allocation's 72.6%`
   - Body: what you saw and where (viewport, tab), the cause if known with `file:line`, a one-line **Fix:** sketch. Link existing TASKS items instead of duplicating them. Footer: `Found in the one-time AI review pass (demo seed, Chromium 1440×900 and 390×844, <date>).`
6. Add the issues to the repo's TASKS.md by priority (P1 = wrong numbers/advice/data, P2 = layout/UX), in the same PR as anything else you change.

## `adopt`: put the bot to work

Follow STANDARD.md § Adopting it in a repo. The parts that bit last time:

- **Fixture** (`tests/journeys/<repo>.js`): reseed before each journey; mock every third-party call (shared with the promo captures, e.g. `promo/demo-mocks.js`); `page.clock.setFixedTime` at the seed's "today"; an init script that sets `Chart.defaults.animation = false` (canvas libraries ignore `animations: 'disabled'`); `settle()` = `networkidle` + `document.fonts.ready` + redraw charts, after load **and** after each tab switch; in teardown, let debounced saves land before the next reseed; mask server-stamped real-date regions.
- **Journeys:** 2–4 `step()`s each, user-voiced names, `@feature:<spots id>` tags, real seeded numbers in `toHaveText`. Phone gets its own journey. Use `hasText`, not `has:`, for "the card containing X". Tag steps `{ docs: '<feature id>' }` so the same suite writes `docs/screenshots/<id>.png` (`npm run capture:screenshots` + `visual-docs.yml`).
- **Tolerance:** `maxDiffPixels: 1000`, never a ratio. 1% missed a renamed wallet (6,029 px); zero tripped on ~650 px of canvas emoji noise. Measure the noise with `--repeat-each` before choosing.
- **Soak before the PR:** `CI=true … --retries 0 --repeat-each 3`, three runs, 0 failures. Then prove sensitivity: change one visible string in the container and confirm the step fails.
- **Same PR:** caller workflow (template, Playwright image pinned), `test:journeys` script, `journeys-report/` in .gitignore and eslint ignores, README Testing line, FEATURES Testing bullet, CHANGELOG, TASKS. Note in the PR body that it merges after any open `nitsuah/.github` journeys change it depends on. After merge: `gh workflow run journeys.yml` once.
- If the repo already has an artifact-only `playwright-nightly.yml`, replace it with the caller rather than running both.

## `add <feature>`

One journey in an existing `tests/journeys/`, same rules as adopt. Generate only the new baselines in Docker, soak, and open a PR that adds the feature's `@feature:` tag. Report the new coverage number.

## `fix <issue#>`

1. Self-assign the issue. Reproduce with the repro command in its body (Docker).
2. Fix it. If the UI changed, regenerate the affected baselines in Docker (`--update-snapshots`, `tests/journeys` mounted) and commit them, so the PNG diff is the before/after.
3. PR body says **`Refs #N`**, never `Fixes #N`. The nightly closes the issue after 3 consecutive green runs; that is the verification. `bot:review` issues close normally with `Fixes #N`.

## `status` (no AI judgment needed)

For each repo in JOURNEYS.md § Inventory with a nightly: open `bot:journey` / `bot:review` counts (`gh issue list -l …`), `BUGS.md` on `bot/journeys`, the last 7 runs (`gh run list -w journeys.yml`), and coverage from the latest `metrics/<month>.jsonl`. Month-end numbers: `node journeys/metrics.mjs --repos …`.

## Finish every run

Append to `~/code/stash/agent/prompts/JOURNEYS.md` § Run log, in a stash worktree, on its own PR or the run's stash PR:

```markdown
### YYYY-MM-DD · <repo> · <mode>
- Ran: <what, counts: issues filed / journeys / baselines / soak result>
- Found: <the 2–3 findings that mattered>
- Friction: <what was slow, flaky or manual>
- Promote: <rule for this skill, STANDARD.md, the reporter, or a repo TASK>
```

If the same friction appears twice in the log, it becomes a rule here or in STANDARD.md. Edit `nitsuah/.github/skills/journeys/SKILL.md`, then copy it to `~/.claude/skills/journeys/`.
