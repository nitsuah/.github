---
name: vuln-run
description: Orchestrate the vuln-agent pipeline: build a work queue from the scored CodeRabbit findings and run cheap 9router workers (fix, gate, adversarial review, repair) on them. Use when someone says "/vuln-run", "work the vulns", "run the vuln agents", "fix the stash vulns", or gives repos= sev= theme= ids= budget=.
---
# /vuln-run

Pipeline code: `~/code/security-program/vuln/`. PRIVATE material: never paste advisory text, findings or reports into public repos, issues, PRs or free-model prompts.

## Inputs
`repos=stash,fire  sev=high,medium  theme=redos-regex  ids=c9996c40  budget=2  mode=plan|run` (all optional; default mode=plan).

## Steps
1. Confirm 9router is up: `curl -s localhost:20128/v1/models` with the key from settings (never print it). If down: `docker compose up -d` in ~/code/9router.
2. `python vuln/vuln_queue.py --repos .. --sev .. --limit N --write` and show the table. Skipped counts show what was excluded (auth/OAuth/API-key themes are the owner's).
3. mode=plan: stop here. mode=run: for each item (max 2 at a time, one per repo) `node vuln/worker.mjs --item <id>` in the background; monitor with `python vuln/vuln_status.py`.
4. For each `ready` item run `python vuln/vuln_review.py <id>`; you (MAX) read the diff and the attacker JSON yourself before recommending it. `needs-review`/`needs-human`: read handoff, decide whether to hint (`vuln-overseer`) or leave for the owner.
5. Shipping is a human step. Public repo + unfixed vuln: only via the advisory's temporary private fork. Private repo or non-security nit: draft PR is fine. Update TASKS/ROADMAP/CHANGELOG in the same branch.

## Budgets
Per item USD/minutes/turns and per-run caps are in `vuln/route_policy.json`. Stop and report rather than raising them.
