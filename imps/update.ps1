#!/usr/bin/env pwsh
# Pull the latest merged kit into the detached imps-runner checkout.
# Does not touch ~/.imps state (ledger, locks, logs, config).
#
#   pwsh -File imps/update.ps1
#   pwsh -File imps/update.ps1 -RunnerPath 'D:\tools\imps-runner'
[CmdletBinding()]
param(
    [string]$RunnerPath = $(
        if ($env:IMPS_RUNNER) { $env:IMPS_RUNNER }
        elseif ($env:IMPS_KIT_PATH) { $env:IMPS_KIT_PATH }
        elseif (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.imps\kit-path.txt')) {
            (Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.imps\kit-path.txt') -Raw).Trim()
        } else { Join-Path $env:LOCALAPPDATA 'imps-runner' }
    ),
    [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $RunnerPath '.git'))) {
    Write-Error "Not a kit checkout: $RunnerPath. Run setup.ps1 first."
    exit 1
}
Push-Location $RunnerPath
try {
    git fetch -q origin $Branch
    if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }
    git checkout -q $Branch
    git reset -q --hard "origin/$Branch"
    Write-Host "updated $RunnerPath → origin/$Branch" -ForegroundColor Green
    git log -1 --oneline
} finally { Pop-Location }
