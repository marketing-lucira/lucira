# build_geo_intel.ps1 — merges the OLD city-intel BigQuery outputs (etl/city_intel_sql/out/*.json)
# with the NEW GA4 Geo Intelligence outputs (etl/geo_intel_sql/out/*.json) into one static payload
# for dashboard/ga4-geo-intelligence.html. Follows the same pattern as build_city_intel.ps1.

$ErrorActionPreference = 'Stop'
$Root = 'c:\Users\ADMIN\.antigravity-ide'
$OldOut = Join-Path $Root 'etl\city_intel_sql\out'
$NewOut = Join-Path $Root 'etl\geo_intel_sql\out'
$OutJs  = Join-Path $Root 'dashboard\geo_intel_data.js'

function LoadJson($dir, $name) {
  $p = Join-Path $dir $name
  return Get-Content $p -Raw | ConvertFrom-Json
}

# ---- old city-intel outputs (still real, still current) ----
$q1old = LoadJson $OldOut 'q1_city_ga4_totals.json'
$q4old = LoadJson $OldOut 'q4_city_campaign_ga4.json'
$q6old = LoadJson $OldOut 'q6_zoho_city_totals.json'
$q7a   = LoadJson $OldOut 'q7a_zoho_totals.json'
$q7b   = LoadJson $OldOut 'q7b_zoho_daily.json'
$q7c   = LoadJson $OldOut 'q7c_zoho_stage_funnel.json'
$q7d   = LoadJson $OldOut 'q7d_zoho_lead_source.json'
$q8old = LoadJson $OldOut 'q8_city_device_ga4.json'

# ---- new fact-table + pincode outputs ----
$natTotals = LoadJson $NewOut 'q1_national_totals_fact.json'
$cityUsers = LoadJson $NewOut 'q2_city_users_fact.json'
$dailyFact = LoadJson $NewOut 'q3_national_daily_fact.json'
$sessAnl   = LoadJson $NewOut 'q4_session_analysis_fact.json'
$funnel    = LoadJson $NewOut 'q5_funnel_fact.json'
$zohoZip   = LoadJson $NewOut 'q6_zoho_pincode.json'
$cityGa4Daily = LoadJson $NewOut 'q7_city_ga4_daily.json'
$webengagePincode = LoadJson $NewOut 'q8_webengage_pincode.json'
# 2026-10-19: Pin Code page merged with Store Location Intelligence logic --
#   q6  = live zoho_crm.cdc_deals, deal zip / address patch / contact Mailing_Zip, real pincodes only
#   q6b = daily deals total vs deals-with-pincode (coverage KPIs)
#   q9  = REAL sales (marketing_sale) on the sale's own ERP pincode, day x channel
#   q10 = per-pincode nearest Lucira store + km, all-time buyers, and sales reconciliation totals
$zohoPinCoverage = LoadJson $NewOut 'q6b_zoho_pincode_coverage.json'
$salesPincode    = LoadJson $NewOut 'q9_sales_pincode.json'
$pincodeMetaAll  = LoadJson $NewOut 'q10_pincode_meta.json'
$pincodeMeta     = @($pincodeMetaAll | Where-Object { $_.pincode -ne '__totals__' } | ForEach-Object { $_.PSObject.Properties.Remove('totals_json'); $_ })
$salesTotalsRow  = $pincodeMetaAll | Where-Object { $_.pincode -eq '__totals__' } | Select-Object -First 1
# kept as the raw JSON string -- PS 5.1 ConvertFrom-Json/ConvertTo-Json round-trips a 1-level array
# into {value:[...],Count:n}; the dashboard JSON.parses it instead.
$salesTotalsJson = if ($salesTotalsRow) { [string]$salesTotalsRow.totals_json } else { '[]' }

# ---- CaratLane competitive data (public store catalog pages, hand/agent-collected -- not a
# BigQuery query, so it lives as a static JSON source instead of etl/geo_intel_sql/out) ----
$caratlaneStores = LoadJson (Join-Path $Root 'etl') 'caratlane_stores.json'
# ---- CaratLane store MASTER (2026-08-10): richer Google-Business-Profile-derived store
# directory (name/address/city/state/status/phone/rating/reviews), one row per pincode,
# deduped (some pincodes have multiple stores). Separate dataset from caratlaneStores above
# (that one is online-catalog listing counts / cat+pb; this one is store presence/details) --
# powers the Pin Code Intelligence full-outer-join (see dashboard's buildPincodeFullOuter()). ----
$caratlaneStoreMaster = LoadJson (Join-Path $Root 'etl') 'caratlane_store_master.json'
# ---- Tanishq store master (2026-08-11): official Tanishq store-locator export (541 stores,
# 509 distinct pincodes) -- name/address/area/city/state/store_type/status/phone/rating/
# reviews/openedDate/mapsUrl per store, grouped per pincode same shape as caratlaneStoreMaster.
# SKU_Product_Inventory_Data in the source sheet is 100% "Not Available" (WAF-blocked at
# collection) -- intentionally NOT carried into this file or the dashboard, per instruction.
$tanishqStoreMaster = LoadJson (Join-Path $Root 'etl') 'tanishq_store_master.json'

# ---- pincode -> area/locality name, resolved from the public India Post pincode directory
# (api.postalpincode.in). Not a Zoho/GA4 field -- there is no Pin Code -> Area master table
# connected in any of our own sources -- so this is real external reference data, not modelled.
$areaLookupPath = Join-Path $Root 'etl\pincode_area_display.json'
$areaLookup = @{}
if (Test-Path $areaLookupPath) {
  $raw = Get-Content $areaLookupPath -Raw | ConvertFrom-Json
  $raw.PSObject.Properties | ForEach-Object { $areaLookup[$_.Name] = $_.Value }
}
foreach ($row in $zohoZip) {
  $area = $areaLookup[[string]$row.pincode]
  $row | Add-Member -NotePropertyName 'area' -NotePropertyValue $area -Force
}

$t = $q7a[0]
$dealsWithZip = if ($t.PSObject.Properties.Name -contains 'deals_with_zip') { [int]$t.deals_with_zip } else { 0 }
$coverage = [ordered]@{
  deals_total          = [int]$t.deals_total
  deals_with_city       = [int]$t.deals_with_city
  deals_with_city_pct   = [math]::Round(100.0 * [int]$t.deals_with_city / [int]$t.deals_total, 1)
  deals_with_zip        = $dealsWithZip
  deals_without_zip     = [int]$t.deals_total - $dealsWithZip
  deals_with_zip_pct    = [math]::Round(100.0 * $dealsWithZip / [int]$t.deals_total, 1)
  won_total             = [int]$t.won_total
  won_with_city         = [int]$t.won_with_city
  amount_total          = [double]$t.amount_total
  amount_with_city      = [double]$t.amount_with_city
  min_date              = $t.min_date
  max_date              = $t.max_date
  note = "Only $([int]$t.deals_with_city) of $([int]$t.deals_total) deals ($([math]::Round(100.0*[int]$t.deals_with_city/[int]$t.deals_total,1))%) have Address_City populated, and only $dealsWithZip of $([int]$t.deals_total) ($([math]::Round(100.0*$dealsWithZip/[int]$t.deals_total,1))%) have Address_Zip populated -- this is the ENTIRE reason Pin Code Intelligence's Deals Created total looks far lower than Zoho's real daily deal-creation rate: it can only count the ~$([math]::Round(100.0*$dealsWithZip/[int]$t.deals_total,1))% of deals where the sales team actually filled in a pin code. ZERO of the city/pin-known deals have a non-zero Amount. Zoho CANNOT attribute revenue by city, pin code or area today -- GA4 (mart + session fact table) is the revenue signal everywhere; Zoho contributes deal COUNT only. There is no Pin Code -> Area master table connected anywhere, no WebEngage event feed (push/email/WhatsApp sends), and no shared identity key across GA4 / WebEngage / Zoho / Shopify (GA4 carries no email or mobile field) -- so Pin/Area drill-down, WebEngage Users, Identified Users and Session-to-Sale Attribution sections show an explicit not-available notice instead of invented numbers."
}

$natTotalsRow = $natTotals[0]
$funnelRow = $funnel[0]

$payload = [ordered]@{
  meta = [ordered]@{
    generated_at     = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
    ga4_mart_source  = 'lucirajewelry-prod.ga4_data.ga4_data'
    ga4_fact_source  = 'lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions'
    zoho_source      = 'lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals (city pages); zoho_crm.cdc_deals (Pin Code page)'
    sales_source     = 'lucirajewelry-prod.ds_imputed_reporting.marketing_sale (Pin Code page, sale-pincode mapped)'
    erp_source       = 'Ornaverse ERP live snapshot (fetched client-side, same as Sales Intelligence)'
    ga4_fact_window  = [ordered]@{ min = $natTotalsRow.min_date; max = $natTotalsRow.max_date }
    zoho_window      = [ordered]@{ min = $coverage.min_date; max = $coverage.max_date }
  }
  coverage        = $coverage
  nationalTotals  = $natTotalsRow
  funnel          = $funnelRow
  cityTotals      = @($q1old)
  cityUsersFact   = @($cityUsers)
  cityGa4Daily    = @($cityGa4Daily)
  dailyFact       = @($dailyFact)
  campaigns       = @($q4old)
  sessionAnalysis = @($sessAnl)
  zohoCity        = @($q6old)
  zohoPincode     = @($zohoZip)
  webengagePincode = @($webengagePincode)
  caratlaneStores = @($caratlaneStores)
  caratlaneStoreMaster = @($caratlaneStoreMaster)
  tanishqStoreMaster = @($tanishqStoreMaster)
  zohoDaily       = @($q7b)
  zohoStages      = @($q7c)
  zohoLeadSource  = @($q7d)
  devices         = @($q8old)
  zohoPincodeCoverage = @($zohoPinCoverage)
  salesPincode    = @($salesPincode)
  pincodeMeta     = $pincodeMeta
  salesTotalsJson = $salesTotalsJson
}

$json = $payload | ConvertTo-Json -Depth 10 -Compress
$js = "window.GEO_INTEL_DATA = " + $json + ";"
[System.IO.File]::WriteAllText($OutJs, $js, (New-Object System.Text.UTF8Encoding($false)))
$sizeKb = [math]::Round((Get-Item $OutJs).Length/1KB,1)
Write-Host "WROTE $OutJs  ($sizeKb KB)"
Write-Host "Fact window: $($coverage.min_date) .. $($coverage.max_date) (Zoho); GA4 fact $($natTotalsRow.min_date)..$($natTotalsRow.max_date)"
Write-Host "Real users(90d): $($natTotalsRow.users)  sessions: $($natTotalsRow.sessions)  revenue: $($natTotalsRow.revenue)"
