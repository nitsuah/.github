#!/usr/bin/env bash
# Remove cron entry and optionally the runner checkout. Keeps ~/.imps unless --wipe-state.
set -euo pipefail
REMOVE_RUNNER=0
WIPE_STATE=0
for a in "$@"; do
  case "$a" in
    --remove-runner) REMOVE_RUNNER=1 ;;
    --wipe-state) WIPE_STATE=1 ;;
  esac
done
RUNNER="${IMPS_RUNNER:-${IMPS_KIT_PATH:-}}"
if [[ -z "$RUNNER" && -f "${IMPS_HOME:-$HOME/.imps}/kit-path.txt" ]]; then
  RUNNER=$(tr -d '\r\n' <"${IMPS_HOME:-$HOME/.imps}/kit-path.txt")
fi
RUNNER="${RUNNER:-${XDG_DATA_HOME:-$HOME/.local/share}/imps-runner}"
IMPS_HOME_DIR="${IMPS_HOME:-$HOME/.imps}"

if command -v crontab >/dev/null; then
  crontab -l 2>/dev/null | grep -v 'imps/dispatch\|imps-runner\|hourly.sh' | crontab - || true
  echo "removed imps crontab lines (if any)"
fi
rm -f "$IMPS_HOME_DIR/hourly.sh" "$IMPS_HOME_DIR/label-watch.sh"
[[ "$REMOVE_RUNNER" -eq 1 && -d "$RUNNER" ]] && rm -rf "$RUNNER" && echo "removed $RUNNER"
if [[ "$WIPE_STATE" -eq 1 ]]; then
  rm -rf "$IMPS_HOME_DIR"
  echo "wiped $IMPS_HOME_DIR"
else
  echo "kept state $IMPS_HOME_DIR"
fi
echo "uninstall done."
