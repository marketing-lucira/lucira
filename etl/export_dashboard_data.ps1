$deals = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Deals.json' -Raw | ConvertFrom-Json
$calls = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Calls.json' -Raw | ConvertFrom-Json

$startDate = [datetime]"2026-06-06"
$filteredDeals = $deals | Where-Object { 
    $dt = [datetime]$_.Created_Time
    $dt -ge $startDate
}

# Index calls by What_Id
$callsByDeal = @{}
foreach($c in $calls) {
    if ($c.What_Id -and $c.What_Id.id) {
        $wid = [string]$c.What_Id.id
        if (-not $callsByDeal.ContainsKey($wid)) {
            $callsByDeal[$wid] = New-Object System.Collections.ArrayList
        }
        $callObj = [ordered]@{
            id = $c.id
            subject = $c.Subject
            start_time = $c.Call_Start_Time
            duration = if($c.Call_Duration_in_seconds){$c.Call_Duration_in_seconds}elseif($c.Call_Duration){$c.Call_Duration}else{0}
            status = if($c.Call_Result){$c.Call_Result}else{"Logged"}
            owner = if($c.Owner){$c.Owner.name}else{"System"}
        }
        [void]$callsByDeal[$wid].Add($callObj)
    }
}

# Transform Deals for Dashboard
$dealList = New-Object System.Collections.ArrayList
foreach($d in $filteredDeals) {
    $id = [string]$d.id
    $linkedCalls = if($callsByDeal.ContainsKey($id)){$callsByDeal[$id]}else{@()}
    
    $ownerName = if($d._own){$d._own}elseif($d.Owner){$d.Owner.name}else{"Unknown"}
    $leadSource = if($d.Lead_Source){$d.Lead_Source}else{"Direct / Organic"}
    $lossReason = if($d.Reason_For_Loss__s){$d.Reason_For_Loss__s}else{"N/A"}
    $utmSource = if($d.UTM_Source){$d.UTM_Source}else{"None"}

    $obj = [ordered]@{
        id = $id
        created_time = $d.Created_Time
        owner = $ownerName
        stage = $d.Stage
        amount = if($d.Amount){[double]$d.Amount}else{0}
        lead_source = $leadSource
        utm_source = $utmSource
        trigger = if($d.Deal_Trigger_Event){$d.Deal_Trigger_Event}else{"None"}
        loss_reason = $lossReason
        calls_count = $linkedCalls.Count
        calls = @($linkedCalls)
    }
    [void]$dealList.Add($obj)
}

# Load Won Stats
$wonStats = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\won_deals_full_stats.json' -Raw | ConvertFrom-Json

$jsonObj = [ordered]@{
    generated_at = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    total_deals = $dealList.Count
    won_stats = $wonStats
    deals = @($dealList)
}

$jsonText = "window.CRM_DATA = " + ($jsonObj | ConvertTo-Json -Depth 10 -Compress) + ";"
[System.IO.File]::WriteAllText("c:\Users\ADMIN\.antigravity-ide\dashboard\crm_data.js", $jsonText)

Write-Host "Successfully generated crm_data.js with $($dealList.Count) deals and won_stats!"
