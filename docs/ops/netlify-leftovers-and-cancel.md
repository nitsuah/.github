# Netlify leftovers + plan-cancel steps

**Updated:** Saturday, Nov 28, 2026, ~4:20 AM ET (America/New_York)  
**Original audit write-up:** Nov 25, 2026, ~1:20 AM ET

Team `nitsuah` (61870aca311dd3f2cf3ae0ad). Both Netlify connectors listed the same 7 sites on Nov 25. Nothing has been deleted (agents will not delete without Austin's OK).

DNS check (1.1.1.1 DoH, Nov 25 and rechecked Nov 28): nitsuah.io + darkmoon.dev zones are on Cloudflare NS (everton/gigi). Every custom host (nitsuah.io, www, fire, vigil, vhs, kryptos, darkmoon.dev, www.darkmoon.dev) resolves to Cloudflare proxy IPs and answers `server: cloudflare` with no `x-nf-request-id`. arcade.nitsuah.io -> Vercel. No DNS record points at Netlify.

## Current status (Nov 28)

- Custom domains are served by Cloudflare (or Vercel for arcade). The remaining Netlify sites are leftovers / rollback / masked-secret copies.
- **vigil cookie-500 is fixed and live.** vigil#499 (OpenNext cookie pin) and vigil#497 (HSTS) are on production `vigil.nitsuah.io` at commit `2bd8a954b294a8f51b2f55bcf218064b6a466dba`. Cookie and no-cookie requests to `/`, `/login`, and `/api/*` return 200, not CF 1101.
- **gh-vigil Netlify builds are skipped** as of vigil PR #565. The Netlify rollback copy at gh-vigil.netlify.app will go stale; do not treat it as a current prod mirror.
- **fire.nitsuah.io eBay Marketplace Account Deletion** now returns 200 with a `challengeResponse` (same response as lifefire.netlify.app), so the verification token and endpoint URL env appear present on Cloudflare. The eBay developer portal registration is still unconfirmed — confirm it points at `https://fire.nitsuah.io/api/sync/ebay/marketplace-account-deletion` before deleting lifefire.
- **Netlify team downgrade to Free is expected around Dec 25, 2026** (not Dec 24). Complete the verify + approved deletes + plan change before then if you still want a clean cutoff; otherwise the team should land on Free around that date anyway.

## Leftover sites

| Site | Netlify URL | Custom domain now served by | Still depended on? | Recommendation |
|---|---|---|---|---|
| lifefire | lifefire.netlify.app | fire.nitsuah.io -> CF Pages `lifefire` | **YES until the eBay portal is confirmed.** CF copy of the deletion endpoint answers 200. Masked prod secret names that lived here: EBAY_CLIENT_SECRET, ETSY_SHARED_SECRET, GDRIVE_CLIENT_SECRET, EBAY_VERIFICATION_TOKEN (public fire health now reports ebay/etsy/plaid/drive configured — values were never copied by agents). | KEEP until Austin confirms the eBay portal points at fire.nitsuah.io and the challenge still passes; then delete |
| gh-vigil | gh-vigil.netlify.app | vigil.nitsuah.io -> CF Worker `gh-vigil` | Cookie-crash fix is already live. Masked secret names that lived here: GITHUB_SECRET, GITHUB_TOKEN, GEMINI_API_KEY, BYOK_ENCRYPTION_KEY, MCP_API_KEY. GEMINI_API_KEY appears set on CF (public `/api/health` gemini configured:true). GITHUB_SECRET is still missing (GitHub sign-in returns Auth.js `error=Configuration`). GITHUB_TOKEN, BYOK_ENCRYPTION_KEY, and MCP_API_KEY are unconfirmed from public endpoints. Neon DB is NOT tied to Netlify: project `overseer` (`muddy-block-34799027`, endpoint name `ep-noisy-morning`) is owned by the nitsuahlabs Neon org. Netlify builds are skipped (vigil#565), so this copy will go stale. | KEEP until remaining vigil secrets are on CF (at least GITHUB_SECRET, confirmed by a working GitHub sign-in) and Austin is ready to give up the masked-secret / rollback copy; then delete |
| nitsuah-io | nitsuah-io.netlify.app | nitsuah.io -> CF Pages `nitsuah-io` (since Nov 19) | No (builds stopped) | DELETE (needs Austin's OK) |
| vhsbox | vhsbox.netlify.app | vhs.nitsuah.io -> CF Worker `vhsbox` (since Nov 19) | No (builds stopped). Google OAuth for vhs should use vhs.nitsuah.io (same host); confirm the Google client if a leftover callback still lists vhsbox.netlify.app | DELETE (needs Austin's OK) |
| darkmoon-dev | darkmoon-dev.netlify.app (SSO-locked) | darkmoon.dev -> CF Pages | No. Only a stale CORS allowlist entry in darkmoon `server/cors.js`/`render.yaml` | DELETE (needs Austin's OK) |
| kryptos-k4 | kryptos-k4.netlify.app (SSO-locked) | kryptos.nitsuah.io -> CF Pages | No. Only a stale CORS entry in kryptos `render.yaml` + `app.py` | DELETE (needs Austin's OK) |
| nitsuah-arcade | nitsuah-arcade.netlify.app (SSO-locked, 404) | arcade.nitsuah.io -> Vercel | No | DELETE (needs Austin's OK) |

Other "something still points at Netlify" checks
- OAuth callbacks: vigil GitHub OAuth = https://vigil.nitsuah.io/api/auth/callback/github (same host, unchanged). fire Etsy = https://fire.nitsuah.io/api/sync/etsy/callback (verified in the live authorize redirect). CoinTracker = dynamic client registration with fire.nitsuah.io. fire Google Drive derives https://fire.nitsuah.io/api/backup/drive/callback; Austin should confirm that URI is on the Google OAuth client (old docs mention the lifefire.netlify.app callback). eBay uses a RuName (`Austin_Hardy-AustinHa-lifefi-…`); its "auth accepted URL" in the eBay portal may still be lifefire.netlify.app — check.
- Webhooks: vigil `/api/webhooks/github` is behind the login redirect on both hosts (pre-existing), host unchanged.
- Routines: stash#426 (merged) moved routines to vigil.nitsuah.io. Austin's local Claude Code MCP registration may still use gh-vigil.netlify.app (`claude mcp add ... https://vigil.nitsuah.io/api/mcp`).

## Netlify plan-cancel steps (do in order)

Verify first
1. fire: eBay portal endpoint moved to https://fire.nitsuah.io/api/sync/ebay/marketplace-account-deletion and eBay shows it verified. `curl "https://fire.nitsuah.io/api/sync/ebay/marketplace-account-deletion?challenge_code=x"` already returns 200 `{"challengeResponse":...}` on CF as of Nov 28; portal confirmation is the remaining step.
2. fire + vigil: remaining secrets are set on Cloudflare (from provider consoles). fire public health already reports ebay/etsy/plaid/drive configured. vigil GitHub sign-in must work on the custom domain (currently blocked on missing GITHUB_SECRET).
3. vigil: fix PR #499 is already deployed (`curl -H 'cookie: a=b' https://vigil.nitsuah.io/` returns 200). This step is done.
4. Nothing serves from Netlify: `curl -sI https://<host>/ | grep -i x-nf-request-id` is empty for every custom host. (True as of Nov 25/28.)
5. Approve deletions (Netlify > Projects > <site> > Project configuration > General > Danger zone > Delete project). Agents won't delete without your OK. Safe-to-delete after the verify steps: nitsuah-io, vhsbox, darkmoon-dev, kryptos-k4, nitsuah-arcade. Keep lifefire until the eBay portal is confirmed; keep gh-vigil until remaining vigil secrets are on CF.
Then cancel
6. app.netlify.com > team `nitsuah` > Team settings (or Billing) > Subscription/Plan > Change plan > choose Free (Starter) / Downgrade, confirm. If the team should go entirely: Team settings > General > Danger zone > Delete team (only after all sites are deleted).
7. Remove the saved payment method under Billing if you don't want it on file, and disconnect the Netlify GitHub app from nitsuah + Nitsuah-Labs (GitHub > Settings > Applications > Installed GitHub Apps > Netlify > Uninstall) after the sites are gone.

**Timing:** Netlify downgrades the team to Free around **Dec 25, 2026**. Finish the verify + approved deletes + plan change before then if you want a clean cutoff. Do not wait on a Dec 24 date from the Nov 25 draft of this doc.
