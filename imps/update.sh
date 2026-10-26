#!/usr/bin/env bash
# Pull latest merged kit into the detached imps-runner checkout.
set -euo pipefail
RUNNER="${IMPS_RUNNER:-${IMPS_KIT_PATH:-}}"
if [[ -z "$RUNNER" && -f "${IMPS_HOME:-$HOME/.imps}/kit-path.txt" ]]; then
  RUNNER=$(tr -d '\r\n' <"${IMPS_HOME:-$HOME/.imps}/kit-path.txt")
fi
RUNNER="${RUNNER:-${XDG_DATA_HOME:-$HOME/.local/share}/imps-runner}"
BRANCH="${IMPS_KIT_BRANCH:-main}"
IMPS_HOME="${IMPS_HOME:-$HOME/.imps}"
[[ -d "$RUNNER/.git" ]] || { echo "Not a kit checkout: $RUNNER (run setup.sh first)" >&2; exit 1; }

# Before reset, migrate tracked model_quota.json to IMPS_HOME if present (#59).
# If the file was modified locally, preserve the working-tree file by copying it
# only when destination is absent; then restore the tracked path so the dirty
# check passes. If the copy or restore fails, the update fails.
if git -C "$RUNNER" ls-files --error-unmatch imps/model_quota.json >/dev/null 2>&1; then
  if [[ -n "$(git -C "$RUNNER" status --porcelain imps/model_quota.json)" ]]; then
    mkdir -p "$IMPS_HOME"
    if [[ ! -e "$IMPS_HOME/model_quota.json" ]]; then
      cp "$RUNNER/imps/model_quota.json" "$IMPS_HOME/model_quota.json" || { echo "failed to copy model_quota.json" >&2; exit 1; }
    fi
    git -C "$RUNNER" checkout -- imps/model_quota.json || { echo "failed to restore tracked model_quota.json" >&2; exit 1; }
    echo "migrated tracked model_quota.json to $IMPS_HOME/model_quota.json"
  fi
fi

# Tracked changes only: `reset --hard` never deletes untracked files, so an
# untracked file is not something this command can lose. model_quota.json used
# to be tracked and is now machine state in IMPS_HOME (#59) — after an upgrade
# it survives as an untracked leftover and must not block updates.
# Also protect untracked files that would be overwritten by the target commit (#64).
# Use NUL-delimited paths so spaces/newlines in filenames don't break the loop,
# and run in the current shell (no subshell) so `set -euo pipefail` doesn't
# cause an early exit on a missing final path.
git -C "$RUNNER" fetch -q origin "$BRANCH"
OVERWRITTEN=""
while IFS= read -r -d '' f; do
  if git -C "$RUNNER" cat-file -t "origin/$BRANCH:$f" >/dev/null 2>&1; then
    OVERWRITTEN="${OVERWRITTEN}${OVERWRITTEN:+ }$f"
  fi
done < <(git -C "$RUNNER" ls-files -z --others --exclude-standard)
if [[ -n "$OVERWRITTEN" ]]; then
  echo "untracked files would be overwritten by reset: $OVERWRITTEN" >&2
  exit 1
fi
if [[ -n "$(git -C "$RUNNER" status --porcelain --untracked-files=no)" ]]; then
  echo "$RUNNER has local changes; refusing to reset" >&2
  exit 1
fi
git -C "$RUNNER" fetch -q origin "$BRANCH"
git -C "$RUNNER" checkout -q "$BRANCH"
git -C "$RUNNER" reset -q --hard "origin/$BRANCH"
# Verify the checkout is usable after reset (#62).
node "$RUNNER/imps/preflight.mjs" || { echo "$RUNNER does not look like a usable imps kit after update" >&2; exit 1; }
echo "updated $RUNNER → origin/$BRANCH"
git -C "$RUNNER" log -1 --oneline
