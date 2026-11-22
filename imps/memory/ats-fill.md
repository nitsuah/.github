---
name: ats-fill-lessons
description: Repo-specific traps and rules for ats-fill imps
metadata:
  type: project
---

- **Edits left uncommitted** (×3): imps make changes but never `git add` + `git commit`. Rule 5: always commit after RUNTEST passes; uncommitted work is lost.
- **Tests never run** (×3): imps edit but skip `node .github/imps/runtest.mjs`. Rule 4/10: RUNTEST must pass before committing; a diff without a test run fails the gate.
- **Turn cap / 20 calls without an edit**: imps read/analyze but don't write. Open the file "The fix" names first and make the edit within your first few turns.
- **Test command is `node --test imps/*.test.mjs`**: do not run `npm test`, `vitest`, or `npx`; those are denied. Use the RUNTEST command exactly as specified in the brief.
