#!/usr/bin/env pwsh
# Remove Scheduled Tasks and optionally the runner checkout.
# NEVER deletes ~/.imps (ledger, locks, logs, config) unless -WipeState.
#
#   pwsh -File imps/uninstall.ps1
#   pwsh -File imps/uninstall.ps1 -RemoveRunner
#   pwsh -File imps/uninstall.ps1 -RemoveRunner -WipeState   # destructive
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
    [switch]$RemoveRunner,
    [switch]$WipeState
)

$ErrorActionPreference = 'Stop'
foreach ($t in @('imps-dispatch', 'imps-label-watch')) {
    & schtasks /Delete /TN $t /F 2>$null | Out-Null
    Write-Host "removed task '$t' (if it existed)"
}
foreach ($f in @('hourly.cmd', 'label-watch.cmd')) {
    $p = Join-Path $HomePath $f
    if (Test-Path -LiteralPath $p) {
        Remove-Item -LiteralPath $p -Force
        Write-Host "removed $p"
    }
}
if ($RemoveRunner -and (Test-Path -LiteralPath $RunnerPath)) {
    $full = [System.IO.Path]::GetFullPath($RunnerPath)
    $profile = [System.IO.Path]::GetFullPath($env:USERPROFILE)
    if ($full -match '^[A-Za-z]:\\?$' -or $full -eq $profile) {
        throw "Refusing to delete $RunnerPath: path is a drive root or user profile."
    }
    $isKit = (Test-Path -LiteralPath (Join-Path $RunnerPath '.git')) -and
             (Test-Path -LiteralPath (Join-Path $RunnerPath 'imps\dispatch.mjs'))
    if (-not $isKit) { throw "Refusing to delete $RunnerPath: not an imps kit checkout." }
    Remove-Item -LiteralPath $RunnerPath -Recurse -Force
    Write-Host "removed runner $RunnerPath"
}
if ($WipeState -and (Test-Path -LiteralPath $HomePath)) {
    Remove-Item -LiteralPath $HomePath -Recurse -Force
    Write-Host "wiped state $HomePath"
} else {
    Write-Host "kept state $HomePath (ledger/locks/logs/config)"
}
Write-Host 'uninstall done.'
