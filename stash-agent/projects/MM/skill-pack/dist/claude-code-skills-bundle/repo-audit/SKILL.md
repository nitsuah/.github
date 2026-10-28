---
name: repo-audit
description: Scan all repos in ~/code for high line-count source files, assess which repos need refactoring/modularization and improved tests, then publish a severity-ranked visual artifact. Use when asked to audit repos, check file sizes, assess code health, or find large files across the codebase.
user_invocable: true
---

# /repo-audit — Repository Code Health Audit

Scans every repo under `~/code` for oversized source files, then publishes a severity-ranked artifact report with refactoring and test-coverage assessments.

## Invocation

```
/repo-audit [--skip repo1,repo2,...] [--root /path] [--threshold N]
```

| Arg | Default | Meaning |
|-----|---------|---------|
| `--skip` | `stash` | Comma-separated repo names to exclude entirely |
| `--root` | `~/code` | Root directory containing repos |
| `--threshold` | `300` | Minimum line count to include a file in results |

If the user specifies repos to skip inline ("skip vhs and 9router"), honour them.

---

## Step 1 — Discover repos

```powershell
Get-ChildItem "~/code" -Directory | Select-Object -ExpandProperty Name
```

Remove from the list: any repo the user specified to skip, plus `stash` (always skipped — non-prod examples).

---

## Step 2 — Scan each repo

Run this bash command **per repo** (not all at once — scanning the full tree times out):

```bash
find ~/code/REPO_NAME -type f \
  \( -name "*.tsx" -o -name "*.ts" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" \) \
  -not -path "*/node_modules/*" \
  -not -path "*/.git/*" \
  -not -path "*/dist/*" \
  -not -path "*/.next/*" \
  -not -path "*/.venv/*" \
  -not -path "*/__pycache__/*" \
  -not -path "*/.claude/worktrees/*" \
  | xargs wc -l 2>/dev/null \
  | awk '$1 > THRESHOLD && $2 != "total" {print $1, $2}' \
  | sort -rn \
  | head -20
```

Replace `REPO_NAME` and `THRESHOLD`. Set a 30-second timeout per repo. If a repo times out, note it and continue.

Collect results into a map: `{ repoName: [ { lines, path } ] }`.

---

## Step 3 — Detect test files

For each repo, check whether test files exist:

```bash
find ~/code/REPO_NAME -type f \
  \( -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.test.js" \
     -o -name "*.spec.ts" -o -name "*.spec.js" -o -name "*.test.py" \) \
  -not -path "*/node_modules/*" -not -path "*/.venv/*" \
  -not -path "*/.claude/worktrees/*" \
  | head -20
```

Classify test coverage:
- **good** — 5+ test files, or test file sizes comparable to implementation files
- **sparse** — 1–4 test files found
- **none** — zero test files found

---

## Step 4 — Classify severity

Assign each repo one severity based on its largest files:

| Severity | Trigger condition |
|----------|------------------|
| **Critical** | Any single file ≥ 2,500 lines |
| **High** | Any file 1,000–2,499 lines, OR 3+ files > 600 lines |
| **Medium** | Files 500–999 lines, or several 300–500 line files accumulating |
| **Low** | No file > 500 lines; mostly borderline sizes |
| **OK** | All files reasonable OR all large files are auto-generated |

**Auto-generated files** — exclude from severity calculation (don't refactor these):
- Ethers/wagmi ABI factory types (`__factory.ts`, Typechain output)
- GraphQL generated files (`generated.ts`, `graphql.ts` with schema comments)
- OpenAPI generated clients
- Any file containing `// @generated` or `# DO NOT EDIT` near the top

**Third-party vendored files** — exclude:
- Anything under `.venv/`, `site-packages/`, `vendor/`, `_vendor/`
- `docx.umd.min.js`, `*.min.js`, `*.bundle.js`

---

## Step 5 — Write refactoring assessment

For each repo, synthesize a short refactoring note based on the actual files found. General patterns to look for:

- **God hooks** (`useSomething.ts` > 1,000 lines): split by domain concern
- **God components** (`GameUI.tsx`, `App.jsx` > 800 lines): extract sub-components per panel/section
- **Fat API routes** (`route.ts`, `server.js` > 600 lines): move logic into service modules, split route handlers to their own files
- **Catch-all index files** (`index.ts` > 500 lines doing tool registration, server setup, etc.): split by concern
- **Constants files** (`constants.ts` > 400 lines): acceptable if pure config, but watch for logic creep
- **Layer/map render files** (`*Layer.tsx` > 500 lines): each entity type should have its own component

---

## Step 6 — Build and publish the artifact

Load the `artifact-design` skill before writing the artifact.

### Design system (use these tokens exactly)

**Dark theme (default):**
```
--bg: #0D1117          /* near-black with blue bias */
--bg-surface: #161B22
--bg-raised: #1C2128
--border: #30363D
--text: #E6EDF3
--text-muted: #8B949E
--text-dim: #484F58
--accent: #58A6FF
--crit: #FF6B6B
--high: #F0883E
--med: #D29922
--low: #3FB950
--ok: #6E7681
--bar-track: #21262D
```

**Light theme:**
```
--bg: #F0F2F5
--bg-surface: #FFFFFF
--bg-raised: #F6F8FA
--border: #D0D7DE
--text: #1C2128
--text-muted: #57606A
--crit: #CF222E  --high: #BC4C00  --med: #9A6700  --low: #1A7F37
```

**Typography:** monospace (`'Courier New', Courier, monospace`) for all file paths, line counts, repo names, and tags. System sans (`-apple-system, 'Segoe UI', system-ui, sans-serif`) for body descriptions. 

### Artifact structure

1. **Sticky header** — page title, subtitle noting skipped repos, and a summary stat row: counts of Critical / High / Medium / Low repos + largest single file size.

2. **Note bar** — one line each for: worktrees excluded, generated files excluded, third-party vendored code excluded.

3. **Repo cards**, sorted by severity (Critical first), each card containing:
   - 4px left severity-color stripe
   - Repo name + severity badge (monospace tag)
   - File list with inline bar chart (normalize bars against 5,369 as 100% — the known max in this codebase; recalculate if the actual max differs)
   - **Refactor** section: specific recommendations based on the actual file names found
   - **Tests** section: test coverage classification + what's missing

4. Section dividers between severity groups: `Critical`, `High`, `Medium`, `Low / borderline`.

### Bar color coding

Assign bar and line-count color by line count:
- ≥ 2,500 → `--crit` class `big`
- 1,000–2,499 → `--high` class `lg`
- 500–999 → `--med` class `md`
- < 500 → `--low` class `sm`

### File path display

Truncate directory prefix, bold the filename:
```html
<div class="file-path">path/to/<span class="fname">FileName.tsx</span></div>
```

### Test coverage pills

```html
<span class="pill needs">no tests found</span>
<span class="pill sparse">sparse tests</span>
<span class="pill ok">good coverage</span>
<span class="pill skip">generated / skip</span>
```

### Publish

Write the HTML to the scratchpad directory, then call the `Artifact` tool with:
- `favicon`: `🔍`
- `description`: `"Code health audit — severity-ranked file size assessment across all repos."`

---

## Output to user

After publishing, give a 3–5 line summary:
- How many repos were scanned / how many skipped
- The top 2–3 most urgent findings by name
- The artifact URL
- One-liner on the biggest test gap found

## Continuous improvement

After a run, if a threshold, severity rule, or exclusion pattern in this file produced a noisy or wrong result, fix it here directly rather than mentally correcting for it next time.
