/* Store City & Agent-wise Deals -> Calls -> Meetings -> Store Follow-up -> Sales Intelligence
   Data: window.DCM_DATA (dashboard/dcm_data.js, locally-embedded BigQuery snapshot, built by
   build_dcm_data.py). No live fetch -- static, honestly-labeled snapshot. See the Data Quality
   tab + DCM-README.md for the exact honesty gates this file respects. */
(function(){
'use strict';

var D = window.DCM_DATA || {meta:{}, cities:[], agents:[], data_quality:{}, deals:[]};
var ALL = D.deals || [];

/* ---------- generic utils ---------- */
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

/* ---------- data extents ---------- */
var DATA_MIN = D.meta.date_min || '2026-06-01';
var DATA_MAX = D.meta.date_max || '2026-09-16';
var CITIES = (D.cities||[]).slice();
var AGENTS = (D.agents||[]).slice();
var MEETING_STORES = Array.from(new Set(ALL.map(function(d){return d.meeting_store;}).filter(Boolean))).sort();
var SOURCES = Array.from(new Set(ALL.map(function(d){return d.lead_source;}).filter(Boolean))).sort();

/* ---------- global filter state ---------- */
var F = { from: DATA_MIN, to: DATA_MAX, cities: new Set(), agents: new Set(), meetingRaised:'any',
  meetingStores: new Set(), storeCalled:'any', saleStatus:'any', sources: new Set() };

function inDateRange(d){ return d && d>=F.from && d<=F.to; }

function computeFiltered(){
  return ALL.filter(function(r){
    if(!inDateRange(r.created_date)) return false;
    if(F.cities.size && !F.cities.has(r.city_bucket)) return false;
    if(F.agents.size && !F.agents.has(r.agent)) return false;
    if(F.meetingRaised==='yes' && !r.meeting_raised) return false;
    if(F.meetingRaised==='no' && r.meeting_raised) return false;
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

/* ================= KPI CALC ================= */
function computeKpis(rows){
  var n=rows.length;
  var agentsSet={}, citiesKnown=0;
  var withCall=0, totalAttempts=0, totalSec=0;
  var meetingsRaised=0, meetingsWithStore=0, storesCalled=0;
  var salesFromMeeting=0;
  var d2mSum=0,d2mN=0, m2sSum=0,m2sN=0;
  rows.forEach(function(r){
    if(r.agent) agentsSet[r.agent]=1;
    if(r.city) citiesKnown++;
    if(r.has_call_attempt) withCall++;
    totalAttempts += r.total_calls||0;
    totalSec += r.total_call_seconds||0;
    if(r.meeting_raised){
      meetingsRaised++;
      if(r.meeting_store) meetingsWithStore++;
      if(r.store_called===true) storesCalled++;
      if(r.sale_status==='Sold') salesFromMeeting++;
      if(r.days_deal_to_meeting!=null){ d2mSum+=r.days_deal_to_meeting; d2mN++; }
      if(r.days_meeting_to_sale!=null){ m2sSum+=r.days_meeting_to_sale; m2sN++; }
    }
  });
  var citiesCovered = new Set(rows.map(function(r){return r.city;}).filter(Boolean)).size;
  return {
    totalDeals:n, totalAgents:Object.keys(agentsSet).length,
    citiesCovered:citiesCovered, cityKnownPct:pct(citiesKnown,n),
    withCall:withCall, withoutCall:n-withCall,
    totalAttempts:totalAttempts, totalSec:totalSec,
    meetingsRaised:meetingsRaised, meetingRaisePct:pct(meetingsRaised,n),
    meetingsWithStore:meetingsWithStore, storesCalled:storesCalled,
    salesFromMeeting:salesFromMeeting, meetingToSalePct:pct(salesFromMeeting,meetingsRaised),
    avgD2M: d2mN? d2mSum/d2mN : null, avgM2S: m2sN? m2sSum/m2sN : null
  };
}

var KPI_DEFS = [
  {key:'totalDeals', lbl:'Total Deals', tip:'Count of Deals with Creat_time in the selected date range and passing all active filters.', fmt:fmtInt},
  {key:'totalAgents', lbl:'Total Agents', tip:'Distinct Deal_Owner values among deals in scope.', fmt:fmtInt},
  {key:'citiesCovered', lbl:'Cities Covered', lbl2:function(k){return fmtPct(k.cityKnownPct,1)+' of deals have a known city';}, tip:'Distinct known Address_City values among deals in scope. Address_City is only ~11.2% populated on Deals overall -- see Data Quality tab.', fmt:fmtInt},
  {key:'withCall', lbl:'Deals with Call Attempt', tip:'Deals with >=1 call in lucira_zoho_Calls joined by What_Id = Deal id.', fmt:fmtInt},
  {key:'withoutCall', lbl:'Deals without Call Attempt', tip:'Deals in scope with zero matching Calls rows (What_Id join).', fmt:fmtInt},
  {key:'totalAttempts', lbl:'Total Call Attempts', tip:'Sum of all call rows joined by What_Id across deals in scope.', fmt:fmtInt},
  {key:'totalSec', lbl:'Total Call Duration', tip:'Sum of Call_Duration_in_seconds across all matched call attempts in scope.', fmt:function(v){ if(v==null)return 'N/A'; var h=Math.floor(v/3600),m=Math.floor((v%3600)/60); return h+'h '+m+'m ('+fmtInt(v)+'s)'; }},
  {key:'meetingsRaised', lbl:'Meetings Raised', tip:'Deals with >=1 linked cdc_meetings row (JSON What_Id.id = Deal id).', fmt:fmtInt},
  {key:'meetingRaisePct', lbl:'Meeting Raise %', tip:'Meetings Raised / Total Deals in scope.', fmt:function(v){return fmtPct(v,1);}},
  {key:'meetingsWithStore', lbl:'Meetings with Store Assigned', tip:'Meeting-raised deals with a resolved Meeting Store (meetings_sheet_sync mobile-match, or cdc_meetings.venue fallback). NOT the Deals.Store_Assigned field -- that column is 0% populated and unused everywhere in this dashboard.', fmt:fmtInt},
  {key:'storesCalled', lbl:'Stores Called', tip:'Meeting-raised deals where meetings_sheet_sync.call_status is populated (Connected or Not Connected) for the mobile-matched row.', fmt:fmtInt},
  {key:'salesFromMeeting', lbl:'Sales from Meeting-raised Deals', tip:'Meeting-raised deals with a mobile-matched sale in marketing_sale dated on/after the meeting date. Mobile-match only -- marketing_sale has no Deal ID column.', fmt:fmtInt},
  {key:'meetingToSalePct', lbl:'Meeting -> Sale %', tip:'Sales from Meeting-raised Deals / Meetings Raised, in scope.', fmt:function(v){return fmtPct(v,1);}},
  {key:'avgD2M', lbl:'Avg Days Deal -> Meeting', tip:'Average of DATE(meeting_raised_date) - DATE(created_date) across meeting-raised deals in scope. Negative diffs are excluded and logged as a data-quality flag, never averaged in.', fmt:function(v){return v==null?'—':v.toFixed(1)+'d';}},
  {key:'avgM2S', lbl:'Avg Days Meeting -> Sale', tip:'Average of DATE(sale_date) - DATE(meeting_raised_date) across meeting-raised deals with a matched sale, in scope.', fmt:function(v){return v==null?'—':v.toFixed(1)+'d';}}
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

/* ================= CHARTS (hand-rolled inline SVG) ================= */
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

/* ================= CHARTS TAB ================= */
var trendBreakdown='none';
function renderCharts(rows){
  // 1. Daily Deals Trend
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

  // 2. City-wise Agent Performance
  var caMap={};
  rows.forEach(function(r){
    var key=r.city_bucket+'|'+r.agent;
    var a=caMap[key]=caMap[key]||{city:r.city_bucket, agent:r.agent, deals:0, meetings:0, sales:0};
    a.deals++; if(r.meeting_raised) a.meetings++; if(r.sale_status==='Sold') a.sales++;
  });
  var caRows=Object.keys(caMap).map(function(k){return caMap[k];});
  caRows.sort(function(a,b){return b.deals-a.deals;});
  var t=document.getElementById('tblCityAgent'); t.innerHTML='<thead><tr><th>City</th><th>Agent</th><th>Deals</th><th>Meetings Raised</th><th>Sales</th><th>Meeting Raise %</th></tr></thead><tbody>'
    +caRows.slice(0,200).map(function(r){return '<tr><td>'+esc(r.city)+'</td><td>'+esc(r.agent)+'</td><td class="num">'+fmtInt(r.deals)+'</td><td class="num">'+fmtInt(r.meetings)+'</td><td class="num">'+fmtInt(r.sales)+'</td><td class="num">'+fmtPct(pct(r.meetings,r.deals),1)+'</td></tr>';}).join('')+'</tbody>';
  var agentTotals={}; rows.forEach(function(r){ agentTotals[r.agent]=(agentTotals[r.agent]||0)+1; });
  var agentBarRows=Object.keys(agentTotals).map(function(a){return {agent:a, deals:agentTotals[a]};}).sort(function(a,b){return b.deals-a.deals;}).slice(0,15);
  svgBar(document.getElementById('chAgentPerf'), agentBarRows, 'agent', 'deals', {fmt:fmtInt, color:'var(--c1,#4f8cff)'});

  // 3. Deal Funnel
  var n=rows.length;
  var callAttempt=rows.filter(function(r){return r.has_call_attempt;}).length;
  var meetingsRaised=rows.filter(function(r){return r.meeting_raised;}).length;
  var storeAssigned=rows.filter(function(r){return r.meeting_store;}).length;
  var storeCalled=rows.filter(function(r){return r.store_called===true;}).length;
  var sales=rows.filter(function(r){return r.sale_status==='Sold';}).length;
  var funnelRows=[
    {stage:'Total Deals', value:n},
    {stage:'Call Attempt', value:callAttempt},
    {stage:'Meetings Raised', value:meetingsRaised},
    {stage:'Store Assigned', value:storeAssigned},
    {stage:'Store Called', value:storeCalled},
    {stage:'Sales', value:sales}
  ];
  svgBar(document.getElementById('chFunnel'), funnelRows, 'stage', 'value', {fmt:fmtInt, color:'var(--c2,#22d3a8)'});
  var ft=document.getElementById('tblFunnel'); ft.innerHTML='<thead><tr><th>Stage</th><th>Count</th><th>% of Total Deals</th></tr></thead><tbody>'
    +funnelRows.map(function(r){return '<tr><td>'+r.stage+'</td><td class="num">'+fmtInt(r.value)+'</td><td class="num">'+fmtPct(pct(r.value,n),1)+'</td></tr>';}).join('')+'</tbody>';

  // 4. Call Attempt Distribution donut
  var noCall=0,one=0,two=0,three=0;
  rows.forEach(function(r){ var tc=r.total_calls||0; if(tc===0) noCall++; else if(tc===1) one++; else if(tc===2) two++; else three++; });
  donut(document.getElementById('chCallDist'), [
    {label:'No Call', value:noCall, color:'#fb7185'},
    {label:'1st Only', value:one, color:'#f4b740'},
    {label:'2 Calls', value:two, color:'#4f8cff'},
    {label:'3+ Calls', value:three, color:'#22d3a8'}
  ]);

  // 5. Meeting -> Sale conversion by city
  var byCity={};
  rows.filter(function(r){return r.meeting_raised;}).forEach(function(r){
    var a=byCity[r.city_bucket]=byCity[r.city_bucket]||{meetings:0,sales:0};
    a.meetings++; if(r.sale_status==='Sold') a.sales++;
  });
  var cityConvRows=Object.keys(byCity).map(function(c){return {city:c, pct: pct(byCity[c].sales, byCity[c].meetings)||0, meetings:byCity[c].meetings, sales:byCity[c].sales};});
  cityConvRows.sort(function(a,b){return b.meetings-a.meetings;});
  svgBar(document.getElementById('chCityConv'), cityConvRows.slice(0,20), 'city', 'pct', {fmt:function(v){return v.toFixed(0)+'%';}, color:'var(--c4,#c084fc)'});

  // 6. Average conversion days bar
  var d2m=[], m2sc=[], m2s=[];
  rows.forEach(function(r){
    if(r.days_deal_to_meeting!=null) d2m.push(r.days_deal_to_meeting);
    if(r.days_meeting_to_storecall!=null) m2sc.push(r.days_meeting_to_storecall);
    if(r.days_meeting_to_sale!=null) m2s.push(r.days_meeting_to_sale);
  });
  function avg(a){ return a.length? a.reduce(function(x,y){return x+y;},0)/a.length : 0; }
  var avgDaysRows=[
    {label:'Deal → Meeting', value:avg(d2m)},
    {label:'Meeting → Store Call', value:avg(m2sc)},
    {label:'Meeting → Sale', value:avg(m2s)}
  ];
  svgBar(document.getElementById('chAvgDays'), avgDaysRows, 'label', 'value', {fmt:function(v){return v.toFixed(1)+'d';}, color:'var(--c6,#38bdf8)'});

  // 7. Store Follow-up Performance table
  var byStore={};
  rows.filter(function(r){return r.meeting_raised;}).forEach(function(r){
    var key=r.meeting_store || '(no store resolved)';
    var a=byStore[key]=byStore[key]||{store:key, assigned:0, called:0, sales:0};
    a.assigned++; if(r.store_called===true) a.called++; if(r.sale_status==='Sold') a.sales++;
  });
  var storeRows=Object.keys(byStore).map(function(k){return byStore[k];});
  storeRows.sort(function(a,b){return b.assigned-a.assigned;});
  var st=document.getElementById('tblStoreFollowup'); st.innerHTML='<thead><tr><th>Meeting Store</th><th>Meetings Assigned</th><th>Stores Called</th><th>Store Call %</th><th>Sales</th><th>Meeting → Sale %</th></tr></thead><tbody>'
    +storeRows.map(function(r){return '<tr><td>'+esc(r.store)+'</td><td class="num">'+fmtInt(r.assigned)+'</td><td class="num">'+fmtInt(r.called)+'</td><td class="num">'+fmtPct(pct(r.called,r.assigned),1)+'</td><td class="num">'+fmtInt(r.sales)+'</td><td class="num">'+fmtPct(pct(r.sales,r.assigned),1)+'</td></tr>';}).join('')+'</tbody>';
}

/* ================= MAIN SUMMARY TABLE ================= */
var summarySortKey='deals', summarySortDir=-1, summarySearch='';
function computeSummaryRows(rows){
  var map={};
  rows.forEach(function(r){
    var key=r.created_date+'|'+r.city_bucket+'|'+r.agent;
    var a=map[key]=map[key]||{date:r.created_date, city:r.city_bucket, agent:r.agent,
      deals:0, c1n:0,c1s:0, c2n:0,c2s:0, c3n:0,c3s:0, totCalls:0, totSec:0,
      meetings:0, storeAssigned:0, storeCalled:0, sales:0, salesFromMeeting:0};
    a.deals++;
    if(r.call1_sec!=null){ a.c1n++; a.c1s+=r.call1_sec; }
    if(r.call2_sec!=null){ a.c2n++; a.c2s+=r.call2_sec; }
    if(r.call3_sec!=null){ a.c3n++; a.c3s+=r.call3_sec; }
    a.totCalls += r.total_calls||0; a.totSec += r.total_call_seconds||0;
    if(r.meeting_raised) a.meetings++;
    if(r.meeting_store) a.storeAssigned++;
    if(r.store_called===true) a.storeCalled++;
    if(r.sale_status==='Sold') a.sales++;
    if(r.meeting_raised && r.sale_status==='Sold') a.salesFromMeeting++;
  });
  // Meeting->Sale% is sales AMONG meeting-raised deals / meetings raised (bounded 0-100%) --
  // NOT total Sales / meetings, since most sales come from deals with no meeting at all
  // (only 639 of 22,819 deals have a mobile-matched sale, vs 307 meetings raised) and mixing
  // the two would routinely read over 100%.
  var arr=Object.keys(map).map(function(k){ var a=map[k]; a.meetingPct=pct(a.meetings,a.deals); a.salePct=pct(a.salesFromMeeting,a.meetings); return a; });
  if(summarySearch){
    var s=summarySearch.toLowerCase();
    arr=arr.filter(function(a){ return (a.city+' '+a.agent+' '+a.date).toLowerCase().indexOf(s)>=0; });
  }
  arr.sort(function(a,b){ var x=a[summarySortKey], y=b[summarySortKey]; if(x<y) return -1*summarySortDir; if(x>y) return 1*summarySortDir; return 0; });
  return arr;
}
function renderSummaryTable(rows){
  var arr=computeSummaryRows(rows);
  var t=document.getElementById('tblSummary');
  var head=[['date','Date'],['city','City'],['agent','Agent'],['deals','Total Deals'],['c1','1st Call'],['c2','2nd Call'],['c3','3rd Call'],['tot','Total Call'],['meetings','Meetings Raised'],['meetingPct','Meeting Raise %'],['storeAssigned','Store Assigned'],['storeCalled','Store Called'],['sales','Sales'],['salePct','Meeting→Sale%']];
  var thead='<thead><tr>'+head.map(function(h){return '<th data-sort="'+h[0]+'" style="cursor:pointer">'+h[1]+(summarySortKey===h[0]?(summarySortDir>0?' ▲':' ▼'):'')+'</th>';}).join('')+'</tr></thead>';
  var tbody='<tbody>'+arr.slice(0,500).map(function(a){
    return '<tr>'+
      '<td>'+a.date+'</td><td>'+esc(a.city)+'</td><td>'+esc(a.agent)+'</td>'+
      '<td class="num">'+fmtInt(a.deals)+'</td>'+
      '<td class="num">'+callAggCell(a.c1n,a.c1s)+'</td>'+
      '<td class="num">'+callAggCell(a.c2n,a.c2s)+'</td>'+
      '<td class="num">'+callAggCell(a.c3n,a.c3s)+'</td>'+
      '<td class="num">'+callAggCell(a.totCalls,a.totSec)+'</td>'+
      '<td class="num">'+fmtInt(a.meetings)+'</td>'+
      '<td class="num">'+fmtPct(a.meetingPct,1)+'</td>'+
      '<td class="num">'+fmtInt(a.storeAssigned)+'</td>'+
      '<td class="num">'+fmtInt(a.storeCalled)+'</td>'+
      '<td class="num">'+fmtInt(a.sales)+'</td>'+
      '<td class="num">'+fmtPct(a.salePct,1)+'</td>'+
    '</tr>';
  }).join('')+'</tbody>';
  t.innerHTML=thead+tbody;
  t.querySelectorAll('th[data-sort]').forEach(function(th){
    th.addEventListener('click', function(){
      var k=th.dataset.sort;
      if(summarySortKey===k) summarySortDir*=-1; else { summarySortKey=k; summarySortDir=-1; }
      renderSummaryTable(computeFiltered());
    });
  });
  document.getElementById('summaryCount').textContent = arr.length+' rows (showing up to 500)';
}

/* ================= DRILL-DOWN: DEAL-LEVEL TABLE ================= */
var drillPage=1, drillPageSize=50;
function renderDrillTable(rows){
  var start=(drillPage-1)*drillPageSize;
  var pageRows=rows.slice(start, start+drillPageSize);
  var t=document.getElementById('tblDrill');
  var head=['Deal ID','Deal Name','Created','City','Agent','Customer','Mobile','1st Call','2nd Call','3rd Call','Total Call','Meeting Raised','Meeting Date','Meeting Owner','Meeting Venue','Meeting Store','Store Called','Store Call Date','Days Deal→Meeting','Sale Status','Sale Date','Days Meeting→Sale','Sale Amount','Invoice'];
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
      '<td>'+(r.store_called===true?'Yes':r.store_called===false?'No':'Not Available')+'</td><td>'+dash(r.store_call_date)+'</td>'+
      '<td>'+(r.days_deal_to_meeting!=null?r.days_deal_to_meeting+'d':'—')+'</td>'+
      '<td>'+esc(r.sale_status)+'</td><td>'+dash(r.sale_date)+'</td>'+
      '<td>'+(r.days_meeting_to_sale!=null?r.days_meeting_to_sale+'d':'—')+'</td>'+
      '<td class="num">'+(r.sale_amount!=null?fmtMoney(r.sale_amount):'—')+'</td><td>'+dash(r.sale_invoice)+'</td>'+
    '</tr>';
  }).join('')+'</tbody>';
  t.innerHTML=thead+tbody;
  t.querySelectorAll('.drillRow').forEach(function(tr){
    tr.addEventListener('click', function(){ openDrawer(rows[+tr.dataset.idx]); });
  });
  document.getElementById('drillPageInfo').textContent = 'Page '+drillPage+' of '+Math.max(1,Math.ceil(rows.length/drillPageSize))+' ('+fmtInt(rows.length)+' deals)';
  window.__drillRowsCache = rows;
}
function renderDrillTab(rows){
  drillPage=1;
  renderDrillTable(rows);
}

/* ================= DRILL-DOWN DRAWER: TIMELINE ================= */
function openDrawer(r){
  if(!r) return;
  var nodes=[
    {label:'Deal Created', date:r.created_date},
    {label:'1st Call', date: r.call1_time ? (r.call1_time.slice? r.call1_time.slice(0,10):r.call1_time) : null, extra: r.call1_sec!=null? callCell(r.call1_sec):null},
    {label:'2nd Call', date: r.call2_time ? (r.call2_time.slice? r.call2_time.slice(0,10):r.call2_time) : null, extra: r.call2_sec!=null? callCell(r.call2_sec):null},
    {label:'3rd Call', date: r.call3_time ? (r.call3_time.slice? r.call3_time.slice(0,10):r.call3_time) : null, extra: r.call3_sec!=null? callCell(r.call3_sec):null},
    {label:'Meeting Raised', date: r.meeting_raised_date, extra: r.meeting_raised? (esc(r.meeting_owner||'')+(r.meeting_venue?(' @ '+esc(r.meeting_venue)):'')) : null},
    {label:'Store Assigned', date: r.meeting_store? r.meeting_raised_date : null, extra: r.meeting_store? esc(r.meeting_store) : null},
    {label:'Store Call', date: r.store_call_date, extra: r.store_call_status? esc(r.store_call_status): (r.store_called===false?'Not Connected':(r.store_called===null?'Not Available':null))},
    {label:'Sale', date: r.sale_date, extra: r.sale_status==='Sold'? (fmtMoney(r.sale_amount)+' · '+esc(r.sale_invoice||'')) : 'Not Available'}
  ];
  var html='<div class="drawHead"><div><b>'+esc(r.deal_name||r.deal_id)+'</b><div class="sub">Deal ID '+esc(r.deal_id)+' · '+esc(r.city_bucket)+' · '+esc(r.agent)+'</div></div><span id="drawClose" class="btn">✕</span></div>';
  html+='<div class="timeline">';
  nodes.forEach(function(n){
    var has = !!n.date;
    html+='<div class="tnode '+(has?'has':'gap2')+'"><div class="tdot"></div><div class="tbody"><div class="tlbl">'+n.label+'</div><div class="tdate">'+(has?n.date:'—')+'</div>'+(n.extra?'<div class="textra">'+n.extra+'</div>':'')+'</div></div>';
  });
  html+='</div>';
  html+='<div class="note" style="margin-top:10px">Meeting Store / Store Called sourced from <code>meetings_sheet_sync</code> (mobile-matched) with <code>cdc_meetings.venue</code> as a fallback for Meeting Store only. Sale matched by mobile to <code>marketing_sale</code> -- not a Deal ID join. See Data Quality tab.</div>';
  var drawer=document.getElementById('drawer');
  drawer.innerHTML=html;
  drawer.classList.add('open');
  document.getElementById('drawClose').addEventListener('click', function(){ drawer.classList.remove('open'); });
}

/* ================= DATA QUALITY TAB ================= */
function renderDataQuality(){
  var dq=D.data_quality||{};
  var rows=[
    ['Deal ID uniqueness', fmtPct(dq.deal_id_uniqueness_pct,2)+' ('+fmtInt(dq.duplicate_deal_id_rows)+' duplicate rows)'],
    ['Total deals', fmtInt(dq.total_deals)],
    ['Address_City coverage', fmtInt(dq.city_known_count)+' of '+fmtInt(dq.total_deals)+' ('+fmtPct(dq.city_known_pct,2)+') -- the remaining deals are shown as "City Not Captured" everywhere, never dropped'],
    ['Calls table: rows with a What_Id', fmtInt(dq.calls_with_what_id)+' of '+fmtInt(dq.calls_total_rows)+' ('+fmtPct(dq.calls_to_deal_match_pct,2)+')'],
    ['Deals matched to >=1 call (What_Id join)', fmtInt(dq.call_to_deal_matched_deals)+' of '+fmtInt(dq.total_deals)+' ('+fmtPct(dq.call_to_deal_matched_pct,2)+')'],
    ['cdc_meetings: rows resolving a real Deal id', fmtInt(dq.cdc_meetings_with_what_id)+' of '+fmtInt(dq.cdc_meetings_total_rows)+' ('+fmtPct(dq.cdc_meetings_to_deal_match_pct,2)+')'],
    ['Deals with Meeting Raised', fmtInt(dq.meeting_raised_count)+' of '+fmtInt(dq.total_deals)+' ('+fmtPct(dq.meeting_raised_pct,2)+')'],
    ['Meeting Store resolved from meetings_sheet_sync', fmtInt(dq.meeting_store_from_sheet)],
    ['Meeting Store resolved from cdc_meetings.venue (fallback)', fmtInt(dq.meeting_store_from_venue_fallback)],
    ['Meeting Store Not Available (no match either source)', fmtInt(dq.meeting_store_not_available)],
    ['Store Called: Yes / No / Not Available', fmtInt(dq.store_called_yes)+' / '+fmtInt(dq.store_called_no)+' / '+fmtInt(dq.store_called_not_available)],
    ['meetings_sheet_sync rows / distinct mobiles', fmtInt(dq.sheet_rows_total)+' / '+fmtInt(dq.sheet_distinct_mobiles)],
    ['marketing_sale rows / distinct mobiles', fmtInt(dq.sale_rows_total)+' / '+fmtInt(dq.sale_distinct_mobiles)],
    ['Deals matched to a sale (mobile-match, not Deal ID)', fmtInt(dq.sales_matched_to_deal)+' of '+fmtInt(dq.total_deals)+' ('+fmtPct(dq.sales_matched_pct_of_deals,2)+')'],
    ['Negative date-diff rows excluded (data-quality flags)', JSON.stringify(dq.negative_date_diff_flags||{})]
  ];
  var t=document.getElementById('tblDataQuality'); t.innerHTML='<thead><tr><th>Check</th><th>Result</th></tr></thead><tbody>'
    +rows.map(function(r){return '<tr><td>'+r[0]+'</td><td>'+r[1]+'</td></tr>';}).join('')+'</tbody>';
  document.getElementById('dqNote').innerHTML='Snapshot generated: <b>'+esc(D.meta.generated_at_ist||'N/A')+'</b>. '+esc(D.meta.note||'')+' <b>This tab always reports on the full dataset regardless of the filter bar above.</b> Every other tab respects the active filter. <b>Deals.Store_Assigned is never used anywhere in this dashboard (verified 0% populated).</b>';
}

/* ================= MAIN RENDER + WIRING ================= */
function renderAll(){
  var rows=renderKpis();
  renderCharts(rows);
  renderSummaryTable(rows);
  renderDrillTab(rows);
  renderDataQuality();
  var srcLabel = D.meta.source==='live_zoho_crm+bigquery' ? 'LIVE Zoho CRM + BigQuery' : (D.meta.source==='bigquery' ? 'BigQuery snapshot' : 'BigQuery snapshot');
  document.getElementById('freshPill').innerHTML='<span class="dot"></span> Data as of '+esc(D.meta.generated_at_ist||'N/A')+' ('+esc(srcLabel)+') — refresh by rerunning build_dcm_data.py [--source live]';
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
    F.meetingRaised='any'; F.storeCalled='any'; F.saleStatus='any';
    document.querySelectorAll('.msbox input').forEach(function(i){i.checked=false;});
    document.getElementById('fMeetingRaised').value='any';
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
    renderCharts(computeFiltered());
  }); });
  document.getElementById('drillSearch').addEventListener('input', function(e){
    var v=e.target.value.trim().toLowerCase();
    var rows=computeFiltered().filter(function(r){
      return !v || (''+r.deal_id).toLowerCase().indexOf(v)>=0 || (r.deal_name||'').toLowerCase().indexOf(v)>=0 || (r.contact_name||'').toLowerCase().indexOf(v)>=0;
    });
    drillPage=1; renderDrillTable(rows);
  });
  document.getElementById('drillPrev').addEventListener('click', function(){ if(drillPage>1){ drillPage--; renderDrillTable(window.__drillRowsCache); } });
  document.getElementById('drillNext').addEventListener('click', function(){ var rows=window.__drillRowsCache||[]; if(drillPage*drillPageSize<rows.length){ drillPage++; renderDrillTable(rows); } });
  document.getElementById('summarySearchInp').addEventListener('input', function(e){ summarySearch=e.target.value.trim(); renderSummaryTable(computeFiltered()); });
}

document.addEventListener('DOMContentLoaded', function(){
  fillFilterUI();
  wireTabs(); wireFilters();
  renderAll();
  var boot=document.getElementById('boot'); if(boot){ boot.classList.add('hide'); setTimeout(function(){boot.remove();},500); }
});

})();
