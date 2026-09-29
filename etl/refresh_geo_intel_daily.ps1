# Daily refresh for the Lucira GA4 Geo Intelligence dashboard.
# Self-heals the trailing 7 days of ga4_fact_sessions from the raw GA4 export
# (fact_sessions.sql finds the actual latest exported day itself -- no date
# needs to be passed in), re-runs the geo-intel queries AND the Zoho deals /
# GA4-mart city queries (etl/city_intel_sql -- these have no date parameter,
# they self-heal to CURRENT_DATE()/unbounded-latest same as fact_sessions.sql),
# regenerates the static snapshot, and pushes it to the public repo
# (Wajiudddin/Lucira-GA4-Geo-Dashboard), which auto-redeploys via its GitHub
# Pages workflow.
#
# Scheduled to run daily at 09:05 IST (after the raw GA4 export for the
# previous day has landed, ~1-2 day lag from Google).
#
# NOTE (2026-08-10): city_intel_sql (Zoho deals + GA4-mart city totals) used
# to be a separate, manual, one-off pull -- it silently sat frozen at
# 2026-07-27 for two weeks even though the underlying BigQuery table
# (lucira_zoho_Deals) was live and current the whole time. Folded into this
# script so that never happens again -- one run keeps BOTH the fact-table
# side and the Zoho/mart side current.

$ErrorActionPreference = 'Stop'
$Root       = 'c:\Users\ADMIN\.antigravity-ide'
$DeployDir  = 'c:\Users\ADMIN\lucira-geo-dashboard-deploy'
$CloudRunDir = Join-Path $Root 'ga4-geo-intelligence-app'
$SqlDir     = Join-Path $Root 'ga4-bq-api\sql'
$GeoSqlDir  = Join-Path $Root 'etl\geo_intel_sql'
$CitySqlDir = Join-Path $Root 'etl\city_intel_sql'
$LogFile    = Join-Path $DeployDir 'refresh.log'
$GcloudCmd  = 'C:\Users\ADMIN\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $LogFile -Value $line
  Write-Host $line
}

# Piping a SQL string straight to `bq` via PowerShell's `|` prepends a UTF-8 BOM
# to the child process's stdin (PowerShell 5.1 pipe-to-native-exe encoding), which
# `bq query` then rejects as "Illegal input character". Use Start-Process with
# -RedirectStandardInput from a BOM-less temp file instead -- no shell involved,
# so no quoting/encoding surprises.
$BqCmd = 'C:\Users\ADMIN\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\bq.cmd'
function Invoke-BqFile($sqlPath, [string[]]$extraArgs) {
  $tmpIn  = [System.IO.Path]::GetTempFileName()
  $tmpOut = [System.IO.Path]::GetTempFileName()
  $tmpErr = [System.IO.Path]::GetTempFileName()
  try {
    $noBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmpIn, [System.IO.File]::ReadAllText($sqlPath), $noBom)
    $bqArgs = @('query','--use_legacy_sql=false','--project_id=lucirajewelry-prod') + $extraArgs
    $p = Start-Process -FilePath $BqCmd -ArgumentList $bqArgs -RedirectStandardInput $tmpIn -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr -NoNewWindow -Wait -PassThru
    $stdout = [System.IO.File]::ReadAllText($tmpOut)
    $stderr = [System.IO.File]::ReadAllText($tmpErr)
    return @{ ExitCode = $p.ExitCode; Output = $stdout; Error = $stderr }
  } finally {
    Remove-Item $tmpIn, $tmpOut, $tmpErr -Force -ErrorAction SilentlyContinue
  }
}

try {
  Log "=== Starting daily refresh ==="

  # 1) Self-heal the trailing 7 days of ga4_fact_sessions from the raw GA4 export.
  #    fact_sessions.sql finds the latest exported day itself and rebuilds the
  #    7 days up to it -- no parameter needed, and any gap (a missed run, a
  #    late export day) gets caught up automatically.
  $todayIST = (Get-Date).ToString('yyyy-MM-dd')
  Log "Refreshing ga4_fact_sessions (self-healing 7-day window)"
  $factRes = Invoke-BqFile (Join-Path $SqlDir 'fact_sessions.sql') @()
  if ($factRes.ExitCode -ne 0) { throw "fact_sessions.sql failed: $($factRes.Error)$($factRes.Output)" }
  Log "  -> $($factRes.Output | Select-String 'affected rows' | Select-Object -Last 1)"

  # 2) Re-run the geo-intel queries that feed the dashboard snapshot.
  $queries = @('q1_national_totals_fact','q2_city_users_fact','q3_national_daily_fact','q4_session_analysis_fact','q5_funnel_fact','q6_zoho_pincode','q7_city_ga4_daily','q8_webengage_pincode')
  foreach ($q in $queries) {
    Log "Refreshing $q"
    $sqlPath = Join-Path $GeoSqlDir "$q.sql"
    $outPath = Join-Path $GeoSqlDir "out\$q.json"
    # --max_rows: `bq query` silently caps results at 100 rows by default --
    # without this flag, every one of these breakdowns (city, daily, session,
    # pincode) gets truncated. 1,000,000 is comfortably above anything these
    # queries can return.
    $res = Invoke-BqFile $sqlPath @('--format=json','--max_rows=1000000')
    if ($res.ExitCode -ne 0) { throw "$q failed: $($res.Error)$($res.Output)" }
    [System.IO.File]::WriteAllText($outPath, $res.Output, (New-Object System.Text.UTF8Encoding($false)))
  }

  # 2b) Re-run the Zoho deals + GA4-mart city queries. None of these take a date
  #     parameter -- they aggregate the full connected table (Zoho) or a
  #     CURRENT_DATE()-relative window (GA4 mart), so simply re-running picks up
  #     whatever is live in BigQuery right now.
  $cityQueries = @('q1_city_ga4_totals','q4_city_campaign_ga4','q6_zoho_city_totals','q7a_zoho_totals','q7b_zoho_daily','q7c_zoho_stage_funnel','q7d_zoho_lead_source','q8_city_device_ga4')
  foreach ($q in $cityQueries) {
    Log "Refreshing $q (Zoho/GA4-mart)"
    $sqlPath = Join-Path $CitySqlDir "$q.sql"
    $outPath = Join-Path $CitySqlDir "out\$q.json"
    $res = Invoke-BqFile $sqlPath @('--format=json','--max_rows=1000000')
    if ($res.ExitCode -ne 0) { throw "$q failed: $($res.Error)$($res.Output)" }
    [System.IO.File]::WriteAllText($outPath, $res.Output, (New-Object System.Text.UTF8Encoding($false)))
  }

  # 3) Rebuild the static snapshot the dashboard reads.
  Log "Rebuilding geo_intel_data.js"
  $buildOut = & powershell -File (Join-Path $Root 'etl\build_geo_intel.ps1') 2>&1
  if ($LASTEXITCODE -ne 0) { throw "build_geo_intel.ps1 failed: $buildOut" }
  $buildOut | ForEach-Object { Log $_ }

  # 4) Publish: pull the clone to a clean state FIRST, then copy the new file in.
  #    (Copying before pulling leaves the working tree dirty, which makes
  #    `git pull --rebase` refuse to run every single time -- caught this by
  #    actually hitting the failure twice, not by inspection.)
  #    IMPORTANT: redirecting a native exe's stderr (2>&1, *>$null, anything)
  #    does NOT help under $ErrorActionPreference='Stop' -- PowerShell 5.1
  #    promotes each stderr line to a terminating ErrorRecord at the moment
  #    the process writes it, before any redirection applies. `git pull`
  #    writes its normal "From https://..." fetch summary to stderr even on
  #    a clean, successful pull, so it was throwing every time regardless of
  #    how output was redirected (confirmed by hitting this twice more after
  #    the first "fix"). The only real fix: drop to 'Continue' around the
  #    native git calls and gate on $LASTEXITCODE ourselves.
  Set-Location $DeployDir
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  git checkout -- dashboard/geo_intel_data.js 2>&1 | Out-Null
  git pull --rebase origin main 2>&1 | Out-Null
  $pullExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEAP
  if ($pullExit -ne 0) { throw "git pull --rebase failed (exit $pullExit)" }
  Log "  git pull: OK"
  Copy-Item (Join-Path $Root 'dashboard\geo_intel_data.js') (Join-Path $DeployDir 'dashboard\geo_intel_data.js') -Force
  git add dashboard/geo_intel_data.js
  $pending = git status --porcelain
  if ($pending) {
    $ErrorActionPreference = 'Continue'
    git -c user.name="Lucira Jewelry" -c user.email="data@lucirajewelry.com" commit -m "Daily geo-intel snapshot refresh ($todayIST)" 2>&1 | Out-Null
    git push origin main 2>&1 | Out-Null
    $pushExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($pushExit -ne 0) { throw "git push failed (exit $pushExit)" }
    Log "Pushed updated snapshot to origin/main"
  } else {
    Log "No changes to publish (snapshot identical to last run)"
  }

  # 5) Publish to the Cloud Run service (the canonical live link, password-gated,
  #    no personal/git name in the URL). Only geo_intel_data.js changes day to
  #    day -- index.html (theme, auth) is edited manually, not touched here.
  Log "Publishing to Cloud Run (ga4-geo-intelligence)"
  Copy-Item (Join-Path $Root 'dashboard\geo_intel_data.js') (Join-Path $CloudRunDir 'static\geo_intel_data.js') -Force
  Set-Location $CloudRunDir
  # Same stderr-promotion gotcha as git pull/push above: gcloud writes its normal
  # build/deploy progress to stderr even on full success, and $ErrorActionPreference
  # = 'Stop' turns each such line into a terminating error regardless of redirection.
  $prevEAP2 = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $deployOut = & $GcloudCmd run deploy ga4-geo-intelligence --source=. --region=asia-south1 --project=lucirajewelry-prod --allow-unauthenticated --memory=512Mi --timeout=300s --max-instances=5 --quiet 2>&1
  $deployExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEAP2
  if ($deployExit -ne 0) { throw "gcloud run deploy failed (exit $deployExit): $deployOut" }
  Log "  Cloud Run deploy: OK"

  Log "=== Daily refresh complete ==="
}
catch {
  Log "ERROR: $($_.Exception.Message)"
  throw
}
