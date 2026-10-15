---
name: promo
description: Keep a repo's screenshots, videos, diagrams, GitHub Pages site and branding in lockstep with its FEATURES.md, and wrap /brag and /brag-slim so launch videos come out as short feature spots (12–21 s) plus one hero/YouTube cut. Repos without a frontend get generated visuals (graph animations, infographics, CLI/MCP captures) instead of screenshots. Use when someone says "/promo", "refresh the promo", "update the github page", "brag about <feature>", "make a reel", "vertical short", "the screenshots are stale", or "update the logo/favicon everywhere".
---

# /promo

`/promo` runs the visual-showcase loop for one repo, end to end, and leaves an auditable trail. The contract is [showcase/STANDARD.md](https://github.com/nitsuah/.github/blob/main/showcase/STANDARD.md) in `nitsuah/.github`. Read it once per session. This file covers the order of operations and the checks.

```
/promo [repo] [mode] [options]
```

- **repo**: a folder under `~/code`, or the current directory.
- **mode**: one of the modes below. Default `refresh`.

| Mode | Does |
|---|---|
| `audit` | Read-only gap report: features without visuals, stale spots, Pages drift, brand drift |
| `refresh` | audit → screenshots/diagrams → spots for new or changed features → Pages → brand check → RSI log |
| `fix <cells>` | **Surgical.** Clear only the named showcase-board cells (`screenshots,diagrams,journeys,linked,vertical,videos`; `red` = every missing/partial cell). Nothing else changes. See [Surgical fixes](#surgical-fixes-fix-cells) |
| `spot <feature or category>` | One 12–21 s spot for one feature group, via /brag or /brag-slim |
| `reel [id]` | Concatenate spots into a longer cut (hero / YouTube). No new rendering |
| `vert <spot>` | Vertical, narrated version of a spot for Shorts, Reels and TikTok |
| `publish` | Copy rendered spots and posters into the Pages folder and update the page |
| `logo` | Generate or replace the logo, propagate it to every derived copy, list the manual uploads |

## Always, before anything else

1. **Work in a worktree.** Run `git worktree add ../<repo>-wt-promo -b promo/<topic> origin/<default>`. Never branch in the shared checkout, because routines commit there. Run every npm, node or ffmpeg command in Docker.
2. **Load the backbone, lightly.**
   - Read README.md and FEATURES.md (root or `docs/`) in full.
   - Read `promo/spots.json` if it exists.
   - Read only the parts of ROADMAP, CHANGELOG and `docs/` that cover features changed since the last spot's `rendered` date: `git log --since=<date> --stat`.
   - Don't read the whole `docs/` tree.
3. **Run the audit with vigil**, in vigil's test image. That image has `tsx` pinned by vigil's lockfile and native dependencies built for Linux. Set `REPO` to the absolute path of the repo you resolved in the first step (the worktree, or the current directory). Mount it read-only:

   ```bash
   REPO="$(cd <repo-path> && pwd)"
   cd ~/code/vigil && docker compose -p vigil-showcase -f config/docker-compose.test.yml run --rm \
     -v "$REPO:/target:ro" test npm run showcase -- audit /target
   ```

   No `promo/spots.json` yet? Run `apply` instead of `audit`. `REPO` must be the worktree, and drop `:ro`, since it writes files. It scaffolds spots.json from FEATURES.md and adds the expand-kit tag to the Pages HTML. Review that diff before you go on.

   In a worktree, `.git` is a pointer file to a Windows path, so the container sees no history: the audit prints `spot-stale-unchecked` and labels the repo `target`. Check staleness yourself, per spot: `git log --since=<rendered> -p -- FEATURES.md` and look for changed lines that name one of the spot's `features`. An edit to some other feature doesn't make the spot stale.
   **First run in a repo:** turn on "Allow GitHub Actions to create and approve pull requests". Without it, the visual-docs and journeys bots can't open their PRs. vigil flags it as `actions_pr_permission`. It needs repo admin, so print the command for the user rather than running it:

   ```bash
   gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
   ```

4. **Cull the feature list before mapping anything.** FEATURES.md usually over-reports (vigil: 201 bullets, 57 user-visible). A feature gets a visual only when a user can see it or do it: a screen, a button, a CLI or MCP response. Mark it `"visual": "none"` when it is:
   - an implementation detail (caching, TTLs, env vars, logging, parsers, DB batching, CSS tweaks, error plumbing),
   - one item of a list that a parent check already covers (each doc type, each community standard, each best practice),
   - tech stack or deployment,
   - a duplicate of a feature in another category (AI/market-trend recaps),
   - a process or marketing statement ("quarterly review"),
   - not shipped, or claimed but missing in code (grep for it),
   - a test, mock or a11y-compliance claim ("validated by tests", axe, WCAG AA, chrome mock): the tests are process; the screen they protect is the visual,
   - agent config: a Claude skill file, model gateway or routing config whose effect a user only sees through another feature.

   Don't delete FEATURES.md lines yourself. List proposed trims in the PR for the user to confirm. If more than about 40% are `none`, say FEATURES.md over-reports.

## Screenshots and diagrams (CI)

Screenshots and diagrams are CI's job. If the repo has no `.github/workflows/visual-docs.yml`, adopt the recipe from vigil's [docs/VISUAL_DOCS.md](https://github.com/nitsuah/vigil/blob/main/docs/VISUAL_DOCS.md) rather than taking screenshots by hand:

- Use mocked APIs, a frozen clock, a fixed viewport, and demo data only.
- Name each screenshot after the feature id in spots.json (`docs/screenshots/<feature-id>.png`). The audit can then match them without anyone editing paths.
- **If the repo has nightly journeys** ([journeys/STANDARD.md](https://github.com/nitsuah/.github/blob/main/journeys/STANDARD.md)), don't add a second suite. Tag journey steps `{ docs: '<feature id>' }`, add a `capture:screenshots` script (`DOCS_SCREENSHOTS=docs/screenshots … --ignore-snapshots`), and copy fire's `visual-docs.yml`. The journeys already have the seed, mocks and frozen clock.
- A system with several moving parts (services, MCP, cron, an extension talking to a backend) gets a `docs/diagrams/<name>.mmd`. A diagram explains a flow faster than a video does. Copy vhs: `docs/diagrams/{architecture,capture-flow,job-lifecycle}.mmd`, `mermaid.config.json` (default theme, `htmlLabels: false`) and the render step in its `visual-docs.yml`. Draw what the code does (read the entry points, compose files, MCP tool list), one architecture diagram plus one or two flows; never a generic boxes-and-arrows guess. Add the render step to an existing visual-docs or screenshot workflow rather than a second workflow (ats-fill: inside ci.yml's `screenshot-gallery` job, with its publish script also adding `docs/diagrams/*.svg`).
  - **Validate locally** with this exact command from the repo root (Git Bash on Windows; no puppeteer config needed; the digest is 11.4.2):

    ```bash
    MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/docs/diagrams:/data" \
      minlag/mermaid-cli@sha256:99c983b3ab4e14033f2880bc1b9de17e5090b4515dabd63fe9cf8c0ae6130956 \
      -c /data/mermaid.config.json -i /data/<name>.mmd -o /data/<name>.svg
    ```

    Without `MSYS_NO_PATHCONV=1` and `pwd -W`, Git Bash mangles the mount and a file mount silently becomes a directory.
  - **Commit the first SVGs** so the README embeds work before the bot PR lands, and end each with a newline: repos running pre-commit's `end-of-file-fixer` fail CI otherwise. Put `echo >> "${f%.mmd}.svg"` after the `mmdc` line in the workflow too, or every bot PR fails (motor-pool#95).
  - vigil's workflow template hard-codes `branches: [main]`: set it to the repo's actual default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`; motor-pool is `master`). Its `visual-docs-readme.mjs` lists every screenshot too; in a repo that already has a hand-written screenshot gallery, embed the diagram SVGs between the markers by hand instead of running the script, or the gallery appears twice.
  - A script copied from another repo must pass this repo's formatter and linter: run its own prettier version (`npx -y prettier@<devDependencies version> --write <file>` in `node:22-alpine`) before pushing (fire#197 failed lint on vigil's script).
  - Working-tree files are often CRLF (`core.autocrlf=true`) and the host has no Python or jq: edit with node or the Edit tool, preserve line endings, and validate JSON with `node -e "JSON.parse(...)"`.

### Full-page captures

A full-page screenshot paints `position: fixed`/`sticky` chrome once at the viewport bottom, over real content, and stops at a `100vh` or `overflow` container, cutting the page. In the capture fixture only: make fixed chrome `position: relative`, expand clipped scroll containers and `100vh` grids vertically (`height:auto; overflow-y:visible`), and override any layout the test-helpers build injects. Then look at the bottom of each shot, not just its height (nitsuah-io#570: the footer hid the wallet's action buttons and the home page lost its card buttons).

### No frontend: generated visuals

A repo with nothing to screenshot (a vault, prompt library, CLI, MCP server, harness) sets `"frontend": false` in spots.json, and its screenshots become **generated visuals**: a script that CI runs to draw something true from the repo's own data. Pick the one that shows the repo's idea fastest:

| Repo shape | Generated visual | Example |
|---|---|---|
| Notes / vault / knowledge graph | Animated graph of the links | stash `agent/scripts/vault-graph-gif.js` → `vault-graph.gif` |
| Prompt / skill library | Card grid rendered from the prompt files' front matter | — (stash proposal) |
| Scheduled routines / cron fleet | Week timeline of what runs when | — (stash proposal) |
| CLI | Terminal capture of a fixed fixture run (HTML → PNG in Chromium) | — |
| MCP server | A tool call and its response, rendered as a chat turn from a fixture | — |

**No browser needed** for card grids, matrices and chat turns: build an SVG in node and rasterize it with `@resvg/resvg-js` (`npm i --no-save @resvg/resvg-js@2.6.2`). resvg ignores system fonts, so pass `fontFiles` explicitly (DejaVu Sans Mono; `apt-get install fonts-dejavu-core` in CI) or the PNG has no text. The board counts PNG/JPG/WebP/GIF stills, not SVG. bb-mcp#148 is the reference: `scripts/visual-docs.mjs` draws the tool catalog, the RBAC matrix and a demo tool call from the built manifest.

Rules: the generator replaces the Playwright capture step in the visual-docs workflow; trigger it on the paths that change its picture, never on daily-note folders (stash: `agent/prompts|routines|projects|topics` plus a weekly cron, or every routine note would open a render PR); moving an already-committed asset into `docs/screenshots/` is a `git mv` plus a Pages-workflow copy step so the site never breaks; deterministic (fixed seed, frame count, clock), demo-safe (check it shows no private note titles, names or accounts; if the real data is private, render from a fixture), output to `docs/screenshots/<feature-id>.<png|gif|webp>`, regenerated by the visual-docs workflow and opened as a bot PR. When a FEATURES.md category has no generator yet, name the one it would need in the PR (a new script, or an existing skill such as `/brag-slim` compose-only stills) rather than leave the category blank. Spots for these repos use the compose-only engine (see Spots).

## Locked spots

A spot or reel with `"locked": true` in spots.json is one the owner is happy with. Every mode, `refresh` included, must leave it alone:

- **Never** re-render, re-encode, trim, rename or delete it, or edit its `promo/<spot>/` sources or its published `.mp4`/poster.
- **Never** demote it: if it is the Pages hero or a feature section's video, it stays there.
- **May** read it: `vert <spot>` writes a separate `<spot>-vert/`, and a reel may include it as is.
- A locked spot whose features changed is reported as `stale (locked)` in the audit and the PR body, not re-rendered. Unlocking is the owner's edit, never the agent's.

The `showcase-locked` check (`.github/workflows/showcase-locked.yml` here, reusable) fails a PR that changes the bytes of a locked spot's sources, `published` file or poster. Add the caller to a repo when you lock its first spot.

## Surgical fixes (`fix <cells>`)

Use it when a repo's showcase is mostly right and only some board cells are red. The cells are the columns of the showcase board (`stash/agent/scripts/visual_board.py`). Each cell maps to the narrowest action, and nothing outside that action's files changes:

| Cell | Action | Files it may touch |
|---|---|---|
| `screenshots` | Adopt the CI recipe (see below), journey-tagged when the repo has journeys | `docs/screenshots/`, the visual-docs workflow and capture script, the README between its screenshot markers |
| `diagrams` | `docs/diagrams/<name>.mmd` and the CI render step | `docs/diagrams/`, the workflow, the README between its diagram markers |
| `journeys` | Run `/journeys` (review pass + nightly) | tests, the journeys caller workflow, its config |
| `linked` | Map existing screenshots and spots to features | `promo/spots.json` (`spots[]`/`screenshots[]` per feature) only |
| `vertical` | `vert <spot>` from the best existing spot (prefer a locked one) | `promo/<spot>-vert/`, spots.json, the Pages vertical slot |
| `videos` | Publish rendered but unpublished spots | the Pages assets folder, spots.json `published` |

Rules:
- Skip the step 2 backbone reading beyond FEATURES.md and spots.json, and skip the full audit; read the cells from the latest `visual-board.json`, or re-run `visual_board.py` for that repo.
- No new spot, hero, reel, logo or Pages redesign unless the user names it. If a cell can't be cleared without one, stop and say so.
- One repo per PR. The PR body lists cells before → after, and the PR passes `showcase-locked`.
- `linked` and `videos` are mechanical: hand them to a haiku subagent. `vertical` narration and diagram content need judgment.

### What the board checks (predict the after state before you push)

The board reads the default branch only, so a cell turns green when the PR merges, not when it opens. Each detector (`visual_board.py` `scan()`):

| Cell | ok when | partial when |
|---|---|---|
| `screenshots` | images under a `screenshots/` or `gallery/` folder (png/jpg/webp/gif) **and** a workflow mentions `screenshot`; `"frontend": false` repos also count stills/GIFs in `pagesDir` | images but no CI, or CI but none committed |
| `diagrams` | a `.mmd`/`.excalidraw`/`.drawio` source (or an image under `diagrams/`) **and** a workflow mentions `mermaid`, `mmdc`, `excalidraw` or `diagram` | sources but no CI |
| `linked` | ≥ 80% of features without `"visual": "none"` have a non-empty `screenshots[]` or `spots[]` | at least one linked |
| `journeys` | any workflow or file path mentions `journey` | — |
| `vertical` | a spot with `"format": "vertical"` | — |
| `videos` | every spot has `published` | some do |

### Linking rule (`linked`), in order

For each feature in spots.json:
0. Get the list: the board JSON's row for the repo carries `unlinked` (visible feature ids with nothing linked). Work only on those. A file named `docs/screenshots/<id>.png` does **not** link itself: the board reads only `screenshots[]`/`spots[]`.
1. A file on the default branch shows it (screenshot named for its id, a diagram, a Pages asset, a spot listing it in `features`)? Add the repo-relative path to `screenshots[]` or the spot id to `spots[]`. Check the path exists with `git ls-tree`, and open the image to confirm the feature is visibly on it. A partial view counts when the feature's control or output is clearly on screen (a Replay button for replay mode); a page that merely hosts it doesn't. Link a spot only if it is published or its `features[]` already lists the feature; add the id to the spot's `features[]` as well. A spot with `features: []` gets its list filled from its `spot.json` scenes first.
2. Not user-visible per the cull list in "Always" step 4? Set `"visual": "none"`.
3. Visible but nothing shows it? Leave it unlinked, list it under **Needs capture** in the PR body, and add one TASKS.md line `Capture for promo: <ids>` (grouped by the screen state each needs: "open Filters panel", "scrolled Settings"). That line is the input to the next `fix screenshots` run, which adds those captures to the visual-docs suite. `linked` staying partial after a links-only pass is the expected result, not a failure. Never mark a visible feature `none` to raise the score: the board's ratio is only honest if `none` means "nothing to show". A feature you can't capture because it doesn't render is a product bug: file it.

### Running fix as a wave (several repos at once)

A coordinator may hand `fix` to several cheaper-model subagents in parallel, one repo each. Then:
- The coordinator's brief names, per repo: the local folder (check `ls ~/code`, repos get renamed), the default branch, the CHANGELOG path (root or `docs/`), the `unlinked` ids from the board JSON, and any spots on hold.
- Each agent returns its RSI entry in its final report instead of editing `PROMO.md`; the coordinator files them in one stash PR. Parallel edits to one log file conflict.
- Docker on the host is shared and small. Agents don't run local renders, Playwright suites or dev servers; CI is the check. Renders (`vertical`, `videos`) go one repo at a time, in their own wave.
- The coordinator re-runs `visual_board.py` after the PRs merge and compares each repo's cells with what its PR body predicted. A cell that didn't move is a detector gap or a wrong prediction: fix whichever it is and note it in the RSI log.

## Spots (video, local only)

**One spot = one feature category or one idea, about 12–21 s.** Don't make one video that tries to cover everything. When FEATURES.md has more categories than one spot can carry, plan several spots plus one hero cut.

**Feature spots don't share an intro or outro.** Each spot plays only its own scenes: wordmark on screen from frame 0 (no question-hook-plus-reveal preamble), outro of 3 s or less, natural length (don't stretch to 21). The shared hook, reveal and full outro belong once, in the hero. Check it with a same-timestamp frame grid across the spots (frames at 1.5, 5, 9, 15 s, one row per spot). If two rows match for more than ~3 s, the spots will read as one video in a gallery. vigil's first run failed this: 10 of 21 s were identical in every spot.

1. **Plan the spot list from spots.json.**
   - Each category with no spot, or whose features changed after the spot's `rendered` date, needs one.
   - Show the user the list (id, features covered, seconds, tool) and get an OK before rendering more than one. If the user already asked for the full run, post the list and go on.
2. **Choose the engine.**
   - The repo has `promo/build.sh` (fire, vigil): use it. It's reproducible and runs in Docker. Don't copy `compose.html`/`synth.py` per spot. Reuse one composition: vigil's spots set `"base": "brag-30s"` in `spot.json` and list a subset of its scenes with their own times; each scene's motion and sound cues are time-mapped into the slot. A new cut is then `spot.json` + `share-copy.txt`. Port that (`promo/spot-config.js`, the `T(id)` blocks in compose, `cue()` in synth) before adding a second spot to a repo whose compose is one long timeline.
   - Check stills with a contact sheet when the repo has `promo/sheet.sh` (vigil): `promo/sheet.sh <spot>` tiles them into one image, which is cheaper to review. Without it, still pull and look at at least four stills one by one before calling the render done.
   - **No frontend** (a prompt library, a CLI, an MCP server, a harness): don't rebuild a UI in /brag. Compose real artifacts (issue titles, terminal output, CLI/MCP responses, screenshots from the repos the tool serves) in a `compose.html` with `window.render(t)`, using stash's compose-only `promo/build.sh` + `render.js` + `Dockerfile` as the template (`journeys-19s`). Check read time on the contact sheet: each text block fully settled for about 0.3 s per word.
   - **Adding to an existing page** (a second product angle): make a new page and link it from the nav and a card. Don't touch the existing hero, video or spots.
   - Otherwise: invoke **/brag** (or **/brag-slim** on Opus 5.5) with a focused brief. The brief must contain:
     - the spot id and the duration: the content's natural length, 12–21 s (`--duration 15`), unless the user said otherwise. Say "no intro, no reveal, outro of 3 s or less" for a feature spot,
     - the 2–4 features it covers, quoted from FEATURES.md,
     - the deployed URL and Pages URL from spots.json,
     - the demo-data rule: fictional seed only, never the user's real accounts, inbox, portfolio or Chrome profile,
     - the output location: work in `promo/<spot-id>/`. Keep the plan, `compose`, `synth` and `share-copy` there. Renders go to `promo/out/<spot-id>/`, which is gitignored. **Never** commit a root `brag-output/` (bb-mcp did, and it's dead weight).
3. **Double-check every render** before calling it done. Brag tends to drift, so check each of these:
   - [ ] The duration is within ±2 s of the target, and the first 2 s say what the product is. A question hook alone doesn't: put the wordmark on screen from frame 0.
   - [ ] Every feature in the brief is visibly on screen. Name the timestamp for each.
   - [ ] No real personal data in any frame. Pull 4 stills and look at them.
   - [ ] Frame 0 is the poster (a settled frame, not mid-transition), and `<spot>.jpg` matches it.
   - [ ] A `-web.mp4` cut exists (CRF ≈ 27, `+faststart`) under ~8 MB for Pages.
   - [ ] `share-copy.txt` is specific to this spot. No "excited to share".
   - [ ] The outro URL is the current deployment or Pages URL from spots.json.
   - [ ] Spots don't repeat each other: in a same-timestamp frame grid across all spots, no two rows match for more than ~3 s.
   - [ ] When two screens show the same field (the same person's title, the same total for the same period) with different values (the landing page says "Senior Platform & AI Engineer", the resume "Senior Systems Engineer") it is a product bug: file it and keep the narration off the disputed value. Different fields, time ranges or deliberately context-specific titles are not a mismatch.
   - [ ] Numbers agree across scenes: the same net worth, total or count wherever it appears (UI vs MCP/CLI output). A mismatch is a product bug: file it, don't hide it in the edit (fire#178).
   - [ ] What the seed should show actually renders (history charts, lists). An API seed can drop server-owned fields (fire#174).
   - [ ] A new cut never inherits claims from an older spot: re-derive tool counts, commands and output from the code. bb-mcp's landscape spot said 34 tools (there are 40), showed CLI verbs that don't exist, and ended on `npm i -g bb-mcp`, which installs someone else's package (bb-mcp#149, #150). Check any install command with `npm view <name> repository.url`.
   - [ ] Every claim about how the product behaves ("not scored", "never", "free", "automatic") is checked against the code, both in the on-screen copy and in `share-copy.txt`. The captured UI counts as a claim too: captures come from a demo fixture, and a stale fixture produces a false screenshot. vigil's `visual-17s` said Visual Docs was "not scored" and its practices card showed "(not scored)" because the capture fixture still flagged it informational; it had been scored for a week (vigil#291, #292).
   - [ ] After the render, `git status`: a `--recapture` or build can rewrite the Pages screenshots as a side effect. Keep only the files the spot needs and the ones you meant to fix.
4. **Record it in spots.json**: `id`, `seconds`, `format`, `tool`, `features`, `rendered` (today), `published` (path once published). Also set each covered feature's `spots[]`.

## Reels

**Prefer one continuous hero cut** (every feature scene, one hook, one outro). With a reusable composition it's one more scene list (vigil: `hero-37s`), listed as a one-spot reel. Concatenate spots only when they carry no intro or outro of their own:

`/promo reel hero` concatenates the spots listed in `reels[].spots`. Run it in Docker with the same encode settings as the spots so the joins are invisible:

```bash
docker run --rm -v "$PWD:/w" -w /w jrottenberg/ffmpeg:7.1-alpine@sha256:8ec1ee1f6a0fcd37c97725827b6b7832795c9596e3439b8da56d7700d61ae778 \
  -i promo/out/a/a.mp4 -i promo/out/b/b.mp4 \
  -filter_complex "[0:v][1:v]xfade=transition=fade:duration=0.3:offset=<a_seconds-0.3>[v];[0:a][1:a]acrossfade=d=0.3[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -crf 17 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 192k promo/out/reel-hero.mp4
```

Chain `xfade` for three or more spots (vigil's `promo/reel.sh <id>` builds the chain from spots.json). Don't add intro or outro cards. The reel's poster is its first spot's poster. Set `reels[].published` when it goes on the page.

## Vertical shorts

`/promo vert <spot>` re-renders an existing spot's plan with `--format vertical --voice` to `promo/<spot>-vert/`:

- 1080×1920, ≤ 30 s,
- captions burned in,
- the narration script derived from the spot's share copy and features.

Check the vertical's frames, not just its duration:
- **Nothing clipped at 1080 px.** A landscape screenshot dropped into a 1000 px window keeps its right edge off screen: fire's first `brag-22s-vert` cut the spend rate to "$44,640.(" and the allocation legend. Scale the image so the content you show fits the width (measure its bounds in the source PNG), then look at the poster again.
- **Script-check the bounds.** Expose `window.bounds()` (every element's rect) from the composition and sample it at ~100 times across the spot: nothing outside 1080×1920, content reaching y≥1300, captions near y≈1650. bb-mcp and nitsuah-io verticals both used this.
- **Text must read at phone size.** A desktop screenshot scaled to 1000 px wide makes body text unreadable; crop to the column that matters or use the `-mobile` capture at 2×.
- **No dead bottom third.** Captions sitting mid-frame over an empty lower half read as unfinished (skyview `hero-30s-vert`). Move captions or the shot down, or scale the shot up.
- Reuse narration and music: `"synth": "<base spot>"` borrows its `synth.py`, `"narration"` mixes committed `vo/*.wav` (stash `promo/tts/`, vigil's `vigil-promo-tts` image). Commit the voice lines so a re-render needs no TTS.
- `build.sh --publish` may have no target for a `-vert` spot. Then do every step of [Publish to Pages](#publish-to-pages) by hand: copy `-web.mp4` and the poster into `pagesDir`, put it in the page's vertical slot and any feature section it leads (and OG/Twitter tags if it's the hero), set `published`, and add the spot id to each covered feature's `spots[]`.

Add it to spots.json with `"format": "vertical"`. Publishing to YouTube Shorts, Reels or TikTok is the user's action. Hand them the file and the share copy. Don't post.

## Publish to Pages

1. Copy `promo/out/<spot>/<spot>-web.mp4` and the poster to the Pages folder's assets (`pagesDir` in spots.json).
2. Update the page:
   - the hero is the hero reel or the best spot,
   - each feature section leads with its screenshot or spot, in FEATURES.md order,
   - the expand-kit `<script>` is present, primary images span the column, and galleries are no more than 2-up,
   - the "use it three ways" block (live app / clone / Claude skill or MCP) is current.
3. Check the page in the browser pane:
   - every image opens the viewer,
   - every video has the ⛶ button,
   - no horizontal scroll at 375 px.
4. One PR that contains the spot sources, spots.json, the page, and any README / FEATURES / CHANGELOG / TASKS edits. Docs close in the same PR, never in a follow-up.

## Logo and brand

`/promo logo` covers two cases:

- **Generate**: write 2–3 SVG options, a simple mark that reads at 16 px, using the app's existing palette. Show them to the user and let them pick. Save the pick as `brand/logo.svg`.
- **Propagate**: render every path in `brand.derived` from the source:
  - favicon / `app/icon.svg`,
  - PNG sizes (16/32/48/128/192/512) via `resvg` or Chromium in Docker,
  - the Pages favicon, the OG image, extension `icons/`.

Then **print `brand.manual`** with each URL, for example the Chrome Web Store dev console for ats-fill's listing icon. For every manual step, check whether it can be automated (a store API, a CI upload step). If it can, add a TASKS.md item in that repo and note it in the RSI log.

## RSI: finish every run with this

Append an entry to `~/code/stash/agent/prompts/PROMO.md` under **Run log**. Edit it in a stash worktree with its own PR, never in the shared checkout:

```markdown
### YYYY-MM-DD · <repo> · <mode>
- Ran: <spots / reel / publish / logo>, <tool>, <durations>
- Checklist misses: <which double-check items failed and how they were fixed>
- Friction: <what was slow, wrong or manual>
- Promote: <the fix that belongs upstream: vigil showcase.ts, STANDARD.md, this skill, or a repo TASK>
```

When the **Promote** line names something reusable, make that change this week:

- in vigil (detection or `apply`),
- in `nitsuah/.github/showcase/`,
- or in this skill: `nitsuah/.github/skills/promo/SKILL.md`, then copy it to `~/.claude/skills/promo/`.

If the same friction shows up twice in the log, it's a rule. Add it to the checklist above.
