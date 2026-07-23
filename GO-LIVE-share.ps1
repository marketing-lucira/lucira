# ════════════════════════════════════════════════════════════════════
#  Lucira Sales Intelligence — ONE-CLICK go-live + share
#  Run:  right-click this file → "Run with PowerShell"
#        (or in a terminal:  powershell -ExecutionPolicy Bypass -File .\GO-LIVE-share.ps1)
# ════════════════════════════════════════════════════════════════════
$ErrorActionPreference = "Stop"
$proj    = "lucirajewelry-prod"
$region  = "asia-south1"
$apiDir  = "C:\Users\ADMIN\.antigravity-ide\sales-reporting-api"
$html    = "C:\Users\ADMIN\.antigravity-ide\dashboard\sales-intelligence.html"
$link    = "https://storage.googleapis.com/lucira-dashboards/sales/dashboard.html"

Write-Host "`n[1/3] Redeploying sales-snapshot function (no-dedup + mobile identity)..." -ForegroundColor Cyan
Set-Location $apiDir
gcloud functions deploy sales-snapshot --gen2 --runtime=python312 --region=$region --source=. `
  --entry-point=sales_snapshot --trigger-http --allow-unauthenticated --memory=512MB --timeout=300s `
  --set-env-vars "BQ_PROJECT=$proj,REPORT_DATASET=$proj.sales_dashboard,SALES_TABLE=$proj.ornaverse_erp_administration.Sales_overview_table,CURRENCY=INR,GST_DIVISOR=1.03,WINDOW_DAYS=540,SNAPSHOT_BUCKET=lucira-dashboards,SNAPSHOT_PATH=sales/latest.json"

Write-Host "`n[2/3] Rebuilding today's snapshot with the correct numbers..." -ForegroundColor Cyan
$u = gcloud functions describe sales-snapshot --region=$region --gen2 --format="value(serviceConfig.uri)"
Invoke-WebRequest -UseBasicParsing -Method POST -Uri "$u/refresh" | Out-Null
Write-Host "    Snapshot rebuilt." -ForegroundColor Green

Write-Host "`n[3/3] Publishing the dashboard page to the public link..." -ForegroundColor Cyan
gsutil -h "Content-Type:text/html" cp $html "gs://lucira-dashboards/sales/dashboard.html"

Write-Host "`n════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host " DONE. Share this link with the CEO / Rupesh:" -ForegroundColor Green
Write-Host "   $link" -ForegroundColor Yellow
Write-Host "════════════════════════════════════════════════════════════`n" -ForegroundColor Green
