# Owned-repository audit roll-up — 2026-11-03 (18:18Z)

| Repository / item | Verified state | Disposition |
|---|---|---|
| `security-program#53` / #51 | One-line malformed-sibling fail-closed regression; exact-head Docker gate reported passing by runner; repository has no CI workflows/status contexts | PR #53 merged; #51 closed |
| `.github#238` / child #248 | Prior parser attempt failed with no diagnostic; no root cause inferred. Child PR #251 is open at `2a0d16acd3de09a499268d4ce809a3846f1f76f2`; focused `test` passed, three Analyze checks were still in progress at this audit | Keep #248 open/unlabelled until exact-head checks finish and PR merges; parent #238 remains open |
| `fire#445` | Test-only missing/empty eBay error-code fallback; active GHASTLY `imp:working` claim started 2026-11-03T18:13:33Z; no PR yet | Do not duplicate or change the active claim |
| `ats-fill#231` | Test-only Workday company fallback; active GHASTLY `imp:working` claim started 2026-11-03T17:28:38Z; no PR yet | Do not duplicate or change the active claim |
| `vigil#429` | Existing `tests/mcp.test.ts` initialize test already sends no `params.protocolVersion` and asserts fallback `2024-11-05` | Closed as already covered; removed stale `imp:ready` |
| `darkmoon#518` | `npm ci` reports missing `typescript@5.9.3` and `@noble/hashes@2.4.0` lock entries; prior Imp attempt failed the common lockfile denylist, not app tests | Maintainer-only lockfile regeneration; do not bypass denylist or requeue as Imp. This install blocker affects #516 and #521 |
| `security-program#50` | Imp attempt failed before implementation because the checkout was missing from `IMPS_CODE` | Restore/verify the intended workspace checkout before any retry; no unchanged requeue |
| `fire#223` Quick Start epic | #439 merged; #444 has a bounded manager/script-order brief but is unlabelled pending local current-kit/cooldown confirmation; #440 depends on #444; #398/#332/#333 remain downstream | Parent remains open; no browser/visual acceptance inferred |
| `vhs#123` | Exact head `d87a5278d7f6a36b52ccd64f42836c2175f58756`: unit/lint/Docker/CodeQL/lock checks pass; Journeys [41369862680](https://github.com/nitsuah/vhs/actions/runs/41369862680) fails 3 screenshot comparisons; guarded refresh [41369857480](https://github.com/nitsuah/vhs/actions/runs/41369857480) exits 42 on unapproved visual paths | Keep open; preserve threshold and allowlist. Owner visual review or correction of unintended UI/seed differences is still required |
| `motor-pool#172` | Exact head `057d7037def4ebe9f0c74536d9362fa6480a5b6c` CI passed; 24 review threads remain unresolved; route authorization and forwarded-IP trust boundaries are still security-gated | Do not merge or treat green CI as security/owner acceptance |
| `fire#443` | Exact-head Netlify preview succeeds, but the visual-doc workflow is `action_required` with zero jobs; two screenshot files changed | Await workflow approval and owner visual review; no baseline approval inferred |
| Queue integrity | GitHub labels are authoritative; the only public `imp:ready` found in this sweep was #429, now closed. #445/#231 are working, not ready | Current ready count is 0 in the checked queue. Confirm the local ledger/current kit SHA before promoting any cooldown-sensitive task |

## Exact-head validation when a repository has no CI

A combined status of `pending` with zero contexts is not an active CI job and will not become green by waiting. Validate the exact PR head with the Imp runner's deterministic Docker test/lint gate, record the SHA, commands, and result in the PR/issue discussion, and do not infer validation from an unverified summary. This exception applies only when the repository has no CI workflows/status contexts; it does not waive real running, failing, approval-blocked, or required checks.
