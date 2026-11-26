---
name: bb-mcp-repo-lessons
description: Repo-specific traps and rules for bb-mcp that differ from general preamble
metadata:
  type: project
---

- Gate denies changes outside `imps/memory/bb-mcp.md` — only edit this file; any other path fails pre-flight.
- Tests run with `node --test imps/*.test.mjs` — run this exact command via RUNTEST before committing; no other test runner works.
- Commands denied when chained (`&&`, pipes) or run outside allowlist — one allowed command per Bash call; tests only through RUNTEST.
- Missing path errors on Windows backslashes — use repo-relative forward-slash paths (e.g. `imps/memory/bb-mcp.md`) in all tools.
- Turn cap / 20-tool-call stall — open the target file first and make the edit within first few turns; don't explore endlessly.
- No commits left behind — after RUNTEST passes, `git add imps/memory/bb-mcp.md` then `git commit -m "docs(bb-mcp): add repo-specific memory lessons" -m "Fixes #353" -m "Co-Authored-By: 9router imp <noreply@anthropic.com>"`.