  # AUDIT.md
  
  Audit the `.github/` folder and root-level directories of the `<REPO>` repo:

  1. **`.github/` vs org `.github` repo** — list every file in `.github/` and flag any
     that duplicate files already in the org-level `.github` repo
     (CODE_OF_CONDUCT, CONTRIBUTING, SECURITY, PULL_REQUEST_TEMPLATE, ISSUE_TEMPLATE/*).
     Note anything present in the org repo but missing here.

  2. **Root folder audit (1 level deep)** — for each folder in the repo root, report:
     - `files_in_git` (tracked file count)
     - `total_items` (actual filesystem count)
     - Flag: empty, untracked (0 in git), gitignored-but-present (e.g. node_modules),
       or consolidation candidates (e.g. multiple test dirs, loose config files that
       belong in an existing `config/` folder)

  3. **Recommendations** — for each issue found, state the action:
     Remove duplicate | Move to config/ | Add to .gitignore | Consolidate dirs | Keep