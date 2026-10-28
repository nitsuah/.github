# Shared by setup.ps1 and doctor.ps1. Mirrors resolveRouter() in lib.mjs:
# user-level env vars first, ~/.claude/settings.json `env` as the fallback.
# Never returns or prints the key itself; only whether it is set and where.
function Resolve-Router {
    $settingsEnv = $null
    $settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
    if (Test-Path -LiteralPath $settingsPath) {
        try { $settingsEnv = (Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).env } catch { $settingsEnv = $null }
    }
    # Process env first, then the persisted User scope (a task started before the var was set only sees the latter via this lookup).
    function FromEnv([string]$n) {
        $v = [Environment]::GetEnvironmentVariable($n)
        if ([string]::IsNullOrWhiteSpace($v)) { $v = [Environment]::GetEnvironmentVariable($n, 'User') }
        if ([string]::IsNullOrWhiteSpace($v)) { return $null }
        return $v.Trim()
    }
    function FromSettings([string]$n) {
        if ($null -eq $settingsEnv) { return $null }
        $v = [string]$settingsEnv.$n
        if ([string]::IsNullOrWhiteSpace($v)) { return $null }
        return $v.Trim()
    }
    $base = $null; $urlFrom = 'default'
    foreach ($c in @(
            @{ src = 'env'; name = 'ANTHROPIC_BASE_URL' }, @{ src = 'settings'; name = 'ANTHROPIC_BASE_URL' },
            @{ src = 'env'; name = 'NINEROUTER_URL' }, @{ src = 'settings'; name = 'NINEROUTER_URL' })) {
        $v = if ($c.src -eq 'env') { FromEnv $c.name } else { FromSettings $c.name }
        if ($v) {
            $base = $v.TrimEnd('/')
            if ($c.name -eq 'NINEROUTER_URL' -and -not $base.EndsWith('/v1')) { $base += '/v1' }
            $urlFrom = $c.src
            break
        }
    }
    if (-not $base) { $base = 'http://localhost:20128/v1' }
    $keyFrom = 'MISSING'
    if ((FromEnv 'NINEROUTER_KEY') -or (FromEnv 'ANTHROPIC_API_KEY')) { $keyFrom = 'env' }
    elseif ((FromSettings 'NINEROUTER_KEY') -or (FromSettings 'ANTHROPIC_API_KEY')) { $keyFrom = 'settings' }
    [pscustomobject]@{
        BaseUrl = $base; UrlFrom = $urlFrom; KeyFrom = $keyFrom
        Note    = "url from $urlFrom, key " + $(if ($keyFrom -eq 'MISSING') { 'MISSING' } else { "set ($keyFrom)" })
    }
}
