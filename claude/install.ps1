#!/usr/bin/env pwsh
# Install the shared Claude Code kit from this checkout into ~/.claude.
#
# Three tiers, never mixed:
#   kit      this repo (public). Skills, hooks, CLAUDE.md, settings/MCP templates.
#            Improvements go upstream via PR; every machine picks them up on update.
#   private  OneDrive claude-sync (or -PrivatePath). Memory, personal context,
#            scheduled-task prompts, licensed assets, third-party hooks. No keys.
#   machine  ~/.claude/machine.json. Keys, URLs and per-machine overrides.
#            Local only: never synced, never committed.
#
# Dry run by default; pass -Apply to change anything.
#   pwsh -File claude/install.ps1            # show the plan
#   pwsh -File claude/install.ps1 -Apply     # do it
[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$KitPath = (Split-Path -Parent $PSScriptRoot),
    [string]$ClaudeHome = (Join-Path $env:USERPROFILE '.claude'),
    [string]$PrivatePath = $(if ($env:CLAUDE_PRIVATE_SYNC) { $env:CLAUDE_PRIVATE_SYNC }
                             else { Join-Path $env:USERPROFILE 'OneDrive\bkup\OneDrive\Documents\claude-sync' }),
    [string]$CodePath = (Join-Path $env:USERPROFILE 'code')
)
$ErrorActionPreference = 'Stop'
$kitClaude = Join-Path $KitPath 'claude'
$machineFile = Join-Path $ClaudeHome 'machine.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $ClaudeHome "backups\kit-$stamp"
$mode = if ($Apply) { 'APPLY' } else { 'DRY RUN' }
Write-Host "Claude kit install ($mode)`n  kit:     $KitPath`n  private: $PrivatePath`n  machine: $machineFile`n"

function Step($msg) { Write-Host "  - $msg" }
function Is-Link($p) { (Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) }
function Backup($p) {
    if (-not (Test-Path -LiteralPath $p) -or (Is-Link $p)) { return }
    if ($Apply) {
        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        Copy-Item -LiteralPath $p -Destination $backupDir -Recurse -Force
    }
}
# Removes only the link itself, never the target's contents.
function Remove-Link($p) { if ($Apply) { [IO.Directory]::Delete($p, $false) } }
function Link-Dir($link, $target) {
    if (Is-Link $link) {
        if ((Get-Item -LiteralPath $link -Force).Target -eq $target) { return }
        Step "relink $link -> $target"; Remove-Link $link
    } elseif (Test-Path -LiteralPath $link) {
        # Never recurse-delete through a parent link: that would delete the synced original.
        if (Is-Link (Split-Path $link)) { throw "refusing to delete ${link}: its parent is a link" }
        Step "replace local copy $link with link -> $target (backed up)"; Backup $link
        if ($Apply) { Remove-Item -LiteralPath $link -Recurse -Force }
    } else { Step "link $link -> $target" }
    if ($Apply) { New-Item -ItemType Junction -Path $link -Target $target | Out-Null }
}
function Merge-Map($base, $over) {
    foreach ($k in @($over.Keys)) {
        if ($base.Contains($k) -and $base[$k] -is [System.Collections.IDictionary] -and $over[$k] -is [System.Collections.IDictionary]) {
            Merge-Map $base[$k] $over[$k]
        } else { $base[$k] = $over[$k] }
    }
}
function Read-Json($p) { Get-Content -LiteralPath $p -Raw | ConvertFrom-Json -AsHashtable }
function Write-Json($p, $obj) {
    if ($Apply) { Backup $p; ($obj | ConvertTo-Json -Depth 32) | Set-Content -LiteralPath $p -Encoding utf8NoBOM }
}

# ── machine.json: seed from the current live config on first run ──────────────
$machine = $null
if (Test-Path -LiteralPath $machineFile) {
    $machine = Read-Json $machineFile
} else {
    $machine = [ordered]@{ secrets = [ordered]@{}; settings = [ordered]@{ env = [ordered]@{} }; mcp = [ordered]@{} }
    $live = Join-Path $ClaudeHome 'settings.json'
    if ((Test-Path -LiteralPath $live) -and -not (Is-Link $live)) {
        $l = Read-Json $live
        if ($l.env) { $machine.settings.env = $l.env }
    }
    $liveMcp = Join-Path $ClaudeHome 'mcp.json'
    if (Test-Path -LiteralPath $liveMcp) {
        $m = Read-Json $liveMcp
        if ($m.obsidian -and $m.obsidian.headers -and $m.obsidian.headers.Authorization) {
            $machine.secrets.OBSIDIAN_AUTH = $m.obsidian.headers.Authorization
        }
    }
    Step "create $machineFile from live config (env: $(@($machine.settings.env.Keys) -join ', '); secrets: $(@($machine.secrets.Keys) -join ', '))"
    if ($Apply) {
        $machine | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $machineFile -Encoding utf8NoBOM
        # Owner-only ACL: drop inherited entries, grant the current user full control.
        & icacls $machineFile /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
    }
}
if (-not $machine.secrets) { $machine.secrets = [ordered]@{} }

$vars = @{
    '{{HOME}}' = $env:USERPROFILE; '{{CLAUDE}}' = $ClaudeHome; '{{CODE}}' = $CodePath; '{{KIT}}' = $KitPath
}
$missing = [System.Collections.Generic.List[string]]::new()
function Expand($o) {
    if ($o -is [System.Collections.IDictionary]) { foreach ($k in @($o.Keys)) { $o[$k] = Expand $o[$k] }; return $o }
    if ($o -is [System.Collections.IList] -and $o -isnot [string]) { for ($i = 0; $i -lt $o.Count; $i++) { $o[$i] = Expand $o[$i] }; return ,$o }
    if ($o -is [string]) {
        foreach ($k in $vars.Keys) { $o = $o.Replace($k, $vars[$k]) }
        $o = [regex]::Replace($o, '\{\{secret:([A-Z0-9_]+)\}\}', {
            param($mm) $n = $mm.Groups[1].Value
            if ($machine.secrets.Contains($n)) { $machine.secrets[$n] } else { $missing.Add($n); '' } })
    }
    return $o
}

# ── settings.json and mcp.json: template + machine overlay ─────────────────────
$settings = Expand (Read-Json (Join-Path $kitClaude 'settings.base.json'))
if ($machine.settings) { Merge-Map $settings $machine.settings }
$sPath = Join-Path $ClaudeHome 'settings.json'
if ((Is-Link $sPath) -or ((Test-Path $sPath) -and (Get-Item $sPath).LinkType -eq 'HardLink')) { Step 'settings.json is linked to a synced copy; replacing with a local file' }
Step "render settings.json (env keys from machine.json: $(@($settings.env.Keys) -join ', '))"
if ($Apply -and (Test-Path $sPath)) { Backup $sPath; Remove-Item -LiteralPath $sPath -Force }
Write-Json $sPath $settings

$mcp = Expand (Read-Json (Join-Path $kitClaude 'mcp.base.json'))
if ($machine.mcp) { Merge-Map $mcp $machine.mcp }
$mPath = Join-Path $ClaudeHome 'mcp.json'
Step "render mcp.json (servers: $(@($mcp.Keys) -join ', '))"
if ($Apply -and (Test-Path $mPath)) { Backup $mPath; Remove-Item -LiteralPath $mPath -Force }
Write-Json $mPath $mcp

# ── CLAUDE.md: copied, so updates arrive with each kit update ──────────────────
$cPath = Join-Path $ClaudeHome 'CLAUDE.md'
Step 'copy CLAUDE.md from kit'
if ($Apply) { if (Test-Path $cPath) { Backup $cPath; Remove-Item -LiteralPath $cPath -Force }; Copy-Item (Join-Path $kitClaude 'CLAUDE.md') $cPath }

# ── skills/ and hooks/: kit entries win, private entries fill the gaps ─────────
foreach ($pair in @(@('skills', (Join-Path $KitPath 'skills')), @('hooks', (Join-Path $kitClaude 'hooks')))) {
    $name, $kitDir = $pair
    $dest = Join-Path $ClaudeHome $name
    $wasLink = Is-Link $dest
    if ($wasLink) { Step "$name/ is one link to a synced folder; converting to a real folder of per-entry links"; Remove-Link $dest }
    if ($Apply) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }
    # Dry run with the old link still in place: describe the result instead of inspecting through it.
    $doLink = if ($wasLink -and -not $Apply) { { param($l, $t) Step "link $l -> $t" } } else { { param($l, $t) Link-Dir $l $t } }
    $usable = { param($d) $name -ne 'skills' -or (Test-Path (Join-Path $d.FullName 'SKILL.md')) }
    $kitNames = @()
    if (Test-Path $kitDir) {
        foreach ($d in Get-ChildItem -LiteralPath $kitDir -Directory) {
            if (& $usable $d) { $kitNames += $d.Name; & $doLink (Join-Path $dest $d.Name) $d.FullName }
        }
    }
    $privDir = Join-Path $PrivatePath $name
    if (Test-Path $privDir) {
        foreach ($d in Get-ChildItem -LiteralPath $privDir -Directory) {
            if ($kitNames -notcontains $d.Name -and (& $usable $d)) { & $doLink (Join-Path $dest $d.Name) $d.FullName }
        }
    }
}

# ── private tier: memory link, plus two-way copy for personal folders ──────────
$memLink = Join-Path $ClaudeHome ('projects\' + ($CodePath -replace '[:\\/]', '-') + '\memory')
$memTarget = Join-Path $PrivatePath 'memory'
if (Test-Path $memTarget) {
    if ($Apply) { New-Item -ItemType Directory -Force -Path (Split-Path $memLink) | Out-Null }
    Link-Dir $memLink $memTarget
}
foreach ($dir in 'scheduled-tasks', 'private') {
    $local = Join-Path $ClaudeHome $dir; $priv = Join-Path $PrivatePath $dir
    if ((Test-Path $local) -and -not (Is-Link $local)) {
        Step "back up $dir/ to private sync"
        if ($Apply) { New-Item -ItemType Directory -Force -Path $priv | Out-Null; Copy-Item "$local\*" $priv -Recurse -Force }
    } elseif (Test-Path $priv) {
        Step "restore $dir/ from private sync"
        if ($Apply) { Copy-Item $priv $local -Recurse -Force }
    }
}

# ── checks ─────────────────────────────────────────────────────────────────────
foreach ($f in 'settings.json', 'mcp.json') {
    $p = Join-Path $PrivatePath $f
    if (Test-Path $p) { Write-Warning "$p is a retired copy that may hold keys in a synced folder. Delete it once this install works." }
}
if ($missing.Count) { Write-Warning "Secrets not set in machine.json (secrets.*): $(($missing | Sort-Object -Unique) -join ', ')" }
if (-not $Apply) { Write-Host "`nNothing changed. Re-run with -Apply." }
else { Write-Host "`nDone. Backups (if any): $backupDir. Restart Claude Code to load the new config." }
