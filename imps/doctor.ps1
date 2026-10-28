#!/usr/bin/env pwsh
# Check prerequisites without installing. Exit 0 if all ok, 1 otherwise.
#
#   pwsh -File imps/doctor.ps1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Continue'
$failed = $false
function Ok($m) { Write-Host "  ok  $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  !!  $m" -ForegroundColor Red; $script:failed = $true }
function Info($m) { Write-Host "  ..  $m" -ForegroundColor DarkGray }

function Test-RouterReachable([string]$Base) {
    try {
        $r = Invoke-WebRequest -Uri "$Base/models" -TimeoutSec 5 -UseBasicParsing
        return ($r.StatusCode -ge 100 -and $r.StatusCode -lt 500)
    } catch {
        $resp = $_.Exception.Response
        if ($resp -and $resp.StatusCode) {
            $code = [int]$resp.StatusCode
            return ($code -ge 100 -and $code -lt 500)
        }
        return $false
    }
}

Write-Host 'imps doctor' -ForegroundColor Cyan
if (Get-Command node -EA SilentlyContinue) { Ok "node $(node -v)" } else { Bad 'node missing' }
if (Get-Command git -EA SilentlyContinue) { Ok "$(git --version)" } else { Bad 'git missing' }
if (Get-Command gh -EA SilentlyContinue) {
    gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok 'gh authenticated' } else { Bad 'gh not authenticated (gh auth login)' }
} else { Bad 'gh missing' }
if (Get-Command docker -EA SilentlyContinue) {
    docker info 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok 'docker reachable' } else { Bad 'docker not running' }
} else { Bad 'docker missing' }

# The runner spawns the npm-installed claude.exe itself (the .cmd shim splits args), so
# `claude --version` working in a shell is not enough. Same lookup as runner.mjs.
# An explicit IMPS_CLAUDE_BIN is used exclusively (no fallback), exactly as runner.mjs does.
$claudePkg = 'node_modules\@anthropic-ai\claude-code\bin\claude.exe'
$claudeCandidates = if ($env:IMPS_CLAUDE_BIN) { @($env:IMPS_CLAUDE_BIN) }
    else { @((Join-Path $env:APPDATA "npm\$claudePkg"), $(if ($env:npm_config_prefix) { Join-Path $env:npm_config_prefix $claudePkg })) | Where-Object { $_ } }
$claudeBin = $claudeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($claudeBin) { Ok "claude binary $claudeBin" }
else { Bad "claude binary not found (looked at: $($claudeCandidates -join ', ')); npm i -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code, or set IMPS_CLAUDE_BIN" }

# Briefs' test:/lint: commands are POSIX-style and run through Git Bash (cmd.exe does not
# group single quotes and the gate fails "tests exit 2" before testing the imp's code).
# Like runner.mjs gateShell(): an explicit IMPS_SHELL wins and is never replaced by a default.
$shellCandidates = if ($env:IMPS_SHELL) { @($env:IMPS_SHELL) }
    else { @("$env:ProgramFiles\Git\bin\bash.exe", "${env:ProgramFiles(x86)}\Git\bin\bash.exe", "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe") }
$gitBash = $shellCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($gitBash) { Ok "gate shell $gitBash" }
else { Bad "Git Bash not found (looked at: $($shellCandidates -join ', ')); install Git for Windows or fix IMPS_SHELL, else brief test commands run under cmd.exe and fail" }

. (Join-Path $PSScriptRoot 'router-env.ps1')
$router = Resolve-Router
$base = $router.BaseUrl
if (Test-RouterReachable $base) { Ok "9router at $base ($($router.Note))" } else { Bad "9router not reachable at $base ($($router.Note))" }
if ($router.KeyFrom -in 'MISSING','persisted-only') { Bad 'no 9router key: set user env NINEROUTER_KEY (imps/README.md "Configure 9router") or settings.json env' }

$stateDir = if ($env:IMPS_HOME) { $env:IMPS_HOME } else { Join-Path $env:USERPROFILE '.imps' }
$kitPointer = Join-Path $stateDir 'kit-path.txt'
$runner = if ($env:IMPS_RUNNER) { $env:IMPS_RUNNER }
    elseif ($env:IMPS_KIT_PATH) { $env:IMPS_KIT_PATH }
    elseif (Test-Path -LiteralPath $kitPointer) {
        (Get-Content -LiteralPath $kitPointer -Raw).Trim()
    } else { Join-Path $env:LOCALAPPDATA 'imps-runner' }
if (Test-Path -LiteralPath (Join-Path $runner 'imps\dispatch.mjs')) { Ok "runner kit at $runner" }
else { Bad "runner kit missing at $runner (run setup.ps1)" }

$codeDir = if ($env:IMPS_CODE) { $env:IMPS_CODE } else { Join-Path $env:USERPROFILE 'code' }
$codeKit = Join-Path $codeDir '.github'
if (Test-Path -LiteralPath (Join-Path $codeKit 'imps\dispatch.mjs')) {
    $runnerFull = (Resolve-Path -LiteralPath $runner -ErrorAction SilentlyContinue).Path
    $codeFull = (Resolve-Path -LiteralPath $codeKit -ErrorAction SilentlyContinue).Path
    if ($runnerFull -and $codeFull -and ($runnerFull -eq $codeFull)) {
        Bad "IMPS_CODE\.github is the runner checkout — kit self-work needs a separate clone"
    } else { Ok "kit self-work clone at $codeKit" }
} else { Bad "kit self-work clone missing at $codeKit (re-run setup.ps1)" }

if (Test-Path -LiteralPath $stateDir) { Ok "state dir $stateDir" } else { Bad "state dir missing $stateDir" }

# An imp can only work in a repo cloned under IMPS_CODE; a missing clone used to show up
# as a failed run on the issue. Check every repo that has an imp:ready issue.
$codeRoot = if ($env:IMPS_CODE) { $env:IMPS_CODE } else { Join-Path $env:USERPROFILE 'code' }
if (Get-Command gh -EA SilentlyContinue) {
    $readyJson = gh search issues --owner nitsuah --state open --label imp:ready --limit 100 --json repository 2>&1
    $ghExit = $LASTEXITCODE
    $ready = if ($ghExit -eq 0) { $readyJson | ConvertFrom-Json }
    if ($ghExit -ne 0) { Info "could not list imp:ready issues, so the clone check was skipped: $(($readyJson | Out-String).Trim())" }
    elseif ($ready) {
        $names = $ready | ForEach-Object { $_.repository.name } | Sort-Object -Unique
        $missing = @($names | Where-Object { -not (Test-Path -LiteralPath (Join-Path $codeRoot $_)) })
        if ($missing.Count) { Bad "imp:ready issues in repos not cloned under ${codeRoot}: $($missing -join ', ') (gh repo clone nitsuah/<repo> $codeRoot\<repo>)" }
        else { Ok "all $($names.Count) repos with imp:ready issues are cloned under $codeRoot" }
    }
}

$vault = $env:IMPS_VAULT_PROMPT
if ([string]::IsNullOrWhiteSpace($vault)) {
    $cfg = Join-Path $stateDir 'config.json'
    if (Test-Path -LiteralPath $cfg) {
        try { $vault = [string]((Get-Content $cfg -Raw | ConvertFrom-Json).vaultPrompt) } catch { $vault = $null }
    }
}
if (-not [string]::IsNullOrWhiteSpace($vault) -and (Test-Path -LiteralPath $vault)) { Ok "vault playbook $vault" }
elseif (-not [string]::IsNullOrWhiteSpace($vault)) { Bad "IMPS_VAULT_PROMPT set but missing: $vault" }
else { Info 'IMPS_VAULT_PROMPT unset (optional; stash wrappers set it from vault_prompt)' }

# Topology: one warlock per machine, and the runner it executes is a real,
# current git checkout. Checked here so install fails loudly rather than
# succeeding into an hourly no-op (WARLOCK.md, #62). Never fatal on its own —
# warlock.mjs reports every check, and doctor is the right place to show them.
$warlock = Join-Path $PSScriptRoot 'warlock.mjs'
if (Test-Path -LiteralPath $warlock) {
    Write-Host '  topology (warlock.mjs):' -ForegroundColor DarkGray
    & node $warlock
    if ($LASTEXITCODE -ne 0) { $script:failed = $true }
} else { Info 'warlock.mjs not present (older kit); topology unchecked' }

# Preflight: fail fast if the checkout is a stub or missing files. This replaces
# the old implicit success on incomplete checkouts (#62).
$preflight = Join-Path $PSScriptRoot 'preflight.mjs'
if (Test-Path -LiteralPath $preflight) {
    Write-Host '  preflight:' -ForegroundColor DarkGray
    & node $preflight
    if ($LASTEXITCODE -ne 0) { $script:failed = $true }
} else { Bad 'preflight.mjs missing — kit is incomplete (re-run setup.ps1)' }

if ($failed) { Write-Host 'doctor: FAIL' -ForegroundColor Red; exit 1 }
