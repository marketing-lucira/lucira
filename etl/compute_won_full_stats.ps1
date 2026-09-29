$data = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\won_deals_summary.json' -Raw | ConvertFrom-Json
$won = $data.won_deals_detail

Write-Host "=================== DETAILED BREAKDOWN OF ALL WON DEALS METRICS ==================="

function Get-Stats($prop) {
    $vals = $won | Select-Object -ExpandProperty $prop
    $meas = $vals | Measure-Object -Average -Sum -Min -Max
    return [PSCustomObject]@{
        Metric = $prop
        TotalSum = [math]::Round($meas.Sum, 1)
        Average = [math]::Round($meas.Average, 2)
        Min = $meas.Minimum
        Max = $meas.Maximum
    }
}

$metrics = @(
    "total_activities",
    "sessions",
    "pdp_views",
    "total_products_viewed",
    "unique_products_viewed",
    "category_pages",
    "search_actions",
    "atc_count",
    "wishlist_count",
    "checkout_attempts",
    "whatsapp_clicks",
    "phone_clicks",
    "store_visits",
    "returned_website",
    "days_to_convert",
    "engagement_minutes",
    "zoho_activities",
    "total_calls",
    "connected_calls",
    "missed_calls",
    "followup_attempts",
    "emails_sent",
    "whatsapp_convos",
    "quotes_sent"
)

$statsList = foreach($m in $metrics) { Get-Stats $m }
$statsList | Format-Table -AutoSize

$statsJson = $statsList | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText("c:\Users\ADMIN\.antigravity-ide\etl\won_deals_full_stats.json", $statsJson)
Write-Host "Full stats saved to won_deals_full_stats.json"
