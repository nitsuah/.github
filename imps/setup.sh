#!/usr/bin/env bash
# Bootstrap or repair a detached imps-runner checkout (Unix). Idempotent.
# Windows Task Scheduler users should prefer setup.ps1.
#
#   ./imps/setup.sh
#   IMPS_RUNNER=~/tools/imps-runner ./imps/setup.sh
set -euo pipefail

RUNNER="${IMPS_RUNNER:-${XDG_DATA_HOME:-$HOME/.local/share}/imps-runner}"
IMPS_HOME_DIR="${IMPS_HOME:-$HOME/.imps}"
CODE="${IMPS_CODE:-$HOME/code}"
KIT_REPO="${IMPS_KIT_REPO:-nitsuah/.github}"
BRANCH="${IMPS_KIT_BRANCH:-main}"
SKIP_CRON="${SKIP_CRON:-0}"

ok() { printf '  ok  %s\n' "$*"; }
bad() { printf '  !!  %s\n' "$*"; FAILED=1; }
hint() { printf '      %s\n' "$*"; }
FAILED=0

echo "imps setup"
echo "  runner : $RUNNER"
echo "  state  : $IMPS_HOME_DIR"
echo "  code   : $CODE"
echo "  kit    : $KIT_REPO@$BRANCH"

echo
echo "prerequisites:"
command -v node >/dev/null && ok "node $(node -v)" || { bad "node missing"; hint "Install Node 20+"; }
command -v git >/dev/null && ok "$(git --version)" || { bad "git missing"; }
if command -v gh >/dev/null; then
  if gh auth status >/dev/null 2>&1; then ok "gh authenticated"; else bad "gh not authenticated"; hint "gh auth login"; fi
else bad "gh missing"; fi
if command -v docker >/dev/null; then
  if docker info >/dev/null 2>&1; then ok "docker reachable"; else bad "docker not running"; fi
else bad "docker missing"; fi

SETTINGS="${HOME}/.claude/settings.json"
if [[ -f "$SETTINGS" ]]; then
  BASE=$(node -e "try{const s=require(process.argv[1]).env||{};console.log((s.ANTHROPIC_BASE_URL||'http://localhost:20128/v1').replace(/\/$/,''))}catch{console.log('http://localhost:20128/v1')}" "$SETTINGS")
  if curl -fsS --max-time 5 "$BASE/models" >/dev/null 2>&1; then ok "9router at $BASE"
  else bad "9router not reachable at $BASE"; hint "Start 9router, then re-run."; fi
else bad "missing $SETTINGS"; fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "Fix the items above, then re-run. Nothing was written."
  exit 1
fi

mkdir -p "$IMPS_HOME_DIR"/{runs,briefs,logs}
CONFIG="$IMPS_HOME_DIR/config.json"
if [[ ! -f "$CONFIG" ]]; then
  cat >"$CONFIG" <<EOF
{
  "rsi": true,
  "rsiDailyIssueCap": 3,
  "autoMergeTrust": 3,
  "runnerPath": "$RUNNER",
  "codePath": "$CODE"
}
EOF
  ok "wrote $CONFIG"
else
  ok "kept existing $CONFIG"
fi

mkdir -p "$(dirname "$RUNNER")"
if [[ -d "$RUNNER/.git" ]]; then
  git -C "$RUNNER" remote set-url origin "https://github.com/${KIT_REPO}.git" 2>/dev/null || true
  git -C "$RUNNER" fetch -q origin "$BRANCH"
  git -C "$RUNNER" checkout -q "$BRANCH"
  git -C "$RUNNER" reset -q --hard "origin/$BRANCH"
  ok "reset $RUNNER to origin/$BRANCH"
else
  if [[ -e "$RUNNER" ]] && [[ -n "$(ls -A "$RUNNER" 2>/dev/null || true)" ]]; then
    bad "$RUNNER exists and is not a git checkout"
    exit 1
  fi
  git clone -q --branch "$BRANCH" "https://github.com/${KIT_REPO}.git" "$RUNNER"
  ok "cloned $KIT_REPO → $RUNNER"
fi

[[ -f "$RUNNER/imps/dispatch.mjs" ]] || { bad "missing imps/dispatch.mjs"; exit 1; }
printf '%s\n' "$RUNNER" >"$IMPS_HOME_DIR/kit-path.txt"
ok "kit pointer → $IMPS_HOME_DIR/kit-path.txt"

HOURLY="$IMPS_HOME_DIR/hourly.sh"
cat >"$HOURLY" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export IMPS_HOME="$IMPS_HOME_DIR"
export IMPS_CODE="$CODE"
export IMPS_KIT_PATH="$RUNNER"
cd "$RUNNER"
git fetch -q origin $BRANCH
git reset -q --hard origin/$BRANCH
node imps/dispatch.mjs >>"\$IMPS_HOME/hourly.log" 2>&1
EOF
chmod +x "$HOURLY"
ok "wrote $HOURLY"

if [[ "$SKIP_CRON" != "1" ]]; then
  CRON_LINE="7 * * * * $HOURLY"
  if command -v crontab >/dev/null; then
    (crontab -l 2>/dev/null | grep -v 'imps/dispatch\|imps-runner\|hourly.sh' || true; echo "$CRON_LINE") | crontab -
    ok "installed hourly crontab: $CRON_LINE"
  else
    hint "crontab not available; run $HOURLY from your own scheduler"
  fi
fi

echo
echo "done."
echo "  Dry-run:  IMPS_HOME=$IMPS_HOME_DIR node $RUNNER/imps/dispatch.mjs --dry-run"
echo "  Update:   $RUNNER/imps/update.sh"
echo "  RSI kill: set \"rsi\": false in $CONFIG (or IMPS_RSI=0)"
