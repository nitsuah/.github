# repo-health

Deterministic weekly checks that replace three cloud routines (`week-vuln`, `week-eng-loc`, `week-eng-mini`). No model runs.

| Check | Script | Replaces | Output |
|---|---|---|---|
| Dependency advisories | `osv_summary.py` (reads `osv-scanner` JSON) | week-vuln | Job summary, a `## For TIRE` section, and one open `bot:repo-health` issue while a HIGH/CRITICAL advisory exists |
| LOC hotspots | `loc.py` | week-eng-loc | Job summary (advice only, never fails) |
| Root-file hygiene | `root_hygiene.py` | week-eng-mini | Job summary; unclassified root entries only. LICENSE always stays at root |

## Adopt in a repo

Copy `templates/repo-health.yml` to `.github/workflows/repo-health.yml`. The reusable workflow is `.github/workflows/repo-health.yml` here. Inputs: `max-lines` (default 500) and `min-severity` (default 7.0).

The caller needs `issues: write` and `contents: read`. The workflow checks this repo out as `.repo-health-kit`, so a change merged to `main` here applies to every caller on its next run (review kit PRs accordingly).

## Where findings go

`monthly-tire-kick` reads open issues labeled `bot:repo-health` across the tracked repos and turns the `quick | repo | bump pkg a->b (id) | peer-dep risk: ...` lines into ledger items, as it did with the old week-vuln report.

## Tests

```bash
python -m pytest repo-health -q
```
