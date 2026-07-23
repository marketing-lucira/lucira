# ─────────────────────────────────────────────────────────────
#  Lucira CRM ETL — packager
#  Emits dashboard\data.js  ->  window.DASH = {...}
#  Slim raw records (positional arrays) so the dashboard computes
#  every KPI/chart/filter CLIENT-SIDE from the full record set.
#  Timestamps are already IST (+05:30) so we substring, not parse.
#  Deal date field = Created_Time (unique-deal + all trends).
# ─────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'
$raw = Join-Path $PSScriptRoot 'raw'
$sb  = New-Object System.Text.StringBuilder

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
  if($null -eq $o){return 'Unassigned'}
  $id= if($o.id){[string]$o.id}else{$null}
  if($id -and $OWNER.ContainsKey($id)){return $OWNER[$id]}
  if($o.name){return [string]$o.name}
  'Unassigned'
}
function Esc($s){ if($null -eq $s){return ''}; ([string]$s).Replace('\','\\').Replace('"','\"') -replace '[\r\n\t]',' ' }
function T16($s){ if($s -and $s.Length -ge 16){$s.Substring(0,16)}else{[string]$s} }   # yyyy-MM-ddTHH:mm (IST)
function M10($m){ if(-not $m){return ''}; $d=($m -replace '\D',''); if($d.Length -ge 10){$d.Substring($d.Length-10)}else{$d} }
function J($v){ '"'+(Esc $v)+'"' }

function Emit($name,$rows,$builder){
  [void]$sb.Append('"'+$name+'":[')
  $first=$true
  foreach($r in $rows){ if(-not $first){[void]$sb.Append(',')}; $first=$false; [void]$sb.Append((& $builder $r)) }
  [void]$sb.Append(']')
}

Write-Host 'Loading...'
$deals  = Get-Content (Join-Path $raw 'Deals.json')  -Raw | ConvertFrom-Json
$calls  = Get-Content (Join-Path $raw 'Calls.json')  -Raw | ConvertFrom-Json
$tasks  = Get-Content (Join-Path $raw 'Tasks.json')  -Raw | ConvertFrom-Json
$online = Get-Content (Join-Path $raw 'Online_Activity_Logs.json') -Raw | ConvertFrom-Json
$events = Get-Content (Join-Path $raw 'Events.json')  -Raw | ConvertFrom-Json
$ce     = Get-Content (Join-Path $raw 'customer_events_agg.json') -Raw | ConvertFrom-Json
$chk    = Get-Content (Join-Path (Split-Path -Parent $PSScriptRoot) 'dashboard\data.json') -Raw | ConvertFrom-Json
Write-Host ("Packing D{0} C{1} T{2} O{3} E{4}" -f $deals.Count,$calls.Count,$tasks.Count,$online.Count,$events.Count)

[void]$sb.Append('window.DASH={')
# meta + validation + CE agg + PS cross-check, reuse computed data.json blocks
[void]$sb.Append('"meta":'+($chk.meta|ConvertTo-Json -Depth 6 -Compress)+',')
[void]$sb.Append('"validation":'+($chk.validation|ConvertTo-Json -Depth 6 -Compress)+',')
[void]$sb.Append('"ce":'+($chk.customerEvents|ConvertTo-Json -Depth 6 -Compress)+',')
[void]$sb.Append('"check":{"dealsTotal":'+$chk.deals.total+',"dealsUnique":'+$chk.deals.unique+',"callsTotal":'+$chk.calls.total+',"callsConnected":'+$chk.calls.connected+',"tasksOverdue":'+$chk.tasks.overdue+',"contactPct":'+$chk.dealsVsCalls.contactPct+',"joinPct":'+$chk.dealsVsCalls.joinCoveragePct+'},')

# deals: [id,t,owner,stage,source,trigger,utmSrc,utmMed,reasonLost,numAct,mobile10,prob]
Emit 'deals' $deals { param($d)
  '['+(J $d.id)+','+(J (T16 $d.Created_Time))+','+(J (OwnerName $d.Owner))+','+(J $d.Stage)+','+(J $d.Lead_Source)+','+(J $d.Deal_Trigger_Event)+','+(J $d.UTM_Source)+','+(J $d.UTM_Medium)+','+(J $d.Reason_For_Loss__s)+','+([int]$d.Number_of_activity)+','+(J (M10 $d.Mobile))+','+([int]$d.Probability)+']'
}
[void]$sb.Append(',')
# calls: [id,t,start,dur,type,owner,whatId]
Emit 'calls' $calls { param($c)
  $w= if($c.What_Id){[string]$c.What_Id.id}else{''}
  '['+(J $c.id)+','+(J (T16 $c.Created_Time))+','+(J (T16 $c.Call_Start_Time))+','+([int]$c.Call_Duration_in_seconds)+','+(J $c.Call_Type)+','+(J (OwnerName $c.Owner))+','+(J $w)+']'
}
[void]$sb.Append(',')
# tasks: [id,t,status,due,owner,taskType]
Emit 'tasks' $tasks { param($t)
  '['+(J $t.id)+','+(J (T16 $t.Created_Time))+','+(J $t.Status)+','+(J $t.Due_Date)+','+(J (OwnerName $t.Owner))+','+(J $t.Task_Type)+']'
}
[void]$sb.Append(',')
# online/chat: [id,t,channel,activity,owner,hasDeal]
Emit 'online' $online { param($o)
  $hd= if($o.Deal -and $o.Deal.id){1}else{0}
  '['+(J $o.id)+','+(J (T16 $o.Created_Time))+','+(J $o.Channel)+','+(J $o.Activity_Type)+','+(J (OwnerName $o.Owner))+','+$hd+']'
}
[void]$sb.Append(',')
# events: [id,t,owner,title]
Emit 'events' $events { param($e)
  '['+(J $e.id)+','+(J (T16 $e.Created_Time))+','+(J ([string]$e.Owner))+','+(J $e.Event_Title)+']'
}
[void]$sb.Append('};')

$dest = Join-Path (Split-Path -Parent $PSScriptRoot) 'dashboard\data.js'
[IO.File]::WriteAllText($dest,$sb.ToString(),[Text.UTF8Encoding]::new($false))
Write-Host ("WROTE {0}  ({1:N0} KB)" -f $dest, ((Get-Item $dest).Length/1KB))
