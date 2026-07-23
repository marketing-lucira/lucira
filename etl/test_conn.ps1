. "$PSScriptRoot\_lib.ps1"
$ErrorActionPreference = 'Stop'
$t = Get-ZohoToken
"TOKEN OK"
foreach ($m in 'Deals','Calls','Events','Tasks','Customer_Events','Online_Activity_Logs') {
    "{0,-22} count = {1}" -f $m, (Get-CoqlCount -Token $t -Module $m)
}
"--- keyset pagination test on Events (should equal count above) ---"
$ev = Get-AllRecords -Token $t -Module 'Events' -Fields @('id','Owner','Created_Time')
"Events pulled via keyset = $($ev.Count)"
"first id = $($ev[0].id); last id = $($ev[$ev.Count-1].id)"
