# Trusted risk-guard check

## Security decision

A required check emitted by GitHub Actions is spoofable: a pull request can add another Actions job with the same check context, and branch protection sees the same GitHub Actions app identity. Renaming the job or using `pull_request_target` does not change that identity.

The enforcement check is therefore emitted by a dedicated GitHub App named **Nitsuah Risk Guard**. The trusted `pull_request_target` caller invokes this pinned reusable workflow, which evaluates PR metadata with the read-only Actions token and creates/completes the required `Nitsuah Risk Guard` check using a narrowly scoped installation token from the dedicated App. A PR cannot mint that App token or spoof its check-run identity.

The reusable workflow checks out only `nitsuah/.github` at `job.workflow_sha`; it never checks out or executes target PR code. The App token is scoped to the current repository and `checks: write` only. The guard's authorized owner login is `nitsuah`, including for repositories owned by the `Nitsuah-Labs` organization.

## One-time GitHub App setup

An owner must perform this account-level setup. The workflow references the resulting variable and secret but does not create, read, print, or modify either value.

1. Register a private GitHub App named **Nitsuah Risk Guard**. It needs **Checks: Read and write** and **Metadata: Read-only** only; no webhook events are required.
2. Install the App on the `nitsuah` user account and the `Nitsuah-Labs` organization, selecting only owned repositories that use the guard.
3. Set repository variable `RISK_GUARD_APP_CLIENT_ID` to the App's Client ID. For `Nitsuah-Labs`, an organization variable can cover all adopted repos; for personal `nitsuah/*` repos, set the variable at repository level.
4. Set secret `RISK_GUARD_APP_PRIVATE_KEY` to the App private key, using an organization secret for `Nitsuah-Labs` where appropriate and repository secrets for personal repos. Never put the key in a brief, issue, PR comment, or file.
5. Copy `repo-health/templates/risk-guard.yml` into each target repo as `.github/workflows/risk-guard.yml`, replacing `REPLACE_WITH_KIT_SHA` with the full commit SHA of this kit.
6. In each target repo's branch protection, require **Nitsuah Risk Guard** from the **Nitsuah Risk Guard GitHub App**. Remove the old `Trusted guard / Risk guard` Actions check from the required list after the App-backed check has passed once. The old Actions check may remain advisory.
7. Verify a normal PR and a high-risk PR. The high-risk check must fail without an owner-added `risk-ack`, then pass after `nitsuah` adds that label. Label changes trigger the caller automatically.

## Runtime behavior

- The local caller uses `pull_request_target` and listens for opened, synchronize, reopened, edited, labeled, and unlabeled events. A label change therefore re-evaluates `risk-ack` and `no-changelog` without requiring an empty commit.
- The caller passes only the App Client ID variable and the private-key secret to the pinned reusable workflow.
- The reusable workflow creates an App-backed check in progress, runs `imps/ci-guard.mjs` with read-only API access, then completes the App check with success or failure.
- The App token is scoped to the current repository and `checks: write`. The workflow does not use it to read PR contents or write repository files.
- If the App is not installed, the variable/secret is missing, or check creation fails, the App check is absent and branch protection blocks the merge. This is intentionally fail-closed.
- The App check is bound to the PR head SHA. A same-named job emitted by GitHub Actions cannot satisfy a required check restricted to the dedicated App.

## Migration

Do not rely on a caller-owned Actions status as the security boundary. Update existing adopters to the pinned `risk-guard-app.yml` workflow, configure the App installation and branch-protection source, verify the App check, then remove the old Actions check from required status checks. Until the App-backed check is configured and required, the legacy Actions result is advisory only.
