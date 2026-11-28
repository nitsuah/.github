---
name: vuln-triage
description: Decide which scored findings are safe to automate, pick tier and recipe, and flag the ones the owner must handle. Use before /vuln-run when choosing what to queue, or when a worker item stalls and needs re-classification.
---
# vuln-triage
- Inputs: `data/findings.scored.json`, `data/drift.json`, `vuln/recipes.json`, `vuln/route_policy.json`.
- Automate (easy): fallback creds, TLS verify, ReDoS, size caps, path containment, CSV/log/proto pollution, XSS escaping. Medium: SSRF, shell injection, data exposure, CORS bind, secrets in argv.
- Never automate: authn/authz design, OAuth flow binding, LLM-agent trust, proxy policy, code-exec parsers, API-key system, anything touching live credentials or deployed config. List them for the owner with file and advisory ref.
- Check for a fix-once helper in the target repo before the worker invents one; if the theme needs a new shared helper (safeFetch, safeResolve), do that item by hand or with MAX first and let workers reuse it.
- A repo with no test command in `vuln/test_cmds.json` cannot be gated: add the Docker test command first, or skip.
