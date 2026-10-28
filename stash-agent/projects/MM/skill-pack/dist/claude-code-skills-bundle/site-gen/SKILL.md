---
name: site-gen
description: B2B website generation pipeline — discover local businesses without websites, generate AI-personalized pitch decks + cold emails, build and deploy polished industry-specific static sites to Netlify. Handles the full sales cycle: lead discovery → pitch → site build → deployment → invoice. Use when asked to find clients, build a website for a local business, generate a pitch, or run the full B2B web agency workflow.
user_invocable: true
---

# /site-gen — B2B Website Generation Pipeline

End-to-end tool for running a micro web agency targeting local businesses.

## Requires
`agent-board` repo at `~/code\agent-board` on `main` (or the feature branch merged to main).
The Docker compose file and tool source both live there.

## Backend
The `website` MCP server runs at **http://localhost:3201** as a Docker container
in the `agent-board` tools stack. Source: `~/code\agent-board\tools\website\`

**Start:**
```powershell
docker compose -f "~/code\agent-board\config\docker-compose.yml" --profile tools up tool-website -d
```

**Stop:**
```powershell
docker compose -f "~/code\agent-board\config\docker-compose.yml" --profile tools stop tool-website
```

**Logs:**
```powershell
docker compose -f "~/code\agent-board\config\docker-compose.yml" logs -f tool-website
```

**Netlify auth** (one-time): add `NETLIFY_AUTH_TOKEN` to `agent-board/.env`.
Get your token at https://app.netlify.com/user/applications#personal-access-tokens

## Pricing model (reference throughout)
- **Starter**: $500 one-time + $50/month (default pitch)
- **Growth**: $900 one-time + $100/month
- **Premium**: $1,500 one-time + $200/month
- See `read_template` tool with `service-packages` for full details

## Commands

| Command | What it does |
|---------|-------------|
| `/site-gen discover <zip> [category]` | Find local businesses near a ZIP code |
| `/site-gen pitch <slug>` | Generate pitch deck + cold email for a lead |
| `/site-gen build <slug>` | Build a full website for a client |
| `/site-gen deploy <slug>` | Deploy site to Netlify |
| `/site-gen invoice <slug> [amount]` | Generate a client invoice |
| `/site-gen full <zip> [category]` | End-to-end: discover → pitch top leads → build → deploy |

If no subcommand is provided, prompt the user: "Which workflow? discover / pitch / build / deploy / invoice / full"

## MCP tools available (http://localhost:3201/mcp)
| Tool | Purpose |
|------|---------|
| `discover_leads` | Yelp/Google Places API search by ZIP + category |
| `read_leads` | Read saved lead JSON |
| `save_file` | Save Claude-generated content (pitch HTML, site HTML, etc.) |
| `read_file` | Read a saved client file |
| `list_client_files` | List all output for a slug |
| `deploy_site` | Netlify deployment |
| `create_invoice` | Generate invoice HTML |
| `read_template` | Read pitch/site/email/packages reference templates |
| `run_setup` | One-time setup (netlify-cli, API keys) |

**Always prefer MCP tools** over PowerShell scripts directly. Fall back to scripts only if the MCP server is not running.

---

## DISCOVER phase
**Trigger**: `/site-gen discover <zip> [category] [options]`

Parse args: `zip` (required), `category` (default: `restaurants`), `--radius N` (miles, default 5), `--max N` (default 40), `--no-website` flag.

**Step 1 — Check MCP server:**
GET http://localhost:3201/health. If not running: tell user to start it with the Docker compose command at the top of this skill.

**Step 2 — Call `discover_leads`:**
```json
{ "zip": "<<ZIP>>", "category": "<<CATEGORY>>", "radius": 5, "max_results": 40 }
```

**Step 3 — Present results:**
Show a table of HIGH priority leads (no website): name, address, phone, rating.
"Found X businesses. Y have no website — hottest targets. Want pitch materials for the top ones?"

**If MCP server unavailable, fallback:**
```powershell
& "~/code\agent-board\tools\website\scripts\discover.ps1" -Zip "<<ZIP>>" -Category "<<CATEGORY>>"
```

---

## PITCH phase
**Trigger**: `/site-gen pitch <slug>` or after discovery when user says "pitch them"

**Step 1 — Read templates via MCP:**
Call `read_template` with `pitch-structure`, then `cold-email`, then `service-packages`.

**Step 2 — Read agency info:**
Read `~/code\agent-board\tools\website\.env` for YOUR_NAME, YOUR_COMPANY, YOUR_EMAIL, YOUR_PHONE.
Fall back to `~/code\content-gen\website\.env` if not present.

**Step 3 — Scrape existing site (if URL available):**
Use `mcp__playwright__browser_navigate` + `mcp__playwright__browser_snapshot`.
Note: mobile-friendliness, design age, missing features.

**Step 4 — Generate pitch deck HTML:**
Write a complete single-file HTML pitch deck following the `pitch-structure` template.
Personalize with the specific business name, city, category, and observations from scraping.
Save using `save_file`: `{ "slug": "<<SLUG>>", "subdir": "pitch", "filename": "pitch-deck.html", "content": "..." }`

**Step 5 — Generate cold email:**
Write personalized email (<200 words, casual tone).
Save: `{ "slug": "<<SLUG>>", "subdir": "pitch", "filename": "cold-email.txt", "content": "..." }`

**Step 6 — Report:**
"Pitch materials saved:
- Pitch deck: [list_client_files result for slug]
- Open pitch-deck.html in browser to preview."

---

## BUILD phase
**Trigger**: `/site-gen build <slug>` or when user says "build the site"

**Step 1 — Read the site-sections template:**
Call `read_template` with `site-sections`.

**Step 2 — Gather client info:**
Ask: company name, category, address, phone, hours, description.
Ask: "Do you have an existing website URL to pull content from?"

**Step 3 — Scrape existing site (if URL):**
`mcp__playwright__browser_navigate` → `mcp__playwright__browser_snapshot` → `mcp__playwright__browser_take_screenshot`
Save screenshot: `save_file` with `subdir: "scrape"`, `filename: "screenshot.png"` (base64 content)
Save text: `save_file` with `subdir: "scrape"`, `filename: "content.txt"`

**Step 4 — Generate website HTML:**
Build a complete, deployable `index.html` with:
- Tailwind CSS via CDN
- All industry-appropriate sections from `site-sections` template
- SEO meta tags (title, description, OG, JSON-LD LocalBusiness schema)
- Netlify Forms contact form (`<form name="contact" netlify>`)
- Tidio chat widget placeholder (`PLACEHOLDER_TIDIO_ID`)
- Mobile-responsive nav with hamburger (vanilla JS)
- Real, compelling copy — never lorem ipsum
- CSS gradient placeholders for photos

Save: `save_file` with `subdir: "site"`, `filename: "index.html"`

Also create `netlify.toml`:
```toml
[build]
  publish = "."
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```
Save: `save_file` with `subdir: "site"`, `filename: "netlify.toml"`

**Step 5 — Report:**
"Site built. Ready to deploy with: /site-gen deploy <<SLUG>>"
Call `list_client_files` to show what was created.

---

## DEPLOY phase
**Trigger**: `/site-gen deploy <slug>` or after build

Call `deploy_site`: `{ "slug": "<<SLUG>>" }`

**If result contains "Not logged in":**
"Run `netlify login` in your terminal (one-time browser auth), then try again."

**If result contains `✓ Deployed:`:**
Extract the URL and present clearly.
"Share this URL with [company] as a proof-of-concept!
Want an invoice? → /site-gen invoice <<SLUG>>"

---

## INVOICE phase
**Trigger**: `/site-gen invoice <slug> [amount] [--monthly]`

Call `create_invoice`:
```json
{ "slug": "<<SLUG>>", "client_name": "<<COMPANY_NAME>>", "amount": 500 }
```
Add `"monthly": true` for maintenance invoices.

**Report:** "Invoice saved. Open in browser → Print → Save as PDF to send to client."

---

## FULL phase (end-to-end)
1. DISCOVER → present top 5 HIGH priority leads
2. Ask which to pitch (user picks 1–3)
3. For each: PITCH → ask if they want a demo site → BUILD → DEPLOY
4. INVOICE if confirmed

**Optional content-gen integration:**
"Want a 30-second promo video for [Company]'s homepage?
I can generate one via /content-gen — just say the word."

---

## File locations (output stored in MCP server's output dir)
| Type | MCP subdir | Filename |
|------|-----------|---------|
| Pitch deck | `pitch` | `pitch-deck.html` |
| Cold email | `pitch` | `cold-email.txt` |
| Site | `site` | `index.html`, `netlify.toml` |
| Invoice | `invoice` | `INV-*.html` |
| Scrape | `scrape` | `screenshot.png`, `content.txt` |

Default output root: `~/code\agent-board\tools\website\output\`

## Troubleshooting
| Symptom | Fix |
|---------|-----|
| MCP server not responding | Run the Docker compose start command above |
| discover returns no leads | Add YELP_API_KEY to `tools/website/.env` (free at yelp.com/developers) |
| Netlify login error | Run `netlify login` on host |
| deploy error: name taken | Pass `site_name` with unique value to `deploy_site` |
| PowerShell script not found | Scripts are in `agent-board/tools/website/scripts/` |

## Continuous improvement

After a run, if a step in this skill was wrong, out of date, or caused avoidable manual work (a broken MCP tool name, a pricing figure that changed, a template that needed rewriting every time), fix this file directly rather than repeating the workaround next time.
