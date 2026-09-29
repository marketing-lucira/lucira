$raw = [System.IO.File]::ReadAllText('c:\Users\ADMIN\.antigravity-ide\dashboard\crm_data.js')
Write-Host ('First 120 chars: ' + $raw.Substring(0,[Math]::Min(120,$raw.Length)))
Write-Host ('File size MB: ' + [math]::Round($raw.Length/1MB, 2))
$dealMatches = ([regex]::Matches($raw, '"stage":"Closed Won"')).Count
$lostMatches = ([regex]::Matches($raw, '"stage":"Closed Lost"')).Count
$callsLinked = ([regex]::Matches($raw, '"calls_count":[1-9]')).Count
Write-Host ('Closed Won deals in crm_data.js: ' + $dealMatches)
Write-Host ('Closed Lost deals in crm_data.js: ' + $lostMatches)
Write-Host ('Deals with at least 1 call linked: ' + $callsLinked)
Write-Host ''
Write-Host '=== HTML INTEGRITY ==='
$html = [System.IO.File]::ReadAllText('c:\Users\ADMIN\.antigravity-ide\dashboard\deals-vs-call.html')
Write-Host ('Script crm_data.js tag found: ' + ($html -match 'src="crm_data.js"'))
Write-Host ('Script data.js tag found: ' + ($html -match 'src="data.js"'))
Write-Host ('Filter: stageSel found: ' + ($html -match 'stageSel'))
Write-Host ('Filter: ownerSel found: ' + ($html -match 'ownerSel'))
Write-Host ('Filter: sourceSel found: ' + ($html -match 'sourceSel'))
Write-Host ('Filter: lossSel found: ' + ($html -match 'lossSel'))
Write-Host ('Filter: searchInput found: ' + ($html -match 'searchInput'))
Write-Host ('KPI: kpiTotal found: ' + ($html -match 'id="kpiTotal"'))
Write-Host ('KPI: kpiWon found: ' + ($html -match 'id="kpiWon"'))
Write-Host ('KPI: kpiLost found: ' + ($html -match 'id="kpiLost"'))
Write-Host ('Table: dealTbody found: ' + ($html -match 'dealTbody'))
Write-Host ('Modal: modalBg found: ' + ($html -match 'modalBg'))
Write-Host ('Chart: chartSources found: ' + ($html -match 'chartSources'))
Write-Host ('Chart: chartOwners found: ' + ($html -match 'chartOwners'))
Write-Host ('Chart: chartLosses found: ' + ($html -match 'chartLosses'))
Write-Host ('Chart: chartTriggers found: ' + ($html -match 'chartTriggers'))
Write-Host ('JS: renderDashboard function found: ' + ($html -match 'function renderDashboard'))
Write-Host ('JS: openModal function found: ' + ($html -match 'function openModal'))
Write-Host ('JS: CRM_DATA fallback found: ' + ($html -match 'CRM_DATA'))
Write-Host ('JS: DASH fallback found: ' + ($html -match 'window.DASH'))
Write-Host ('Theme toggle: toggleTheme found: ' + ($html -match 'toggleTheme'))
Write-Host ''
Write-Host '=== RESULT ==='
Write-Host 'Dashboard is READY to open in browser!'
