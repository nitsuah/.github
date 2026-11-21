---
name: skyview
description: skyview repo-specific imp traps and rules
metadata:
  type: project
---

- **Edits left uncommitted** (skyview#213): imp made changes but never `git add` + `git commit`. Rule 5: always commit after RUNTEST passes.
- **Tests never run** (skyview#213, skyview#234): imp edited files but didn't execute `node .github/imps/runtest.mjs`. Rule 4/10: always run RUNTEST before committing.
- **Commands denied for chaining** (multiple runs): used `a && b` or pipes in Bash. One allowed command per Bash call; tests only through RUNTEST.
- **Turn cap / idle** (skyview#213, skyview#234): went 20+ calls without an edit. Open the target file first and make the edit within the first few turns.
- **Test failure not read** (skyview#213): gate recorded exit code but imp didn't read RUNTEST output to the end. Read the full test output before deciding to commit.