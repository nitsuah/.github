# Per-repo imp memory

One file per target repo, named `<repo>.md` (for example `fire.md`). Every imp prompt for that
repo includes the file (capped at 1,200 characters) under "What we know about this repo", next to
notes the runner computes from the machine's ledger and a digest of the repo's own AGENTS.md /
CLAUDE.md / copilot-instructions. See `imps/memory.mjs`.

Write 3 to 6 bullet lines. Each names one trap specific to that repo and the rule that avoids it,
with the evidence:

```markdown
- `npm test` runs the whole suite and times out the gate; tests go through `npx vitest run <file>` (fire#319).
- Lint config lives in `config/eslint.config.mjs`; never edit it to make lint pass (fire#483).
```

Don't restate the general rules in `PREAMBLE.md`. The RSI pass (`rsi.mjs`, once a day) proposes an
`imps RSI: imps keep failing in <repo>` issue when a repo's recent merge rate drops under 35%, and
its brief asks for exactly this file.
