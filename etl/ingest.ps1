# Ingest the N most-recently-saved MCP COQL page files into one per-module raw JSON.
# Grabs the newest $Pages files matching the executeCOQLQuery pattern, concatenates
# .data.data, de-dups by id, writes etl\raw\<Module>.json, prints validation.
param(
    [Parameter(Mandatory=$true)][string]$Module,
    [Parameter(Mandatory=$true)][int]$Expected,
    [Parameter(Mandatory=$true)][int]$Pages
)
$ErrorActionPreference = 'Stop'
$tr  = "C:\Users\ADMIN\.claude\projects\c--Users-ADMIN--antigravity-ide\82c54a5d-13bf-49aa-859f-2c5a10e77de7\tool-results"
$out = Join-Path $PSScriptRoot 'raw'
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Path $out | Out-Null }

$files = Get-ChildItem $tr -Filter 'mcp-claude_ai_Zoho_CRM-executeCOQLQuery-*.txt' |
         Sort-Object LastWriteTime -Descending | Select-Object -First $Pages | Sort-Object LastWriteTime
$rows = New-Object System.Collections.ArrayList
$pageInfo = @()
foreach ($f in $files) {
    $j = Get-Content $f.FullName -Raw | ConvertFrom-Json
    $batch = @($j.data.data)
    foreach ($r in $batch) { [void]$rows.Add($r) }
    $pageInfo += [pscustomobject]@{ file=$f.Name; rows=$batch.Count }
}
$seen = @{}
$uniq = New-Object System.Collections.ArrayList
foreach ($r in $rows) { $k = [string]$r.id; if ($k -and -not $seen.ContainsKey($k)) { $seen[$k]=$true; [void]$uniq.Add($r) } }

$dest = Join-Path $out "$Module.json"
$uniq | ConvertTo-Json -Depth 8 -Compress | Set-Content $dest -Encoding UTF8
"Module   : $Module"
"Pages    : $($files.Count) (requested $Pages)"
$pageInfo | ForEach-Object { "  {0,-58} {1}" -f $_.file, $_.rows }
"Rows read: $($rows.Count) | unique-by-id: $($uniq.Count) | expected: $Expected"
if ($uniq.Count -eq $Expected) { "STATUS   : OK (exact)" }
elseif ([math]::Abs($uniq.Count - $Expected) -le [math]::Ceiling($Expected*0.002)) { "STATUS   : OK within live-drift" }
else { "STATUS   : CHECK - delta $($uniq.Count - $Expected)" }
"Saved    : $dest"