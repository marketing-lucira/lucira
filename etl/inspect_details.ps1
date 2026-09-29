$deals = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Deals.json' -Raw | ConvertFrom-Json
$startDate = [datetime]"2026-06-06"
$wonDeals = @($deals | Where-Object { $_.Stage -like '*Won*' -and ([datetime]$_.Created_Time) -ge $startDate })
Write-Host "Won Deals created on or after 2026-06-06: $($wonDeals.Count)"

$online = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Online_Activity_Logs.json' -Raw | ConvertFrom-Json
$tasks = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Tasks.json' -Raw | ConvertFrom-Json
$events = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Events.json' -Raw | ConvertFrom-Json
$custAgg = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\customer_events_agg.json' -Raw | ConvertFrom-Json

Write-Host "Online logs sample (first 3):"
$online | Select-Object -First 3 | ConvertTo-Json -Depth 3 | Write-Host

Write-Host "Tasks sample (first 2):"
$tasks | Select-Object -First 2 | ConvertTo-Json -Depth 3 | Write-Host

Write-Host "Events sample (first 2):"
$events | Select-Object -First 2 | ConvertTo-Json -Depth 3 | Write-Host

Write-Host "Customer Events Agg sample:"
$custAgg | ConvertTo-Json -Depth 3 | Write-Host
