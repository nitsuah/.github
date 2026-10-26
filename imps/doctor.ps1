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
        try {
            $r = Invoke-WebRequest -Uri "$base/models" -TimeoutSec 5 -UseBasicParsing
            if ($r.StatusCode -lt 500) { Ok "9router at $base" } else { Bad "9router HTTP $($r.StatusCode) at $base" }
        } catch { Bad "9router not reachable at $base" }
    } catch { Bad "unreadable $settings" }
} else { Bad "missing $settings" }

$runner = if ($env:IMPS_RUNNER) { $env:IMPS_RUNNER }
    elseif ($env:IMPS_KIT_PATH) { $env:IMPS_KIT_PATH }
    elseif (Test-Path (Join-Path $env:USERPROFILE '.imps\kit-path.txt')) {
        (Get-Content (Join-Path $env:USERPROFILE '.imps\kit-path.txt') -Raw).Trim()
    } else { Join-Path $env:LOCALAPPDATA 'imps-runner' }
if (Test-Path (Join-Path $runner 'imps\dispatch.mjs')) { Ok "runner kit at $runner" }
else { Bad "runner kit missing at $runner (run setup.ps1)" }

$home = if ($env:IMPS_HOME) { $env:IMPS_HOME } else { Join-Path $env:USERPROFILE '.imps' }
if (Test-Path $home) { Ok "state dir $home" } else { Bad "state dir missing $home" }

if ($failed) { Write-Host 'doctor: FAIL' -ForegroundColor Red; exit 1 }
Write-Host 'doctor: OK' -ForegroundColor Green
exit 0
