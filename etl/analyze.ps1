$deals = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Deals.json' -Raw | ConvertFrom-Json
$calls = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Calls.json' -Raw | ConvertFrom-Json

Write-Host "Total Deals in File: $($deals.Count)"
Write-Host "Total Calls in File: $($calls.Count)"

# Filter for deals created from 6 June 2026 till today
$startDate = [datetime]"2026-06-06"
$filteredDeals = $deals | Where-Object { 
    $dt = [datetime]$_.Created_Time
    $dt -ge $startDate
}

Write-Host "Deals Created from 6 June 2026: $($filteredDeals.Count)"

# Group by Stage
$byStage = $filteredDeals | Group-Object -Property Stage | Select-Object Name, Count | Sort-Object Count -Descending
Write-Host "--- Stage Breakdown ---"
$byStage | ForEach-Object { Write-Host "$($_.Name): $($_.Count)" }

# Filter focus stages: Won / Closed Won / Closed Lost
$targetDeals = $filteredDeals | Where-Object {
    $s = [string]$_.Stage
    $s -like "*Won*" -or $s -like "*Lost*"
}
Write-Host "Target Won/Lost Deals from 6 June 2026: $($targetDeals.Count)"

# Map calls by Deal (What_Id.id)
$callsByDeal = @{}
foreach($c in $calls) {
    if ($c.What_Id -and $c.What_Id.id) {
        $wid = [string]$c.What_Id.id
        if (-not $callsByDeal.ContainsKey($wid)) {
            $callsByDeal[$wid] = New-Object System.Collections.ArrayList
        }
        [void]$callsByDeal[$wid].Add($c)
    }
}

# Analyze Lead Source, Owner, Product, City, Reasons
$wonDeals = $targetDeals | Where-Object { $_.Stage -like "*Won*" }
$lostDeals = $targetDeals | Where-Object { $_.Stage -like "*Lost*" }

Write-Host "`n--- WON DEALS BY LEAD SOURCE ---"
$wonDeals | Group-Object Lead_Source | Sort-Object Count -Descending | Select-Object Name, Count | ForEach-Object { Write-Host "$($_.Name): $($_.Count)" }

Write-Host "`n--- LOST DEALS BY LEAD SOURCE ---"
$lostDeals | Group-Object Lead_Source | Sort-Object Count -Descending | Select-Object Name, Count | ForEach-Object { Write-Host "$($_.Name): $($_.Count)" }

Write-Host "`n--- WON DEALS BY OWNER ---"
$wonDeals | Group-Object { if($_._own){$_._own}elseif($_.Owner){$_.Owner.name}else{"Unknown"} } | Sort-Object Count -Descending | Select-Object Name, Count | ForEach-Object { Write-Host "$($_.Name): $($_.Count)" }

Write-Host "`n--- LOST DEALS BY OWNER ---"
$lostDeals | Group-Object { if($_._own){$_._own}elseif($_.Owner){$_.Owner.name}else{"Unknown"} } | Sort-Object Count -Descending | Select-Object Name, Count | ForEach-Object { Write-Host "$($_.Name): $($_.Count)" }

# Detailed Metrics
$wonCount = $wonDeals.Count
$lostCount = $lostDeals.Count
$totalTarget = $wonCount + $lostCount
$winRate = if($totalTarget -gt 0){ [math]::Round(($wonCount / $totalTarget)*100, 1) } else {0}

Write-Host "`n=== SUMMARY STATS ==="
Write-Host "Total Target Deals (Won + Lost): $totalTarget"
Write-Host "Won Deals: $wonCount"
Write-Host "Lost Deals: $lostCount"
Write-Host "Overall Win Rate: $winRate %"

# Sample Properties check
$sample = $targetDeals[0]
Write-Host "`nSample Deal Fields available:"
$sample.psobject.Properties.Name -join ", "
