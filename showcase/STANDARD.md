# Visual showcase standard

How every nitsuah repo shows what it does: **screenshots**, **videos** and **diagrams**, kept in lockstep with `FEATURES.md` and published to the README and the GitHub Pages site.

- **This file** is the contract.
- **[vigil](https://github.com/nitsuah/vigil)** detects drift against it and applies the mechanical parts (`npm run showcase -- audit|apply`, see [vigil docs/VISUAL_DOCS.md](https://github.com/nitsuah/vigil/blob/main/docs/VISUAL_DOCS.md)).
- **`/promo`** ([skill](../skills/promo/SKILL.md)) runs the whole loop by hand, including the parts CI can't do (video).

Index of everything this covers: the [profile README](../profile/README.md) (one row per project: **▶ LIVE** is the deployed app, **▣ PAGE** is the Pages site) and [nitsuah.io](https://nitsuah-labs.github.io/nitsuah-io/).

## The three elements

| Element | Built by | Lives in | Shown in | Fresh when |
|---|---|---|---|---|
| **Screenshots** | CI: `.github/workflows/visual-docs.yml` (Playwright, mocked data, frozen clock) | `docs/screenshots/*.png` | README `visual-docs` block, Pages feature sections | every push to `main` that changes the UI |
| **Diagrams** | CI: same workflow renders `docs/diagrams/*.mmd` with mermaid-cli | `docs/diagrams/*.{mmd,svg}` | README `visual-docs` block, Pages "how it works" | every push that changes a `.mmd` |
| **Videos** | **Local only**: `/promo` → `/brag` or `/brag-slim`, or the repo's `promo/build.sh` (ffmpeg + Chromium in Docker) | sources in `promo/<spot>/`, renders in `promo/out/` (gitignored), published copy in the Pages assets folder | Pages hero + feature sections, README link | after a big feature lands. `promo/spots.json` records what each spot covers and when it was rendered |

Videos stay local on purpose. GitHub runners can run ffmpeg, but brag renders need a model in the loop and minutes of headless Chromium. What CI *can* check is drift: vigil flags a spot whose features changed after `rendered`.

## FEATURES.md is the backbone

`FEATURES.md` (root or `docs/`) lists features as `### <emoji> Category` headings with `- **Name**: description` bullets. That list drives everything else:

1. **`promo/spots.json`** maps each feature to its screenshots and video spots. `vigil showcase apply` scaffolds it from FEATURES.md. You fill in the paths.
2. Pages feature sections follow FEATURES.md categories, in the same order.
3. `/brag` gets a spot brief per category, not the whole repo at once.

A feature without a screenshot or spot shows up as a gap in `vigil showcase audit`. Close it, or mark it `"visual": "none"` when it has nothing to show (a privacy guarantee, an internal-only flag; a CLI command whose output a user reads is visual). Cull first: a feature gets a visual only when a user can see it or do it. Implementation details, items of a list a parent check covers, tech stack, cross-category duplicates, process statements and unshipped claims are `none`. On vigil's first run that was 144 of 201 bullets. Report the coverage as visuals over *visual* features (36/57), not over all bullets.

## Video spots

- **Default length: 21 s.** One spot covers one feature category, or one hero idea. Name it `<topic>-<seconds>s` (`fill-21s`, `chaos-24s`).
- **Hero / YouTube cut = a reel.** `reels[]` in spots.json lists spots in order. `/promo reel` concatenates them with ffmpeg in Docker (same codec settings, 0.3 s crossfade), so a long video never needs one giant brag run.
- **Vertical (Shorts / Reels / TikTok):** render a spot with `--format vertical --voice`. It goes in `promo/<spot>-vert/` and is listed under `spots[]` with `"format": "vertical"`.
- Every spot ships `<spot>.mp4`, a poster `.jpg` (frame 0 = poster), a `-web.mp4` cut for Pages (CRF ≈ 27), and `share-copy.txt`.
- **Demo data only.** Seed fictional data (see fire's `promo/demo-seed.js`, vigil's `promo/demo-seed.ts`). Never record a real account, inbox or portfolio.

### `promo/spots.json`

```jsonc
{
  "product": "fire",
  "live": "https://lifefire.netlify.app/",          // deployed app (▶ LIVE), or null
  "page": "https://nitsuah.github.io/fire/",        // Pages site (▣ PAGE), or null
  "pagesDir": "site",                               // folder the Pages workflow uploads
  "features": [
    { "id": "projections", "title": "Scenario projections", "category": "Planning",
      "screenshots": ["site/assets/proj-base.webp"], "spots": ["brag-22s"] },
    { "id": "local-only", "title": "Local-first data", "category": "Privacy", "visual": "none" }
  ],
  "spots": [
    { "id": "brag-22s", "seconds": 22, "format": "landscape", "tool": "promo/build.sh",
      "features": ["dashboard", "projections"], "published": "site/assets/fire-tracker.mp4",
      "rendered": "2026-09-27" }
  ],
  "reels": [ { "id": "hero", "spots": ["brag-22s", "chaos-24s"], "published": null } ],
  "brand": {
    "source": "brand/logo.svg",
    "derived": ["app/icon.svg", "site/favicon.svg"],
    "manual": [ { "what": "Chrome Web Store icon", "url": "https://chrome.google.com/webstore/devconsole" } ]
  }
}
```

The template is [`templates/spots.json`](./templates/spots.json).

## GitHub Pages contract

Every Pages site (`site/` preferred, deployed by `.github/workflows/pages.yml` on pushes to that folder) has:

1. **The expand kit.** Put this in `<head>`:

   ```html
   <script src="https://cdn.jsdelivr.net/gh/nitsuah/.github@main/showcase/expand.js" defer></script>
   ```

   - Images ≥ 160 px become click-to-expand: fullscreen viewer, ←/→ between images, Esc or click to exit.
   - Every `<video>` gets a ⛶ fullscreen button.
   - `data-no-expand` opts an element and everything inside it out. `data-no-expand="images"` opts out images only and keeps the video buttons. Use `<html data-no-expand="images">` on a site that already has its own lightbox (fire does).
   - `data-full="big.png"` serves a larger file in the viewer.
   - Changes to `expand.js` reach every site within jsDelivr's cache window (≤ 12 h). Purge with `https://purge.jsdelivr.net/gh/nitsuah/.github@main/showcase/expand.js`.
2. **Big images.**
   - Primary screenshots span the content column, at least 720 px wide on desktop.
   - Galleries are at most 2-up on desktop and 1-up under 720 px.
   - No thumbnail grids. Thumbnails are what the expand viewer is for.
3. **A hero video** with `poster`, `muted loop playsinline`, `preload="metadata"` and an `aria-label` that gives its length. If it autoplays, it needs a way to pause it, either `controls` or the site's own pause button (WCAG 2.2.2).
4. **Feature sections in FEATURES.md order.** Each one leads with its screenshot or spot.
5. **"Use it three ways"**, whichever apply:
   - **Run it**: the deployed app (▶ LIVE).
   - **Clone it**: the README quick start.
   - **Use it from Claude**: the repo's Claude Code skill or MCP server.
6. **OG / Twitter tags** pointing at the poster and the web cut. Use absolute URLs. Relative ones don't unfurl.
7. **Links back** to README, FEATURES, ROADMAP and CHANGELOG.

Start from [`templates/page-skeleton.html`](./templates/page-skeleton.html) for a new site. Existing sites keep their own design and only need items 1–7.

**Republish triggers.** The Pages workflow runs on a push to the site folder, so any of these needs a commit there:

- a frontend change that alters a screenshot,
- a new or re-rendered spot (`/promo publish` copies it),
- a FEATURES.md change that adds or renames a category.

## Brand assets

- One source logo: `brand/logo.svg`, or the app's existing icon if it already has one.
- Every derived copy goes in `spots.json` → `brand.derived`: favicon, PWA icons, extension icons, Pages favicon, OG image.
- A step that can't be automated (a store listing icon, a third-party dashboard) goes in `brand.manual` with the URL to do it. `/promo logo` prints that list after every logo change. Turning a manual step into CI is a standing RSI item.

## Improving this (RSI)

Each `/promo` or `/brag` run appends a short entry to [`stash/agent/prompts/PROMO.md`](https://github.com/nitsuah/stash/blob/main/agent/prompts/PROMO.md): what ran, what broke, what you changed. A fix that would help the next repo lands in **vigil** (detection or `apply`) or in **this file** in the same week, not in the one repo where you hit it.
