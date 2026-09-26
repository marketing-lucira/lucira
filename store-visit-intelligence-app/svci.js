/* Store Visit & Sales Conversion Intelligence
   Data: window.SVCI_DATA (dashboard/svci_data.js, locally-embedded BigQuery snapshot, built by
   build_svci_data.py). No live fetch -- static, honestly-labeled snapshot.

   Journey: Deal Created -> Agent Call Attempts -> Meeting Raised -> Store Assigned ->
   Store Visit -> Store Follow-up Call -> Sale. Primary hierarchy: City -> Agent -> Day ->
   Deal -> Store Visit -> Sale.

   Chart helpers (svgBar/svgLine/donut) and general utils are ported from the sibling
   dashboard's dcm.js -- same look, same honesty-gate philosophy. See SVCI-README.md for the
   exact data-quality numbers and honesty gates this file respects. */
(function(){
'use strict';

var D = window.SVCI_DATA || {meta:{}, cities:[], agents:[], data_quality:{}, deals:[]};
var ALL = D.deals || [];

/* ---------- generic utils (ported from dcm.js) ---------- */
function el(tag,cls,html){ var e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; }
function esc(s){ return (s==null?'':''+s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function fmtInt(n){ return (n==null||isNaN(n))?'N/A':Math.round(n).toLocaleString('en-IN'); }
function fmtMoney(n){ if(n==null||isNaN(n))return 'N/A'; var a=Math.abs(n),s=n<0?'-':''; if(a>=1e7) return s+'₹'+(a/1e7).toFixed(2)+'Cr'; if(a>=1e5) return s+'₹'+(a/1e5).toFixed(2)+'L'; return s+'₹'+Math.round(a).toLocaleString('en-IN'); }
function fmtPct(n,d){ if(n==null||isNaN(n))return 'N/A'; return n.toFixed(d==null?1:d)+'%'; }
function pct(a,b){ return b?(100*a/b):null; }
function dash(v){ return (v==null||v==='')?'—':v; }
function downloadBlob(content,filename,mime){ if(mime==='text/csv' && typeof content==='string' && content.charCodeAt(0)!==0xFEFF) content='﻿'+content; var blob=new Blob([content],{type:mime+';charset=utf-8'}); var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},800); }
function csvOf(rows){ return rows.map(function(r){return r.map(function(v){ v=(v==null?'':''+v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }).join(',');}).join('\n'); }
function tableToCsv(id){ var t=document.getElementById(id); if(!t)return ''; var rows=[]; t.querySelectorAll('tr').forEach(function(tr){ var r=[]; tr.querySelectorAll('th,td').forEach(function(td){ r.push(td.textContent.trim()); }); rows.push(r); }); return csvOf(rows); }
function addDays(dstr,n){ var p=dstr.split('-').map(Number); var d=new Date(Date.UTC(p[0],p[1]-1,p[2])); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function clampDate(d,lo,hi){ if(d<lo)return lo; if(d>hi)return hi; return d; }
function maskMobile(m){ if(!m) return 'N/A'; var digits=(''+m).replace(/\D/g,''); if(digits.length<4) return '••••••'; return '••••••'+digits.slice(-4); }
function callCell(sec){ if(sec==null) return '<span class="gap">—</span>'; var mn=Math.floor(sec/60), s=sec%60; return sec+'s ('+mn+'min '+s+'s)'; }
function callAggCell(count,sec){ if(!count) return '<span class="gap">0</span>'; var mn=Math.floor(sec/60), s=sec%60; return count+' | '+sec+'s ('+mn+'min '+s+'s)'; }
function dayCell(n){ return (n==null)?'<span class="gap">—</span>':n+'d'; }
function badge(text,cls){ return '<span class="badge '+cls+'">'+esc(text)+'</span>'; }
function visitBadge(status){
  if(status==null) return '<span class="gap">N/A (no meeting)</span>';
  if(status==='Visited (Confirmed)') return badge('Visited (Confirmed)','good');
  if(status==='No Show') return badge('No Show','bad');
  if(status==='Scheduled / Pending') return badge('Scheduled / Pending','warn');
  if(status==='Not Available') return badge('Not Available','mut');
  return badge(status,'mut');
}
function storeCalledBadge(v){
  if(v===true) return badge('Yes','good');
  if(v===false) return badge('No','bad');
  return badge('Not Available','mut');
}

/* ---------- data extents ---------- */
var DATA_MIN = D.meta.date_min || '2026-06-01';
var DATA_MAX = D.meta.date_max || '2026-09-16';
var CITIES = (D.cities||[]).slice();
var AGENTS = (D.agents||[]).slice();
var MEETING_STORES = Array.from(new Set(ALL.map(function(d){return d.meeting_store;}).filter(Boolean))).sort();
var SOURCES = Array.from(new Set(ALL.map(function(d){return d.lead_source;}).filter(Boolean))).sort();

/* ---------- global filter state ---------- */
var F = { from: DATA_MIN, to: DATA_MAX, cities: new Set(), agents: new Set(), meetingRaised:'any',
  storeVisit:'any', meetingStores: new Set(), storeCalled:'any', saleStatus:'any', sources: new Set() };

function inDateRange(d){ return d && d>=F.from && d<=F.to; }

function storeVisitFilterKey(r){
  if(r.store_visit_status==='Visited (Confirmed)') return 'confirmed';
  if(r.store_visit_status==='No Show') return 'noshow';
  if(r.store_visit_status==='Scheduled / Pending') return 'scheduled';
  return 'na'; // Not Available, Video Call/TAH non-visit rows, or no meeting at all
}

function computeFiltered(){
  return ALL.filter(function(r){
    if(!inDateRange(r.created_date)) return false;
    if(F.cities.size && !F.cities.has(r.city_bucket)) return false;
    if(F.agents.size && !F.agents.has(r.agent)) return false;
    if(F.meetingRaised==='yes' && !r.meeting_raised) return false;
    if(F.meetingRaised==='no' && r.meeting_raised) return false;
    if(F.storeVisit!=='any' && storeVisitFilterKey(r)!==F.storeVisit) return false;
    if(F.meetingStores.size && !F.meetingStores.has(r.meeting_store)) return false;
    if(F.storeCalled==='yes' && r.store_called!==true) return false;
    if(F.storeCalled==='no' && r.store_called!==false) return false;
    if(F.storeCalled==='na' && r.store_called!==null) return false;
    if(F.saleStatus==='sold' && r.sale_status!=='Sold') return false;
    if(F.saleStatus==='na' && r.sale_status!=='Not Available') return false;
    if(F.sources.size && !F.sources.has(r.lead_source)) return false;
    return true;
  });
}

/* ================= KPI CALC (12 KPIs) ================= */
function computeKpis(rows){
  var n=rows.length;
  var agentsSet={}, citiesKnown=0;
  var withCall=0, totalAttempts=0, totalSec=0;
  var meetingsRaised=0, storeAssigned=0, storeVisitConfirmed=0, storeCalledYes=0;
  var totalSales=0, salesFromVisit=0;
  var m2vSum=0,m2vN=0;
  rows.forEach(function(r){
    if(r.agent) agentsSet[r.agent]=1;
    if(r.city) citiesKnown++;
    if(r.has_call_attempt) withCall++;
    totalAttempts += r.total_calls||0;
    totalSec += r.total_call_seconds||0;
    if(r.sale_status==='Sold') totalSales++;
    if(r.meeting_raised){
      meetingsRaised++;
      if(r.meeting_store) storeAssigned++;
      if(r.store_visit_confirmed) storeVisitConfirmed++;
      if(r.store_called===true) storeCalledYes++;
      if(r.store_visit_confirmed && r.sale_status==='Sold') salesFromVisit++;
      if(r.days_meeting_to_visit!=null){ m2vSum+=r.days_meeting_to_visit; m2vN++; }
    }
  });
  var citiesCovered = new Set(rows.map(function(r){return r.city;}).filter(Boolean)).size;
  return {
    totalDeals:n, totalAgents:Object.keys(agentsSet).length,
    citiesCovered:citiesCovered, cityKnownPct:pct(citiesKnown,n),
    withCall:withCall, withCallPct: pct(withCall,n),
    meetingsRaised:meetingsRaised, meetingRaisePct:pct(meetingsRaised,n),
    storeAssigned:storeAssigned,
    storeVisitConfirmed:storeVisitConfirmed, storeVisitPct:pct(storeVisitConfirmed,meetingsRaised),
    storeCalledYes:storeCalledYes, storeCalledPct:pct(storeCalledYes,meetingsRaised),
    totalSales:totalSales,
    salesFromVisit:salesFromVisit, salesFromVisitPct:pct(salesFromVisit,storeVisitConfirmed),
    avgM2V: m2vN? m2vSum/m2vN : null
  };
}

var KPI_DEFS = [
  {key:'totalDeals', lbl:'Total Deals', tip:'Count of Deals with Creat_time in the selected date range and passing all active filters.', fmt:fmtInt},
  {key:'totalAgents', lbl:'Total Agents', tip:'Distinct Deal_Owner values among deals in scope.', fmt:fmtInt},
  {key:'citiesCovered', lbl:'Cities Covered', lbl2:function(k){return fmtPct(k.cityKnownPct,1)+' of deals have a known city';}, tip:'Distinct known Address_City values among deals in scope. Address_City is only ~11.2% populated on Deals overall.', fmt:fmtInt},
  {key:'withCall', lbl:'Deals with Call Attempt', lbl2:function(k){return fmtPct(k.withCallPct,1)+' of deals in scope';}, tip:'Deals with >=1 call in lucira_zoho_Calls joined by What_Id = Deal id.', fmt:fmtInt},
  {key:'meetingsRaised', lbl:'Meetings Raised', tip:'Deals with >=1 linked cdc_meetings row (JSON What_Id.id = Deal id).', fmt:fmtInt},
  {key:'meetingRaisePct', lbl:'Meeting Raise %', tip:'Meetings Raised / Total Deals in scope.', fmt:function(v){return fmtPct(v,1);}},
  {key:'storeAssigned', lbl:'Store Assigned (Meeting Store)', tip:'Meeting-raised deals with a resolved Meeting Store (meetings_sheet_sync mobile-match, or cdc_meetings.venue fallback). NOT Deals.Store_Assigned -- that column is 0% populated and unused everywhere in this dashboard.', fmt:fmtInt},
  {key:'storeVisitConfirmed', lbl:'Store Visits Confirmed', lbl2:function(k){return fmtPct(k.storeVisitPct,1)+' of meetings raised';}, tip:'Genuine confirmed attendance: meetings_sheet_sync.action=\'Store Visit\' AND show_no_show=\'Show\'. This is a distinct field from Meeting Raised and from Store Called -- never inferred from either.', fmt:fmtInt},
  {key:'storeCalledYes', lbl:'Stores Called', lbl2:function(k){return fmtPct(k.storeCalledPct,1)+' of meetings raised';}, tip:'Meeting-raised deals where meetings_sheet_sync.call_status is populated (Connected or Not Connected) for the mobile-matched row. Distinct from Store Visit -- a deal can be called without a confirmed visit, or visit without a follow-up call being logged.', fmt:fmtInt},
  {key:'totalSales', lbl:'Total Sales (mobile-matched)', tip:'Deals with a mobile-matched sale in marketing_sale dated on/after the deal/meeting/visit anchor date. Mobile-match only -- marketing_sale has no Deal ID column.', fmt:fmtInt},
  {key:'salesFromVisit', lbl:'Sales from Confirmed Visit', lbl2:function(k){return fmtPct(k.salesFromVisitPct,1)+' of confirmed visits';}, tip:'Deals with Store Visit Confirmed = true AND a mobile-matched sale on/after the visit date.', fmt:fmtInt},
  {key:'avgM2V', lbl:'Avg Days Meeting → Visit', tip:'Average of DATE(store_visit_date) - DATE(meeting_raised_date) across meeting-raised deals with a Store Visit record in scope. Negative diffs are excluded and logged as a data-quality flag.', fmt:function(v){return v==null?'—':v.toFixed(1)+'d';}}
];

function renderKpis(){
  var rows=computeFiltered();
  var k=computeKpis(rows);
  var grid=document.getElementById('kpiGrid'); grid.innerHTML='';
  KPI_DEFS.forEach(function(def){
    var val=k[def.key];
    var c=el('div','kpi');
    var sub = def.lbl2 ? def.lbl2(k) : '';
    c.innerHTML='<div class="lbl">'+def.lbl+' <span class="qmark" title="'+esc(def.tip)+'">ⓘ</span></div><div class="val">'+def.fmt(val)+'</div>'+(sub?'<div class="sub">'+esc(sub)+'</div>':'');
    grid.appendChild(c);
  });
  return rows;
}

/* ================= CHARTS (hand-rolled inline SVG, ported from dcm.js) ================= */
function svgBar(container, rows, labelKey, valueKey, opts){
  opts=opts||{}; container.innerHTML='';
  if(!rows.length){ container.innerHTML='<div class="gap">No data in current filter.</div>'; return; }
  var w=opts.width||Math.max(360, container.clientWidth||600), h=opts.height||220;
  var pad={l:60,r:16,t:10,b:36};
  var max=Math.max.apply(null, rows.map(function(r){return r[valueKey]||0;}).concat([1]));
  var innerW=w-pad.l-pad.r, innerH=h-pad.t-pad.b;
  var bw=innerW/rows.length;
  var svg='<svg viewBox="0 0 '+w+' '+h+'" width="100%" height="'+h+'" style="overflow:visible">';
  [0,.25,.5,.75,1].forEach(function(f){
    var y=pad.t+innerH*(1-f);
    svg+='<line x1="'+pad.l+'" x2="'+(w-pad.r)+'" y1="'+y+'" y2="'+y+'" stroke="var(--line,#2a3242)" stroke-width="1" opacity=".5"/>';
    svg+='<text x="'+(pad.l-8)+'" y="'+(y+4)+'" font-size="9.5" text-anchor="end" fill="var(--tx3,#8993a6)">'+(opts.fmt?opts.fmt(max*f):Math.round(max*f))+'</text>';
  });
  rows.forEach(function(r,i){
    var v=r[valueKey]||0; var bh=innerH*(v/max); var x=pad.l+i*bw+bw*0.15; var bwv=bw*0.7;
    var y=pad.t+innerH-bh;
    svg+='<rect x="'+x+'" y="'+y+'" width="'+bwv+'" height="'+Math.max(bh,0)+'" fill="'+(opts.color||'var(--acc,#4f8cff)')+'" rx="2"><title>'+esc(r[labelKey])+': '+(opts.fmt?opts.fmt(v):v)+'</title></rect>';
    if(rows.length<=20) svg+='<text x="'+(x+bwv/2)+'" y="'+(h-pad.b+14)+'" font-size="9" text-anchor="middle" fill="var(--tx2,#98a3b8)">'+esc((''+r[labelKey]).slice(0,10))+'</text>';
  });
  svg+='</svg>';
  container.innerHTML=svg;
}
function svgLine(container, rows, xKey, series, opts){
  opts=opts||{}; container.innerHTML='';
  if(!rows.length){ container.innerHTML='<div class="gap">No data in current filter.</div>'; return; }
  var w=opts.width||Math.max(360, container.clientWidth||600), h=opts.height||240;
  var pad={l:60,r:16,t:10,b:28};
  var innerW=w-pad.l-pad.r, innerH=h-pad.t-pad.b;
  var allVals=[]; series.forEach(function(s){ rows.forEach(function(r){ allVals.push(r[s.key]||0); }); });
  var max=Math.max.apply(null, allVals.concat([1]));
  var stepX = rows.length>1 ? innerW/(rows.length-1) : 0;
  var svg='<svg viewBox="0 0 '+w+' '+h+'" width="100%" height="'+h+'" style="overflow:visible">';
  [0,.25,.5,.75,1].forEach(function(f){
    var y=pad.t+innerH*(1-f);
    svg+='<line x1="'+pad.l+'" x2="'+(w-pad.r)+'" y1="'+y+'" y2="'+y+'" stroke="var(--line,#2a3242)" stroke-width="1" opacity=".5"/>';
    svg+='<text x="'+(pad.l-8)+'" y="'+(y+4)+'" font-size="9.5" text-anchor="end" fill="var(--tx3,#8993a6)">'+(opts.fmt?opts.fmt(max*f):Math.round(max*f))+'</text>';
  });
  series.forEach(function(s){
    var pts=rows.map(function(r,i){ var x=pad.l+i*stepX; var y=pad.t+innerH*(1-((r[s.key]||0)/max)); return x+','+y; });
    svg+='<polyline points="'+pts.join(' ')+'" fill="none" stroke="'+s.color+'" stroke-width="2"/>';
  });
  var lblStep=Math.max(1, Math.ceil(rows.length/8));
  rows.forEach(function(r,i){ if(i%lblStep===0){ var x=pad.l+i*stepX; svg+='<text x="'+x+'" y="'+(h-8)+'" font-size="9" text-anchor="middle" fill="var(--tx3,#8993a6)">'+esc((r[xKey]||'').slice(5))+'</text>'; } });
  svg+='</svg>';
  var legend='<div style="display:flex;gap:12px;font-size:11px;margin-top:4px;flex-wrap:wrap">'+series.map(function(s){return '<span style="color:'+s.color+'">&#9679;</span> '+esc(s.label);}).join(' &nbsp; ')+'</div>';
  container.innerHTML=svg+legend;
}
function donut(container, segs){
  container.innerHTML='';
  var total=segs.reduce(function(a,s){return a+s.value;},0)||1;
  var r=54,cx=64,cy=64,acc=-90,inner='';
  segs.forEach(function(s){ var a=(s.value/total)*360; var x1=cx+r*Math.cos(acc*Math.PI/180), y1=cy+r*Math.sin(acc*Math.PI/180); var end=acc+a; var x2=cx+r*Math.cos(end*Math.PI/180), y2=cy+r*Math.sin(end*Math.PI/180); var large=a>180?1:0;
    inner+='<path d="M'+cx+' '+cy+' L'+x1.toFixed(1)+' '+y1.toFixed(1)+' A'+r+' '+r+' 0 '+large+' 1 '+x2.toFixed(1)+' '+y2.toFixed(1)+' Z" fill="'+s.color+'"><title>'+esc(s.label)+': '+fmtInt(s.value)+'</title></path>'; acc=end; });
  inner+='<circle cx="'+cx+'" cy="'+cy+'" r="30" fill="var(--card)"></circle>';
  var legend=segs.map(function(s){return '<div style="display:flex;align-items:center;gap:5px;font-size:11px;margin:2px 0"><span style="width:9px;height:9px;border-radius:2px;background:'+s.color+';display:inline-block"></span>'+esc(s.label)+' — '+fmtInt(s.value)+' ('+fmtPct(pct(s.value,total))+')</div>';}).join('');
  container.innerHTML='<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><svg viewBox="0 0 128 128" width="128" height="128">'+inner+'</svg><div>'+legend+'</div></div>';
}

/* ================= FILTER UI ================= */
function fillFilterUI(){
  var cityBox=document.getElementById('msCity'); cityBox.innerHTML='';
  CITIES.forEach(function(c){ var l=el('label'); l.innerHTML='<input type="checkbox" value="'+esc(c)+'"> '+esc(c); cityBox.appendChild(l); });
  var agentBox=document.getElementById('msAgent'); agentBox.innerHTML='';
  AGENTS.forEach(function(a){ var l=el('label'); l.innerHTML='<input type="checkbox" value="'+esc(a)+'"> '+esc(a); agentBox.appendChild(l); });
  var storeBox=document.getElementById('msMeetingStore'); storeBox.innerHTML='';
  MEETING_STORES.forEach(function(s){ var l=el('label'); l.innerHTML='<input type="checkbox" value="'+esc(s)+'"> '+esc(s); storeBox.appendChild(l); });
  var srcBox=document.getElementById('msSource'); srcBox.innerHTML='';
  SOURCES.forEach(function(s){ var l=el('label'); l.innerHTML='<input type="checkbox" value="'+esc(s)+'"> '+esc(s); srcBox.appendChild(l); });

  document.getElementById('fFrom').value=F.from; document.getElementById('fTo').value=F.to;
  document.getElementById('fFrom').min=DATA_MIN; document.getElementById('fFrom').max=DATA_MAX;
  document.getElementById('fTo').min=DATA_MIN; document.getElementById('fTo').max=DATA_MAX;

  [cityBox,agentBox,storeBox,srcBox].forEach(function(box){
    box.addEventListener('change', function(){ readMultiFilters(); renderAll(); });
  });
  document.getElementById('fMeetingRaised').addEventListener('change', function(e){ F.meetingRaised=e.target.value; renderAll(); });
  document.getElementById('fStoreVisit').addEventListener('change', function(e){ F.storeVisit=e.target.value; renderAll(); });
  document.getElementById('fStoreCalled').addEventListener('change', function(e){ F.storeCalled=e.target.value; renderAll(); });
  document.getElementById('fSaleStatus').addEventListener('change', function(e){ F.saleStatus=e.target.value; renderAll(); });
}
function readMultiFilters(){
  function readBox(id,setter){ var s=new Set(); document.querySelectorAll('#'+id+' input:checked').forEach(function(i){ s.add(i.value); }); setter(s); }
  readBox('msCity', function(s){ F.cities=s; });
  readBox('msAgent', function(s){ F.agents=s; });
  readBox('msMeetingStore', function(s){ F.meetingStores=s; });
  readBox('msSource', function(s){ F.sources=s; });
}
function applyDatePreset(preset){
  var max=DATA_MAX;
  if(preset==='today'){ F.from=max; F.to=max; }
  else if(preset==='yesterday'){ F.from=addDays(max,-1); F.to=addDays(max,-1); }
  else if(preset==='7'){ F.from=clampDate(addDays(max,-6),DATA_MIN,DATA_MAX); F.to=max; }
  else if(preset==='30'){ F.from=clampDate(addDays(max,-29),DATA_MIN,DATA_MAX); F.to=max; }
  else if(preset==='90'){ F.from=clampDate(addDays(max,-89),DATA_MIN,DATA_MAX); F.to=max; }
  else if(preset==='all'){ F.from=DATA_MIN; F.to=DATA_MAX; }
  document.getElementById('fFrom').value=F.from; document.getElementById('fTo').value=F.to;
  renderAll();
}

/* ================= TAB 0: MEETING INTELLIGENCE (ALL Zoho CRM Meetings) =================
   Sourced from D.all_meetings -- the FULL Events/Meetings module, not just deal-linked meetings
   (which is what the rest of this dashboard uses via ALL[].meeting_raised etc). Fully
   independent filter state/UI from the global filterbar above, since it filters on different
   date fields (meeting Create Date / From, not Deal Created date). */
var ALL_MEETINGS = D.all_meetings || [];
function miDateOnly(iso){ return iso ? (''+iso).slice(0,10) : null; }
var MI_CREATED_DATES = ALL_MEETINGS.map(function(m){return m.created_date;}).filter(Boolean).sort();
var MI_FROM_DATES = ALL_MEETINGS.map(function(m){return miDateOnly(m.start_datetime);}).filter(Boolean).sort();
var MI_MIN = MI_CREATED_DATES[0] || '2026-01-01';
var MI_MAX = MI_CREATED_DATES[MI_CREATED_DATES.length-1] || DATA_MAX;
var MI_FROM_MIN = MI_FROM_DATES[0] || MI_MIN;
var MI_FROM_MAX = MI_FROM_DATES[MI_FROM_DATES.length-1] || MI_MAX;
var MI_VENUES = Array.from(new Set(ALL_MEETINGS.map(function(m){return m.venue;}).filter(Boolean))).sort();

// Default the From (Visit Date) filter to "today" (IST, from the data's own generation
// timestamp, not the viewer's local browser clock -- avoids a timezone mismatch showing the
// wrong day), so the tab opens on "meetings scheduled to visit today" and the on-screen count
// is based on From date, not Create Date. Clamped into the From-date range actually present in
// the data (falls back to the latest/earliest available day if today has none). Create Date
// stays the full range by default -- narrowing that too would hide meetings raised on other
// days whose customer is still expected to visit today.
var MI_TODAY_RAW = ((D.meta.generated_at_ist||'')+'').slice(0,10) || MI_FROM_MAX;
var MI_TODAY_FROM = MI_TODAY_RAW; // clamped into the From-date range
if(MI_TODAY_FROM < MI_FROM_MIN) MI_TODAY_FROM = MI_FROM_MIN;
if(MI_TODAY_FROM > MI_FROM_MAX) MI_TODAY_FROM = MI_FROM_MAX;

var MIF = { from: MI_MIN, to: MI_MAX, fromFrom: MI_TODAY_FROM, fromTo: MI_TODAY_FROM, store:'', location:'', title:'' };

var MONTH_ABBR=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDateNice(iso){
  if(!iso) return '—';
  var m=(''+iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(!m) return '—';
  return parseInt(m[3],10)+' '+MONTH_ABBR[parseInt(m[2],10)-1]+' '+m[1];
}
function fmtDateTimeNice(iso){
  if(!iso) return '—';
  var m=(''+iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if(!m) return fmtDateNice(iso);
  var hh=parseInt(m[4],10), mi=m[5];
  var ampm = hh>=12 ? 'PM' : 'AM';
  var h12 = hh%12; if(h12===0) h12=12;
  return parseInt(m[3],10)+' '+MONTH_ABBR[parseInt(m[2],10)-1]+' '+m[1]+', '+h12+':'+mi+' '+ampm;
}
function miDash(v){ return (v==null || v==='' || v==='null' || v==='undefined') ? '—' : v; }

function fillMiFilterUI(){
  var storeSel=document.getElementById('miStore'), locSel=document.getElementById('miLocation');
  MI_VENUES.forEach(function(v){
    var o1=document.createElement('option'); o1.value=v; o1.textContent=v; storeSel.appendChild(o1);
    var o2=document.createElement('option'); o2.value=v; o2.textContent=v; locSel.appendChild(o2);
  });
  document.getElementById('miFrom').value=MIF.from; document.getElementById('miFrom').min=MI_MIN; document.getElementById('miFrom').max=MI_MAX;
  document.getElementById('miTo').value=MIF.to; document.getElementById('miTo').min=MI_MIN; document.getElementById('miTo').max=MI_MAX;
  document.getElementById('miFromFrom').value=MIF.fromFrom; document.getElementById('miFromFrom').min=MI_FROM_MIN; document.getElementById('miFromFrom').max=MI_FROM_MAX;
  document.getElementById('miFromTo').value=MIF.fromTo; document.getElementById('miFromTo').min=MI_FROM_MIN; document.getElementById('miFromTo').max=MI_FROM_MAX;

  document.getElementById('miFrom').addEventListener('change', function(e){ MIF.from=e.target.value||MI_MIN; renderMeetingIntel(); });
  document.getElementById('miTo').addEventListener('change', function(e){ MIF.to=e.target.value||MI_MAX; renderMeetingIntel(); });
  document.getElementById('miFromFrom').addEventListener('change', function(e){ MIF.fromFrom=e.target.value||MI_FROM_MIN; renderMeetingIntel(); });
  document.getElementById('miFromTo').addEventListener('change', function(e){ MIF.fromTo=e.target.value||MI_FROM_MAX; renderMeetingIntel(); });
  storeSel.addEventListener('change', function(e){ MIF.store=e.target.value; renderMeetingIntel(); });
  locSel.addEventListener('change', function(e){ MIF.location=e.target.value; renderMeetingIntel(); });
  document.getElementById('miTitle').addEventListener('input', function(e){ MIF.title=e.target.value.trim().toLowerCase(); renderMeetingIntel(); });
  document.getElementById('miResetBtn').addEventListener('click', function(){
    MIF = { from: MI_MIN, to: MI_MAX, fromFrom: MI_TODAY_FROM, fromTo: MI_TODAY_FROM, store:'', location:'', title:'' };
    document.getElementById('miFrom').value=MIF.from; document.getElementById('miTo').value=MIF.to;
    document.getElementById('miFromFrom').value=MIF.fromFrom; document.getElementById('miFromTo').value=MIF.fromTo;
    storeSel.value=''; locSel.value=''; document.getElementById('miTitle').value='';
    miPage=1; miSortKey='created_date'; miSortDir=-1;
    renderMeetingIntel();
  });
}

function computeMiFiltered(){
  return ALL_MEETINGS.filter(function(m){
    var cd=m.created_date, fd=miDateOnly(m.start_datetime);
    if(cd && (cd<MIF.from || cd>MIF.to)) return false;
    if(!cd && (MIF.from>MI_MIN || MIF.to<MI_MAX)) return false; // no create date -- excluded once date filter narrowed
    if(MIF.fromFrom!==MI_FROM_MIN || MIF.fromTo!==MI_FROM_MAX){
      if(!fd || fd<MIF.fromFrom || fd>MIF.fromTo) return false;
    }
    if(MIF.store && m.venue!==MIF.store) return false;
    if(MIF.location && m.venue!==MIF.location) return false;
    if(MIF.title && !((m.event_title||'').toLowerCase().indexOf(MIF.title)>=0)) return false;
    return true;
  });
}

var miPage=1, miPageSize=50, miSortKey='created_date', miSortDir=-1;

/* Store x Date pivot: rows = raw Venue value (unnormalized -- "Borivali"/"Borivali Store"/
   "Borivali visit" stay separate rows, exactly as the source data has them, per this
   dashboard's no-fabricated-normalization rule), columns = one per distinct date present in
   the current filtered rows, cell = meeting count. No Grand Total row/column, per request.
   dateField selects which date drives the columns: 'created_date' for the Create Date pivot,
   'start_datetime' (date part) for the From pivot. Missing venue groups under row label "—". */
function renderMiPivot(rows, dateField, tableId){
  var dateOf = function(m){ return dateField==='created_date' ? m.created_date : miDateOnly(m.start_datetime); };
  var venues = {}, dates = {};
  rows.forEach(function(m){
    var d = dateOf(m);
    if(!d) return; // no date for this axis -- excluded from this pivot, not guessed
    var v = m.venue || '—';
    dates[d]=true;
    (venues[v] = venues[v] || {})[d] = (venues[v][d] || 0) + 1;
  });
  var dateCols = Object.keys(dates).sort();
  var venueRows = Object.keys(venues).sort(function(a,b){ return a==='—'?1 : b==='—'?-1 : a.localeCompare(b); });
  var t = document.getElementById(tableId);
  if(!dateCols.length || !venueRows.length){
    t.innerHTML = '<thead><tr><th>Row Labels</th></tr></thead><tbody><tr><td class="gap">No meetings with a valid date in current filter.</td></tr></tbody>';
    return;
  }
  var thead = '<thead><tr><th>Row Labels</th>' + dateCols.map(function(d){ return '<th class="num">'+esc(fmtDateNice(d))+'</th>'; }).join('') + '</tr></thead>';
  var bodyRows = venueRows.map(function(v){
    var cells = dateCols.map(function(d){
      var c = (venues[v][d] || 0);
      return '<td class="num">' + (c ? fmtInt(c) : '') + '</td>';
    }).join('');
    return '<tr><td>'+esc(v)+'</td>'+cells+'</tr>';
  });
  t.innerHTML = thead + '<tbody>' + bodyRows.join('') + '</tbody>';
}

var MI_COLS=[
  {key:'venue', lbl:'Store Name'},
  {key:'venue', lbl:'Used Location'},
  {key:'created_date', lbl:'Create Date'},
  {key:'start_datetime', lbl:'From'},
  {key:'event_title', lbl:'Title'}
];
function renderMiDetail(rows){
  var sorted=rows.slice().sort(function(a,b){
    var av=a[miSortKey], bv=b[miSortKey];
    if(av==null && bv==null) return 0;
    if(av==null) return 1; if(bv==null) return -1;
    if(av<bv) return -1*miSortDir; if(av>bv) return 1*miSortDir; return 0;
  });
  var start=(miPage-1)*miPageSize;
  var pageRows=sorted.slice(start, start+miPageSize);
  var t=document.getElementById('tblMiDetail');
  var thead='<thead><tr>'+MI_COLS.map(function(c,i){
    var arrow = (c.key===miSortKey) ? (miSortDir===1?' ▲':' ▼') : '';
    return '<th data-mi-sort="'+c.key+'" style="cursor:pointer">'+esc(c.lbl)+arrow+'</th>';
  }).join('')+'</tr></thead>';
  var tbody='<tbody>'+pageRows.map(function(m){
    return '<tr>'
      +'<td>'+esc(miDash(m.venue))+'</td>'
      +'<td>'+esc(miDash(m.venue))+'</td>'
      +'<td>'+esc(fmtDateNice(m.created_date))+'</td>'
      +'<td>'+esc(fmtDateTimeNice(m.start_datetime))+'</td>'
      +'<td>'+esc(miDash(m.event_title))+'</td>'
      +'</tr>';
  }).join('')+'</tbody>';
  if(!pageRows.length) tbody='<tbody><tr><td colspan="'+MI_COLS.length+'" class="gap">No meetings match the current filter.</td></tr></tbody>';
  t.innerHTML=thead+tbody;
  t.querySelectorAll('th[data-mi-sort]').forEach(function(th){
    th.addEventListener('click', function(){
      var k=th.dataset.miSort;
      if(miSortKey===k) miSortDir=-miSortDir; else { miSortKey=k; miSortDir=1; }
      renderMiDetail(window.__miRowsCache||rows);
    });
  });
  window.__miRowsCache = rows;
  document.getElementById('miPageInfo').textContent = 'Page '+miPage+' of '+Math.max(1,Math.ceil(sorted.length/miPageSize))+' ('+fmtInt(sorted.length)+' meetings, '+miPageSize+'/page)';
}
function renderMeetingIntel(){
  var rows=computeMiFiltered();
  renderMiPivot(rows, 'created_date', 'tblMiPivotCreate');
  renderMiPivot(rows, 'start_datetime', 'tblMiPivotFrom');
  miPage=1;
  renderMiDetail(rows);
  document.getElementById('miScopeNote').textContent = 'Scope: From (Visit Date) '+MIF.fromFrom+' to '+MIF.fromTo+' · '+fmtInt(rows.length)+' of '+fmtInt(ALL_MEETINGS.length)+' total meetings in current filter (all Zoho CRM Meetings, deal-linked or not)';
}
function wireMiTabExtras(){
  document.getElementById('miPrev').addEventListener('click', function(){ if(miPage>1){ miPage--; renderMiDetail(window.__miRowsCache||computeMiFiltered()); } });
  document.getElementById('miNext').addEventListener('click', function(){
    var rows=window.__miRowsCache||computeMiFiltered();
    if(miPage*miPageSize<rows.length){ miPage++; renderMiDetail(rows); }
  });
}

/* ================= TAB 1: EXECUTIVE OVERVIEW extras ================= */
var trendBreakdown='none';
function renderOverviewCharts(rows){
  // Daily Deals Trend
  var byDate={};
  rows.forEach(function(r){ if(!r.created_date) return; byDate[r.created_date]=(byDate[r.created_date]||0)+1; });
  var dateRows=Object.keys(byDate).sort().map(function(d){return {date:d, count:byDate[d]};});
  if(trendBreakdown==='none'){
    svgLine(document.getElementById('chDailyTrend'), dateRows, 'date', [{key:'count',color:'var(--c1,#4f8cff)',label:'Deals'}], {fmt:fmtInt});
  } else {
    var field = trendBreakdown==='city' ? 'city_bucket' : 'agent';
    var counts={}; rows.forEach(function(r){ var k=r[field]||'N/A'; counts[k]=(counts[k]||0)+1; });
    var top5=Object.keys(counts).sort(function(a,b){return counts[b]-counts[a];}).slice(0,5);
    var byDateSeries={}; rows.forEach(function(r){ if(!r.created_date)return; var k=r[field]||'N/A'; if(top5.indexOf(k)<0) return; byDateSeries[r.created_date]=byDateSeries[r.created_date]||{}; byDateSeries[r.created_date][k]=(byDateSeries[r.created_date][k]||0)+1; });
    var dr=Object.keys(byDateSeries).sort().map(function(d){ var o={date:d}; top5.forEach(function(k){o[k]=byDateSeries[d][k]||0;}); return o; });
    var palette=['#4f8cff','#22d3a8','#f4b740','#c084fc','#fb7185'];
    var series=top5.map(function(k,i){return {key:k,color:palette[i%palette.length],label:k};});
    svgLine(document.getElementById('chDailyTrend'), dr, 'date', series, {fmt:fmtInt});
  }

  // Conversion Funnel
  var n=rows.length;
  var callAttempt=rows.filter(function(r){return r.has_call_attempt;}).length;
  var meetingsRaised=rows.filter(function(r){return r.meeting_raised;}).length;
  var storeAssigned=rows.filter(function(r){return r.meeting_store;}).length;
  var storeVisitConfirmed=rows.filter(function(r){return r.store_visit_confirmed;}).length;
  var storeCalled=rows.filter(function(r){return r.store_called===true;}).length;
  var sales=rows.filter(function(r){return r.sale_status==='Sold';}).length;
  var funnelRows=[
    {stage:'Total Deals', value:n},
    {stage:'Call Attempt', value:callAttempt},
    {stage:'Meetings Raised', value:meetingsRaised},
    {stage:'Store Assigned', value:storeAssigned},
    {stage:'Store Visit (Confirmed)', value:storeVisitConfirmed},
    {stage:'Store Called', value:storeCalled},
    {stage:'Sales', value:sales}
  ];
  svgBar(document.getElementById('chFunnel'), funnelRows, 'stage', 'value', {fmt:fmtInt, color:'var(--c2,#22d3a8)'});
  var ft=document.getElementById('tblFunnel'); ft.innerHTML='<thead><tr><th>Stage</th><th>Count</th><th>% of Total Deals</th></tr></thead><tbody>'
    +funnelRows.map(function(r){return '<tr><td>'+r.stage+'</td><td class="num">'+fmtInt(r.value)+'</td><td class="num">'+fmtPct(pct(r.value,n),1)+'</td></tr>';}).join('')+'</tbody>';

  // City Summary
  // NOTE: Meeting->Sale% must divide sales AMONG meeting-raised deals by meetings raised, NOT
  // total city sales by meetings raised -- most sales (637 total) come from deals that never
  // had a meeting (only 307 meetings raised total), so dividing total sales by meetings would
  // routinely read over 100% (the exact bug the sibling DCM dashboard hit and fixed). Track a
  // separate salesFromMeeting counter here.
  var byCity={};
  rows.forEach(function(r){
    var a=byCity[r.city_bucket]=byCity[r.city_bucket]||{city:r.city_bucket, deals:0, meetings:0, visits:0, storeCalled:0, sales:0, salesFromMeeting:0};
    a.deals++;
    if(r.meeting_raised) a.meetings++;
    if(r.store_visit_confirmed) a.visits++;
    if(r.store_called===true) a.storeCalled++;
    if(r.sale_status==='Sold') a.sales++;
    if(r.meeting_raised && r.sale_status==='Sold') a.salesFromMeeting++;
  });
  var cityRows=Object.keys(byCity).map(function(k){return byCity[k];});
  cityRows.sort(function(a,b){return b.deals-a.deals;});
  var ct=document.getElementById('tblCitySummary');
  ct.innerHTML='<thead><tr><th>City</th><th>Deals</th><th>Meetings Raised</th><th>Meeting %</th><th>Store Visits Confirmed</th><th>Visit %</th><th>Store Called</th><th>Total Sales (all deals)</th><th>Sales from Meeting-raised Deals</th><th>Meeting→Sale %</th></tr></thead><tbody>'
    +cityRows.map(function(r){return '<tr><td>'+esc(r.city)+'</td><td class="num">'+fmtInt(r.deals)+'</td><td class="num">'+fmtInt(r.meetings)+'</td><td class="num">'+fmtPct(pct(r.meetings,r.deals),1)+'</td><td class="num">'+fmtInt(r.visits)+'</td><td class="num">'+fmtPct(pct(r.visits,r.meetings),1)+'</td><td class="num">'+fmtInt(r.storeCalled)+'</td><td class="num">'+fmtInt(r.sales)+'</td><td class="num">'+fmtInt(r.salesFromMeeting)+'</td><td class="num">'+fmtPct(pct(r.salesFromMeeting,r.meetings),1)+'</td></tr>';}).join('')+'</tbody>';
  document.getElementById('citySummaryCount').textContent = cityRows.length+' cities/buckets in current filter';
}

/* ================= DATA QUALITY (Tab 1) ================= */
function renderDataQuality(){
  var dq=D.data_quality||{};
  var rows=[
    ['Deal ID uniqueness', fmtPct(dq.deal_id_uniqueness_pct,2)+' ('+fmtInt(dq.duplicate_deal_id_rows)+' duplicate rows)'],
    ['Total deals', fmtInt(dq.total_deals)],
    ['Address_City coverage', fmtInt(dq.city_known_count)+' of '+fmtInt(dq.total_deals)+' ('+fmtPct(dq.city_known_pct,2)+') -- the remaining deals are shown as "City Not Captured" everywhere, never dropped'],
    ['Calls table: rows with a What_Id', fmtInt(dq.calls_with_what_id)+' of '+fmtInt(dq.calls_total_rows)+' ('+fmtPct(dq.calls_to_deal_match_pct,2)+')'],
    ['Deals matched to >=1 call (What_Id join)', fmtInt(dq.call_to_deal_matched_deals)+' of '+fmtInt(dq.total_deals)+' ('+fmtPct(dq.call_to_deal_matched_pct,2)+')'],
    ['cdc_meetings: rows resolving a real Deal id (re-verified live via IN (SELECT id FROM Deals))', fmtInt(dq.cdc_meetings_resolves_deal)+' of '+fmtInt(dq.cdc_meetings_total_rows)+' ('+fmtPct(dq.cdc_meetings_to_deal_match_pct,2)+')'],
    ['Deals with Meeting Raised', fmtInt(dq.meeting_raised_count)+' of '+fmtInt(dq.total_deals)+' ('+fmtPct(dq.meeting_raised_pct,2)+')'],
    ['Meeting Store resolved from meetings_sheet_sync', fmtInt(dq.meeting_store_from_sheet)],
    ['Meeting Store resolved from cdc_meetings.venue (fallback)', fmtInt(dq.meeting_store_from_venue_fallback)],
    ['Meeting Store Not Available (no match either source)', fmtInt(dq.meeting_store_not_available)],
    ['meetings_sheet_sync: Store Visit Confirmed rows (action=Store Visit AND show_no_show=Show)', fmtInt(dq.store_visit_confirmed_sheet_rows)+' of '+fmtInt(dq.sheet_rows_total)+' sheet rows'],
    ['Store Visit Confirmed, resolved to a Deal (mobile-match)', fmtInt(dq.store_visit_confirmed_deals)+' of '+fmtInt(dq.meeting_raised_count)+' meeting-raised deals'],
    ['Store Visit No Show (resolved to a Deal)', fmtInt(dq.store_visit_no_show_deals)],
    ['Store Visit Scheduled / Pending (WIP or null show_no_show)', fmtInt(dq.store_visit_scheduled_pending_deals)],
    ['Store Visit Not Available (no sheet match for a meeting-raised deal)', fmtInt(dq.store_visit_not_available_deals)],
    ['Store Called: Yes / No / Not Available', fmtInt(dq.store_called_yes)+' / '+fmtInt(dq.store_called_no)+' / '+fmtInt(dq.store_called_not_available)],
    ['meetings_sheet_sync rows / distinct mobiles', fmtInt(dq.sheet_rows_total)+' / '+fmtInt(dq.sheet_distinct_mobiles)],
    ['meetings_sheet_sync action breakdown', 'Store Visit '+fmtInt(dq.sheet_action_store_visit)+' · Video Call '+fmtInt(dq.sheet_action_video_call)+' · TAH '+fmtInt(dq.sheet_action_tah)],
    ['meetings_sheet_sync show_no_show breakdown', 'No Show '+fmtInt(dq.sheet_no_show_rows)+' · WIP '+fmtInt(dq.sheet_wip_rows)],
    ['marketing_sale rows / distinct mobiles', fmtInt(dq.sale_rows_total)+' / '+fmtInt(dq.sale_distinct_mobiles)],
    ['Deals matched to a sale (mobile-match, not Deal ID)', fmtInt(dq.sales_matched_to_deal)+' of '+fmtInt(dq.total_deals)+' ('+fmtPct(dq.sales_matched_pct_of_deals,2)+')'],
    ['Sales among Store-Visit-Confirmed deals', fmtInt(dq.sales_matched_from_confirmed_visit)+' of '+fmtInt(dq.store_visit_confirmed_deals)+' ('+fmtPct(dq.sales_matched_from_confirmed_visit_pct,2)+')'],
    ['Negative date-diff rows excluded (data-quality flags)', JSON.stringify(dq.negative_date_diff_flags||{})]
  ];
  var t=document.getElementById('tblDataQuality'); t.innerHTML='<thead><tr><th>Check</th><th>Result</th></tr></thead><tbody>'
    +rows.map(function(r){return '<tr><td>'+r[0]+'</td><td>'+r[1]+'</td></tr>';}).join('')+'</tbody>';
  document.getElementById('dqNote').innerHTML='Snapshot generated: <b>'+esc(D.meta.generated_at_ist||'N/A')+'</b>. '+esc(D.meta.note||'')+' <b>This card always reports on the full dataset regardless of the filter bar above.</b> Every other section respects the active filter. <b>Deals.Store_Assigned is never used anywhere in this dashboard (verified 0% populated).</b> Meeting-raised sample size is small (n≈'+fmtInt(D.data_quality.meeting_raised_count)+' of '+fmtInt(D.data_quality.total_deals)+' deals) -- every Meeting/Visit/Store/Sale metric downstream of it inherits that small sample.';
}

/* ================= TAB 2: CITY -> AGENT -> DAY TREE ================= */
function newAgg(){ return {deals:0, c1n:0,c1s:0, c2n:0,c2s:0, c3n:0,c3s:0, totCalls:0, totSec:0,
  meetings:0, storeAssigned:0, visits:0, storeCalled:0, sales:0, salesFromMeeting:0}; }
function addToAgg(a, r){
  a.deals++;
  if(r.call1_sec!=null){ a.c1n++; a.c1s+=r.call1_sec; }
  if(r.call2_sec!=null){ a.c2n++; a.c2s+=r.call2_sec; }
  if(r.call3_sec!=null){ a.c3n++; a.c3s+=r.call3_sec; }
  a.totCalls += r.total_calls||0; a.totSec += r.total_call_seconds||0;
  if(r.meeting_raised) a.meetings++;
  if(r.meeting_store) a.storeAssigned++;
  if(r.store_visit_confirmed) a.visits++;
  if(r.store_called===true) a.storeCalled++;
  if(r.sale_status==='Sold') a.sales++;
  if(r.meeting_raised && r.sale_status==='Sold') a.salesFromMeeting++;
}
function buildTree(rows){
  var cityMap={};
  rows.forEach(function(r){
    var c=r.city_bucket;
    var cNode = cityMap[c] = cityMap[c] || {key:c, agg:newAgg(), agents:{}};
    addToAgg(cNode.agg, r);
    var a=r.agent;
    var aNode = cNode.agents[a] = cNode.agents[a] || {key:a, agg:newAgg(), days:{}};
    addToAgg(aNode.agg, r);
    var dt=r.created_date || 'Unknown';
    var dNode = aNode.days[dt] = aNode.days[dt] || {key:dt, agg:newAgg(), deals:[]};
    addToAgg(dNode.agg, r);
    dNode.deals.push(r);
  });
  var cities=Object.keys(cityMap).map(function(k){return cityMap[k];});
  cities.forEach(function(c){
    c.agentsArr=Object.keys(c.agents).map(function(k){return c.agents[k];});
    c.agentsArr.sort(function(x,y){return y.agg.deals-x.agg.deals;});
    c.agentsArr.forEach(function(a){
      a.daysArr=Object.keys(a.days).map(function(k){return a.days[k];});
      a.daysArr.sort(function(x,y){return x.key<y.key?1:(x.key>y.key?-1:0);});
    });
  });
  cities.sort(function(x,y){return y.agg.deals-x.agg.deals;});
  return cities;
}

var expandedCities=new Set(), expandedAgents=new Set(), treeSearch='';
function aggCells(agg){
  return '<td class="num">'+fmtInt(agg.deals)+'</td>'+
    '<td class="num">'+callAggCell(agg.c1n,agg.c1s)+'</td>'+
    '<td class="num">'+callAggCell(agg.c2n,agg.c2s)+'</td>'+
    '<td class="num">'+callAggCell(agg.c3n,agg.c3s)+'</td>'+
    '<td class="num">'+callAggCell(agg.totCalls,agg.totSec)+'</td>'+
    '<td class="num">'+fmtInt(agg.meetings)+'</td>'+
    '<td class="num">'+fmtPct(pct(agg.meetings,agg.deals),1)+'</td>'+
    '<td class="num">'+fmtInt(agg.visits)+'</td>'+
    '<td class="num">'+fmtPct(pct(agg.visits,agg.meetings),1)+'</td>'+
    '<td class="num">'+fmtInt(agg.sales)+'</td>'+
    '<td class="num">'+fmtPct(pct(agg.salesFromMeeting,agg.meetings),1)+'</td>';
}
function renderTree(rows){
  var tree=buildTree(rows);
  if(treeSearch){
    var s=treeSearch.toLowerCase();
    tree=tree.filter(function(c){
      if((c.key||'').toLowerCase().indexOf(s)>=0) return true;
      return c.agentsArr.some(function(a){ return (a.key||'').toLowerCase().indexOf(s)>=0; });
    });
  }
  var head=['City','Agent','Deal Date','Total Deals','1st Call','2nd Call','3rd Call','Total Call','Meetings Raised','Meeting %','Store Visits','Visit %','Sales','Sale %'];
  var thead='<thead><tr>'+head.map(function(h){return '<th>'+h+'</th>';}).join('')+'</tr></thead>';
  var body='';
  tree.forEach(function(c){
    var cOpen=expandedCities.has(c.key);
    body+='<tr class="treeRow" data-lvl="city" data-key="'+esc(c.key)+'"><td><span class="twist">'+(cOpen?'▾':'▸')+'</span><b>'+esc(c.key)+'</b></td><td class="gap">— all agents —</td><td></td>'+aggCells(c.agg)+'</tr>';
    if(!cOpen) return;
    c.agentsArr.forEach(function(a){
      var akey=c.key+'|||'+a.key;
      var aOpen=expandedAgents.has(akey);
      body+='<tr class="treeRow" data-lvl="agent" data-ckey="'+esc(c.key)+'" data-key="'+esc(akey)+'"><td style="padding-left:24px">'+esc(c.key)+'</td><td><span class="twist">'+(aOpen?'▾':'▸')+'</span><b>'+esc(a.key)+'</b></td><td class="gap">— all days —</td>'+aggCells(a.agg)+'</tr>';
      if(!aOpen) return;
      a.daysArr.forEach(function(d){
        body+='<tr data-lvl="day"><td style="padding-left:48px">'+esc(c.key)+'</td><td style="padding-left:16px">'+esc(a.key)+'</td><td>'+esc(d.key)+'</td>'+aggCells(d.agg)+'</tr>';
      });
    });
  });
  var t=document.getElementById('tblTree'); t.innerHTML=thead+'<tbody>'+body+'</tbody>';
  t.querySelectorAll('.treeRow').forEach(function(tr){
    tr.addEventListener('click', function(){
      var lvl=tr.dataset.lvl;
      if(lvl==='city'){
        var k=tr.dataset.key;
        if(expandedCities.has(k)) expandedCities.delete(k); else expandedCities.add(k);
      } else if(lvl==='agent'){
        var ak=tr.dataset.key;
        if(expandedAgents.has(ak)) expandedAgents.delete(ak); else expandedAgents.add(ak);
      }
      renderTree(computeFiltered());
    });
  });
}

/* ================= TAB 2: charts (agent perf, call dist, city conv, avg days) ================= */
function renderCityAgentCharts(rows){
  var agentTotals={}; rows.forEach(function(r){ agentTotals[r.agent]=(agentTotals[r.agent]||0)+1; });
  var agentBarRows=Object.keys(agentTotals).map(function(a){return {agent:a, deals:agentTotals[a]};}).sort(function(a,b){return b.deals-a.deals;}).slice(0,15);
  svgBar(document.getElementById('chAgentPerf'), agentBarRows, 'agent', 'deals', {fmt:fmtInt, color:'var(--c1,#4f8cff)'});

  var noCall=0,one=0,two=0,three=0;
  rows.forEach(function(r){ var tc=r.total_calls||0; if(tc===0) noCall++; else if(tc===1) one++; else if(tc===2) two++; else three++; });
  donut(document.getElementById('chCallDist'), [
    {label:'No Call', value:noCall, color:'#fb7185'},
    {label:'1st Only', value:one, color:'#f4b740'},
    {label:'2 Calls', value:two, color:'#4f8cff'},
    {label:'3+ Calls', value:three, color:'#22d3a8'}
  ]);

  var byCity={};
  rows.filter(function(r){return r.meeting_raised;}).forEach(function(r){
    var a=byCity[r.city_bucket]=byCity[r.city_bucket]||{meetings:0,sales:0};
    a.meetings++; if(r.sale_status==='Sold') a.sales++;
  });
  var cityConvRows=Object.keys(byCity).map(function(c){return {city:c, pctv: pct(byCity[c].sales, byCity[c].meetings)||0, meetings:byCity[c].meetings, sales:byCity[c].sales};});
  cityConvRows.sort(function(a,b){return b.meetings-a.meetings;});
  svgBar(document.getElementById('chCityConv'), cityConvRows.slice(0,20), 'city', 'pctv', {fmt:function(v){return v.toFixed(0)+'%';}, color:'var(--c4,#c084fc)'});

  var d2m=[], m2v=[], m2sc=[], m2s=[];
  rows.forEach(function(r){
    if(r.days_deal_to_meeting!=null) d2m.push(r.days_deal_to_meeting);
    if(r.days_meeting_to_visit!=null) m2v.push(r.days_meeting_to_visit);
    if(r.days_meeting_to_storecall!=null) m2sc.push(r.days_meeting_to_storecall);
    if(r.days_meeting_to_sale!=null) m2s.push(r.days_meeting_to_sale);
  });
  function avg(a){ return a.length? a.reduce(function(x,y){return x+y;},0)/a.length : 0; }
  var avgDaysRows=[
    {label:'Deal → Meeting', value:avg(d2m)},
    {label:'Meeting → Visit', value:avg(m2v)},
    {label:'Meeting → Store Call', value:avg(m2sc)},
    {label:'Meeting → Sale', value:avg(m2s)}
  ];
  svgBar(document.getElementById('chAvgDays'), avgDaysRows, 'label', 'value', {fmt:function(v){return v.toFixed(1)+'d';}, color:'var(--c6,#38bdf8)'});
}

/* ================= TAB 3: STORE VISIT INTELLIGENCE ================= */
function renderStoreVisitTab(rows){
  var meetingRows=rows.filter(function(r){return r.meeting_raised;});
  var byKey={};
  meetingRows.forEach(function(r){
    var store=r.meeting_store || '(No Store Resolved)';
    var key=r.city_bucket+'|||'+store;
    var a=byKey[key]=byKey[key]||{city:r.city_bucket, store:store, assigned:0, visits:0, called:0, sales:0};
    a.assigned++;
    if(r.store_visit_confirmed) a.visits++;
    if(r.store_called===true) a.called++;
    if(r.sale_status==='Sold') a.sales++;
  });
  var svRows=Object.keys(byKey).map(function(k){return byKey[k];});
  svRows.sort(function(a,b){return b.assigned-a.assigned;});
  var t=document.getElementById('tblStoreVisit');
  t.innerHTML='<thead><tr><th>City</th><th>Meeting Store</th><th>Meetings Assigned</th><th>Store Visits</th><th>Visit %</th><th>Store Called</th><th>Store Call %</th><th>Sales</th><th>Meeting→Sale %</th></tr></thead><tbody>'
    +svRows.map(function(r){return '<tr><td>'+esc(r.city)+'</td><td>'+esc(r.store)+'</td><td class="num">'+fmtInt(r.assigned)+'</td><td class="num">'+fmtInt(r.visits)+'</td><td class="num">'+fmtPct(pct(r.visits,r.assigned),1)+'</td><td class="num">'+fmtInt(r.called)+'</td><td class="num">'+fmtPct(pct(r.called,r.assigned),1)+'</td><td class="num">'+fmtInt(r.sales)+'</td><td class="num">'+fmtPct(pct(r.sales,r.assigned),1)+'</td></tr>';}).join('')+'</tbody>';

  var statusCounts={};
  meetingRows.forEach(function(r){
    var k=r.store_visit_status||'Not Available';
    statusCounts[k]=(statusCounts[k]||0)+1;
  });
  var palette={'Visited (Confirmed)':'#22c55e','No Show':'#ff5d6c','Scheduled / Pending':'#f4b740','Not a Store Visit (Video Call)':'#4f8cff','Not a Store Visit (TAH)':'#c084fc','Not Available':'#68738a'};
  var segs=Object.keys(statusCounts).map(function(k){return {label:k, value:statusCounts[k], color:palette[k]||'#98a3b8'};});
  donut(document.getElementById('chVisitStatus'), segs);
}

/* ================= TAB 4: DEAL JOURNEY ================= */
var drillPage=1, drillPageSize=50;
function renderDrillTable(rows){
  var start=(drillPage-1)*drillPageSize;
  var pageRows=rows.slice(start, start+drillPageSize);
  var t=document.getElementById('tblDrill');
  var head=['Deal ID','Deal Name','Created','City','Agent','Customer','Mobile','1st Call','2nd Call','3rd Call','Total Call','Meeting Raised','Meeting Date','Meeting Owner','Meeting Venue','Meeting Store','Store Visit Status','Store Visit Date','Store Called','Store Call Date','Days Deal→Meeting','Days Meeting→Visit','Days Meeting→StoreCall','Sale Status','Sale Date','Days Meeting→Sale','Sale Amount','Invoice'];
  var thead='<thead><tr>'+head.map(function(h){return '<th>'+h+'</th>';}).join('')+'</tr></thead>';
  var tbody='<tbody>'+pageRows.map(function(r,i){
    return '<tr class="drillRow" data-idx="'+(start+i)+'">'+
      '<td>'+esc(r.deal_id)+'</td><td>'+esc(r.deal_name)+'</td><td>'+dash(r.created_date)+'</td>'+
      '<td>'+esc(r.city_bucket)+'</td><td>'+esc(r.agent)+'</td><td>'+esc(r.contact_name)+'</td>'+
      '<td>'+maskMobile(r.mobile)+'</td>'+
      '<td>'+callCell(r.call1_sec)+'</td><td>'+callCell(r.call2_sec)+'</td><td>'+callCell(r.call3_sec)+'</td>'+
      '<td>'+callAggCell(r.total_calls,r.total_call_seconds)+'</td>'+
      '<td>'+(r.meeting_raised?'Yes':'No')+'</td><td>'+dash(r.meeting_raised_date)+'</td><td>'+dash(r.meeting_owner)+'</td><td>'+dash(r.meeting_venue)+'</td>'+
      '<td>'+dash(r.meeting_store)+'</td>'+
      '<td>'+visitBadge(r.store_visit_status)+'</td><td>'+dash(r.store_visit_date)+'</td>'+
      '<td>'+storeCalledBadge(r.store_called)+'</td><td>'+dash(r.store_call_date)+'</td>'+
      '<td>'+dayCell(r.days_deal_to_meeting)+'</td>'+
      '<td>'+dayCell(r.days_meeting_to_visit)+'</td>'+
      '<td>'+dayCell(r.days_meeting_to_storecall)+'</td>'+
      '<td>'+esc(r.sale_status)+'</td><td>'+dash(r.sale_date)+'</td>'+
      '<td>'+dayCell(r.days_meeting_to_sale)+'</td>'+
      '<td class="num">'+(r.sale_amount!=null?fmtMoney(r.sale_amount):'—')+'</td><td>'+dash(r.sale_invoice)+'</td>'+
    '</tr>';
  }).join('')+'</tbody>';
  t.innerHTML=thead+tbody;
  t.querySelectorAll('.drillRow').forEach(function(tr){
    tr.addEventListener('click', function(){ openDrawer(rows[+tr.dataset.idx]); });
  });
  document.getElementById('drillPageInfo').textContent = 'Page '+drillPage+' of '+Math.max(1,Math.ceil(rows.length/drillPageSize))+' ('+fmtInt(rows.length)+' deals, '+drillPageSize+'/page -- never all rows rendered at once)';
  window.__drillRowsCache = rows;
}
function renderDrillTab(rows){
  drillPage=1;
  renderDrillTable(rows);
}

/* ================= DRILL-DOWN DRAWER: JOURNEY TIMELINE ================= */
function openDrawer(r){
  if(!r) return;
  var nodes=[
    {label:'Deal Created', date:r.created_date},
    {label:'1st Call', date: r.call1_time ? (r.call1_time.slice? r.call1_time.slice(0,10):r.call1_time) : null, extra: r.call1_sec!=null? callCell(r.call1_sec):null},
    {label:'2nd Call', date: r.call2_time ? (r.call2_time.slice? r.call2_time.slice(0,10):r.call2_time) : null, extra: r.call2_sec!=null? callCell(r.call2_sec):null},
    {label:'3rd Call', date: r.call3_time ? (r.call3_time.slice? r.call3_time.slice(0,10):r.call3_time) : null, extra: r.call3_sec!=null? callCell(r.call3_sec):null},
    {label:'Meeting Raised', date: r.meeting_raised_date, extra: r.meeting_raised? (esc(r.meeting_owner||'')+(r.meeting_venue?(' @ '+esc(r.meeting_venue)):'')) : null},
    {label:'Store Assigned', date: r.meeting_store? r.meeting_raised_date : null, extra: r.meeting_store? esc(r.meeting_store) : null},
    {label:'Store Visit', date: r.store_visit_date, extra: r.store_visit_status? visitBadge(r.store_visit_status) : null},
    {label:'Store Follow-up Call', date: r.store_call_date, extra: r.store_call_status? esc(r.store_call_status): storeCalledBadge(r.store_called)},
    {label:'Sale', date: r.sale_date, extra: r.sale_status==='Sold'? (fmtMoney(r.sale_amount)+' · '+esc(r.sale_invoice||'')) : 'Not Available'}
  ];
  var html='<div class="drawHead"><div><b>'+esc(r.deal_name||r.deal_id)+'</b><div class="sub">Deal ID '+esc(r.deal_id)+' · '+esc(r.city_bucket)+' · '+esc(r.agent)+'</div></div><span id="drawClose" class="btn">✕</span></div>';
  html+='<div class="timeline">';
  nodes.forEach(function(n){
    var has = !!n.date;
    html+='<div class="tnode '+(has?'has':'gap2')+'"><div class="tdot"></div><div class="tbody"><div class="tlbl">'+n.label+'</div><div class="tdate">'+(has?n.date:'—')+'</div>'+(n.extra?'<div class="textra">'+n.extra+'</div>':'')+'</div></div>';
  });
  html+='</div>';
  html+='<div class="note" style="margin-top:10px">Meeting Store / Store Visit / Store Called sourced from <code>meetings_sheet_sync</code> (mobile-matched) with <code>cdc_meetings.venue</code> as a fallback for Meeting Store only. Store Visit is genuine confirmed attendance (<code>action=\'Store Visit\' AND show_no_show=\'Show\'</code>) -- distinct from Meeting Raised and from Store Called. Sale matched by mobile to <code>marketing_sale</code> -- not a Deal ID join.</div>';
  var drawer=document.getElementById('drawer');
  drawer.innerHTML=html;
  drawer.classList.add('open');
  document.getElementById('drawClose').addEventListener('click', function(){ drawer.classList.remove('open'); });
}

/* ================= MAIN RENDER + WIRING ================= */
function renderAll(){
  renderMeetingIntel();
  var rows=renderKpis();
  renderOverviewCharts(rows);
  renderDataQuality();
  renderTree(rows);
  renderCityAgentCharts(rows);
  renderStoreVisitTab(rows);
  renderDrillTab(rows);
  var srcLabel = D.meta.source==='live_zoho_crm+bigquery' ? 'LIVE Zoho CRM + BigQuery' : (D.meta.source==='bigquery' ? 'BigQuery snapshot' : 'BigQuery snapshot');
  document.getElementById('freshPill').innerHTML='<span class="dot"></span> Data as of '+esc(D.meta.generated_at_ist||'N/A')+' ('+esc(srcLabel)+') — refresh by rerunning build_svci_data.py [--source live]';
  document.getElementById('scopeNote').textContent = 'Scope: '+F.from+' to '+F.to+' · '+fmtInt(rows.length)+' deals in current filter';
}

function wireTabs(){
  document.querySelectorAll('.tab').forEach(function(t){
    t.addEventListener('click', function(){
      document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active');});
      document.querySelectorAll('.view').forEach(function(x){x.classList.remove('on');});
      t.classList.add('active');
      document.getElementById(t.dataset.view).classList.add('on');
    });
  });
}
function wireFilters(){
  document.getElementById('fFrom').addEventListener('change', function(e){ F.from=e.target.value||DATA_MIN; renderAll(); });
  document.getElementById('fTo').addEventListener('change', function(e){ F.to=e.target.value||DATA_MAX; renderAll(); });
  document.querySelectorAll('[data-preset]').forEach(function(b){ b.addEventListener('click', function(){ applyDatePreset(b.dataset.preset); }); });
  document.getElementById('resetFiltBtn').addEventListener('click', function(){
    F.cities=new Set(); F.agents=new Set(); F.meetingStores=new Set(); F.sources=new Set();
    F.meetingRaised='any'; F.storeVisit='any'; F.storeCalled='any'; F.saleStatus='any';
    document.querySelectorAll('.msbox input').forEach(function(i){i.checked=false;});
    document.getElementById('fMeetingRaised').value='any';
    document.getElementById('fStoreVisit').value='any';
    document.getElementById('fStoreCalled').value='any';
    document.getElementById('fSaleStatus').value='any';
    applyDatePreset('all');
  });
  document.getElementById('moreFiltBtn').addEventListener('click', function(){ document.getElementById('fdrawer').classList.toggle('open'); });
  document.getElementById('themeBtn').addEventListener('click', function(){
    var html=document.documentElement; html.setAttribute('data-theme', html.getAttribute('data-theme')==='dark'?'light':'dark');
  });
  document.getElementById('printBtn').addEventListener('click', function(){ window.print(); });
  document.querySelectorAll('[data-csv]').forEach(function(b){ b.addEventListener('click', function(){ downloadBlob(tableToCsv(b.dataset.csv), b.dataset.name+'.csv', 'text/csv'); }); });
  document.querySelectorAll('[data-trend]').forEach(function(b){ b.addEventListener('click', function(){
    trendBreakdown=b.dataset.trend;
    document.querySelectorAll('[data-trend]').forEach(function(x){x.classList.remove('active2');});
    b.classList.add('active2');
    renderOverviewCharts(computeFiltered());
  }); });
  document.getElementById('treeSearchInp').addEventListener('input', function(e){ treeSearch=e.target.value.trim(); renderTree(computeFiltered()); });
  document.getElementById('treeExpandAll').addEventListener('click', function(){
    CITIES.forEach(function(c){ expandedCities.add(c); });
    renderTree(computeFiltered());
  });
  document.getElementById('treeCollapseAll').addEventListener('click', function(){
    expandedCities.clear(); expandedAgents.clear();
    renderTree(computeFiltered());
  });
  document.getElementById('drillSearch').addEventListener('input', function(e){
    var v=e.target.value.trim().toLowerCase();
    var rows=computeFiltered().filter(function(r){
      return !v || (''+r.deal_id).toLowerCase().indexOf(v)>=0 || (r.deal_name||'').toLowerCase().indexOf(v)>=0 || (r.contact_name||'').toLowerCase().indexOf(v)>=0;
    });
    drillPage=1; renderDrillTable(rows);
  });
  document.getElementById('drillPrev').addEventListener('click', function(){ if(drillPage>1){ drillPage--; renderDrillTable(window.__drillRowsCache); } });
  document.getElementById('drillNext').addEventListener('click', function(){ var rows=window.__drillRowsCache||[]; if(drillPage*drillPageSize<rows.length){ drillPage++; renderDrillTable(rows); } });
}

document.addEventListener('DOMContentLoaded', function(){
  fillFilterUI();
  fillMiFilterUI(); wireMiTabExtras();
  wireTabs(); wireFilters();
  renderAll();
  var boot=document.getElementById('boot'); if(boot){ boot.classList.add('hide'); setTimeout(function(){boot.remove();},500); }
});

})();
