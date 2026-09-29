$deals = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Deals.json' -Raw | ConvertFrom-Json
$sample = $deals | Where-Object { $_.Stage -like '*Won*' } | Select-Object -First 1

Write-Host "Keys matching city|store|campaign|win|utm|reason:"
$sample.psobject.properties.name | Where-Object { $_ -match '(?i)city|store|campaign|win|utm|reason' } | Write-Host

Write-Host "`nSample Won Deal:"
$sample | ConvertTo-Json -Depth 2
