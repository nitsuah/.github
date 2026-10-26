#!/usr/bin/env pwsh
# Pull the latest merged kit into the detached imps-runner checkout.
# Does not touch ~/.imps state (ledger, locks, logs, config).
#
#   pwsh -File imps/update.ps1
#   pwsh -File imps/update.ps1 -RunnerPath 'D:\tools\imps-runner'
[CmdletBinding()]
param(
    [string]$HomePath = $(if ($env:IMPS_HOME) { $env:IMPS_HOME } else { Join-Path $env:USERPROFILE '.imps' }),
    [string]$RunnerPath = $(
        if ($env:IMPS_RUNNER) { $env:IMPS_RUNNER }
        elseif ($env:IMPS_KIT_PATH) { $env:IMPS_KIT_PATH }
        elseif (Test-Path -LiteralPath (Join-Path $(if ($env:IMPS_HOME) { $env:IMPS_HOME } else { Join-Path $env:USERPROFILE '.imps' }) 'kit-path.txt')) {
            (Get-Content -LiteralPath (Join-Path $(if ($env:IMPS_HOME) { $env:IMPS_HOME } else { Join-Path $env:USERPROFILE '.imps' }) 'kit-path.txt') -Raw).Trim()
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
    # Tracked changes only: `reset --hard` never deletes untracked files, so an
    # untracked file is not something this command can lose. model_quota.json
    # used to be tracked and is now machine state in IMPS_HOME (#59) — after an
    # upgrade it survives as an untracked leftover and must not block updates.
    $dirty = & git status --porcelain --untracked-files=no
    if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
    if ($dirty) { throw "$RunnerPath has local changes; refusing to reset. Use a dedicated runner path." }
    git fetch -q origin $Branch
    if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }
    git checkout -q $Branch
    if ($LASTEXITCODE -ne 0) { throw 'git checkout failed' }
    git reset -q --hard "origin/$Branch"
    if ($LASTEXITCODE -ne 0) { throw 'git reset failed' }
    # Verify the checkout is usable after reset (#62).
    & node imps\preflight.mjs
    if ($LASTEXITCODE -ne 0) { throw "$RunnerPath does not look like a usable imps kit after update" }
    Write-Host "updated $RunnerPath → origin/$Branch" -ForegroundColor Green
    git log -1 --oneline
} finally { Pop-Location }
