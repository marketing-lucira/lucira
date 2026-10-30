# Deploys the Product Pricing dashboard. No switch = API + page.
#   -Api      pos-price-api Cloud Function only
#   -Page     copy dashboard/ppi.js + html into pp-dashboard-web/static, deploy pp-dashboard-web
#   -Refresh  afterwards, run the snapshot refresh (rebuilds every price, ~10 min)
# Env vars (REFRESH_TOKEN, EDITOR_PASSWORDS, DASH_USER/DASH_PASS) are left untouched.
param([switch]$Api, [switch]$Page, [switch]$Refresh)

$project = "lucirajewelry-prod"
$region = "asia-south1"
$root = (git rev-parse --show-toplevel)
if (-not $root) { Write-Error "Run this inside the lucira git repo."; exit 1 }
if (-not ($Api -or $Page)) { $Api = $true; $Page = $true }

function Check($what, $code) {
    if ($code -ne 0) { Write-Error "$what failed (exit $code) - stopping."; exit $code }
}

if ($Api) {
    Write-Host "== Deploying pos-price-api"
    Push-Location (Join-Path $root "pos-price-api")
    gcloud functions deploy pos-price-api --gen2 --runtime=python312 --region=$region --source=. `
        --entry-point=pos_price --trigger-http --allow-unauthenticated --memory=4096MB --timeout=1800s `
        --min-instances=1 --project=$project
    $code = $LASTEXITCODE
    Pop-Location
    Check "API deploy" $code
}

if ($Page) {
    Write-Host "== Copying page files and deploying pp-dashboard-web"
    Copy-Item (Join-Path $root "dashboard/ppi.js"), (Join-Path $root "dashboard/product-pricing-intelligence.html") `
        (Join-Path $root "pp-dashboard-web/static/") -Force
    Push-Location (Join-Path $root "pp-dashboard-web")
    gcloud run deploy pp-dashboard-web --source . --region=$region --project=$project
    $code = $LASTEXITCODE
    Pop-Location
    Check "Page deploy" $code
}

if ($Refresh) {
    Write-Host "== Starting the snapshot refresh (prices rebuild in ~10 min)"
    gcloud scheduler jobs run pricing-snapshot-refresh --location=$region --project=$project
    Check "Snapshot refresh" $LASTEXITCODE
}

Write-Host "Done."
