# TokenEconomizer integration for Imps / Warlock

Status: proposal for staged implementation
Upstream: https://github.com/microsoft/TokenEconomizer
Upstream license: Apache-2.0
Target: `nitsuah/.github/imps`

## Goal

Apply TokenEconomizer's evidence-driven cost controls to our existing headless Claude/9router Imp workflow without replacing its dispatcher, brief contract, gate, reviewer, or RSI loop.

The first implementation should be native to the current Node.js runner. Do not make Python 3.10, a second plugin marketplace, or a resident daemon a prerequisite for Imps.

## Port the three ideas, with Imp-specific boundaries

### 1. Repo micro-skills (high priority)

Persist small, verified repository facts across Imp runs. Candidate facts:
- verified test/lint/build commands and working directories
- package-manager/runtime requirements and install preconditions
- common setup failures and their proven fixes
- generated/ignored paths and repository-specific conventions
- commands that passed the Imp gate, including the environment fingerprint

Store per repository under the existing local Imp state root (not in target repos), e.g. `<IMPS_HOME>/knowledge/<owner-repo>/facts.json`. Keep this out of git and never put credentials, tokens, secret values, private source snippets, or unreviewed vulnerability details in it.

Each fact must include: stable id, normalized statement, category, source run ids, evidence count, confidence, created/last-confirmed timestamps, status, and optional expiry. Promote only after independent confirmation in at least two successful runs, or one successful run plus an explicit maintainer approval. Contradictory evidence demotes/quarantines the fact; never silently overwrite it.

At run start, inject only a small bounded set (initial budget: 500 tokens) of high-confidence facts into the Imp prompt. Treat facts as hints, not authority: the current repo's files and commands win, and all gate commands are still executed.

### 2. Failure-loop intervention (high priority)

Track repeated tool/command failures within one Imp run. Use structured runner events where available; otherwise derive conservative signatures from bounded stderr/exit-code data. Do not store full prompts or whole command output.

Trigger a deterministic nudge when the same normalized failure signature recurs three times without a meaningful state change, or when the same failed check is retried without intervening edits. The nudge should ask the Imp to stop repeating the same action, inspect the root cause, and choose a different bounded strategy.

Initial implementation must be deterministic; no judge-model call. A later optional judge can be considered only after baseline telemetry proves false-positive rates are acceptable and its model cost is included in accounting.

Never terminate the worker automatically. Keep the existing wall-clock/turn limits and final gate as the hard controls.

### 3. Tool/skill pruning (defer; proposal-only)

The upstream project prunes unused tools across sessions. Our `claude -p` + 9router invocation currently does not expose a stable, complete per-tool schema/usage inventory comparable to all supported upstream hosts. Do not guess at tool names or mutate global Claude/9router configuration.

First collect per-run tool inventory/use evidence (names and counts only, no arguments or payloads). After a statistically meaningful sample, produce a report-only proposed deny list. Require maintainer opt-in and a reversible allow-list before any enforcement. Never prune git, filesystem, test, security scanner, browser/network, or review capabilities required by the task.

## Integration points

- `imp.mjs`: load bounded facts before prompt construction; write run id and environment fingerprint to telemetry.
- runner/event parser: emit normalized tool/failure events without raw args or secrets.
- `dispatch.mjs`: aggregate per-run outcome and costs; do not change queue selection or label semantics in this phase.
- `rsi.mjs`: correlate repeated gate/setup failure signatures and propose facts; do not promote a fact from a failed run alone.
- `doctor.ps1`: validate writable knowledge/telemetry directories and report feature state.
- `watch.mjs`: expose compact token/cost, fact injection, loop nudge, and failure counts if these are available; missing telemetry must not break runs.

## Data model and privacy

Use JSONL append-only events plus an atomic snapshot for facts. Suggested event fields:

```json
{
  "schema": 1,
  "runId": "opaque-run-id",
  "repo": "owner/repo",
  "event": "run-end",
  "at": "ISO-8601",
  "inputTokens": null,
  "outputTokens": null,
  "cacheReadTokens": null,
  "cacheWriteTokens": null,
  "estimatedCostUsd": null,
  "outcome": "gate-pass",
  "failureSignatures": []
}
```

Unavailable provider usage must be `null`, never zero or an invented estimate. Separate measured provider usage from estimates and include pricing-model/version metadata for estimates. Do not assume 9router exposes exact per-model token/cost usage until verified.

## Configuration

Feature flags, all default-off initially:
- `IMPS_KNOWLEDGE=off|on`
- `IMPS_LOOP_GUARD=off|on`
- `IMPS_TOOL_TELEMETRY=off|on`
- `IMPS_TOOL_PRUNE=off|propose` (no enforcement in initial release)

Per-feature flags should be scoped to the Imp runner, not global agent config. Provide `status`, `knowledge list`, `knowledge explain <id>`, and `knowledge forget <id>` commands. Deletion must be local and auditable.

## Rollout

1. Instrument run lifecycle and failure signatures only; prove no prompt/config/queue regressions.
2. Add fact extraction from deterministic runner evidence; keep it report-only.
3. Enable bounded fact injection for opted-in repos; gate remains mandatory.
4. Add deterministic loop nudges behind a flag and measure retries/gate outcomes.
5. Consider optional model-based review only if its total cost and safety are measured.
6. Consider tool-prune proposal only after reliable tool inventory exists.

## Acceptance criteria

- Existing Imp brief parsing, queue labels, worktree isolation, gates, review, merge policy, and RSI behavior are unchanged with all flags off.
- Every knowledge fact is traceable to evidence and can be revoked.
- No secrets, raw prompts, tool arguments, or full command output are persisted.
- Facts are injected under a hard token/character budget and cannot override the brief or gate.
- Repeated-failure nudges are bounded (one per signature per run by default) and never stop a worker.
- Telemetry distinguishes measured values, estimates, and unavailable values.
- Missing/corrupt optional state degrades to the current unmodified Imp behavior.
- Tests cover promotion, contradiction, expiry, redaction, budget, loop signature normalization, nudge limits, and fail-open behavior.
- Benchmark at least 20 comparable tasks before enabling by default: report cost per successful PR, gate-pass rate, retries, and median wall time. Do not optimize tokens at the expense of successful PRs.

## Upstream implementation references

See the upstream README for the micro-skills, tool-pruning, loop-guard design, cost accounting, and supported agent surfaces. Reuse concepts, not upstream internals blindly: https://github.com/microsoft/TokenEconomizer