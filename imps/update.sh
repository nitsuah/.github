#!/usr/bin/env bash
# Pull latest merged kit into the detached imps-runner checkout.
set -euo pipefail
RUNNER="${IMPS_RUNNER:-${IMPS_KIT_PATH:-}}"
if [[ -z "$RUNNER" && -f "${IMPS_HOME:-$HOME/.imps}/kit-path.txt" ]]; then
  RUNNER=$(tr -d '\r\n' <"${IMPS_HOME:-$HOME/.imps}/kit-path.txt")
fi
RUNNER="${RUNNER:-${XDG_DATA_HOME:-$HOME/.local/share}/imps-runner}"
BRANCH="${IMPS_KIT_BRANCH:-main}"
[[ -d "$RUNNER/.git" ]] || { echo "Not a kit checkout: $RUNNER (run setup.sh first)" >&2; exit 1; }
if [[ -n "$(git -C "$RUNNER" status --porcelain)" ]]; then
  echo "$RUNNER has local changes; refusing to reset" >&2
  exit 1
fi
git -C "$RUNNER" fetch -q origin "$BRANCH"
git -C "$RUNNER" checkout -q "$BRANCH"
git -C "$RUNNER" reset -q --hard "origin/$BRANCH"
echo "updated $RUNNER → origin/$BRANCH"
git -C "$RUNNER" log -1 --oneline
