$raw = [System.IO.File]::ReadAllText('c:\Users\ADMIN\.antigravity-ide\dashboard\crm_data.js')
$idx = $raw.IndexOf('"stage"')
$snippet = $raw.Substring($idx, 150)
Write-Host "Stage field sample:"
Write-Host $snippet
Write-Host ""
Write-Host "Counting stage values..."
$wonCount = ([regex]::Matches($raw, '"stage":\s*"Closed Won"')).Count
$lostCount = ([regex]::Matches($raw, '"stage":\s*"Closed Lost"')).Count
$prospectCount = ([regex]::Matches($raw, '"stage":\s*"Prospect"')).Count
Write-Host "Closed Won: $wonCount"
Write-Host "Closed Lost: $lostCount"
Write-Host "Prospect: $prospectCount"

# Check calls sub-array
$callsIdx = $raw.IndexOf('"calls":')
$callsSnip = $raw.Substring($callsIdx, 200)
Write-Host ""
Write-Host "Calls field sample:"
Write-Host $callsSnip
