$deals = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Deals.json' -Raw | ConvertFrom-Json
$calls = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Calls.json' -Raw | ConvertFrom-Json

$startDate = [datetime]"2026-06-06"
$targetDeals = $deals | Where-Object { 
    $dt = [datetime]$_.Created_Time
    $dt -ge $startDate -and ($_.Stage -like "*Won*" -or $_.Stage -like "*Lost*")
}

$wonDeals = $targetDeals | Where-Object { $_.Stage -like "*Won*" }
$lostDeals = $targetDeals | Where-Object { $_.Stage -like "*Lost*" }

Write-Host "=== 1. REASON FOR LOSS BREAKDOWN ==="
$lostDeals | Group-Object Reason_For_Loss__s | Sort-Object Count -Descending | Select-Object Name, Count | ForEach-Object { Write-Host "$($_.Name): $($_.Count)" }

Write-Host "`n=== 2. UTM SOURCE BREAKDOWN ==="
Write-Host "WON DEALS:"
$wonDeals | Group-Object UTM_Source | Sort-Object Count -Descending | ForEach-Object { Write-Host "$($_.Name): $($_.Count)" }
Write-Host "LOST DEALS:"
$lostDeals | Group-Object UTM_Source | Sort-Object Count -Descending | ForEach-Object { Write-Host "$($_.Name): $($_.Count)" }

Write-Host "`n=== 3. DEAL TRIGGER EVENT / PRODUCT BREAKDOWN ==="
Write-Host "WON DEALS:"
$wonDeals | Group-Object Deal_Trigger_Event | Sort-Object Count -Descending | Select-Object -First 10 | ForEach-Object { Write-Host "$($_.Name): $($_.Count)" }
Write-Host "LOST DEALS:"
$lostDeals | Group-Object Deal_Trigger_Event | Sort-Object Count -Descending | Select-Object -First 10 | ForEach-Object { Write-Host "$($_.Name): $($_.Count)" }

Write-Host "`n=== 4. SALES EXECUTIVE CONVERSION RATES ==="
$owners = $targetDeals | ForEach-Object { if($_._own){$_._own}elseif($_.Owner){$_.Owner.name}else{"Unknown"} } | Select-Object -Unique
foreach($o in $owners) {
    $w = ($wonDeals | Where-Object { ($_._own -eq $o) -or ($_.Owner.name -eq $o) }).Count
    $l = ($lostDeals | Where-Object { ($_._own -eq $o) -or ($_.Owner.name -eq $o) }).Count
    $tot = $w + $l
    if ($tot -gt 5) {
        $conv = [math]::Round(($w / $tot) * 100, 1)
        Write-Host "${o}: Total=$tot, Won=$w, Lost=$l, ConvRate=${conv}%"
    }
}

Write-Host "`n=== 5. AVERAGE DEAL AMOUNT ==="
$wonAmt = ($wonDeals | Measure-Object -Property Amount -Average).Average
$lostAmt = ($lostDeals | Measure-Object -Property Amount -Average).Average
Write-Host "Won Deals Avg Amount: ₹ $([math]::Round($wonAmt, 2))"
Write-Host "Lost Deals Avg Amount: ₹ $([math]::Round($lostAmt, 2))"

Write-Host "`n=== 6. AVERAGE ACTIVITIES / CALLS PER DEAL ==="
$wonAct = ($wonDeals | Measure-Object -Property Number_of_activity -Average).Average
$lostAct = ($lostDeals | Measure-Object -Property Number_of_activity -Average).Average
Write-Host "Won Deals Avg Activities: $([math]::Round($wonAct, 2))"
Write-Host "Lost Deals Avg Activities: $([math]::Round($lostAct, 2))"
