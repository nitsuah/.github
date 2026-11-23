---
name: ats-fill-lessons
description: Repo-specific traps and rules for ats-fill imps
metadata:
  type: project
---

- **Edits left uncommitted** (×3): imps make changes but never `git add` + `git commit`. Rule 5: always commit after RUNTEST passes; uncommitted work is lost.
- **Tests never run** (×3): imps edit but skip the RUNTEST command from "Gate limits for this run". Rule 4/10: RUNTEST must pass before committing; a diff without a test run fails the gate.
- **Turn cap / 20 calls without an edit**: imps read/analyze but don't write. Open the file "The fix" names first and make the edit within your first few turns.
- **Test command is the RUNTEST command in "Gate limits for this run"**: do not run `npm test`, `vitest`, or `npx`; those are denied. Run RUNTEST exactly as given there. Its path depends on where the runner is installed.
- **Edit only the files in the brief's `allow:` list** (×4): the gate rejects any file outside that list. Do not touch `imps/lib.mjs` or `imps/imp.mjs` unless `allow:` names them.
