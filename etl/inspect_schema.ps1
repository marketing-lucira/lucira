$deals = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Deals.json' -Raw | ConvertFrom-Json
$wonDeals = @($deals | Where-Object { $_.Stage -like '*Won*' })
Write-Host "Total Deals: $($deals.Count)"
Write-Host "Won Deals: $($wonDeals.Count)"
if($wonDeals.Count -gt 0){
    Write-Host "Sample Won Deal Sample Fields:"
    $wonDeals[0] | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name | Select-Object -First 30 | ForEach-Object { Write-Host " - $_ : $($wonDeals[0].$_)" }
}

$online = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Online_Activity_Logs.json' -Raw | ConvertFrom-Json
Write-Host "Total Online Logs: $($online.Count)"
if($online.Count -gt 0){
    Write-Host "Sample Online Log:"
    $online[0] | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name | ForEach-Object { Write-Host " - $_ : $($online[0].$_)" }
}

$calls = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Calls.json' -Raw | ConvertFrom-Json
Write-Host "Total Calls: $($calls.Count)"
if($calls.Count -gt 0){
    Write-Host "Sample Call:"
    $calls[0] | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name | ForEach-Object { Write-Host " - $_ : $($calls[0].$_)" }
}

$tasks = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Tasks.json' -Raw | ConvertFrom-Json
Write-Host "Total Tasks: $($tasks.Count)"

$events = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Events.json' -Raw | ConvertFrom-Json
Write-Host "Total Events: $($events.Count)"
