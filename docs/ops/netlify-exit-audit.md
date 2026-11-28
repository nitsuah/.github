> **Later update (Saturday, Nov 28, 2026, America/New_York):** DNS cutovers for fire, vigil, vhs, and nitsuah.io have since happened. This document is the Nov 19 pre-cutover audit and recommended order. For current leftover-site recommendations, secret *names* still missing, and the Netlify Free downgrade around **Dec 25, 2026**, see `netlify-leftovers-and-cancel.md` (and, in-repo, `docs/ops/`). Do not treat the "no DNS cutovers" section below as a current constraint.

# Netlify exit audit — nitsuahlabs team

**Date:** Thursday, Nov 19, 2026 (America/New_York)  
**Scope:** All 9 Netlify sites on team `nitsuah` (nitsuahlabs@gmail.com).  
**Target preference:** Cloudflare Workers + Static Assets first; Cloudflare Pages only where already live; Vercel as fallback where already live.  
**Constraints honored:** no DNS changes, no Netlify deletions, no credit purchases, no secrets printed.

**Method:** Netlify MCP `get-projects` / `get-project` (forms flag only; MCP has no stop-builds or full build-settings dump); repo greps of `netlify.toml`, `netlify/functions`, `netlify/edge-functions`, `@netlify/*`, Identity, Blobs, Forms, scheduled functions; Cloudflare MCP read of Pages projects, Workers, and DNS on `nitsuah.io` + `darkmoon.dev`; Vercel MCP `list_projects` / `get_project` / `get_project_domain` on team `austin-hardys-projects`; live HTTP checks (status/server only).

**Cloudflare account:** `Nitsuahlabs@gmail.com's Account` (`939d5eb9d2dcfb9b68bc3ccf74762bf6`). Zones `nitsuah.io` and `darkmoon.dev` are active on the Free plan. Workers subdomain: `nitsuahlabs` (future previews would be `*.nitsuahlabs.workers.dev`). Existing Workers (`9router-relay`, `cloudflare-relay`, `cloudflare-relay-haunter`) are unrelated relays — none yet host these sites. No Worker custom domains are attached.

**Revisit of prior plan:** `/workspace/netlify-migration-plan.md` (Nov 17) said lifefire stays on Netlify and the move order is vhsbox → gh-vigil → nitsuah-io, with darkmoon/kryptos/arcade/pgfarms/skyviewd already retired in-repo. This audit keeps that move order for the three live apps, **but lifefire is no longer a “stay.”** It is last in the WSJF list because of OAuth/Plaid/eBay-compliance rework, not because it should remain on Netlify.

---

## Standing rules for any follow-up work

- **No DNS cutovers** (do not delete or retarget CNAMEs; do not attach Worker/Pages custom domains on apex or subdomains) without Austin’s go in Marketing chat.
- **No Netlify site deletions.** Disable / stop builds only, and only after nitsuahlabs OAuth is actually granted. Confirm later with Austin before deleting pgfarms or skyviewd.
- **No credit purchases / no auto-recharge.**
- Do not start new product work that overlaps rentals, leasing, or property management.

---

## Summary table

| Site | Primary URL | Custom domain still on Netlify? | Stack | Already elsewhere? | Rewrite | Recommended target |
|---|---|---|---|---|---|---|
| darkmoon-dev | https://darkmoon.dev | **No** — already CF Pages (proxied) | Vite SPA (`/workspace/repos/darkmoon`) | https://darkmoon.dev, https://darkmoon-dev.pages.dev | None | Retire Netlify shell (disable only) |
| kryptos-k4 | http://kryptos-k4.netlify.app (legacy) | **No** — https://kryptos.nitsuah.io already CF Pages (proxied) | Vite frontend; Python API on Render | https://kryptos.nitsuah.io, https://kryptos-k4.pages.dev; API https://kryptos-kg8t.onrender.com | None | Retire Netlify shell (disable only) |
| nitsuah-arcade | http://nitsuah-arcade.netlify.app (404) | **No** — https://arcade.nitsuah.io already Vercel (verified) | Next.js 16 in `app/` (`/workspace/repos/games`) | https://arcade.nitsuah.io | None | Retire Netlify shell (disable only) |
| pgfarms | http://pgfarms.netlify.app (404) | **No custom domain** | Next.js (`/workspace/repos/farm-3j`) | https://v0-farm-contact-website.vercel.app | None | Retire Netlify shell (disable only) |
| skyviewd | http://skyviewd.netlify.app | **No custom domain** (still live on Netlify) | Static marketing + Vite `/app` + 12 Netlify Functions, Blobs, cron | Showcase only: https://nitsuah.github.io/skyview/ | High (if kept) | **Retire** (disable + stop cron; do not rebuild) |
| vhsbox | https://vhs.nitsuah.io | **Yes** (grey-cloud CNAME → vhsbox.netlify.app) | Static SPA + Express via one Function | No | Medium | CF Workers + assets |
| nitsuah-io | https://nitsuah.io (+ www) | **Yes** (apex → Netlify load balancer; www → nitsuah-io.netlify.app) | Next.js 16 SSR + `sharp` + `src/proxy.ts` | Prior local attempt only (`nitsuah-io-cfwa`; no wrangler) | High | CF Workers + assets (OpenNext) |
| gh-vigil | https://vigil.nitsuah.io | **Yes** (grey-cloud CNAME → gh-vigil.netlify.app) | Next.js 16 App Router + Auth.js + Neon + AI | No | High | CF Workers + assets (OpenNext); Workers Paid likely |
| lifefire | https://fire.nitsuah.io | **Yes** (grey-cloud CNAME → lifefire.netlify.app) | Static `app/` + 9 Netlify Functions (eBay/Etsy/Plaid/CoinTracker/GDrive) | GitHub Pages docs: https://nitsuah.github.io/fire/ (not the app) | High | CF Workers + assets — **last**, after callback plan |

Forms are **not enabled** on any of the nine sites (Netlify MCP). No site uses Edge Functions or Image CDN. Netlify Identity is not in use (skyview removed it on Oct 14, 2026).

---

## WSJF-ordered move list

Cost of delay is mostly **Netlify credit drain** plus leftover risk (skyview cron, eBay endpoint still on a Netlify URL). Job size is rewrite + callback work. Easy / already-moved first; real rework flagged.

### 1. Disable already-moved Netlify shells — job size: None
**darkmoon-dev, kryptos-k4, nitsuah-arcade, pgfarms.** Custom domains already live elsewhere. Netlify `.app` hosts are 401/404 (or SSO-locked). In-repo `netlify.toml` already has `ignore = "exit 0"`. Action when nitsuahlabs OAuth is granted: `stop_builds=true` only. **Do not delete.** No DNS work.

### 2. Retire skyviewd — job size: Low (disable), High (if anyone rebuilds)
No custom domain. Marketing page still 200 on `skyviewd.netlify.app`. Uses Functions, Blobs, Stripe, Google OAuth, Neon, and a **daily scheduled function** `cron-cert-expiry` (`0 9 * * *` UTC). Showcase already on GitHub Pages. **Do not migrate.** Stop builds and disable/remove the scheduled function so it cannot keep burning credits. Confirm deletion with Austin later. Not a rentals/Inhabit overlap (drone booking), but do not start new skyview product work.

### 3. Move vhsbox — job size: Medium — first real migration
Smallest live app still on Netlify. Static `public/` + one Express Function (`serverless-http`). Target: Cloudflare Workers + assets. Needs a wrangler adapter, `nodejs_compat`, Neon via serverless driver, and Google/eBay OAuth callback updates on the workers.dev preview (production host can stay `vhs.nitsuah.io` until cutover). **DNS flip only after Austin’s go.**

### 4. Move gh-vigil — job size: High (flagged)
Next.js 16 + Auth.js (GitHub) + Neon + AI providers + webhook. Target: OpenNext on Workers + assets. Likely needs **Workers Paid** (bundle size). Callbacks: GitHub OAuth and webhook (host can stay `vigil.nitsuah.io` at cutover; workers.dev needs temporary callback URLs).

### 5. Move nitsuah-io (apex + www) — job size: High (flagged)
Portfolio, highest visibility, last of the original three-site plan. Next.js 16 SSR, CSP headers in `netlify.toml`, wagmi codegen at build, `sharp` image optimization, `src/proxy.ts`. Target: OpenNext on Workers + assets. Move CSP/headers into `next.config.js`. Replace `sharp` with unoptimized images or CF Image Transformations. Apex cutover is the riskiest DNS change — keep the Netlify site published for rollback. **DNS flip only after Austin’s go, low-traffic hour.**

### 6. Move lifefire — job size: High (flagged; was “stay,” now last not never)
Browser demo at `fire.nitsuah.io` is a static app plus many OAuth Functions. Rewritable as Workers + assets, but blocked on: **eBay marketplace account-deletion endpoint** (currently documented as `https://lifefire.netlify.app/api/sync/ebay/marketplace-account-deletion`), eBay/Etsy/CoinTracker/Google Drive redirect URIs, **Plaid (on hold)**, and `SYNC_MASTER_KEY` plus other secrets Austin must supply (never paste in chat). Do prep only after a callback cutover plan exists. Self-hosted Docker remains the primary “your data, your machine” path.

---

## Per-site details

### 1. lifefire

1. **Primary URL:** https://fire.nitsuah.io (200, Netlify). Also https://lifefire.netlify.app (200). **Custom domain still points at Netlify:** yes. CF DNS (DNS-only, unproxied): `fire.nitsuah.io` CNAME → `lifefire.netlify.app`.
2. **Netlify features:**
   - **Functions** (`netlify/functions`, esbuild):  
     `ebay-marketplace-account-deletion.mjs`, `ebay-authorize.mjs`, `ebay-callback.mjs`, `ebay-sync.mjs`, `ebay-status.mjs`, `plaid.mjs`, `etsy.mjs`, `cointracker.mjs`, `gdrive-backup.mjs`, `fire-api.mjs` (compat for remaining `/api/*`, including metals/prices/ENS).  
     Public paths rewritten in `netlify.toml`: `/api/sync/ebay/*`, `/api/sync/plaid/*`, `/api/sync/etsy/*`, `/api/sync/cointracker/*`, `/api/backup/drive`, `/api/*`.
   - Edge Functions: none. Forms: not enabled. Identity: none. Blobs: none. Image CDN: none. Scheduled/cron: none on Netlify (GitHub workflows only).
   - `netlify.toml`: publish `app`; `ignore` via `scripts/netlify-ignore.sh`; many forced 200 redirects to functions.
3. **Repo / stack:** `/workspace/repos/fire` (github.com/nitsuah/fire). Express app (`app/server.js`) for self-host/Docker; Netlify serves static `app/` plus Functions that wrap the same handlers. No Next/Vite build (`build` is a no-op).
4. **Already hosted elsewhere?** Docs/showcase: https://nitsuah.github.io/fire/. The live browser demo is only on Netlify.
5. **Rewrite effort: High.** Port the Function wrappers (or a single Worker router) onto Workers + assets; keep sealed-token browser flows; map redirects to Worker routes. Not a static-only lift because of OAuth and the eBay deletion challenge.
6. **Recommended target:** Cloudflare Workers + assets. (Vercel would also run the functions, but CF is preferred.)
7. **Blockers:** eBay marketplace account-deletion URL is registered with eBay (must be updated in lockstep, or keep a Netlify shim until eBay is updated). eBay/Etsy/CoinTracker/Google Drive redirect URIs. Plaid is on hold — do not re-enable as part of the move. Many secrets (`SYNC_MASTER_KEY`, `EBAY_*`, `ETSY_*`, `PLAID_*`, `GDRIVE_*`, `COINTRACKER_*`, etc. — names only; values never printed). Skip preview deploys until Austin provides secrets via `wrangler secret put` / a vault path, not chat.

### 2. nitsuah-io

1. **Primary URL:** https://nitsuah.io (200, Netlify). https://www.nitsuah.io 200-redirects to apex. https://nitsuah-io.netlify.app also 200. **Custom domain still points at Netlify:** yes. CF DNS (DNS-only, unproxied): apex CNAME → `apex-loadbalancer.netlify.com`; `www.nitsuah.io` CNAME → `nitsuah-io.netlify.app`. README mentions `dev.nitsuah.io`; **there is no `dev` record in the CF zone** (HTTPS fails). Stale doc, not a live staging host.
2. **Netlify features:** No `netlify/functions` or Edge Functions. Forms not enabled (a “Netlify Forms” mention in `src/lib/data/client-projects.ts` is copy about the old skyview client site, not a form on this site). Identity/Blobs/Image CDN: none. No scheduled functions.  
   `netlify.toml`: `next build`, publish `.next`, `NODE_VERSION=26.13.1`, production ignore-script, **CSP + security + cache headers**. No redirects besides comments. No `@netlify/plugin-nextjs` in package.json (Netlify still runs Next via publish `.next`).
3. **Repo / stack:** `/workspace/repos/nitsuah-io` (Nitsuah-Labs/nitsuah-io). Next.js ^16.4.5 + TypeScript, wagmi/ConnectKit, Spline, `sharp` ^0.35.5, `src/proxy.ts`, App Router pages (no conventional `/api/*` routes besides `src/app/sw.js/route.ts`). Optional `DATABASE_URL` in `.env.example` (commented).
4. **Already hosted elsewhere?** No production alternate. Local prior attempt: `/workspace/repos/nitsuah-io-cfwa` (same repo remote, Oct 25 vintage) — **no wrangler / OpenNext config present.**
5. **Rewrite effort: High.** OpenNext Cloudflare adapter; move CSP/headers out of `netlify.toml`; `sharp` will not run on Workers (set `images.unoptimized` or CF Image Transformations); honor Node 26.13.1 / wagmi build-time keys; replace `NETLIFY`/`CONTEXT` env checks; possible Workers Paid if the bundle exceeds the free 3 MB compressed limit.
6. **Recommended target:** Cloudflare Workers + assets (OpenNext). Vercel is a compatible fallback (Next.js native) if OpenNext/bundle/image issues block CF.
7. **Blockers:** Apex + www cutover visibility; `sharp` / image optimizer; build-time wagmi keys; bundle size / Workers Paid decision; no secrets should be copied in chat. `NEXT_PUBLIC_CF_BEACON_TOKEN` already in CSP — watch double-counting during a switch.

### 3. skyviewd

1. **Primary URL:** http://skyviewd.netlify.app — **currently 200** (README’s “site-not-found” is stale). **No custom domain** in CF zones. Pro plan (`nf_team_pro`).
2. **Netlify features:**
   - **Functions:** `api-jobs`, `api-bookings`, `api-portal`, `api-uploads`, `api-stripe-webhooks`, `api-operators`, `api-reviews`, `api-auth-google`, `api-auth`, `api-admin`, `api-notifications`, plus utils (`stripe`, `auth`, `scheduling`, `email`, `portal`, `db`, `booking-billing`, …).
   - **Blobs:** yes — `@netlify/blobs` in `api-uploads.mjs` (`operator-certs`, `deliverables` stores).
   - **Scheduled:** `cron-cert-expiry` daily `0 9 * * *` UTC (netlify.toml + function `config.schedule`). Warns/suspends operators on FAA cert expiry (Resend). **This can run even when production builds are ignored.**
   - Edge Functions: none. Forms: not enabled. **Identity: not in use** (removed Oct 14, 2026; Decap CMS `/admin` deleted; `/.netlify/identity` was 404). Image CDN: none.
   - `netlify.toml`: `ignore = "exit 0"` (retired Nov 2026), publish `dist`, SPA + page redirects, CSP headers (Stripe on `/app/*`).
3. **Repo / stack:** `/workspace/repos/skyview` (nitsuah/skyview). Static marketing site + Vite platform SPA at `/app`. Netlify Functions + Neon (`DATABASE_URL`) + Stripe Connect + Google OAuth + Resend.
4. **Already hosted elsewhere?** Showcase only: https://nitsuah.github.io/skyview/. No CF/Vercel app host.
5. **Rewrite effort: High** if kept (Functions → Workers, Blobs → R2, cron → Cron Trigger, Stripe webhook URL, Google OAuth, Neon). **Do not rewrite.**
6. **Recommended target:** **Retire (disable only).** Keep GitHub Pages showcase. Do not create a CF/Vercel project.
7. **Blockers for a move (if ever reversed):** Stripe webhooks, Google OAuth, Blobs data export, scheduled cert cron, Neon, secrets. For retirement: stop the scheduled function and builds; confirm deletion later with Austin.

### 4. darkmoon-dev

1. **Primary URL:** https://darkmoon.dev (200, Cloudflare). www also 200. **Custom domain does not point at Netlify.** CF DNS (proxied): apex + www CNAME → `darkmoon-dev.pages.dev`. Netlify still lists https://darkmoon.dev as the site’s primary URL, but live traffic is Pages. https://darkmoon-dev.netlify.app returns **401** (SSO locked). Pages preview: https://darkmoon-dev.pages.dev (latest production deploy succeeded Nov 18, 2026, 8:53 AM ET).
2. **Netlify features:** No Functions / Edge / Forms / Identity / Blobs / Image CDN / cron. `netlify.toml`: Vite `publish = "dist"`, SPA fallback `/* → /index.html`, `ignore = "exit 0"`.
3. **Repo / stack:** `/workspace/repos/darkmoon` (nitsuah/darkmoon). Vite + React SPA. Local/optional Express + Socket.IO server (`server/index.js`) is **not** what CF Pages serves (static only).
4. **Already hosted elsewhere?** Yes — CF Pages project `darkmoon-dev`, Git-connected to `nitsuah/darkmoon` (`main`). Domains: `darkmoon-dev.pages.dev`, `darkmoon.dev`, `www.darkmoon.dev`.
5. **Rewrite effort: None.**
6. **Recommended target:** Retire the Netlify shell (disable / stop builds only). Keep CF Pages.
7. **Blockers:** None for retirement. Do not flip DNS (already correct). SSO on the Netlify URL is expected.

### 5. gh-vigil

1. **Primary URL:** https://vigil.nitsuah.io (200, Netlify). https://gh-vigil.netlify.app also 200. **Custom domain still points at Netlify:** yes. CF DNS (DNS-only, unproxied): `vigil.nitsuah.io` CNAME → `gh-vigil.netlify.app`.
2. **Netlify features:** `@netlify/plugin-nextjs` in `netlify.toml` + package.json; `[functions] directory = "netlify/functions"` but **no `netlify/functions` directory in the repo** (old `/api/*` Function redirects were removed; App Router API routes are used instead). A leftover `/api/auth/*` 200 rewrite to itself is a no-op. Edge/Forms/Identity/Blobs/Image CDN/cron: none. Security headers in `netlify.toml`. Production ignore-script present; bot-branch ignore was planned but not required for this audit.
3. **Repo / stack:** `/workspace/repos/vigil` (nitsuah/vigil). Next.js 16.4.6 App Router, Auth.js/NextAuth (GitHub), Neon (`@neondatabase/serverless` / `DATABASE_URL`), Gemini/OpenAI/Anthropic, MCP endpoint, GitHub webhook, `proxy.ts`.
4. **Already hosted elsewhere?** No. Showcase: https://nitsuah.github.io/vigil/.
5. **Rewrite effort: High.** OpenNext on Workers; strip `@netlify/plugin-nextjs` and `NETLIFY_DATABASE_URL` fallback; confirm `proxy.ts` under OpenNext; watch Worker bundle size (free 3 MB vs paid 10 MB).
6. **Recommended target:** Cloudflare Workers + assets (OpenNext). Vercel is a reasonable fallback if OpenNext or size blocks CF.
7. **Blockers:** **Workers Paid ($5/mo) likely — Austin decision.** GitHub OAuth callback (`/api/auth/callback/github`) and GitHub webhook URL (production host unchanged at cutover; add workers.dev for tests). Many secrets (`NEXTAUTH_SECRET`, `GITHUB_*`, AI keys, `BYOK_ENCRYPTION_KEY`, `MCP_API_KEY`, … — names only). Long AI calls vs Worker CPU limits.

### 6. vhsbox

1. **Primary URL:** https://vhs.nitsuah.io (200, Netlify). https://vhsbox.netlify.app also 200. **Custom domain still points at Netlify:** yes. CF DNS (DNS-only, unproxied): `vhs.nitsuah.io` CNAME → `vhsbox.netlify.app`.
2. **Netlify features:**
   - **Functions:** `netlify/functions/server.js` — Express (`src/server.js`) wrapped with `serverless-http`, migrations bundled (`included_files = ["migrations/**"]`).
   - Redirects: `/api/*`, `/auth/*`, `/health` → function; `/c/*` → `/index.html` (SPA share links).
   - Edge/Forms/Identity/Blobs/Image CDN/cron: none.
3. **Repo / stack:** `/workspace/repos/vhs` (nitsuah/vhs). Static SPA in `public/` + Express + Neon Postgres. Optional eBay valuation + Google OAuth + JWT.
4. **Already hosted elsewhere?** No. GitHub Pages landing: https://nitsuah.github.io/vhs/ (not the app).
5. **Rewrite effort: Medium.** Add `wrangler.jsonc` with assets on `public/`, `run_worker_first` for `/api/*` `/auth/*` `/health`, `nodejs_compat`. Serve Express via Workers `node:http` / `httpServerHandler`, or port to Hono if Express misbehaves. **Do not import `src/modules/certs.js` in the Worker** (`child_process` + openssl + fs for local HTTPS CA). Keep migrations idempotent (cold start or deploy-time).
6. **Recommended target:** Cloudflare Workers + assets.
7. **Blockers:** Express-on-Workers compatibility; Google OAuth redirect URIs (and eBay RuName if used in prod); secrets (`DATABASE_URL`, `JWT_SECRET`, `GOOGLE_*`, `EBAY_*`, `OMDB_API_KEY`, `TMDB_KEY`, … — names only). No preview deploy until secrets are set out of band.

### 7. nitsuah-arcade

1. **Primary URL on Netlify:** http://nitsuah-arcade.netlify.app — **404**. Live app: **https://arcade.nitsuah.io** (200, Vercel). **Custom domain does not point at Netlify.** CF DNS (DNS-only): `arcade.nitsuah.io` CNAME → `7ca98e2f03e336c5.vercel-dns-017.com` (comment: “Vercel nitsuah-arcade”). Vercel domain `arcade.nitsuah.io` is **verified** on project `nitsuah-arcade`. SSO-locked `*.vercel.app` URLs are expected (protection = all except custom domains). Latest named production deploy in MCP was CANCELED; the custom domain itself is serving 200.
2. **Netlify features:** No Functions/Edge/Forms/Identity/Blobs/Image CDN/cron. `netlify.toml` still describes a Next.js build + `@netlify/plugin-nextjs` + headers, but `[build] ignore = "exit 0"`.
3. **Repo / stack:** `/workspace/repos/games` (nitsuah/games). Next.js 16.4.6 + R3F/Three in `app/`.
4. **Already hosted elsewhere?** Yes — Vercel project `nitsuah-arcade` (`prj_UsH7iTTFsgAss7mGbgrBGeLWfMhB`).
5. **Rewrite effort: None** (already off Netlify). A later CF move is optional and not required to exit Netlify.
6. **Recommended target:** Retire the Netlify shell (disable only). Keep Vercel.
7. **Blockers:** None for retirement. Do not change DNS.

### 8. kryptos-k4

1. **Primary URL on Netlify:** http://kryptos-k4.netlify.app — **404**. Live frontend: **https://kryptos.nitsuah.io** (200, Cloudflare) and https://kryptos-k4.pages.dev (200). **Custom domain does not point at Netlify.** CF DNS (proxied): `kryptos.nitsuah.io` CNAME → `kryptos-k4.pages.dev`. Latest Pages production deploy: Oct 25, 2026, 9:14 PM ET.
2. **Netlify features:** No Functions/Edge/Forms/Identity/Blobs/Image CDN/cron. `netlify.toml`: Vite `frontend` → `dist`, `VITE_API_BASE_URL = https://kryptos-kg8t.onrender.com`, `ignore = "exit 0"`.
3. **Repo / stack:** `/workspace/repos/kryptos` (nitsuah/kryptos). Vite frontend + Python API.
4. **Already hosted elsewhere?** Yes — CF Pages project `kryptos-k4` (Git-connected to `nitsuah/kryptos`). Backend stays on Render free-tier `kryptos-api`: https://kryptos-kg8t.onrender.com (200). CORS is already pointed at the Pages origin.
5. **Rewrite effort: None** for leaving Netlify.
6. **Recommended target:** Retire the Netlify shell (disable only). Keep CF Pages + Render API.
7. **Blockers:** None for retirement. Do not change DNS. (A later API move off Render is out of scope.)

### 9. pgfarms

1. **Primary URL on Netlify:** http://pgfarms.netlify.app — **404**. **No custom domain.** Live app: **https://v0-farm-contact-website.vercel.app** (200, Vercel). SSO-locked `pgfarms-*.vercel.app` URLs exist; the `v0-farm-contact-website.vercel.app` alias is the public one.
2. **Netlify features:** No Functions/Edge/Forms/Identity/Blobs/Image CDN/cron. `netlify.toml` is only `[build] ignore = "exit 0"`.
3. **Repo / stack:** `/workspace/repos/farm-3j` (nitsuah/farm-3j). Next.js site/game with API routes `/api/contact`, `/api/saves`, `/api/highscores`. Contact delivery uses `FARM_CONTACT_WEBHOOK_URL` when set (already on Vercel).
4. **Already hosted elsewhere?** Yes — Vercel project `pgfarms` (`prj_6kJtjKJlKxLa7vJiuvJTdYRhqfwN`), domain `v0-farm-contact-website.vercel.app`.
5. **Rewrite effort: None.**
6. **Recommended target:** Retire the Netlify shell (disable only). Keep Vercel. No CF project needed.
7. **Blockers:** None for retirement. Confirm later with Austin before any Netlify deletion. No farm custom domain on `nitsuah.io` today.

---

## Prep done vs blocked

### Already in place (no new prep this audit; nothing created or changed)

| Host | Project | Preview / production URL |
|---|---|---|
| CF Pages | `darkmoon-dev` (Git: nitsuah/darkmoon) | https://darkmoon-dev.pages.dev and https://darkmoon.dev |
| CF Pages | `kryptos-k4` (Git: nitsuah/kryptos) | https://kryptos-k4.pages.dev and https://kryptos.nitsuah.io |
| Vercel | `nitsuah-arcade` | https://arcade.nitsuah.io (verified) |
| Vercel | `pgfarms` | https://v0-farm-contact-website.vercel.app |

### Not done (blocked or intentionally skipped — low-risk rule)

- **No new Cloudflare Pages or Workers projects** were created.
- **No preview deploys** for vhsbox, gh-vigil, nitsuah-io, or lifefire: each needs a wrangler/OpenNext adapter, and production secrets Austin has not provided out of band. A secret-less preview would be an incomplete stub, not a real smoke test.
- **skyviewd / pgfarms / already-moved shells:** no new hosts. Retirement only.
- **nitsuah-io-cfwa** is not a usable CF starter (no wrangler/OpenNext files).
- **Netlify `stop_builds` / preview-off settings** were not applied here. The nitsuahlabs CLI OAuth card is still required (a prior approval landed on the wrong account, ajhardy4@vt.edu). In-repo `ignore = "exit 0"` already covers the four retired shells + skyviewd, but **skyview’s scheduled function is independent of that ignore** and should be disabled once OAuth is on the right team.
- **DNS was read only.** No records created, edited, proxied, or deleted.

---

## Explicit: no DNS cutovers / no deletions without Austin

This document is an audit and a recommended order only.

- Do **not** change Cloudflare DNS (`nitsuah.io` or `darkmoon.dev`).
- Do **not** attach Worker or Pages custom domains for fire / vhs / vigil / nitsuah.io (apex or www).
- Do **not** delete any Netlify site, including pgfarms and skyviewd.
- Do **not** buy Netlify credits or enable auto-recharge.
- After a future approved cutover, leave the Netlify site published for rollback, then stop builds only. Deletion is a separate Austin decision.
