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
IMPS_HOME_DIR="${IMPS_HOME:-$HOME/.imps}"
RUNNER="${IMPS_RUNNER:-${IMPS_KIT_PATH:-}}"
if [[ -z "$RUNNER" && -f "$IMPS_HOME_DIR/kit-path.txt" ]]; then
  RUNNER=$(tr -d '\r\n' <"$IMPS_HOME_DIR/kit-path.txt")
fi
RUNNER="${RUNNER:-${XDG_DATA_HOME:-$HOME/.local/share}/imps-runner}"
HOURLY="$IMPS_HOME_DIR/hourly.sh"

if command -v crontab >/dev/null; then
  crontab -l 2>/dev/null | grep -vF "$HOURLY" | crontab - || true
  echo "removed imps crontab lines (if any)"
fi
rm -f "$HOURLY" "$IMPS_HOME_DIR/label-watch.sh"
if [[ "$REMOVE_RUNNER" -eq 1 && -d "$RUNNER" ]]; then
  if [[ -d "$RUNNER/.git" && -f "$RUNNER/imps/dispatch.mjs" ]]; then
    case "$RUNNER" in
      /|"$HOME"|"$HOME/") echo "Refusing to delete $RUNNER: unsafe path" >&2; exit 1 ;;
    esac
    rm -rf "$RUNNER" && echo "removed $RUNNER"
  else
    echo "Refusing to delete $RUNNER: not an imps kit checkout" >&2
    exit 1
  fi
fi
if [[ "$WIPE_STATE" -eq 1 ]]; then
  rm -rf "$IMPS_HOME_DIR"
  echo "wiped $IMPS_HOME_DIR"
else
  echo "kept state $IMPS_HOME_DIR"
fi
echo "uninstall done."
