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

$settings = Join-Path $env:USERPROFILE '.claude\settings.json'
if (Test-Path -LiteralPath $settings) {
    try {
        $base = [string]((Get-Content $settings -Raw | ConvertFrom-Json).env.ANTHROPIC_BASE_URL)
        if ([string]::IsNullOrWhiteSpace($base)) { $base = 'http://localhost:20128/v1' }
        $base = $base.TrimEnd('/')
        if (Test-RouterReachable $base) { Ok "9router at $base" } else { Bad "9router not reachable at $base" }
    } catch { Bad "unreadable $settings" }
} else { Bad "missing $settings" }

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
Write-Host 'doctor: OK' -ForegroundColor Green
exit 0
