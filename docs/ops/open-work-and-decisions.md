# Open work and decisions (Nov 28, 2026)

Austin-facing items. Secret *names* only.

## Verified live (Nov 28, ~4:08–4:11 AM ET)

- vigil.nitsuah.io: cookie and no-cookie 200 on `/`, `/login`, `/api/version` (commit `2bd8a954b294a8f51b2f55bcf218064b6a466dba`, includes #499 and #497). `/api/health` 200 `status=healthy`. Gemini configured. GitHub sign-in still `error=Configuration`. HSTS present.
- fire.nitsuah.io: `/` and `/api/health` 200; ebay/etsy/plaid/drive configured:true. Deletion challenge 200 on CF (same as lifefire.netlify.app). eBay portal move still unconfirmed. HSTS present.
- vhs.nitsuah.io and nitsuah.io: healthy 200s. HSTS on vhs.

## Still needs Austin

1. **GITHUB_SECRET** on Worker `gh-vigil` (GitHub sign-in is still Auth.js Configuration). Also unconfirmed on CF: **GITHUB_TOKEN**, **BYOK_ENCRYPTION_KEY**, **MCP_API_KEY**. **GEMINI_API_KEY** appears set.
2. Confirm the eBay developer portal Marketplace Account Deletion endpoint (and RuName auth-accepted URL) points at fire.nitsuah.io. CF already returns 200; portal registration is the remaining block on deleting Netlify `lifefire`.
3. Cloudflare API token with Workers Scripts:Edit on account `939d5eb9d2dcfb9b68bc3ccf74762bf6` for `vhsbox` and `gh-vigil`, stored as repo secret `CLOUDFLARE_API_TOKEN` (never paste in chat). vhs token exists but lacks access.
4. Re-auth the Cloudflare MCP connector (still `needsAuth`).
5. A GitHub token (or local `git mv`) with the `workflow` scope, to copy YAML from `.github` PR #434 (`qa/github-workflows/`) and vigil PR #581 (`docs/github-workflows/`) into `.github/workflows/`. #434 PR-size check is red (needs the size-override label or a split). #581 risk-guard is red until a CHANGELOG line or `no-changelog` label.
6. Approve deleting leftover Netlify sites, then downgrade team `nitsuah` to Free. **Downgrade expected around Dec 25, 2026.** gh-vigil Netlify builds are already skipped (vigil#565).
7. Decide: Workers Paid vs stay on Workers Free for vigil.
8. Find original **BYOK_ENCRYPTION_KEY** (vigil) and **SYNC_MASTER_KEY** (fire), or accept the data-loss fallback.
9. Decide keep or drop Etsy and Plaid on fire.
10. Approve deleting Neon branch `backup-pre-k4-tables-2026-11-20` on project `kryptos` when ready.
11. Confirm Google Drive callback `https://fire.nitsuah.io/api/backup/drive/callback` is on the Google OAuth client; confirm vhs Google OAuth is not still on vhsbox.netlify.app.

## Decentralization PRs (opened Nov 28, not merged)

- https://github.com/nitsuah/.github/pull/434 — weekly QA + 4-hourly uptime (YAML not in `.github/workflows/` yet)
- https://github.com/nitsuah/vigil/pull/581 — gated Cloudflare deploy workflow (YAML not in `.github/workflows/` yet)

The Grok Bot "Weekly QA + brand/link sweep" routine is **not** safe to delete until those workflows are installed and a run is green.
