---
name: ats-fill-lessons
description: Repo-specific traps and rules for ats-fill imps
metadata:
  type: project
---

- **Edits left uncommitted** (×3): imps make changes but never `git add` + `git commit`. Rule 5: always commit after RUNTEST passes; uncommitted work is lost.
- **Tests never run** (×3): imps edit but skip the RUNTEST command from "Gate limits for this run". Rule 4/10: RUNTEST must pass before committing; a diff without a test run fails the gate.
- **Turn cap / 20 calls without an edit**: imps read/analyze but don't write. Open the file "The fix" names first and make the edit within your first few turns.
- **Test command is `node C:/Users/ajhar/AppData/Local/imps-runner/imps/runtest.mjs`**: do not run `npm test`, `vitest`, or `npx`; those are denied. Use the RUNTEST command exactly as specified in the brief.
- **Only `imps/memory/ats-fill.md` is allowed** (×4): the gate rejects any file outside `imps/memory/ats-fill.md`. Do not touch `imps/lib.mjs`, `imps/imp.mjs`, or anything else; `allow:` is strict.
