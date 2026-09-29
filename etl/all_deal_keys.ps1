$deals = Get-Content 'c:\Users\ADMIN\.antigravity-ide\etl\raw\Deals.json' -Raw | ConvertFrom-Json
$allKeys = New-Object System.Collections.Generic.HashSet[string]
foreach ($deal in $deals) {
    foreach ($prop in $deal.psobject.properties) {
        [void]$allKeys.Add($prop.Name)
    }
}
Write-Host "All unique keys in Deals.json:"
$allKeys | Sort-Object | Write-Host
