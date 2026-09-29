# build_city_intel.ps1 — merges the 10 BigQuery query outputs (etl/city_intel_sql/out/*.json)
# into one static payload for the City Intelligence & Market Expansion dashboard.
# Follows the same pattern as build.ps1 / export_dashboard_data.ps1: write window.X = {...} to dashboard/*.js.

$ErrorActionPreference = 'Stop'
$Root = 'c:\Users\ADMIN\.antigravity-ide'
$OutDir = Join-Path $Root 'etl\city_intel_sql\out'
$OutJs  = Join-Path $Root 'dashboard\city_intel_data.js'

function LoadJson($name) {
  $p = Join-Path $OutDir $name
  return Get-Content $p -Raw | ConvertFrom-Json
}

$q1 = LoadJson 'q1_city_ga4_totals.json'
$q2 = LoadJson 'q2_national_daily_ga4.json'
$q3 = LoadJson 'q3_city_daily_top20_ga4.json'
$q4 = LoadJson 'q4_city_campaign_ga4.json'
$q5 = LoadJson 'q5_city_product_ga4.json'
$q5b = LoadJson 'q5b_city_top_products_ga4.json'
$q6 = LoadJson 'q6_zoho_city_totals.json'
$q7a = LoadJson 'q7a_zoho_totals.json'
$q7b = LoadJson 'q7b_zoho_daily.json'
$q7c = LoadJson 'q7c_zoho_stage_funnel.json'
$q7d = LoadJson 'q7d_zoho_lead_source.json'
$q8 = LoadJson 'q8_city_device_ga4.json'

$t = $q7a[0]
$coverage = [ordered]@{
  deals_total        = [int]$t.deals_total
  deals_with_city     = [int]$t.deals_with_city
  deals_with_city_pct = [math]::Round(100.0 * [int]$t.deals_with_city / [int]$t.deals_total, 1)
  won_total           = [int]$t.won_total
  won_with_city       = [int]$t.won_with_city
  amount_total        = [double]$t.amount_total
  amount_with_city    = [double]$t.amount_with_city
  min_date            = $t.min_date
  max_date            = $t.max_date
  note = "Only $([int]$t.deals_with_city) of $([int]$t.deals_total) deals ($([math]::Round(100.0*[int]$t.deals_with_city/[int]$t.deals_total,1))%) have Address_City populated; $([int]$t.won_with_city) of $([int]$t.won_total) Closed-Won deals have a city; ZERO of the city-known deals have a non-zero Amount. CRM cannot currently attribute revenue by city -- GA4 revenue is used as the revenue signal everywhere; Zoho contributes deal COUNT, Deal_Score and Probability as lead-quality proxies only."
}

$payload = [ordered]@{
  meta = [ordered]@{
    generated_at   = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
    ga4_source     = 'lucirajewelry-prod.ga4_data.ga4_data'
    zoho_source    = 'lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals'
    ga4_window_days = 400
    zoho_window     = @{ min = $coverage.min_date; max = $coverage.max_date }
  }
  coverage       = $coverage
  cityTotals     = @($q1)
  nationalDaily  = @($q2)
  cityDaily      = @($q3)
  campaigns      = @($q4)
  products       = @($q5)
  topProducts    = @($q5b)
  zohoCity       = @($q6)
  zohoDaily      = @($q7b)
  zohoStages     = @($q7c)
  zohoLeadSource = @($q7d)
  devices        = @($q8)
}

$json = $payload | ConvertTo-Json -Depth 10 -Compress
$js = "window.CITY_INTEL_DATA = " + $json + ";"
[System.IO.File]::WriteAllText($OutJs, $js, (New-Object System.Text.UTF8Encoding($false)))
$sizeKb = [math]::Round((Get-Item $OutJs).Length/1KB,1)
Write-Host "WROTE $OutJs  ($sizeKb KB)"
Write-Host "Coverage: $($coverage.deals_with_city)/$($coverage.deals_total) deals have city ($($coverage.deals_with_city_pct)%)"
