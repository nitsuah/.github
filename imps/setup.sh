#!/usr/bin/env bash
# Bootstrap or repair a detached imps-runner checkout (Unix). Idempotent.
# Ensures IMPS_CODE/.github exists for kit self-work. Label-watch cron is ON
# by default (kill with SKIP_LABEL_WATCH=1 or IMPS_LABEL_WATCH=0).
# Windows Task Scheduler users should prefer setup.ps1.
#
#   ./imps/setup.sh
#   IMPS_RUNNER=~/tools/imps-runner ./imps/setup.sh
#   SKIP_LABEL_WATCH=1 ./imps/setup.sh
set -euo pipefail

RUNNER="${IMPS_RUNNER:-${XDG_DATA_HOME:-$HOME/.local/share}/imps-runner}"
IMPS_HOME_DIR="${IMPS_HOME:-$HOME/.imps}"
CODE="${IMPS_CODE:-$HOME/code}"
KIT_REPO="${IMPS_KIT_REPO:-nitsuah/.github}"
KIT_FOLDER=".github"
CODE_KIT="$CODE/$KIT_FOLDER"
BRANCH="${IMPS_KIT_BRANCH:-main}"
SKIP_CRON="${SKIP_CRON:-0}"
VAULT_PROMPT="${IMPS_VAULT_PROMPT:-}"

WANT_LABEL_WATCH=1
if [[ "${SKIP_LABEL_WATCH:-0}" == "1" ]]; then WANT_LABEL_WATCH=0; fi
if [[ "${IMPS_LABEL_WATCH:-}" == "0" || "${IMPS_LABEL_WATCH:-}" == "false" ]]; then WANT_LABEL_WATCH=0; fi

ok() { printf '  ok  %s\n' "$*"; }
bad() { printf '  !!  %s\n' "$*"; FAILED=1; }
hint() { printf '      %s\n' "$*"; }
FAILED=0

echo "imps setup"
echo "  runner : $RUNNER"
echo "  state  : $IMPS_HOME_DIR"
echo "  code   : $CODE"
echo "  kit    : $KIT_REPO@$BRANCH  (self-work clone → $CODE_KIT)"
if [[ "$WANT_LABEL_WATCH" -eq 1 ]]; then echo "  label  : watch every 5 min (default)"; else echo "  label  : hourly only"; fi

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
  CODE_HTTP=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/models" 2>/dev/null || echo 000)
  if [[ "$CODE_HTTP" =~ ^[0-9]+$ ]] && (( CODE_HTTP >= 100 && CODE_HTTP < 500 )); then ok "9router at $BASE"
  else bad "9router not reachable at $BASE"; hint "Start 9router, then re-run."; fi
else bad "missing $SETTINGS"; fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "Fix the items above, then re-run. Nothing was written."
  exit 1
fi

mkdir -p "$IMPS_HOME_DIR"/{runs,briefs,logs}
CONFIG="$IMPS_HOME_DIR/config.json"
LABEL_JSON=true
[[ "$WANT_LABEL_WATCH" -eq 1 ]] || LABEL_JSON=false
if [[ ! -f "$CONFIG" ]]; then
  if [[ -n "$VAULT_PROMPT" ]]; then
    cat >"$CONFIG" <<EOF
{
  "rsi": true,
  "rsiDailyIssueCap": 3,
  "autoMergeTrust": 3,
  "labelWatch": $LABEL_JSON,
  "runnerPath": "$RUNNER",
  "codePath": "$CODE",
  "kitCodePath": "$CODE_KIT",
  "vaultPrompt": "$VAULT_PROMPT"
}
EOF
  else
    cat >"$CONFIG" <<EOF
{
  "rsi": true,
  "rsiDailyIssueCap": 3,
  "autoMergeTrust": 3,
  "labelWatch": $LABEL_JSON,
  "runnerPath": "$RUNNER",
  "codePath": "$CODE",
  "kitCodePath": "$CODE_KIT"
}
EOF
  fi
  ok "wrote $CONFIG"
else
  ok "kept existing $CONFIG"
fi

mkdir -p "$(dirname "$RUNNER")"
if [[ -d "$RUNNER/.git" ]]; then
  if [[ -n "$(git -C "$RUNNER" status --porcelain)" ]]; then
    bad "$RUNNER has local changes; refusing to reset. Use a dedicated runner path."
    exit 1
  fi
  git -C "$RUNNER" remote set-url origin "https://github.com/${KIT_REPO}.git"
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

# CODE/.github — first-class clone for kit self-work (separate worktrees; never the runner).
mkdir -p "$CODE"
RUNNER_REAL=$(cd "$RUNNER" && pwd -P)
if [[ -d "$CODE_KIT/.git" ]]; then
  CODE_KIT_REAL=$(cd "$CODE_KIT" && pwd -P)
  if [[ "$CODE_KIT_REAL" == "$RUNNER_REAL" ]]; then
    bad "$CODE_KIT points at the runner checkout; move/rename it and re-run"
    exit 1
  fi
  git -C "$CODE_KIT" remote set-url origin "https://github.com/${KIT_REPO}.git"
  git -C "$CODE_KIT" fetch -q origin "$BRANCH"
  ok "fetched $CODE_KIT (no reset; imps use worktrees off this clone)"
elif [[ -e "$CODE_KIT" ]]; then
  bad "$CODE_KIT exists and is not a git checkout"
  exit 1
else
  git clone -q --branch "$BRANCH" "https://github.com/${KIT_REPO}.git" "$CODE_KIT"
  ok "cloned $KIT_REPO → $CODE_KIT (imps open PRs from worktrees here)"
fi

HOURLY="$IMPS_HOME_DIR/hourly.sh"
cat >"$HOURLY" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="$PATH"
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

WATCH="$IMPS_HOME_DIR/label-watch.sh"
if [[ "$WANT_LABEL_WATCH" -eq 1 ]]; then
  cat >"$WATCH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
# Kill switch: IMPS_LABEL_WATCH=0/false or SKIP_LABEL_WATCH at setup time.
case "\${IMPS_LABEL_WATCH:-}" in 0|false) exit 0 ;; esac
export PATH="$PATH"
export IMPS_HOME="$IMPS_HOME_DIR"
export IMPS_CODE="$CODE"
export IMPS_KIT_PATH="$RUNNER"
cd "$RUNNER"
git fetch -q origin $BRANCH
git reset -q --hard origin/$BRANCH
node imps/dispatch.mjs >>"\$IMPS_HOME/label-watch.log" 2>&1
EOF
  chmod +x "$WATCH"
  ok "wrote $WATCH (5-min label watch; lock prevents overlap)"
fi

if [[ "$SKIP_CRON" != "1" ]]; then
  if command -v crontab >/dev/null; then
    EXISTING=$(crontab -l 2>/dev/null | grep -vF "$HOURLY" | grep -vF "$WATCH" || true)
    {
      echo "$EXISTING"
      echo "7 * * * * $HOURLY"
      if [[ "$WANT_LABEL_WATCH" -eq 1 ]]; then
        echo "*/5 * * * * $WATCH"
      fi
    } | grep -v '^$' | crontab -
    ok "installed crontab: hourly + $([[ "$WANT_LABEL_WATCH" -eq 1 ]] && echo '5-min label-watch' || echo 'no label-watch')"
  else
    hint "crontab not available; run $HOURLY from your own scheduler"
  fi
fi

echo
echo "done."
echo "  Dry-run:  IMPS_HOME=$IMPS_HOME_DIR node $RUNNER/imps/dispatch.mjs --dry-run"
echo "  Update:   $RUNNER/imps/update.sh"
echo "  RSI kill: set \"rsi\": false in $CONFIG (or IMPS_RSI=0)"
echo "  Label kill: set \"labelWatch\": false in $CONFIG (or IMPS_LABEL_WATCH=0)"
echo "  Kit self-work: repo: .github → worktrees under $CODE_KIT"
