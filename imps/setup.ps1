#!/usr/bin/env pwsh
# Bootstrap or repair a detached imps-runner checkout and (on Windows) the
# hourly Scheduled Task + 5-minute label-watch (on by default). Idempotent:
# re-running updates the kit without clobbering ~/.imps state (locks, logs,
# stats, config, ledger). Also ensures IMPS_CODE/.github exists for kit self-work.
#
#   pwsh -File imps/setup.ps1
#   pwsh -File imps/setup.ps1 -RunnerPath 'D:\tools\imps-runner'
#   pwsh -File imps/setup.ps1 -SkipLabelWatch   # hourly only
#   pwsh -File imps/setup.ps1 -SkipTask         # kit only
#
# Env overrides: IMPS_RUNNER, IMPS_HOME, IMPS_CODE, IMPS_KIT_REPO, IMPS_LABEL_WATCH=0
[CmdletBinding()]
param(
    [string]$RunnerPath = $(if ($env:IMPS_RUNNER) { $env:IMPS_RUNNER } else { Join-Path $env:LOCALAPPDATA 'imps-runner' }),
    [string]$HomePath = $(if ($env:IMPS_HOME) { $env:IMPS_HOME } else { Join-Path $env:USERPROFILE '.imps' }),
    [string]$CodePath = $(if ($env:IMPS_CODE) { $env:IMPS_CODE } else { Join-Path $env:USERPROFILE 'code' }),
    [string]$KitRepo = $(if ($env:IMPS_KIT_REPO) { $env:IMPS_KIT_REPO } else { 'nitsuah/.github' }),
    [string]$Branch = 'main',
    [string]$VaultPrompt = $(if ($env:IMPS_VAULT_PROMPT) { $env:IMPS_VAULT_PROMPT } else { '' }),
    [switch]$SkipTask,
    [switch]$SkipLabelWatch,
    [switch]$EnableLabelWatch, # deprecated alias: label watch is ON by default
    [switch]$SkipDoctor
)

$ErrorActionPreference = 'Stop'
$TaskName = 'imps-dispatch'
$WatchName = 'imps-label-watch'
$KitFolder = '.github'
$CodeKitPath = Join-Path $CodePath $KitFolder

# Label watch ON by default; kill with -SkipLabelWatch or IMPS_LABEL_WATCH=0/false.
$wantLabelWatch = -not $SkipLabelWatch
if ($env:IMPS_LABEL_WATCH -eq '0' -or $env:IMPS_LABEL_WATCH -eq 'false') { $wantLabelWatch = $false }
if ($EnableLabelWatch) { $wantLabelWatch = $true }

function Write-Ok($m) { Write-Host "  ok  $m" -ForegroundColor Green }
function Write-Bad($m) { Write-Host "  !!  $m" -ForegroundColor Red }
function Write-Hint($m) { Write-Host "      $m" -ForegroundColor Yellow }

Write-Host "imps setup" -ForegroundColor Cyan
Write-Host "  runner : $RunnerPath"
Write-Host "  state  : $HomePath  (preserved across updates)"
Write-Host "  code   : $CodePath"
Write-Host "  kit    : $KitRepo@$Branch  (self-work clone → $CodeKitPath)"
Write-Host "  label  : $(if ($wantLabelWatch) { 'watch every 5 min (default)' } else { 'hourly only' })"

# ── doctor ────────────────────────────────────────────────────────────────
$failed = $false
if (-not $SkipDoctor) {
    Write-Host "`nprerequisites:" -ForegroundColor Cyan
    if (Get-Command node -ErrorAction SilentlyContinue) {
        Write-Ok "node $((node -v 2>$null))"
    } else {
        Write-Bad 'node not on PATH'
        Write-Hint 'Install Node 20+ from https://nodejs.org and reopen the shell.'
        $failed = $true
    }
    if (Get-Command git -ErrorAction SilentlyContinue) {
        Write-Ok "git $((git --version 2>$null))"
    } else {
        Write-Bad 'git not on PATH'
        Write-Hint 'Install Git for Windows: https://git-scm.com/download/win'
        $failed = $true
    }
    if (Get-Command gh -ErrorAction SilentlyContinue) {
        $auth = & gh auth status 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) { Write-Ok 'gh authenticated' }
        else {
            Write-Bad 'gh not authenticated'
            Write-Hint 'Run: gh auth login'
            $failed = $true
        }
    } else {
        Write-Bad 'gh not on PATH'
        Write-Hint 'Install GitHub CLI: https://cli.github.com/'
        $failed = $true
    }
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        & docker info 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Ok 'docker reachable' }
        else {
            Write-Bad 'docker installed but not running'
            Write-Hint 'Start Docker Desktop, then re-run setup.'
            $failed = $true
        }
    } else {
        Write-Bad 'docker not on PATH'
        Write-Hint 'Install Docker Desktop and ensure it starts on login.'
        $failed = $true
    }
    # 9router: ~/.claude/settings.json ANTHROPIC_BASE_URL
    $settings = Join-Path $env:USERPROFILE '.claude\settings.json'
    if (Test-Path -LiteralPath $settings) {
        try {
            $envMap = (Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json).env
            $base = [string]$envMap.ANTHROPIC_BASE_URL
            if ([string]::IsNullOrWhiteSpace($base)) { $base = 'http://localhost:20128/v1' }
            $base = $base.TrimEnd('/')
            # Any HTTP response < 500 means the router is up (401/404 still count).
            $reachable = $false
            try {
                $probe = Invoke-WebRequest -Uri "$base/models" -Method GET -TimeoutSec 5 -UseBasicParsing
                $reachable = ($probe.StatusCode -ge 100 -and $probe.StatusCode -lt 500)
            } catch {
                $resp = $_.Exception.Response
                if ($resp -and $resp.StatusCode) {
                    $code = [int]$resp.StatusCode
                    $reachable = ($code -ge 100 -and $code -lt 500)
                }
            }
            if ($reachable) {
                Write-Ok "9router reachable at $base"
            } else {
                Write-Bad "9router not reachable at $base"
                Write-Hint 'Start 9router (the local router that serves free models), then re-run.'
                $failed = $true
            }
        } catch {
            Write-Bad "could not read $settings"
            Write-Hint 'Ensure ~/.claude/settings.json has env.ANTHROPIC_BASE_URL and a 9router key.'
            $failed = $true
        }
    } else {
        Write-Bad "missing $settings"
        Write-Hint 'Create it with env.ANTHROPIC_BASE_URL (e.g. http://localhost:20128/v1) and NINEROUTER_KEY.'
        $failed = $true
    }
    if ($failed) {
        Write-Host "`nFix the items above, then re-run setup. Partial install was not written." -ForegroundColor Red
        exit 1
    }
}

# ── state dir (never wiped) ───────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $HomePath | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $HomePath 'runs') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $HomePath 'briefs') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $HomePath 'logs') | Out-Null
$configPath = Join-Path $HomePath 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    $cfg = [ordered]@{
        rsi = $true
        rsiDailyIssueCap = 3
        autoMergeTrust = 3
        labelWatch = [bool]$wantLabelWatch
        runnerPath = $RunnerPath
        codePath = $CodePath
        kitCodePath = $CodeKitPath
    }
    if (-not [string]::IsNullOrWhiteSpace($VaultPrompt)) { $cfg.vaultPrompt = $VaultPrompt }
    $cfg | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
    Write-Ok "wrote $configPath (kill switches: `"rsi`": false, `"labelWatch`": false)"
} else {
    Write-Ok "kept existing $configPath"
    try {
        $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        $dirty = $false
        $explicitLabel = $PSBoundParameters.ContainsKey('SkipLabelWatch') -or $PSBoundParameters.ContainsKey('EnableLabelWatch') -or $env:IMPS_LABEL_WATCH
        # Honor persisted labelWatch:false unless this run explicitly overrides it.
        if (-not $explicitLabel -and $existing.labelWatch -eq $false) { $wantLabelWatch = $false }
        if (-not [string]::IsNullOrWhiteSpace($VaultPrompt)) {
            $existing | Add-Member -NotePropertyName vaultPrompt -NotePropertyValue $VaultPrompt -Force
            $dirty = $true
            Write-Ok "set vaultPrompt in $configPath"
        }
        if ($null -eq $existing.labelWatch) {
            $existing | Add-Member -NotePropertyName labelWatch -NotePropertyValue ([bool]$wantLabelWatch) -Force
            $dirty = $true
        } elseif ($explicitLabel) {
            $existing | Add-Member -NotePropertyName labelWatch -NotePropertyValue ([bool]$wantLabelWatch) -Force
            $dirty = $true
        }
        if ($null -eq $existing.kitCodePath) {
            $existing | Add-Member -NotePropertyName kitCodePath -NotePropertyValue $CodeKitPath -Force
            $dirty = $true
        }
        if ($dirty) { $existing | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8 }
    } catch { Write-Hint "could not update $configPath" }
}

# ── detached kit checkout ─────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $RunnerPath) | Out-Null
$gitDir = Join-Path $RunnerPath '.git'
if (Test-Path -LiteralPath $gitDir) {
    Write-Host "`nupdating runner checkout…" -ForegroundColor Cyan
    Push-Location $RunnerPath
    try {
        $dirty = & git status --porcelain
        if ($LASTEXITCODE -ne 0) { throw "git status failed" }
        if ($dirty) { throw "$RunnerPath has local changes; refusing to reset. Use a dedicated runner path (default %LOCALAPPDATA%\imps-runner)." }
        & git remote set-url origin "https://github.com/$KitRepo.git"
        if ($LASTEXITCODE -ne 0) { throw "git remote set-url failed" }
        & git fetch -q origin $Branch
        if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
        & git checkout -q $Branch
        if ($LASTEXITCODE -ne 0) { throw "git checkout failed" }
        & git reset -q --hard "origin/$Branch"
        if ($LASTEXITCODE -ne 0) { throw "git reset failed" }
        Write-Ok "reset $RunnerPath to origin/$Branch"
    } finally { Pop-Location }
} else {
    Write-Host "`ncloning kit into runner…" -ForegroundColor Cyan
    if (Test-Path -LiteralPath $RunnerPath) {
        # Empty or non-git folder: only clone if it has no precious local files.
        $kids = @(Get-ChildItem -LiteralPath $RunnerPath -Force -ErrorAction SilentlyContinue)
        if ($kids.Count -gt 0) {
            Write-Bad "$RunnerPath exists and is not a git checkout"
            Write-Hint 'Move it aside or pass -RunnerPath to a new empty location.'
            exit 1
        }
    }
    & git clone -q --branch $Branch "https://github.com/$KitRepo.git" $RunnerPath
    if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
    Write-Ok "cloned $KitRepo → $RunnerPath"
}

$Dispatch = Join-Path $RunnerPath 'imps\dispatch.mjs'
if (-not (Test-Path -LiteralPath $Dispatch)) {
    Write-Bad "kit missing imps/dispatch.mjs under $RunnerPath"
    exit 1
}

# Pointer file for stash wrappers (IMPS_KIT_PATH / .imps/kit-path.txt)
$env:IMPS_KIT_PATH = $RunnerPath
$kitPointer = Join-Path $HomePath 'kit-path.txt'
Set-Content -LiteralPath $kitPointer -Value $RunnerPath -Encoding utf8
Write-Ok "kit pointer → $kitPointer (stash can copy to <repo>/.imps/kit-path.txt)"

# ── CODE/.github: first-class clone for kit self-work (worktrees only) ────
# Runner checkout is reset hourly and must never be a worktree base. Imps and
# RSI that improve the kit use separate worktrees off this CODE clone, open a
# normal PR, and after merge update.ps1 / hourly reset pulls main into the runner.
New-Item -ItemType Directory -Force -Path $CodePath | Out-Null
$runnerResolved = (Resolve-Path -LiteralPath $RunnerPath).Path
# Reject equality or containment before clone/refresh (not only for existing .git).
$codeParent = if (Test-Path -LiteralPath $CodeKitPath) {
    (Resolve-Path -LiteralPath $CodeKitPath).Path
} else {
    # Prospective path: resolve parent + leaf so we catch CodePath == runner.
    $parent = (Resolve-Path -LiteralPath $CodePath).Path
    Join-Path $parent $KitFolder
}
$codeNorm = $codeParent.TrimEnd('\', '/').ToLowerInvariant()
$runnerNorm = $runnerResolved.TrimEnd('\', '/').ToLowerInvariant()
if ($codeNorm -eq $runnerNorm -or $codeNorm.StartsWith("$runnerNorm\") -or $codeNorm.StartsWith("$runnerNorm/")) {
    Write-Bad "$CodeKitPath equals or sits under the runner checkout ($RunnerPath); pick a different IMPS_CODE"
    exit 1
}
function Test-KitRemote([string]$Path, [string]$ExpectedRepo) {
    $url = (& git -C $Path remote get-url origin 2>$null)
    if (-not $url) { return $false }
    $norm = ($url -replace '\.git$', '' -replace '^.+github\.com[:/]', '').Trim().ToLowerInvariant()
    return ($norm -eq $ExpectedRepo.ToLowerInvariant())
}
if (Test-Path -LiteralPath (Join-Path $CodeKitPath '.git')) {
    if (-not (Test-KitRemote $CodeKitPath $KitRepo)) {
        Write-Bad "$CodeKitPath origin is not $KitRepo; refusing to rewrite it. Move it aside and re-run."
        exit 1
    }
    Write-Host "`nrefreshing kit clone for self-work…" -ForegroundColor Cyan
    Push-Location $CodeKitPath
    try {
        & git remote set-url origin "https://github.com/$KitRepo.git"
        & git fetch -q origin $Branch
        if ($LASTEXITCODE -ne 0) { throw "git fetch failed for $CodeKitPath" }
        # Do NOT hard-reset: this may be Austin's interactive clone. Worktrees are separate.
        Write-Ok "fetched $CodeKitPath (no reset; imps use worktrees off this clone)"
    } finally { Pop-Location }
} elseif (Test-Path -LiteralPath $CodeKitPath) {
    Write-Bad "$CodeKitPath exists and is not a git checkout"
    Write-Hint "Move it aside, or clone $KitRepo there manually."
    exit 1
} else {
    Write-Host "`ncloning kit into IMPS_CODE for self-work…" -ForegroundColor Cyan
    & git clone -q --branch $Branch "https://github.com/$KitRepo.git" $CodeKitPath
    if ($LASTEXITCODE -ne 0) { throw "git clone of $KitRepo into $CodeKitPath failed" }
    Write-Ok "cloned $KitRepo → $CodeKitPath (imps open PRs from worktrees here)"
}

# ── hourly.cmd (state dir; calls into runner) ─────────────────────────────
$hourly = Join-Path $HomePath 'hourly.cmd'
$hourlyBody = @"
@echo off
REM Generated by imps/setup.ps1 — do not put secrets here.
setlocal
set IMPS_HOME=$HomePath
set IMPS_CODE=$CodePath
set IMPS_KIT_PATH=$RunnerPath
cd /d "$RunnerPath"
REM Only merged kit code runs unattended.
git fetch -q origin $Branch
git reset -q --hard origin/$Branch
node imps\dispatch.mjs >> "%IMPS_HOME%\hourly.log" 2>&1
"@
Set-Content -LiteralPath $hourly -Value $hourlyBody -Encoding ascii
Write-Ok "wrote $hourly"

$watch = Join-Path $HomePath 'label-watch.cmd'
if ($wantLabelWatch) {
    $watchBody = @"
@echo off
setlocal
REM Kill switches: IMPS_LABEL_WATCH=0/false, or config.json "labelWatch": false.
if /I "%IMPS_LABEL_WATCH%"=="0" exit /b 0
if /I "%IMPS_LABEL_WATCH%"=="false" exit /b 0
set IMPS_HOME=$HomePath
node -e "try{var c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.exit(c.labelWatch===false?0:1)}catch(e){process.exit(1)}" "%IMPS_HOME%\config.json" && exit /b 0
set IMPS_CODE=$CodePath
set IMPS_KIT_PATH=$RunnerPath
cd /d "$RunnerPath"
git fetch -q origin $Branch
git reset -q --hard origin/$Branch
REM Cheap tick: dispatch no-ops under the lock if a cycle is already running.
node imps\dispatch.mjs >> "%IMPS_HOME%\label-watch.log" 2>&1
"@
    Set-Content -LiteralPath $watch -Value $watchBody -Encoding ascii
    Write-Ok "wrote $watch (5-min label watch; lock prevents overlap)"
}

# ── Scheduled Task ────────────────────────────────────────────────────────
if (-not $SkipTask) {
    Write-Host "`nscheduled task:" -ForegroundColor Cyan
    # Unregister any previous task, then recreate (idempotent re-register).
    & schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
    & schtasks /Create /TN $TaskName /SC HOURLY /ST ("{0:HH:mm}" -f (Get-Date).Date.AddMinutes(7)) /TR "conhost.exe --headless cmd.exe /d /c `"$hourly`"" /RL LIMITED /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        # Fallback without conhost headless (older Windows)
        & schtasks /Create /TN $TaskName /SC HOURLY /MO 1 /ST 00:07 /TR "cmd.exe /d /c `"$hourly`"" /RL LIMITED /F | Out-Null
    }
    if ($LASTEXITCODE -eq 0) { Write-Ok "registered task '$TaskName' (hourly at :07)" }
    else {
        Write-Bad "could not register '$TaskName' (run elevated if needed)"
        Write-Hint "Manual: schtasks /Create /TN $TaskName /SC HOURLY /ST 00:07 /TR `"cmd.exe /d /c $hourly`""
    }

    & schtasks /Delete /TN $WatchName /F 2>$null | Out-Null
    if ($wantLabelWatch) {
        & schtasks /Create /TN $WatchName /SC MINUTE /MO 5 /TR "conhost.exe --headless cmd.exe /d /c `"$watch`"" /RL LIMITED /F | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Ok "registered task '$WatchName' (every 5 min; lock prevents overlap)" }
        else { Write-Bad "could not register '$WatchName'" }
    } else {
        Write-Ok "skipped '$WatchName' (IMPS_LABEL_WATCH=0 / -SkipLabelWatch / labelWatch:false)"
    }
}

Write-Host "`ndone." -ForegroundColor Cyan
Write-Host "  Dry-run a cycle:  `$env:IMPS_HOME='$HomePath'; node `"$Dispatch`" --dry-run"
Write-Host "  Update kit:       pwsh -File `"$(Join-Path $RunnerPath 'imps\update.ps1')`""
Write-Host "  Uninstall task:   pwsh -File `"$(Join-Path $RunnerPath 'imps\uninstall.ps1')`""
Write-Host "  RSI kill switch:  set `"rsi`": false in $configPath  (or IMPS_RSI=0)"
Write-Host "  Label-watch kill: set `"labelWatch`": false in $configPath  (or IMPS_LABEL_WATCH=0)"
Write-Host "  Kit self-work:    briefs use repo: .github → worktrees under $CodeKitPath"
exit 0
