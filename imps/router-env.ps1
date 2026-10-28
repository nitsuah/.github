# Shared by setup.ps1 and doctor.ps1. Mirrors resolveRouter() in lib.mjs:
# user-level env vars first, ~/.claude/settings.json `env` as the fallback.
# Never returns or prints the key itself; only whether it is set and where.
function Resolve-Router {
    $settingsEnv = $null
    $settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
    if (Test-Path -LiteralPath $settingsPath) {
        try { $settingsEnv = (Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).env } catch { $settingsEnv = $null }
    }
    # Only the PROCESS env counts as available: a Node child launched from this session never sees a value that exists only at persisted User scope.
    function FromEnv([string]$n) {
        $v = [Environment]::GetEnvironmentVariable($n)
        if ([string]::IsNullOrWhiteSpace($v)) { return $null }
        return $v.Trim()
    }
    function FromSettings([string]$n) {
        if ($null -eq $settingsEnv) { return $null }
        $v = [string]$settingsEnv.$n
        if ([string]::IsNullOrWhiteSpace($v)) { return $null }
        return $v.Trim()
    }
    # Mirrors resolveRouter() in lib.mjs: router-specific names first, ambient ANTHROPIC_* distrusted, anthropic.com refused.
    function IsAnthropicHost([string]$u) {
        try { $h = ([Uri]$u).Host.ToLowerInvariant(); return ($h -eq 'anthropic.com' -or $h.EndsWith('.anthropic.com')) } catch { return $true }
    }
    $default = 'http://localhost:20128/v1'
    $base = $null; $urlFrom = 'default'; $genericEnvUrl = $false
    if ($v = FromEnv 'NINEROUTER_URL') { $base = $v.TrimEnd('/'); if (-not $base.EndsWith('/v1')) { $base += '/v1' }; $urlFrom = 'env' }
    elseif ($v = FromSettings 'ANTHROPIC_BASE_URL') { $base = $v.TrimEnd('/'); $urlFrom = 'settings' }
    elseif ($v = FromSettings 'NINEROUTER_URL') { $base = $v.TrimEnd('/'); if (-not $base.EndsWith('/v1')) { $base += '/v1' }; $urlFrom = 'settings' }
    elseif (($v = FromEnv 'ANTHROPIC_BASE_URL') -and -not (IsAnthropicHost $v)) { $base = $v.TrimEnd('/'); $urlFrom = 'env'; $genericEnvUrl = $true }
    if (-not $base) { $base = $default }
    $keyFrom = 'MISSING'
    if (FromEnv 'NINEROUTER_KEY') { $keyFrom = 'env' }
    elseif ((FromSettings 'NINEROUTER_KEY') -or (FromSettings 'ANTHROPIC_API_KEY')) { $keyFrom = 'settings' }
    elseif ($genericEnvUrl -and (FromEnv 'ANTHROPIC_API_KEY')) { $keyFrom = 'env' }
    $refused = $null
    if (IsAnthropicHost $base) { $refused = "refusing $base (anthropic.com is never a 9router)"; $base = $default; $urlFrom = 'default'; $keyFrom = 'MISSING' }
    # Only the PROCESS env counts as available; a value saved only at User scope is not seen by this session or its Node children.
    $persisted = $false
    foreach ($n in 'NINEROUTER_KEY', 'ANTHROPIC_API_KEY') { if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($n, 'User'))) { $persisted = $true } }
    if ($keyFrom -eq 'MISSING' -and $persisted -and -not $refused) { $keyFrom = 'persisted-only' }
    $keyNote = switch ($keyFrom) {
        'MISSING' { 'MISSING' }
        'persisted-only' { 'saved at User scope but NOT set in this session: open a new terminal (and sign out/in for Task Scheduler)' }
        default { "set ($keyFrom)" }
    }
    if ($refused) { $keyNote += "; $refused" }
    [pscustomobject]@{
        BaseUrl = $base; UrlFrom = $urlFrom; KeyFrom = $keyFrom
        Note    = "url from $urlFrom, key $keyNote"
    }
}
