# ─────────────────────────────────────────────────────────────
#  Lucira Zoho CRM ETL — shared library
#  Reads OAuth creds from disk (never inline) and provides
#  token refresh + robust COQL pagination with retry/rate-limit.
# ─────────────────────────────────────────────────────────────
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:DC        = 'in'
$script:TOKEN_URL = "https://accounts.zoho.$($script:DC)/oauth/v2/token"
$script:COQL_URL  = "https://www.zohoapis.$($script:DC)/crm/v8/coql"

function Get-ZohoCreds {
    # Prefer a local, git-ignored secrets file; fall back to the legacy
    # hardcoded creds in zoho-task-function/main.py (already in repo).
    $root = Split-Path -Parent $PSScriptRoot
    $envFile = Join-Path $PSScriptRoot '.zoho.env'
    if (Test-Path $envFile) {
        $m = @{}
        Get-Content $envFile | ForEach-Object {
            if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') { $m[$Matches[1]] = $Matches[2] }
        }
        return @{ id=$m['ZOHO_CLIENT_ID']; secret=$m['ZOHO_CLIENT_SECRET']; refresh=$m['ZOHO_REFRESH_TOKEN'] }
    }
    $src = Join-Path $root 'zoho-task-function\main.py'
    $txt = Get-Content $src -Raw
    $id      = if ($txt -match 'CLIENT_ID\s*=\s*"([^"]+)"')     { $Matches[1] }
    $secret  = if ($txt -match 'CLIENT_SECRET\s*=\s*"([^"]+)"') { $Matches[1] }
    $refresh = if ($txt -match 'REFRESH_TOKEN\s*=\s*"([^"]+)"') { $Matches[1] }
    return @{ id=$id; secret=$secret; refresh=$refresh }
}

function Get-ZohoToken {
    $c = Get-ZohoCreds
    $body = @{ refresh_token=$c.refresh; client_id=$c.id; client_secret=$c.secret; grant_type='refresh_token' }
    $tok = Invoke-RestMethod -Uri $script:TOKEN_URL -Method Post -Body $body -TimeoutSec 40
    if (-not $tok.access_token) { throw "Token refresh failed: $($tok | ConvertTo-Json -Compress)" }
    return $tok.access_token
}

# Execute a single COQL query with retry + rate-limit handling.
function Invoke-Coql {
    param([string]$Token, [string]$Query, [int]$MaxRetry = 5)
    $h = @{ Authorization = "Zoho-oauthtoken $Token" }
    $payload = @{ select_query = $Query } | ConvertTo-Json -Compress
    for ($attempt = 1; $attempt -le $MaxRetry; $attempt++) {
        try {
            $r = Invoke-RestMethod -Uri $script:COQL_URL -Method Post -Headers $h -Body $payload -ContentType 'application/json' -TimeoutSec 60
            return $r
        } catch {
            $code = $null
            try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
            if ($code -eq 204) { return @{ data=@(); info=@{ more_records=$false } } }
            $detail = ''
            if ($_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
            # 429 rate-limit or 5xx -> backoff & retry
            if ($code -eq 429 -or ($code -ge 500)) {
                Start-Sleep -Seconds ([Math]::Min(30, [Math]::Pow(2, $attempt)))
                continue
            }
            if ($attempt -eq $MaxRetry) { throw "COQL failed (HTTP $code): $detail`nQuery: $Query" }
            Start-Sleep -Milliseconds 800
        }
    }
}

# Keyset pagination over an entire module (no offset cap). Returns all rows.
# $Fields must include 'id'. Ordered by id asc; cursor = last id seen.
function Get-AllRecords {
    param([string]$Token, [string]$Module, [string[]]$Fields, [string]$Where = 'id is not null')
    $cols = ($Fields -join ', ')
    $all = New-Object System.Collections.ArrayList
    $lastId = '0'
    $page = 0
    while ($true) {
        $page++
        $q = "select $cols from $Module where ($Where) and id > $lastId order by id asc limit 2000"
        $r = Invoke-Coql -Token $Token -Query $q
        $batch = @($r.data)
        if ($batch.Count -eq 0) { break }
        foreach ($row in $batch) { [void]$all.Add($row) }
        $lastId = $batch[$batch.Count - 1].id
        if ($batch.Count -lt 2000) { break }
        Start-Sleep -Milliseconds 120   # gentle on rate limits
    }
    return $all
}

function Get-CoqlCount {
    param([string]$Token, [string]$Module, [string]$Where = 'id is not null')
    $r = Invoke-Coql -Token $Token -Query "select COUNT(id) from $Module where $Where"
    return [int]$r.data[0].'COUNT(id)'
}
