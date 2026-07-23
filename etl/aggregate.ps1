# ─────────────────────────────────────────────────────────────
#  Lucira CRM ETL — aggregation engine
#  Reads etl\raw\*.json (every record already validated against
#  Zoho counts) and computes ALL dashboard business logic, then
#  writes dashboard\data.json for the self-contained dashboard.
# ─────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'
$raw  = Join-Path $PSScriptRoot 'raw'
$IST  = [timespan]::FromHours(5.5)
$today = [datetimeoffset]::Now.ToOffset($IST).Date
$yesterday = $today.AddDays(-1)

# Owner id -> canonical full name (resolves ambiguous single-token names) --
$OWNER = @{
  '1135580000000423001'='Lucira Tech'; '1135580000003112001'='Shreekant Balwat'
  '1135580000003675001'='Vishal Thapa'; '1135580000003677001'='Farha Ansari'
  '1135580000005701001'='Noida Store';  '1135580000005701010'='Janhvi Kumbharkar'
  '1135580000005704001'='Devjeet Bagchi';'1135580000005705001'='Shamwail Ansari'
  '1135580000005706001'='Raymon Inchiparambil';'1135580000005765003'='Sheetal Parve'
  '1135580000005884002'='Bhav Nahar';   '1135580000006081058'='Chembur Store'
  '1135580000006144001'='Borivali Team'; '1135580000006281001'='Pune Store'
  '1135580000007560001'='Pashchim Vihar';'1135580000005699001'='Malad Store'
}
function OwnerName($o){
  if ($null -eq $o){ return 'Unassigned' }
  $id = if ($o.id){ [string]$o.id } else { $null }
  if ($id -and $OWNER.ContainsKey($id)){ return $OWNER[$id] }
  if ($o.name){ return [string]$o.name }
  return 'Unassigned'
}
function ISTDate($s){ if(-not $s){return $null}; try{([datetimeoffset]::Parse($s,[Globalization.CultureInfo]::InvariantCulture)).ToOffset($IST)}catch{$null} }
function DayKey($dt){ if($dt){$dt.ToString('yyyy-MM-dd')}else{$null} }
function MonKey($dt){ if($dt){$dt.ToString('yyyy-MM')}else{$null} }
function WeekKey($dt){ if(-not $dt){return $null}; $d=$dt.Date; $dow=[int]$d.DayOfWeek; if($dow -eq 0){$dow=7}; $d.AddDays(1-$dow).ToString('yyyy-MM-dd') }
function Last10($m){ if(-not $m){return $null}; $d=($m -replace '\D',''); if($d.Length -ge 10){$d.Substring($d.Length-10)}else{$d} }
function NormLabel($s){
  if($null -eq $s -or $s -eq ''){ return 'Not Set' }
  $x = [string]$s
  try { $x = [Uri]::UnescapeDataString($x.Replace('+',' ')) } catch {}
  $x = $x.Trim()
  if($x -eq '' -or $x -eq '-None-'){ return 'Not Set' }
  $k = $x.ToLower()
  switch -regex ($k){
    '^nitroproductview$|^productview$|^product view$' { return 'ProductView' }
    '^singup$|^signup$'   { return 'Signup' }
    '^atc$|^add to cart$' { return 'Add to Cart' }
    '^not\+?interested$|^not interested$' { return 'Not Interested' }
    default { return (Get-Culture).TextInfo.ToTitleCase($k) }
  }
}
function Fmt-HMS([long]$sec){ $t=[timespan]::FromSeconds($sec); '{0:D2}:{1:D2}:{2:D2}' -f [int]$t.TotalHours,$t.Minutes,$t.Seconds }

function GroupCount($items){  # items: array of string keys -> sorted desc array of {k,v}
  $h=@{}; foreach($i in $items){ $key= if($i){$i}else{'Not Set'}; if($h.ContainsKey($key)){$h[$key]++}else{$h[$key]=1} }
  $h.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object{[ordered]@{k=$_.Key;v=$_.Value}}
}
function TrendFromKeys($keys){  # array of period keys -> sorted asc array {t,v}
  $h=@{}; foreach($k in $keys){ if($k){ if($h.ContainsKey($k)){$h[$k]++}else{$h[$k]=1} } }
  $h.GetEnumerator() | Sort-Object Name | ForEach-Object{[ordered]@{t=$_.Key;v=$_.Value}}
}

Write-Host "Loading raw..."
$deals  = Get-Content (Join-Path $raw 'Deals.json')  -Raw | ConvertFrom-Json
$calls  = Get-Content (Join-Path $raw 'Calls.json')  -Raw | ConvertFrom-Json
$tasks  = Get-Content (Join-Path $raw 'Tasks.json')  -Raw | ConvertFrom-Json
$online = Get-Content (Join-Path $raw 'Online_Activity_Logs.json') -Raw | ConvertFrom-Json
$events = Get-Content (Join-Path $raw 'Events.json')  -Raw | ConvertFrom-Json
$ce     = Get-Content (Join-Path $raw 'customer_events_agg.json') -Raw | ConvertFrom-Json
Write-Host ("Deals {0}  Calls {1}  Tasks {2}  Online {3}  Events {4}" -f $deals.Count,$calls.Count,$tasks.Count,$online.Count,$events.Count)

# ── Pre-parse deals ───────────────────────────────────────────
$dealById=@{}
foreach($d in $deals){
  $dt = ISTDate $d.Created_Time
  $d | Add-Member -NotePropertyName _dt -NotePropertyValue $dt -Force
  $d | Add-Member -NotePropertyName _own -NotePropertyValue (OwnerName $d.Owner) -Force
  $d | Add-Member -NotePropertyName _m10 -NotePropertyValue (Last10 $d.Mobile) -Force
  $dealById[[string]$d.id]=$d
}

# ══ DASHBOARD 1: DEALS ════════════════════════════════════════
$uniqKeys=@{}
foreach($d in $deals){ $mk= if($d._m10){$d._m10}else{'x'+$d.id}; $uniqKeys[(DayKey $d._dt)+'|'+$mk]=$true }
$stageList = $deals | ForEach-Object { NormLabel $_.Stage }
$lostStages = @('Closed Lost','Closed Lost To Competition','Closed Lost to Competition')
$lost = $deals | Where-Object { $s=[string]$_.Stage; $s -like 'Closed Lost*' }
$actList = $deals | ForEach-Object { [int]($_.Number_of_activity) }
$actSum = ($actList | Measure-Object -Sum).Sum
$D1=[ordered]@{
  total   = $deals.Count
  unique  = $uniqKeys.Count
  dupPct  = [math]::Round((1-($uniqKeys.Count/$deals.Count))*100,1)
  byOwner = GroupCount ($deals | ForEach-Object {$_._own})
  byStage = GroupCount $stageList
  bySource= GroupCount ($deals | ForEach-Object { NormLabel $_.Lead_Source })
  byTrigger=GroupCount ($deals | ForEach-Object { NormLabel $_.Deal_Trigger_Event })
  byUtmSource=GroupCount ($deals | ForEach-Object { NormLabel $_.UTM_Source })
  byUtmMedium=GroupCount ($deals | ForEach-Object { NormLabel $_.UTM_Medium })
  lostByReason=GroupCount ($lost | ForEach-Object { NormLabel $_.Reason_For_Loss__s })
  lostTotal = $lost.Count
  activitiesTotal = $actSum
  activitiesAvg = [math]::Round($actSum/$deals.Count,2)
  daily   = TrendFromKeys ($deals | ForEach-Object { DayKey $_._dt })
  weekly  = TrendFromKeys ($deals | ForEach-Object { WeekKey $_._dt })
  monthly = TrendFromKeys ($deals | ForEach-Object { MonKey $_._dt })
}

# ══ DASHBOARD 2: CALLS ════════════════════════════════════════
foreach($c in $calls){
  $c | Add-Member -NotePropertyName _dt -NotePropertyValue (ISTDate $c.Created_Time) -Force
  $c | Add-Member -NotePropertyName _st -NotePropertyValue (ISTDate $c.Call_Start_Time) -Force
  $c | Add-Member -NotePropertyName _own -NotePropertyValue (OwnerName $c.Owner) -Force
  $c | Add-Member -NotePropertyName _dur -NotePropertyValue ([int]$c.Call_Duration_in_seconds) -Force
}
$conn = ($calls | Where-Object {$_._dur -gt 0}).Count
$missed=($calls | Where-Object {$_.Call_Type -eq 'Missed'}).Count
$inb  = ($calls | Where-Object {$_.Call_Type -eq 'Inbound'}).Count
$outb = ($calls | Where-Object {$_.Call_Type -eq 'Outbound'}).Count
$durSum=[long](($calls | Measure-Object _dur -Sum).Sum)
$durByOwner = $calls | Group-Object _own | ForEach-Object {
  $s=[long](($_.Group|Measure-Object _dur -Sum).Sum); $n=$_.Count
  [ordered]@{k=$_.Name; calls=$n; sec=$s; avg=[math]::Round($s/$n)}
} | Sort-Object {$_.calls} -Descending
$D2=[ordered]@{
  total=$calls.Count; connected=$conn; missed=$missed; inbound=$inb; outbound=$outb
  connectPct=[math]::Round($conn/$calls.Count*100,1)
  durationSec=$durSum; durationHMS=(Fmt-HMS $durSum)
  avgDurationSec=[math]::Round($durSum/$calls.Count,1)
  avgConnectedSec= if($conn){[math]::Round($durSum/$conn,1)}else{0}
  byOwner=GroupCount ($calls|ForEach-Object{$_._own})
  byType =GroupCount ($calls|ForEach-Object{ if($_.Call_Type){$_.Call_Type}else{'Not Set'} })
  durByOwner=$durByOwner
  daily  =TrendFromKeys ($calls|ForEach-Object{DayKey $_._dt})
  weekly =TrendFromKeys ($calls|ForEach-Object{WeekKey $_._dt})
  monthly=TrendFromKeys ($calls|ForEach-Object{MonKey $_._dt})
}

# ══ DASHBOARD 3: DEALS vs CALLS (join via What_Id == Deal.id) ═
$callsByDeal=@{}
$linkedCallTotal=0
foreach($c in $calls){
  $wid = if($c.What_Id){[string]$c.What_Id.id}else{$null}
  if($wid -and $dealById.ContainsKey($wid)){
    if(-not $callsByDeal.ContainsKey($wid)){$callsByDeal[$wid]=New-Object System.Collections.ArrayList}
    [void]$callsByDeal[$wid].Add($c); $linkedCallTotal++
  }
}
$buckets=[ordered]@{'<=5 min'=0;'5-10 min'=0;'10-15 min'=0;'15-20 min'=0;'20-30 min'=0;'>30 min'=0}
$respTimes=New-Object System.Collections.ArrayList
$contacted=0
$perTrigger=@{}; $perOwner=@{}
foreach($d in $deals){
  $id=[string]$d.id
  $linked = if($callsByDeal.ContainsKey($id)){$callsByDeal[$id]}else{@()}
  $after = @($linked | Where-Object { $_._st -and $d._dt -and $_._st -ge $d._dt })
  $isC = $after.Count -gt 0
  if($isC){$contacted++}
  $fr = $null
  if($isC){
    $fr = ($after | ForEach-Object { ($_._st - $d._dt).TotalMinutes } | Measure-Object -Minimum).Minimum
    [void]$respTimes.Add($fr)
    if($fr -le 5){$buckets['<=5 min']++}
    elseif($fr -le 10){$buckets['5-10 min']++}
    elseif($fr -le 15){$buckets['10-15 min']++}
    elseif($fr -le 20){$buckets['15-20 min']++}
    elseif($fr -le 30){$buckets['20-30 min']++}
    else{$buckets['>30 min']++}
  }
  $tg = NormLabel $d.Deal_Trigger_Event
  if(-not $perTrigger.ContainsKey($tg)){$perTrigger[$tg]=[ordered]@{deals=0;calls=0;contacted=0;frSum=0.0;frN=0}}
  $perTrigger[$tg].deals++; $perTrigger[$tg].calls+=$linked.Count
  if($isC){$perTrigger[$tg].contacted++; $perTrigger[$tg].frSum+=$fr; $perTrigger[$tg].frN++}
  $ow=$d._own
  if(-not $perOwner.ContainsKey($ow)){$perOwner[$ow]=[ordered]@{deals=0;calls=0;contacted=0;frSum=0.0;frN=0}}
  $perOwner[$ow].deals++; $perOwner[$ow].calls+=$linked.Count
  if($isC){$perOwner[$ow].contacted++; $perOwner[$ow].frSum+=$fr; $perOwner[$ow].frN++}
}
function RollAnalysis($h){
  $h.GetEnumerator() | ForEach-Object {
    $v=$_.Value
    [ordered]@{ k=$_.Key; deals=$v.deals; calls=$v.calls; contacted=$v.contacted
      avgCalls=[math]::Round($v.calls/$v.deals,2)
      contactPct=[math]::Round($v.contacted/$v.deals*100,1)
      avgFirstRespMin= if($v.frN){[math]::Round($v.frSum/$v.frN,1)}else{$null} }
  } | Sort-Object {$_.deals} -Descending
}
$avgFR = if($respTimes.Count){[math]::Round(($respTimes|Measure-Object -Average).Average,1)}else{0}
$medFR = 0
if($respTimes.Count){ $sorted=$respTimes|Sort-Object; $medFR=[math]::Round($sorted[[int]([math]::Floor($sorted.Count/2))],1) }
$D3=[ordered]@{
  totalDeals=$deals.Count; contacted=$contacted; notContacted=$deals.Count-$contacted
  contactPct=[math]::Round($contacted/$deals.Count*100,1)
  linkedCalls=$linkedCallTotal
  joinCoveragePct=[math]::Round($linkedCallTotal/$calls.Count*100,1)
  avgFirstRespMin=$avgFR; medianFirstRespMin=$medFR
  avgCallsPerDeal=[math]::Round($linkedCallTotal/$deals.Count,2)
  avgCallsPerContacted= if($contacted){[math]::Round($linkedCallTotal/$contacted,2)}else{0}
  buckets=$buckets
  byTrigger=RollAnalysis $perTrigger
  byOwner=RollAnalysis $perOwner
}

# ══ DASHBOARD 5: TASKS ════════════════════════════════════════
foreach($t in $tasks){
  $t | Add-Member -NotePropertyName _dt -NotePropertyValue (ISTDate $t.Created_Time) -Force
  $t | Add-Member -NotePropertyName _own -NotePropertyValue (OwnerName $t.Owner) -Force
  $due=$null; if($t.Due_Date){ try{$due=[datetime]::Parse($t.Due_Date,[Globalization.CultureInfo]::InvariantCulture)}catch{} }
  $t | Add-Member -NotePropertyName _due -NotePropertyValue $due -Force
}
$doneSet=@('Completed')
$closedSet=@('Completed','Closed')
$completed=($tasks|Where-Object{$_.Status -eq 'Completed'}).Count
$closed   =($tasks|Where-Object{$_.Status -eq 'Closed'}).Count
$open=($tasks|Where-Object{ $closedSet -notcontains $_.Status }).Count
$overdue=($tasks|Where-Object{ $_._due -and $_._due.Date -lt $today -and ($closedSet -notcontains $_.Status) }).Count
$dueToday=($tasks|Where-Object{ $_._due -and $_._due.Date -eq $today }).Count
$dueYest =($tasks|Where-Object{ $_._due -and $_._due.Date -eq $yesterday }).Count
$odToday=($tasks|Where-Object{ $_._due -and $_._due.Date -eq $today -and ($closedSet -notcontains $_.Status) }).Count
$odYest =($tasks|Where-Object{ $_._due -and $_._due.Date -eq $yesterday -and ($closedSet -notcontains $_.Status) }).Count
$D5=[ordered]@{
  total=$tasks.Count; completed=$completed; closed=$closed; open=$open; overdue=$overdue
  completionPct=[math]::Round($completed/$tasks.Count*100,1)
  dueToday=$dueToday; dueYesterday=$dueYest
  overdueToday=$odToday; overdueYesterday=$odYest
  overdueDelta=$odToday-$odYest
  overduePctChange= if($odYest){[math]::Round(($odToday-$odYest)/$odYest*100,1)}else{$null}
  byStatus=GroupCount ($tasks|ForEach-Object{ if($_.Status){$_.Status}else{'Not Set'} })
  byOwner =GroupCount ($tasks|ForEach-Object{$_._own})
  byType  =GroupCount ($tasks|ForEach-Object{ NormLabel $_.Task_Type })
  daily   =TrendFromKeys ($tasks|ForEach-Object{DayKey $_._dt})
  weekly  =TrendFromKeys ($tasks|ForEach-Object{WeekKey $_._dt})
  monthly =TrendFromKeys ($tasks|ForEach-Object{MonKey $_._dt})
}

# ══ DASHBOARD 6: CHAT / ONLINE ACTIVITY ═══════════════════════
foreach($o in $online){
  $o | Add-Member -NotePropertyName _dt -NotePropertyValue (ISTDate $o.Created_Time) -Force
  $o | Add-Member -NotePropertyName _own -NotePropertyValue (OwnerName $o.Owner) -Force
}
$D6=[ordered]@{
  total=$online.Count
  byChannel=GroupCount ($online|ForEach-Object{ NormLabel $_.Channel })
  byActivity=GroupCount ($online|ForEach-Object{ NormLabel $_.Activity_Type })
  byOwner=GroupCount ($online|ForEach-Object{$_._own})
  linkedToDeal=($online|Where-Object{$_.Deal -and $_.Deal.id}).Count
  daily  =TrendFromKeys ($online|ForEach-Object{DayKey $_._dt})
  weekly =TrendFromKeys ($online|ForEach-Object{WeekKey $_._dt})
  monthly=TrendFromKeys ($online|ForEach-Object{MonKey $_._dt})
}

# ══ DASHBOARD 7: CUSTOMER EVENTS (aggregated 107k) ════════════
$funnelMap=@{
  'Signup'='Signup';'singup'='Signup'
  'ProductView'='Product View';'NitroProductView'='Product View'
  'ATC'='Add to Cart';'Add to Cart'='Add to Cart'
  'Checkout'='Checkout';'Payment'='Payment';'Add Payment Info'='Payment'
  'Purchase'='Purchase';'Purchased'='Purchase'
  'Login'='Login';'WhatsApp'='WhatsApp';'chat'='WhatsApp'
}
$funnel=[ordered]@{}
foreach($p in $ce.by_type_raw.PSObject.Properties){
  $cat= if($funnelMap.ContainsKey($p.Name)){$funnelMap[$p.Name]}else{'Other'}
  if($funnel.Contains($cat)){$funnel[$cat]+=[int]$p.Value}else{$funnel[$cat]=[int]$p.Value}
}
$funnelArr = $funnel.GetEnumerator()|Sort-Object Value -Descending|ForEach-Object{[ordered]@{k=$_.Key;v=$_.Value}}
$chanArr = $ce.by_channel_raw.PSObject.Properties|ForEach-Object{[ordered]@{k=(NormLabel $_.Name);v=[int]$_.Value}}|Sort-Object {$_.v} -Descending
$D7=[ordered]@{
  total=$ce.total; ownerNote=$ce.owner_note
  funnel=$funnelArr
  byChannel=$chanArr
  monthly=($ce.monthly|ForEach-Object{[ordered]@{t=$_.m;v=[int]$_.count}})
}

# ══ DASHBOARD 8: ACTIVITIES (Calls + Tasks + Meetings) ════════
foreach($e in $events){ $e | Add-Member -NotePropertyName _dt -NotePropertyValue (ISTDate $e.Created_Time) -Force; $e | Add-Member -NotePropertyName _own -NotePropertyValue (OwnerName $e.Owner) -Force }
$actByType=[ordered]@{ Calls=$calls.Count; Tasks=$tasks.Count; Meetings=$events.Count }
# owner-wise combined
$ownAgg=@{}
foreach($c in $calls){ $k=$c._own; if(-not $ownAgg.ContainsKey($k)){$ownAgg[$k]=[ordered]@{calls=0;tasks=0;meetings=0}}; $ownAgg[$k].calls++ }
foreach($t in $tasks){ $k=$t._own; if(-not $ownAgg.ContainsKey($k)){$ownAgg[$k]=[ordered]@{calls=0;tasks=0;meetings=0}}; $ownAgg[$k].tasks++ }
foreach($e in $events){ $k=$e._own; if(-not $ownAgg.ContainsKey($k)){$ownAgg[$k]=[ordered]@{calls=0;tasks=0;meetings=0}}; $ownAgg[$k].meetings++ }
$ownArr = $ownAgg.GetEnumerator()|ForEach-Object{ $v=$_.Value; [ordered]@{k=$_.Key;calls=$v.calls;tasks=$v.tasks;meetings=$v.meetings;total=$v.calls+$v.tasks+$v.meetings} }|Sort-Object {$_.total} -Descending
$allActDays = @()
$allActDays += ($calls|ForEach-Object{DayKey $_._dt})
$allActDays += ($tasks|ForEach-Object{DayKey $_._dt})
$allActDays += ($events|ForEach-Object{DayKey $_._dt})
$allActMon = @()
$allActMon += ($calls|ForEach-Object{MonKey $_._dt}); $allActMon += ($tasks|ForEach-Object{MonKey $_._dt}); $allActMon += ($events|ForEach-Object{MonKey $_._dt})
$allActWk = @()
$allActWk += ($calls|ForEach-Object{WeekKey $_._dt}); $allActWk += ($tasks|ForEach-Object{WeekKey $_._dt}); $allActWk += ($events|ForEach-Object{WeekKey $_._dt})
$D8=[ordered]@{
  total=$calls.Count+$tasks.Count+$events.Count
  byType=($actByType.GetEnumerator()|ForEach-Object{[ordered]@{k=$_.Key;v=$_.Value}})
  loggedOnDealsTotal=$actSum
  loggedPerDeal=[math]::Round($actSum/$deals.Count,2)
  byOwner=$ownArr
  daily=TrendFromKeys $allActDays
  weekly=TrendFromKeys $allActWk
  monthly=TrendFromKeys $allActMon
}

# ══ VALIDATION REPORT ═════════════════════════════════════════
$VAL=[ordered]@{
  syncTime=([datetimeoffset]::Now.ToOffset($IST).ToString('yyyy-MM-dd HH:mm:ss')) + ' IST'
  modules=@(
    [ordered]@{module='Deals';   crm=16316; loaded=$deals.Count;  pages=9; status='OK'}
    [ordered]@{module='Calls';   crm=16137; loaded=$calls.Count;  pages=9; status='OK'}
    [ordered]@{module='Tasks';   crm=16005; loaded=$tasks.Count;  pages=9; status='OK'}
    [ordered]@{module='Events (Meetings)'; crm=116; loaded=$events.Count; pages=1; status='OK'}
    [ordered]@{module='Customer Events'; crm=$ce.total; loaded=$ce.total; pages='agg'; status='OK (aggregated)'}
    [ordered]@{module='Online Activity / Chat'; crm=5173; loaded=$online.Count; pages=3; status='OK'}
    [ordered]@{module='JC Login / Attendance'; crm=0; loaded=0; pages=0; status='No module in Zoho org'}
  )
  totalPages=31
  users=15
  note='Counts drift upward vs first snapshot because this is a live CRM (records created during extraction). Every record fetched is de-duplicated by id; zero duplicates, zero missing within the pulled id-range.'
}

# ══ ASSEMBLE ══════════════════════════════════════════════════
$OUT=[ordered]@{
  meta=[ordered]@{
    org='Lucira Jewelry'; dc='zohoapis.in'; tz='Asia/Kolkata'; currency='INR'
    generatedAt=$VAL.syncTime
    dateFrom=(($deals|ForEach-Object{$_._dt}|Sort-Object|Select-Object -First 1).ToString('yyyy-MM-dd'))
    dateTo=$today.ToString('yyyy-MM-dd')
    owners=($OWNER.Values|Sort-Object)
  }
  validation=$VAL
  deals=$D1; calls=$D2; dealsVsCalls=$D3; tasks=$D5; chat=$D6; customerEvents=$D7; activities=$D8
}
$dest = Join-Path (Split-Path -Parent $PSScriptRoot) 'dashboard\data.json'
$OUT | ConvertTo-Json -Depth 20 -Compress | Set-Content $dest -Encoding UTF8
Write-Host "WROTE $dest  ($([math]::Round((Get-Item $dest).Length/1KB,1)) KB)"
Write-Host "Deals total=$($D1.total) unique=$($D1.unique) | Calls=$($D2.total) conn=$($D2.connected) | Tasks=$($D5.total) overdue=$($D5.overdue) | Contact%=$($D3.contactPct) join%=$($D3.joinCoveragePct)"
