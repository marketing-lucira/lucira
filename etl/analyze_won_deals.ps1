$deals = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Deals.json' -Raw | ConvertFrom-Json
$calls = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Calls.json' -Raw | ConvertFrom-Json
$tasks = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Tasks.json' -Raw | ConvertFrom-Json
$events = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Events.json' -Raw | ConvertFrom-Json
$online = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Online_Activity_Logs.json' -Raw | ConvertFrom-Json
$custAgg = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\customer_events_agg.json' -Raw | ConvertFrom-Json

$startDate = [datetime]"2026-06-06"
$wonDeals = @($deals | Where-Object { $_.Stage -like '*Won*' -and ([datetime]$_.Created_Time) -ge $startDate })
$allWonDealsEver = @($deals | Where-Object { $_.Stage -like '*Won*' })

Write-Host "Won Deals since June 6, 2026: $($wonDeals.Count)"
Write-Host "All Won Deals ever in CRM: $($allWonDealsEver.Count)"

# Let's inspect fields on won deals
$wonDeals | Select-Object -First 5 | Select-Object id, Stage, Amount, Lead_Source, Deal_Trigger_Event, Created_Time, Closing_Date, Mobile | Format-Table -AutoSize

# Map calls by What_Id
$callsByDeal = @{}
foreach($c in $calls) {
    if ($c.What_Id -and $c.What_Id.id) {
        $wid = [string]$c.What_Id.id
        if (-not $callsByDeal.ContainsKey($wid)) { $callsByDeal[$wid] = New-Object System.Collections.ArrayList }
        [void]$callsByDeal[$wid].Add($c)
    }
}

# Map tasks by What_Id or deal
$tasksByDeal = @{}
foreach($t in $tasks) {
    if ($t.What_Id -and $t.What_Id.id) {
        $wid = [string]$t.What_Id.id
        if (-not $tasksByDeal.ContainsKey($wid)) { $tasksByDeal[$wid] = New-Object System.Collections.ArrayList }
        [void]$tasksByDeal[$wid].Add($t)
    }
}

Write-Host "Calls matched to Won Deals:"
$wonCallsCount = 0
foreach($d in $wonDeals) {
    $id = [string]$d.id
    if($callsByDeal.ContainsKey($id)) {
        $wonCallsCount += $callsByDeal[$id].Count
    }
}
Write-Host "Total calls linked to June 6+ Won Deals: $wonCallsCount"
