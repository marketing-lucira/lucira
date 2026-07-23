# build.ps1 — Deals VS Call ETL
# Reads the raw Zoho MCP tool-result JSON pages saved this session, classifies them
# by module, dedupes by id, validates counts, and packs dashboard/data.js.
# All data is Created_Time >= 2026-05-31 (post 31st May), Asia/Kolkata.

$ErrorActionPreference = 'Stop'
[System.Reflection.Assembly]::LoadWithPartialName('System.Web.Extensions') | Out-Null
$jss = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$jss.MaxJsonLength = [int]::MaxValue
$jss.RecursionLimit = 200

$Root      = 'c:\Users\ADMIN\.antigravity-ide'
$ToolDir   = 'C:\Users\ADMIN\.claude\projects\c--Users-ADMIN--antigravity-ide\b4008d5b-53d7-4d08-a1fd-990f15047772\tool-results'
$OutJs     = Join-Path $Root 'dashboard\data.js'
$CutoffStr = '2026-05-31T00:00:00'
$Cutoff    = [datetime]::Parse($CutoffStr)

function Digits10([string]$s){
  if([string]::IsNullOrEmpty($s)){ return '' }
  $d = ($s -replace '[^0-9]','')
  if($d.Length -ge 10){ return $d.Substring($d.Length-10) }
  return $d
}
# Parse Zoho ISO like 2026-06-03T17:39:19+05:30 -> keep local wall-clock (already IST); return 'yyyy-MM-ddTHH:mm:ss'
function IstIso([string]$s){
  if([string]::IsNullOrEmpty($s)){ return $null }
  # strip timezone offset, keep the local time as Zoho returns IST for these modules
  $m = [regex]::Match($s,'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})')
  if($m.Success){ return $m.Groups[1].Value }
  $m2 = [regex]::Match($s,'^(\d{4}-\d{2}-\d{2})')
  if($m2.Success){ return $m2.Groups[1].Value + 'T00:00:00' }
  return $null
}
function DtOf([string]$iso){
  if([string]::IsNullOrEmpty($iso)){ return $null }
  try { return [datetime]::Parse($iso) } catch { return $null }
}

# ---- owner map from getUsers file (toolu_*.txt) ----
$owners = @{}
Get-ChildItem $ToolDir -Filter 'toolu_*.txt' -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $o = $jss.DeserializeObject((Get-Content $_.FullName -Raw))
    if($o.data -and $o.data.users){
      foreach($u in $o.data.users){
        $id = [string]$u.id
        $nm = [string]$u.full_name
        if([string]::IsNullOrEmpty($nm)){ $nm = (('' + $u.first_name + ' ' + $u.last_name).Trim()) }
        if($id){ $owners[$id] = $nm }
      }
    }
  } catch {}
}
Write-Host "Owners loaded: $($owners.Count)"

# ---- collect module records from all mcp COQL/getRecords page files ----
$deals=@{}; $calls=@{}; $tasks=@{}; $online=@{}; $events=@{}
$ceByCatDay = @{}         # cat -> (date -> count)
$ceByRaw    = @{}         # raw type -> count
$ceTotal    = 0
$ceDates    = @{}         # date -> count (all cats)
$pagesRead  = 0

function CeCat([string]$t){
  if([string]::IsNullOrEmpty($t)){ return 'Other' }
  $x = $t.ToLower()
  if($x -match 'signup' -or $x -match 'singup'){ return 'Signup' }
  if($x -match 'atc' -or $x -match 'addtocart' -or $x -match 'add.?to.?cart'){ return 'ATC' }
  if($x -match 'checkout'){ return 'Checkout' }
  if($x -match 'purchase' -or $x -match 'payment'){ return 'Purchase' }
  if($x -match 'productview' -or $x -match 'pageview' -or $x -match 'websitevisit' -or $x -match 'view'){ return 'Website Visit' }
  return 'Other'
}

$files = Get-ChildItem $ToolDir -Filter 'mcp-claude_ai_Zoho_CRM-*.txt' -ErrorAction SilentlyContinue
Write-Host "Page files: $($files.Count)"
foreach($f in $files){
  $obj = $null
  try { $obj = $jss.DeserializeObject((Get-Content $f.FullName -Raw)) } catch { Write-Host "PARSE FAIL $($f.Name)"; continue }
  $rows = $null
  if($obj.data -and $obj.data.data){ $rows = $obj.data.data } elseif($obj.data -and $obj.data.users){ continue } else { continue }
  if($null -eq $rows){ continue }
  $pagesRead++
  foreach($r in $rows){
    $keys = @($r.Keys)
    if($keys -contains 'Event_Type'){
      # Customer_Events slim (no id) -> aggregate
      $iso = IstIso([string]$r['Created_Time'])
      if($null -eq $iso){ continue }
      $dt = DtOf $iso
      if($dt -lt $Cutoff){ continue }
      $date = $iso.Substring(0,10)
      $raw = [string]$r['Event_Type']; if([string]::IsNullOrEmpty($raw)){ $raw='(blank)' }
      $cat = CeCat $raw
      $ceTotal++
      if(-not $ceByRaw.ContainsKey($raw)){ $ceByRaw[$raw]=0 }; $ceByRaw[$raw]++
      if(-not $ceByCatDay.ContainsKey($cat)){ $ceByCatDay[$cat]=@{} }
      if(-not $ceByCatDay[$cat].ContainsKey($date)){ $ceByCatDay[$cat][$date]=0 }; $ceByCatDay[$cat][$date]++
      if(-not $ceDates.ContainsKey($date)){ $ceDates[$date]=0 }; $ceDates[$date]++
      continue
    }
    $id = [string]$r['id']
    if([string]::IsNullOrEmpty($id)){ continue }
    if($keys -contains 'Stage' -and $keys -contains 'Deal_Name'){
      $iso = IstIso([string]$r['Created_Time']); if($null -eq (DtOf $iso)){ continue }
      if((DtOf $iso) -lt $Cutoff){ continue }
      $ownId = ''
      if($r['Owner.id']){ $ownId=[string]$r['Owner.id'] } elseif($r['Owner']){ $ownId=[string]$r['Owner'].id }
      $deals[$id] = @(
        $id,
        [string]$r['Deal_Name'],
        $ownId,
        $iso,
        [string]$r['Stage'],
        $(if($null -ne $r['Probability']){ [int]$r['Probability'] } else { $null }),
        [string]$r['Lead_Source'],
        [string]$r['Reason_For_Loss__s'],
        [string]$r['Deal_Trigger_Event'],
        [string]$r['UTM_Source'],
        [string]$r['UTM_Medium'],
        $(if($null -ne $r['Number_of_activity']){ [int]$r['Number_of_activity'] } else { 0 }),
        (Digits10 ([string]$r['Mobile']))
      )
    }
    elseif($keys -contains 'Call_Type'){
      $iso = IstIso([string]$r['Created_Time']); if($null -eq (DtOf $iso)){ continue }
      if((DtOf $iso) -lt $Cutoff){ continue }
      $ownId=''; if($r['Owner.id']){ $ownId=[string]$r['Owner.id'] } elseif($r['Owner']){ $ownId=[string]$r['Owner'].id }
      $whatId=''
      if($r['What_Id']){ if($r['What_Id'].id){ $whatId=[string]$r['What_Id'].id } else { $whatId=[string]$r['What_Id'] } }
      # phone from subject "(...number...)"
      $subj=[string]$r['Subject']; $phone=''
      if($subj){ $mm=[regex]::Matches($subj,'\(([^)]*\d[^)]*)\)'); if($mm.Count -gt 0){ $phone=Digits10($mm[$mm.Count-1].Groups[1].Value) } }
      $dur = 0; if($null -ne $r['Call_Duration_in_seconds']){ try{$dur=[int]$r['Call_Duration_in_seconds']}catch{$dur=0} }
      $calls[$id] = @(
        $id, $ownId, $iso, [string]$r['Call_Type'], $dur,
        (IstIso([string]$r['Call_Start_Time'])), $whatId, $phone
      )
    }
    elseif($keys -contains 'Due_Date' -and $keys -contains 'Status'){
      $iso = IstIso([string]$r['Created_Time']); if($null -eq (DtOf $iso)){ continue }
      if((DtOf $iso) -lt $Cutoff){ continue }
      $ownId=''; if($r['Owner.id']){ $ownId=[string]$r['Owner.id'] } elseif($r['Owner']){ $ownId=[string]$r['Owner'].id }
      $tasks[$id] = @(
        $id, $ownId, $iso, [string]$r['Status'], [string]$r['Due_Date'], (IstIso([string]$r['Closed_Time']))
      )
    }
    elseif($keys -contains 'Channel'){
      $iso = IstIso([string]$r['Created_Time']); if($null -eq (DtOf $iso)){ continue }
      if((DtOf $iso) -lt $Cutoff){ continue }
      $ownId=''; if($r['Owner.id']){ $ownId=[string]$r['Owner.id'] } elseif($r['Owner']){ $ownId=[string]$r['Owner'].id }
      $online[$id] = @(
        $id, $ownId, $iso, [string]$r['Channel'], [string]$r['Activity_Type']
      )
    }
    elseif($keys -contains 'Start_DateTime'){
      # Events (meetings) from getRecords; filter to cutoff
      $iso = IstIso([string]$r['Created_Time']); if($null -eq (DtOf $iso)){ continue }
      if((DtOf $iso) -lt $Cutoff){ continue }
      $ownId=''; $ownNm=''
      if($r['Owner']){ $ownId=[string]$r['Owner'].id; $ownNm=[string]$r['Owner'].name } elseif($r['Owner.id']){ $ownId=[string]$r['Owner.id'] }
      $events[$id] = @(
        $id, $ownId, $iso, (IstIso([string]$r['Start_DateTime'])), (IstIso([string]$r['End_DateTime'])), [string]$r['Event_Title']
      )
    }
  }
}

$dealsArr  = @($deals.Values)
$callsArr  = @($calls.Values)
$tasksArr  = @($tasks.Values)
$onlineArr = @($online.Values)
$eventsArr = @($events.Values)

Write-Host "Deals=$($dealsArr.Count) Calls=$($callsArr.Count) Tasks=$($tasksArr.Count) Online=$($onlineArr.Count) Events=$($eventsArr.Count) CE=$ceTotal pages=$pagesRead"

# CE aggregate objects
$ceCats = @('Signup','ATC','Checkout','Purchase','Website Visit','Other')
$ceByCatTotal = @{}
foreach($c in $ceCats){ $ceByCatTotal[$c] = 0 }
foreach($c in $ceByCatDay.Keys){ $s=0; foreach($d in $ceByCatDay[$c].Keys){ $s += $ceByCatDay[$c][$d] }; $ceByCatTotal[$c]=$s }

# top raw types
$ceRawTop = $ceByRaw.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 25 |
  ForEach-Object { @{ t=$_.Key; n=$_.Value } }

$payload = [ordered]@{
  meta = [ordered]@{
    generated = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
    cutoff    = $CutoffStr
    tz        = 'Asia/Kolkata'
    pagesRead = $pagesRead
  }
  owners = $owners
  dealFields  = @('id','name','owner','created','stage','prob','leadSource','reasonLoss','trigger','utmSource','utmMedium','numAct','mobile10')
  callFields  = @('id','owner','created','type','durSec','start','whatId','phone10')
  taskFields  = @('id','owner','created','status','dueDate','closed')
  onlineFields= @('id','owner','created','channel','activityType')
  eventFields = @('id','owner','created','start','end','title')
  deals  = $dealsArr
  calls  = $callsArr
  tasks  = $tasksArr
  online = $onlineArr
  events = $eventsArr
  ce = [ordered]@{
    total     = $ceTotal
    cats      = $ceCats
    byCat     = $ceByCatTotal
    byCatDay  = $ceByCatDay
    byDay     = $ceDates
    rawTop    = $ceRawTop
  }
  validation = [ordered]@{
    Deals  = $dealsArr.Count
    Calls  = $callsArr.Count
    Tasks  = $tasksArr.Count
    Online = $onlineArr.Count
    Events = $eventsArr.Count
    CustomerEvents = $ceTotal
  }
}

$json = $jss.Serialize($payload)
$js = "window.DASH = " + $json + ";"
[System.IO.File]::WriteAllText($OutJs, $js, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "WROTE $OutJs  ($([math]::Round((Get-Item $OutJs).Length/1MB,2)) MB)"
