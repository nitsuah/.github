---
name: promo
description: Keep a repo's screenshots, videos, diagrams, GitHub Pages site and branding in lockstep with its FEATURES.md, and wrap /brag and /brag-slim so launch videos come out as reusable 21-second feature spots that combine into a hero/YouTube reel. Use when someone says "/promo", "refresh the promo", "update the github page", "brag about <feature>", "make a reel", "vertical short", "the screenshots are stale", or "update the logo/favicon everywhere".
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
| `spot <feature or category>` | One 21 s spot for one feature group, via /brag or /brag-slim |
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
4. **Cull the feature list before mapping anything.** FEATURES.md usually over-reports (vigil: 201 bullets, 57 user-visible). A feature gets a visual only when a user can see it or do it: a screen, a button, a CLI or MCP response. Mark it `"visual": "none"` when it is:
   - an implementation detail (caching, TTLs, env vars, logging, parsers, DB batching, CSS tweaks, error plumbing),
   - one item of a list that a parent check already covers (each doc type, each community standard, each best practice),
   - tech stack or deployment,
   - a duplicate of a feature in another category (AI/market-trend recaps),
   - a process or marketing statement ("quarterly review"),
   - not shipped, or claimed but missing in code (grep for it).

   Don't delete FEATURES.md lines yourself. List proposed trims in the PR for the user to confirm. If more than about 40% are `none`, say FEATURES.md over-reports.

## Screenshots and diagrams (CI)

Screenshots and diagrams are CI's job. If the repo has no `.github/workflows/visual-docs.yml`, adopt the recipe from vigil's [docs/VISUAL_DOCS.md](https://github.com/nitsuah/vigil/blob/main/docs/VISUAL_DOCS.md) rather than taking screenshots by hand:

- Use mocked APIs, a frozen clock, a fixed viewport, and demo data only.
- Name each screenshot after the feature id in spots.json (`docs/screenshots/<feature-id>.png`). The audit can then match them without anyone editing paths.
- **If the repo has nightly journeys** ([journeys/STANDARD.md](https://github.com/nitsuah/.github/blob/main/journeys/STANDARD.md)), don't add a second suite. Tag journey steps `{ docs: '<feature id>' }`, add a `capture:screenshots` script (`DOCS_SCREENSHOTS=docs/screenshots … --ignore-snapshots`), and copy fire's `visual-docs.yml`. The journeys already have the seed, mocks and frozen clock.
- A system with several moving parts (services, MCP, cron, an extension talking to a backend) gets a `docs/diagrams/<name>.mmd`. A diagram explains a flow faster than a video does.

## Spots (video, local only)

**One spot = one feature category or one idea, about 12–21 s.** Don't make one video that tries to cover everything. When FEATURES.md has more categories than one spot can carry, plan several spots plus one hero cut.

**Feature spots don't share an intro or outro.** Each spot plays only its own scenes: wordmark on screen from frame 0 (no question-hook-plus-reveal preamble), outro of 3 s or less, natural length (don't stretch to 21). The shared hook, reveal and full outro belong once, in the hero. Check it with a same-timestamp frame grid across the spots (frames at 1.5, 5, 9, 15 s, one row per spot). If two rows match for more than ~3 s, the spots will read as one video in a gallery. vigil's first run failed this: 10 of 21 s were identical in every spot.

1. **Plan the spot list from spots.json.**
   - Each category with no spot, or whose features changed after the spot's `rendered` date, needs one.
   - Show the user the list (id, features covered, seconds, tool) and get an OK before rendering more than one. If the user already asked for the full run, post the list and go on.
2. **Choose the engine.**
   - The repo has `promo/build.sh` (fire, vigil): use it. It's reproducible and runs in Docker. Don't copy `compose.html`/`synth.py` per spot. Reuse one composition: vigil's spots set `"base": "brag-30s"` in `spot.json` and list a subset of its scenes with their own times; each scene's motion and sound cues are time-mapped into the slot. A new cut is then `spot.json` + `share-copy.txt`. Port that (`promo/spot-config.js`, the `T(id)` blocks in compose, `cue()` in synth) before adding a second spot to a repo whose compose is one long timeline.
   - Check stills with a contact sheet when the repo has `promo/sheet.sh` (vigil): `promo/sheet.sh <spot>` tiles them into one image, which is cheaper to review. Without it, still pull and look at at least four stills one by one before calling the render done.
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
   - [ ] Numbers agree across scenes: the same net worth, total or count wherever it appears (UI vs MCP/CLI output). A mismatch is a product bug: file it, don't hide it in the edit (fire#178).
   - [ ] What the seed should show actually renders (history charts, lists). An API seed can drop server-owned fields (fire#174).
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
