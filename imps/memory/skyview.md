---
name: skyview
description: skyview repo-specific imp traps and rules
metadata:
  type: project
---

- Browser/screenshot tests (`tests/visual-docs`, `tests/journeys`) need the Playwright image: `docker run ... mcr.microsoft.com/playwright:v1.65.1-jammy` (match `@playwright/test` in package.json). In plain `node:22` there are no browsers and the base never passes (skyview#253). Unit tests use `node:22` and `npx vitest run --config config/vitest.config.ts <file>`.
- Visual changes (CSS only) are judged by eye and need regenerated `docs/screenshots/*.png`; they are session work, not imp work (skyview#253 failed twice).
- Auth fixes (`netlify/functions/api-auth*.mjs`): the test file's SQL-statement mocks match exact strings, so read the failing assertion's expected statement and change the code to emit it, not the test (skyview#234).
- Docker `npm ci` takes ~20-70s per run: mount `-v imp-nm-skyview:/app/node_modules` and never put `npm ci` twice in one test command.
