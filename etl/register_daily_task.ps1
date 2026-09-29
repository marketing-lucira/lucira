# Run this ONCE in an elevated PowerShell window (right-click PowerShell -> Run as administrator)
# to register the daily 9:00 AM refresh of the GA4 Geo Intelligence dashboard.

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\ADMIN\.antigravity-ide\etl\refresh_geo_intel_daily.ps1"'
$trigger = New-ScheduledTaskTrigger -Daily -At 9:00AM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "Lucira GA4 Geo Intel Daily Refresh" -Action $action -Trigger $trigger -Settings $settings -Description "Daily 9am refresh of BigQuery + geo_intel_data.js + GitHub Pages + Cloud Run for the GA4 Geo Intelligence dashboard" -RunLevel Highest -Force

Get-ScheduledTask -TaskName "Lucira GA4 Geo Intel Daily Refresh" | Select-Object TaskName, State
