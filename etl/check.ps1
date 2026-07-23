$ErrorActionPreference='Stop'
[System.Reflection.Assembly]::LoadWithPartialName('System.Web.Extensions')|Out-Null
$jss=New-Object System.Web.Script.Serialization.JavaScriptSerializer; $jss.MaxJsonLength=[int]::MaxValue
$txt=Get-Content 'c:\Users\ADMIN\.antigravity-ide\dashboard\data.js' -Raw
$json=$txt.Substring($txt.IndexOf('{')); $json=$json.TrimEnd(); $json=$json.Substring(0,$json.Length-1)
$D=$jss.DeserializeObject($json)
$deals=$D['deals']; $calls=$D['calls']; $owners=$D['owners']

$dealIds=New-Object 'System.Collections.Generic.HashSet[string]'
for($i=0;$i -lt $deals.Length;$i++){ [void]$dealIds.Add([string]$deals[$i][0]) }
$byWhat=@{}; $byPhone=@{}
for($i=0;$i -lt $calls.Length;$i++){
  $c=$calls[$i]
  $w=[string]$c[6]; if($w -and $dealIds.Contains($w)){ if(-not $byWhat.ContainsKey($w)){$byWhat[$w]=New-Object System.Collections.ArrayList}; [void]$byWhat[$w].Add($c) }
  $p=[string]$c[7]; if($p){ if(-not $byPhone.ContainsKey($p)){$byPhone[$p]=New-Object System.Collections.ArrayList}; [void]$byPhone[$p].Add($c) }
}
$contacted=0; $sumFrt=0.0; $frtN=0
for($i=0;$i -lt $deals.Length;$i++){
  $d=$deals[$i]; $dc=[datetime]::Parse([string]$d[3])
  $cand=New-Object System.Collections.ArrayList
  $id=[string]$d[0]; if($byWhat.ContainsKey($id)){ [void]$cand.AddRange($byWhat[$id]) }
  $ph=[string]$d[12]; if($ph -and $byPhone.ContainsKey($ph)){ [void]$cand.AddRange($byPhone[$ph]) }
  $best=$null
  foreach($c in $cand){ $ct=[datetime]::Parse([string]$c[2]); if($ct -ge $dc){ if($null -eq $best -or $ct -lt $best){ $best=$ct } } }
  if($null -ne $best){ $contacted++; $sumFrt += ($best-$dc).TotalMinutes; $frtN++ }
}
$n=$deals.Length
Write-Host ("Deals={0} Contacted={1} Rate={2}%  AvgFirstResp(min)={3}" -f $n,$contacted,[math]::Round(100*$contacted/$n,1),[math]::Round($sumFrt/[math]::Max(1,$frtN),1))
$conn=0;$missed=0;$types=@{};$pe=0;$wl=0
for($i=0;$i -lt $calls.Length;$i++){ $c=$calls[$i]; if([int]$c[4] -gt 0){$conn++}; $t=[string]$c[3]; if($t.ToLower().Contains('miss')){$missed++}; if(-not $types.ContainsKey($t)){$types[$t]=0}; $types[$t]++; if([string]$c[7]){$pe++}; $w=[string]$c[6]; if($w -and $dealIds.Contains($w)){$wl++} }
Write-Host ("Calls={0} Connected={1} MissedType={2} PhoneExtracted={3} LinkedViaWhatId={4}" -f $calls.Length,$conn,$missed,$pe,$wl)
Write-Host "CallTypes:"; $types.GetEnumerator()|ForEach-Object{ Write-Host "   $($_.Key) = $($_.Value)" }
$st=@{}; for($i=0;$i -lt $deals.Length;$i++){ $s=[string]$deals[$i][4]; if(-not $st.ContainsKey($s)){$st[$s]=0}; $st[$s]++ }
Write-Host "Stages:"; $st.GetEnumerator()|Sort-Object Value -Descending|ForEach-Object{ Write-Host "   $($_.Key) = $($_.Value)" }
$od=@{}; for($i=0;$i -lt $deals.Length;$i++){ $nm=$owners[[string]$deals[$i][2]]; if(-not $nm){$nm='('+[string]$deals[$i][2]+')'}; if(-not $od.ContainsKey($nm)){$od[$nm]=0}; $od[$nm]++ }
Write-Host "Owners in deals:"; $od.GetEnumerator()|Sort-Object Value -Descending|ForEach-Object{ Write-Host "   $($_.Key) = $($_.Value)" }
Write-Host "CE byCat:"; $D['ce']['byCat'].GetEnumerator()|ForEach-Object{ Write-Host "   $($_.Key)=$($_.Value)" }
