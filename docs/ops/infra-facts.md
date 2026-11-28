# Infra facts (Marketing state, Nov 28, 2026)

Secret *names* only appear in this tree. No values, no connection strings, no tokens.

## Cloudflare

- Account: `Nitsuahlabs@gmail.com's Account` (`939d5eb9d2dcfb9b68bc3ccf74762bf6`)
- Workers subdomain: `nitsuahlabs` (`*.nitsuahlabs.workers.dev`)
- Zones: `nitsuah.io` and `darkmoon.dev` (Cloudflare NS). Zone id for nitsuah.io: `ec17394ebc16cfc3f2ce1c6bc6ba25c6`.

### Live custom-domain mapping

| Host | Cloudflare project / worker | Kind |
|---|---|---|
| fire.nitsuah.io | Pages `lifefire` | Cloudflare Pages |
| vigil.nitsuah.io | Worker `gh-vigil` | Cloudflare Worker + static assets |
| vhs.nitsuah.io | Worker `vhsbox` | Cloudflare Worker |
| nitsuah.io + www | Pages `nitsuah-io` | Cloudflare Pages |
| kryptos.nitsuah.io | Pages `kryptos-k4` | Cloudflare Pages |
| darkmoon.dev | Pages `darkmoon-dev` | Cloudflare Pages |
| arcade.nitsuah.io | (Vercel `nitsuah-arcade`, not CF) | Vercel |

### DNS rollback record ids (nitsuah.io zone `ec17394ebc16cfc3f2ce1c6bc6ba25c6`)

From `/workspace/netlify-migration-plan.md`. Rollback is a last-resort DNS retarget; do not apply unless production on CF is down.

| Record / object | Id | Rollback action |
|---|---|---|
| fire.nitsuah.io DNS | `c9fe5fa90a928a619705007965b6f0a2` | CNAME back to `lifefire.netlify.app`, DNS-only |
| nitsuah.io (apex) DNS | `e7639c29818b0e8dd9859a2a4c9e50ce` | see migration plan |
| www.nitsuah.io DNS | `6eff52dd9c93690e11824d860d9b8c61` | see migration plan |
| vigil Worker custom domain | `66baf1f01495ec517e737ad509eb8fbaedddb43e` | detach / restore per plan |

## Neon (nitsuahlabs org `org-ancient-voice-10866215`)

Endpoints are named only (no connection strings).

| Project name | Project id | Default / primary endpoint name | Notes |
|---|---|---|---|
| overseer | `muddy-block-34799027` | `ep-noisy-morning-aecfq5ur` | Vigil production DB. Not tied to Netlify. |
| moneymakers | `divine-surf-90579532` | `ep-jolly-hat-b73w51ku` (branch `main` / `br-holy-glade-b7wale1h`) | Shared agent state. Marketing backup lives in existing `agents`, `agent_notes`, `tasks`, `apps`, `ops_log`. Snapshot branch: `backup-pre-marketing-state-2026-11-28` (`br-small-band-b7tifcq1`). |
| vhs | `late-surf-78805664` | `ep-calm-term-at6b9di6` | |
| kryptos | `nameless-morning-02056417` | `ep-patient-lake-apz2nfg4` | Leftover safety branch `backup-pre-k4-tables-2026-11-20` (`br-holy-cell-apmk92jb`) — do not delete without Austin. |
| motor-pool | `jolly-dew-40713231` | `ep-sweet-bonus-atryjsfl` | |
| skyview | `polished-cake-80668411` | `ep-tiny-bird-axldnm44` | |

## CI / deploy notes

- user-Cloudflare MCP was `needsAuth` as of Nov 28, so agents cannot list or set Pages/Worker env or deploy from the connector.
- nitsuah/vhs already has a gated Deploy workflow (merged #208 / skip-if-missing #235). Runs fail with Cloudflare API "No access to the specified service" for `vhsbox` — the token is present but lacks Workers Scripts:Edit on the nitsuahlabs account, or is on the wrong account. Live vhs.nitsuah.io was still healthy.
- nitsuah/vigil Deploy workflow is in PR #581 as `docs/github-workflows/deploy.yml` (cannot push `.github/workflows/*` with the current GitHub OAuth token; it lacks the `workflow` scope). Gated: skip green if `CLOUDFLARE_API_TOKEN` is missing.
- Weekly QA + 4-hourly uptime workflows are in nitsuah/.github PR #434 under `qa/github-workflows/`. Same workflow-scope install step is required before crons run. Do not delete the Grok "Weekly QA + brand/link sweep" routine until a workflow-scoped install has had a green run.
