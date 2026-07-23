. "$PSScriptRoot\_lib.ps1"
$ErrorActionPreference = 'Stop'
$t = Get-ZohoToken
$h = @{ Authorization = "Zoho-oauthtoken $t" }
$base = "https://www.zohoapis.$($script:DC)/crm/v8"
try {
    $r = Invoke-RestMethod -Uri "$base/Deals?fields=id,Deal_Name,Created_Time&per_page=2" -Method Get -Headers $h -TimeoutSec 40
    "RECORDS API OK. sample count=$($r.data.Count) more=$($r.info.more_records) page_token?=$([bool]$r.info.next_page_token)"
    $r.data | ForEach-Object { "  id=$($_.id) created=$($_.Created_Time)" }
} catch {
    "RECORDS ERR: $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)"
}
