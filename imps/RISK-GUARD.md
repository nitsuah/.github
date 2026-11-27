# Required risk guard

## Decision

The old caller-owned `pull_request` + `pull_request_target` pattern is not an enforceable required check. A target-repository PR can add another Actions job with the same workflow/job context; both checks are emitted by the GitHub Actions app. A source-app restriction therefore cannot distinguish the trusted run from the spoof.

The preferred replacement is GitHub's **Require workflows to pass before merging** ruleset rule, selecting this repository's `.github/workflows/required-risk-guard.yml` from the `main` branch. That rule binds enforcement to the selected source workflow, not to a check name that PR code can copy. The workflow itself is stored in this shared repository, uses only read permissions, checks out this exact workflow revision from `nitsuah/.github`, and reads PR metadata through the API. It never checks out or executes target PR code.

## Activation

After this workflow is merged:

1. In each supported repository's Settings → Rules → Rulesets, edit the active default-branch ruleset.
2. Add **Require workflows to pass before merging**.
3. Select source repository `nitsuah/.github`, branch `main`, workflow `.github/workflows/required-risk-guard.yml`.
4. Apply it to the default branch only. Do not target all branches.
5. For existing open PRs, push a normal follow-up commit or update the branch to trigger the required workflow; ruleset workflows do not automatically run on PRs that were already open when the rule was created.
6. Verify the required workflow appears and passes on a test PR before removing the old caller-owned status check from branch protection and deleting the local `.github/workflows/risk-guard.yml` caller.

For `Nitsuah-Labs`, prefer an organization-level ruleset targeting the owned repositories. For user-owned `nitsuah/*` repositories, configure the rule at repository level if the account UI exposes this rule.

## Availability and fallback

GitHub documents ruleset workflows as an organization/enterprise ruleset capability. If **Require workflows to pass before merging** is not available on the account, do not fall back to another same-name GitHub Actions job. The safe fallback is a separately installed GitHub App that creates a check run under its own App identity, with the required status check restricted to that App. That requires an App installation and private-key secret configured by an owner; this repository deliberately does not create, read, or modify secrets.

Until one of those two enforcement mechanisms is active, treat the legacy Actions status as advisory only and do not claim the spoofing issue is fixed.

## Legacy caller

`repo-health/templates/risk-guard.yml` is retained for historical reference and migration. It is not a secure required-check mechanism. Do not copy it into new repositories or rely on its `Trusted guard` check name for enforcement.
