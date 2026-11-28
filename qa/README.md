# Live-app QA (no Grok required)

Read-only checks of the public custom domains, the profile README links, and
each public repo's homepage URL. Scheduled GitHub Actions run these so the
weekly QA + brand/link sweep does not depend on Grok Bot.

```bash
npm ci
npx playwright install --with-deps chromium   # only for the crawl
node health.mjs          # curl-level uptime, including a cookie-bearing vigil request
node link-sweep.mjs      # profile/README.md + GitHub repo homepage URLs
node crawl.mjs           # Playwright crawl (optional subset: node crawl.mjs vhs vigil)
```

Outputs land in `qa/out/`. `health.mjs` and `link-sweep.mjs` exit 1 on
failures. `crawl.mjs` exits 1 when a finding is severity `fail`.

On a scheduled failure the workflow opens or updates a sticky issue:

- [QA sweep (live apps + profile links)](https://github.com/nitsuah/.github/issues?q=is%3Aissue+%22QA+sweep+%28live+apps+%2B+profile+links%29%22) (`bot:qa`)
- [Uptime: live apps](https://github.com/nitsuah/.github/issues?q=is%3Aissue+%22Uptime%3A+live+apps%22) (`bot:uptime`)

Those issues are **not** labelled `imp:ready`. Outages are owner-gated. A
fixable code defect can be briefed by hand (or groom) and then promoted.

Schedules (UTC): uptime every 4 hours at :19; weekly crawl Mondays 14:00 UTC
(9:00 AM Eastern Standard / 10:00 AM Eastern Daylight). Both also have
`workflow_dispatch`.

## Activating the schedules

The workflow YAML lives in `qa/github-workflows/` because the token that
opens this PR does not have GitHub's `workflow` scope, so it cannot write
`.github/workflows/`. To turn the schedules on, copy (or `git mv`) the two
files into `.github/workflows/` and merge:

```bash
git mv qa/github-workflows/qa-weekly.yml .github/workflows/qa-weekly.yml
git mv qa/github-workflows/uptime.yml .github/workflows/uptime.yml
```

Until that copy is on `main`, run the checks locally or via `workflow_dispatch`
once the files are in place.

## Pointing the crawl at a preview

`crawl.mjs` reads `BASE_OVERRIDE_<APP_ID>` with the app id upper-snake-cased (`nitsuah-io` → `BASE_OVERRIDE_NITSUAH_IO=https://preview-url`). With exactly one app id on the command line, plain `BASE_OVERRIDE` works too.
