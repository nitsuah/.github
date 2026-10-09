# Journeys: the low-inference "AI user" loop

Think of an OSRS essence-mining bot: deterministic, repeatable, near-zero cost. The bot that "uses the product every night" is a **plain Playwright script on a cron**. AI is involved at exactly two points:

1. **Writing a journey, once per feature.** An agent turns a confirmed happy path from FEATURES.md into `tests/journeys/*.spec.js`.
2. **Fixing a failure, once per bug.** A routine picks up a `bot:journey` issue and opens a fix PR.

Everything in between is code and GitHub Actions, with zero tokens: the nightly run, visual diffs, issue filing, dedup, fix verification, BUGS.md, and metrics.

```
FEATURES.md ──(AI, once per feature)──► tests/journeys/*.spec.js   step() = test.step + visual baseline
                                              │
GH Actions cron (nightly, Docker, 0 tokens) ──┘ .github/workflows/journeys.yml → this repo's reusable workflow
                                              │ fail
                                              ▼
reporter.mjs (no AI): fingerprint = repo + journey + step + error class
   → create / update / reopen a `bot:journey` issue (screenshots pinned on bot/journeys)
   → green N nights in a row → auto-close     → BUGS.md + metrics/<month>.jsonl on bot/journeys
                                              │
fix routines take `bot:journey` issues ─► fix PR ─► the next nights verify it (no AI)
                                              │
monthly RSI: metrics.mjs (no AI) → one short AI pass reads the table → RSI log
```

Files in this folder:

| File | What it is |
|---|---|
| `reporter.mjs` | Playwright JSON report → issues, BUGS.md, metrics. No deps, Node 18+. |
| `metrics.mjs` | Monthly table: flaky rate, reopen rate, time-to-fix, coverage. No deps. |
| `lib.mjs` / `lib.test.mjs` | Pure logic (fingerprints, plan, BUGS.md). `node --test journeys/*.test.mjs` |
| `templates/journey.js` | The `step()` helper each repo vendors into `tests/journeys/journey.js`. |
| `templates/journeys.yml` | Caller workflow for a repo. |
| `templates/playwright.journeys.config.js` | Journeys config that extends a repo's Playwright config. |
| `../.github/workflows/journeys.yml` | The reusable workflow: Docker, run, report, upload. |

Pilot: **nitsuah/fire** (`tests/journeys/`, `.github/workflows/journeys.yml`). Copy from there when a template isn't enough.

## The docs a repo already has, and what each one does here

| Doc | Role in the loop |
|---|---|
| `docs/FEATURES.md` (or root) | Source of happy paths. A journey exists for a user-visible feature, not for every bullet. |
| `promo/spots.json` | **Feature ids.** Journeys tag `@feature:<id>` using spots.json ids, so coverage comes free and `/promo`'s `"visual": "none"` culling also defines what needs a journey. No second ledger. |
| `docs/TASKS.md` / `ROADMAP.md` | Rollout and follow-ups. A fix PR that closes a TASKS item still closes it in the same PR (see the global CLAUDE.md). |
| `docs/CHANGELOG.md` | The PR that adds journeys, and each fix PR, get an entry as usual. |
| `BUGS.md` | **Generated. Never hand-written.** Lives on the `bot/journeys` branch, rebuilt every night from open `bot:journey` + `bot:review` issues, grouped by `area:` label. Link to it from the docs nav: `https://github.com/<owner>/<repo>/blob/bot/journeys/BUGS.md`. |
| `README.md` | One line under Testing: what the nightly journeys are and where BUGS.md lives. |

## Labels

| Label | Set by | Meaning |
|---|---|---|
| `bot:journey` | reporter.mjs | Nightly failure. Carries `<!-- journey-fp -->` and `<!-- journey-meta -->` markers. Don't edit those. |
| `bot:review` | the one-time AI review pass | Distinct finding from an agent using the product, site or promo. Title `[area/path] …`. |
| `area:<app\|site\|promo\|docs\|mcp\|api>` | both | Grouping in BUGS.md. Journeys default to `area:app`; tag `@area:site` to override. |
| `bug` | both | Standard. |

## Issue lifecycle (all no-AI)

- **Fingerprint** = sha1(`repo | spec file | journey title path | failing step path | error class`), 12 hex chars.
  - The *step* is the deepest `test.step` with an error, so name steps for what the user does.
  - The *error class* is deliberately coarse: `expect:toHaveText`, `timeout:locator.click`, `visual-diff`, `missing-baseline`, `TypeError`, `test-timeout`. Numbers, quotes, paths and selectors are stripped, so the same bug on a different night lands on the same issue.
- **New fingerprint** → open an issue (at most `max-new-issues` per run, 5 by default; the rest follow on later nights). The issue carries the error, up to three screenshots (actual/diff/expected) pinned to a commit on `bot/journeys`, the repro command, and a link to the trace artifact.
- **Same fingerprint, issue open** → update the body: last seen, occurrences. No comment, so no noise.
- **Same fingerprint, issue closed** → reopen with a comment, and count `reopens`.
- **Journey passes and its issue is open** → `greens += 1`. At `green-runs` (3 by default) → close as completed, with a comment linking the run. **This is the fix verification.**
- **Journey didn't run** (deleted, renamed, skipped) → issue untouched. Close it by hand if the journey is gone.
- **Flaky** (failed, then passed on the CI retry) → no issue, counted in metrics. A flaky rate above ~5% is an RSI finding.
- **Harness failure** (no report, webServer didn't start, config error) → one `(harness)` issue, which closes after N runs that produce journeys again.
- Issues are filed only on `schedule` / `workflow_dispatch` runs of the default branch. PR runs write the step summary only.

## Adopting it in a repo

1. Prereqs: Playwright already in devDependencies, a fictional demo seed (promo's, if the repo has one), and `promo/spots.json` (run `/promo audit` / vigil `showcase apply` if it's missing).
2. Copy `templates/journey.js` → `tests/journeys/journey.js`. Add a small repo fixture (`tests/journeys/<repo>.js`) that:
   - seeds the **fictional** demo data before each journey (never the user's real data),
   - mocks every third-party call the UI makes (prices, OAuth status, AI APIs),
   - pins the clock (`page.clock.setFixedTime`) to the seed's "today",
   - turns off canvas/JS animation libraries (fire: an init script that sets `Chart.defaults.animation = false`; `animations: 'disabled'` only stops CSS),
   - waits for `networkidle` and `document.fonts.ready` after load and after each tab switch, then redraws canvas charts (text drawn before web fonts load keeps the fallback font), and lets debounced saves land in teardown before the next journey reseeds,
   - masks regions the server stamps with the real date.
3. Copy `templates/playwright.journeys.config.js` → `config/` (or the repo root) and point it at the repo's base config. Add `"test:journeys"` to package.json and `journeys-report/` to `.gitignore` and the eslint ignores.
4. Copy `templates/journeys.yml` → `.github/workflows/journeys.yml`. Set `image` to the Playwright version in package.json.
   - If the repo already has a `playwright-nightly.yml` (ats-fill, nitsuah-io), **replace it** with the caller rather than running both.
5. Write the journeys (see below), generate baselines in Docker, and soak them: `CI=true … --retries 0 --repeat-each 3`, three times, 0 failures. Don't merge a journey that fails the soak.
6. In the same PR: README Testing line, CHANGELOG, TASKS/ROADMAP rollout item, FEATURES.md Testing bullet. Then trigger the workflow once by hand (`gh workflow run journeys.yml`) and check the summary.

## Writing a journey (the AI-once part)

- **One journey = one thing a user wants done**, named in their words: `reseller prices an eBay sale and logs it`. 2–4 `step()`s, each a visible action plus an assertion on the result. Each step gets a viewport baseline automatically.
- Tag every journey `@feature:<spots.json id>` for each feature it exercises. The reporter warns about unknown tags.
- Assert outcomes users care about: totals, rows appearing, panels opening. Don't assert implementation details.
- Use real numbers from the demo seed (`$45.50`, not `/\$\d/`). They catch calculation regressions the screenshot might not.
- Phone layouts get their own journey with `test.use({ viewport: { width: 390, height: 844 }, isMobile: true })`.
- Prefer ids and roles over CSS paths. A `has:` locator is evaluated *inside* the outer element, so use `hasText` when you mean "the card containing this text".
- Baselines are **Linux, Docker only.** Generate them with the Playwright image, never on Windows/macOS.
- **Tolerance: `maxDiffPixels: 1000`, never a ratio.** `maxDiffPixelRatio: 0.01` allows ~13k px at 1440×900, so fire's renamed demo wallet (6,029 px) passed unnoticed. Exact zero failed on ~650 px of canvas emoji rendering noise. Keep it above the measured noise and well below a layout change, and let `toHaveText` pin exact text and numbers.
- **Journeys double as the visual-docs screenshots.** Add `{ docs: '<spots.json feature id>' }` to a step, and with `DOCS_SCREENSHOTS=docs/screenshots` set the step also saves `docs/screenshots/<id>.png` (unmasked), which vigil's `showcase apply` links by id. A `capture:screenshots` npm script (`--ignore-snapshots`) plus a `visual-docs.yml` that opens a PR on `bot/visual-docs` (fire's is the reference) replaces a separate screenshot suite.

### Baselines and fix PRs

A fix that changes the UI fails its own journey's visual step. That's intended: the PR must regenerate the affected baselines in Docker (`--update-snapshots`, with `tests/journeys` mounted) and commit them, so the reviewer sees the before/after PNG diff in the PR. Known bugs are visible in baselines until fixed (fire: the clipped allocation legend, #167).

## The fix loop (AI-once part 2)

Fix routines (stash `agent/prompts/MINI.md`, `ENG.md`) take open `bot:journey` issues before other backlog. Each issue is self-contained: journey, step, error, screenshots, repro command. The routine:

1. Reproduces with the issue's repro command (Docker).
2. Fixes it, updates baselines if the UI changed, and opens a PR that says `Refs #N`.
3. **Doesn't close the issue on merge.** Use `Refs #N`, not `Fixes`, for `bot:journey` issues, so the nightly closes it after N green runs. Otherwise a fix that doesn't hold gets marked done by a human. (`bot:review` issues close normally with `Fixes #N`.)

## Metrics (monthly RSI)

`node journeys/metrics.mjs --repos nitsuah/fire,… --month YYYY-MM` prints one table:

| Metric | Definition |
|---|---|
| runs (green) | nightly runs in the month (runs with 0 failures) |
| flaky rate | flaky test executions ÷ all test executions |
| issues opened / closed / open | `bot:journey` issues created / closed in the month / open now |
| reopen rate | issues ever reopened ÷ issues ever closed (all-time) |
| median time-to-fix | issue created → auto-closed, in days. Includes the N-green verification window. |
| feature coverage | user-visible spots.json features with ≥1 journey (last run) |
| tokens | from USAGE.md. The loop itself spends none. |

The RSI routine (stash `agent/prompts/RSI.md`) runs it, appends the table to `stash/agent/prompts/JOURNEYS.md` § Metrics log, and turns outliers into rules or tasks: flaky above 5%, reopens above 20%, coverage flat for two months.
