# Exact-head validation for repositories without CI

Some owned repositories intentionally have no GitHub Actions workflows or reported commit-status contexts. A combined status of `pending` with zero contexts is not an active CI job and will not become green by waiting.

For these repositories, use the Imp runner's deterministic Docker gate as the validation source of truth:

1. Confirm the PR head SHA is the exact commit evaluated by the runner.
2. Require declared test and lint commands to complete successfully in the configured Docker environment on that SHA.
3. Record the exact-head SHA, commands, and gate result in the PR/issue discussion.
4. Do not hold for nonexistent CI contexts or infer validation from an unverified Imp summary. If exact-head gate evidence is absent, request it; if it passes and review is clean, proceed under normal merge policy.

This exception applies only when the repository has no CI workflows/status contexts. It does not waive real failing, running, approval-blocked, or required checks.
