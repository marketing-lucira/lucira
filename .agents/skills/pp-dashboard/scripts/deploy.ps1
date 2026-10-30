# Deploys the Product Pricing dashboard. Works from any folder. No switch = API + page.
#   -Api                 pos-price-api Cloud Function only
#   -Page                copy dashboard/ppi.js + html into pp-dashboard-web/static, deploy pp-dashboard-web
#   -Refresh             afterwards, run the snapshot refresh (rebuilds every price, ~10 min)
#   -SetEditorPasswords  asks for each editor's dashboard password (typing is hidden) and saves them on the API
# Other env vars (REFRESH_TOKEN, DASH_USER/DASH_PASS) are left untouched.
param([switch]$Api, [switch]$Page, [switch]$Refresh, [switch]$SetEditorPasswords)

# gcloud may not be on PATH on this PC and then needs its bundled Python.
$sdk = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk"
if (Test-Path (Join-Path $sdk "bin")) { $env:PATH = (Join-Path $sdk "bin") + ";" + $env:PATH }
$bundledPy = Join-Path $sdk "platform\bundledpython\python.exe"
if (Test-Path $bundledPy) { $env:CLOUDSDK_PYTHON = $bundledPy }

$project = "lucirajewelry-prod"
$region = "asia-south1"
$editors = @("data@lucirajewelry.com", "data.cat@lucirajewelry.com", "tech@lucirajewelry.com")
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")
if ($SetEditorPasswords) { $Api = $true }
if (-not ($Api -or $Page)) { $Api = $true; $Page = $true }

function Check($what, $code) {
    if ($code -ne 0) { Write-Error "$what failed (exit $code) - stopping."; exit $code }
}

$envArgs = @()
if ($SetEditorPasswords) {
    $pairs = foreach ($e in $editors) {
        $sec = Read-Host "Dashboard password for $e" -AsSecureString
        $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
        if (-not $pw -or $pw -match "[,;]") { Write-Error "Password for $e is empty or has , or ; - stopping."; exit 1 }
        "$e=$pw"
    }
    $envArgs = @("--update-env-vars", "EDITOR_PASSWORDS=$($pairs -join ';')")
}

if ($Api) {
    Write-Host "== Deploying pos-price-api"
    Push-Location (Join-Path $root "pos-price-api")
    gcloud functions deploy pos-price-api --gen2 --runtime=python312 --region=$region --source=. `
        --entry-point=pos_price --trigger-http --allow-unauthenticated --memory=4096MB --timeout=1800s `
        --min-instances=1 --project=$project @envArgs
    $code = $LASTEXITCODE
    Pop-Location
    Check "API deploy" $code
}

if ($Page) {
    Write-Host "== Copying page files and deploying pp-dashboard-web"
    Copy-Item (Join-Path $root "dashboard\ppi.js"), (Join-Path $root "dashboard\product-pricing-intelligence.html") `
        (Join-Path $root "pp-dashboard-web\static\") -Force
    Push-Location (Join-Path $root "pp-dashboard-web")
    gcloud run deploy pp-dashboard-web --source . --region=$region --project=$project --quiet
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
