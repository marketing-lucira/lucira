# build_geo_intel.ps1 -- thin wrapper since 2026-10-19: the build logic now lives in
# etl/build_geo_intel.js (Node) so the SAME code runs locally and inside the daily
# pincode-refresh Cloud Run Job. Output was diffed against the old PowerShell build: identical
# except that Node keeps UTF-8 text intact (PowerShell 5.1 was mojibaking "—" / emoji).
$ErrorActionPreference = 'Stop'
$Root = 'c:\Users\ADMIN\.antigravity-ide'
& node (Join-Path $Root 'etl\build_geo_intel.js')
if ($LASTEXITCODE -ne 0) { throw "build_geo_intel.js failed ($LASTEXITCODE)" }
