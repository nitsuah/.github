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
    # Before reset, migrate tracked model_quota.json to IMPS_HOME if present (#59).
    # If the file was modified locally, preserve the working-tree file by copying it
    # only when destination is absent; then restore the tracked path so the dirty
    # check passes. If the copy or restore fails, the update fails.
    if (& git ls-files --error-unmatch imps/model_quota.json 2>$null) {
        $status = & git status --porcelain imps/model_quota.json
        if ($LASTEXITCODE -eq 0 -and $status) {
            if (-not (Test-Path -LiteralPath (Join-Path $HomePath 'model_quota.json'))) {
                Copy-Item -LiteralPath (Join-Path $RunnerPath 'imps\model_quota.json') -Destination (Join-Path $HomePath 'model_quota.json') -ErrorAction Stop
            }
            & git checkout -- imps/model_quota.json
            if ($LASTEXITCODE -ne 0) { throw 'failed to restore tracked model_quota.json' }
            Write-Host "migrated tracked model_quota.json to $HomePath/model_quota.json" -ForegroundColor Green
        }
    }
    # Tracked changes only: `reset --hard` never deletes untracked files, so an
    # untracked file is not something this command can lose. model_quota.json
    # used to be tracked and is now machine state in IMPS_HOME (#59) — after an
    # upgrade it survives as an untracked leftover and must not block updates.
    # Also protect untracked files that would be overwritten by the target commit (#64).
    # Use NUL-delimited paths so spaces/newlines in filenames don't break the loop.
    $dirty = & git status --porcelain --untracked-files=no
    if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
    if ($dirty) { throw "$RunnerPath has local changes; refusing to reset. Use a dedicated runner path." }
    git fetch -q origin $Branch
    if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }
    # Protect untracked files that would be overwritten by the target commit (#64).
    $untracked = & git ls-files -z --others --exclude-standard
    if ($LASTEXITCODE -eq 0 -and $untracked) {
        $overwritten = @()
        foreach ($f in $untracked.Split([char]0)) {
            $obj = "origin/${Branch}:$f"
            if ($f -and (& git cat-file -t $obj 2>$null)) {
                $overwritten += $f
            }
        }
        if ($overwritten) { throw "untracked files would be overwritten by reset: $($overwritten -join ', ')" }
    }
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
