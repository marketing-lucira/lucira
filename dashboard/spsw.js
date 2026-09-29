/* Store x Product Scan/Sale/Walk-in Intelligence — engine
   Data: window.SPSW_DATA (dashboard/spsw_data.js, locally-embedded BigQuery snapshot,
   built by build_spsw_data.py). No live fetch — this is a static, honestly-labeled snapshot.
   See spsw_data.js header + Data Quality tab for the exact honesty gates this file respects. */
(function(){
'use strict';

var D = window.SPSW_DATA || {kpi:{},top_products_sold:[],
  data_quality:{},store_master:[],party_linked_scan_sale:[],meta:{},
  sale_rows_raw_sample:[],scan_rows_raw_sample:[],walkin_rows_raw_sample:[],walkin_sale_conversion_rows:[]};

/* ---------- generic utils ---------- */
function el(tag,cls,html){ var e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; }
function esc(s){ return (s==null?'':''+s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function fmtInt(n){ return (n==null||isNaN(n))?'N/A':Math.round(n).toLocaleString('en-IN'); }
function fmtMoney(n){ if(n==null||isNaN(n))return 'N/A'; var a=Math.abs(n),s=n<0?'-':''; if(a>=1e7) return s+'₹'+(a/1e7).toFixed(2)+'Cr'; if(a>=1e5) return s+'₹'+(a/1e5).toFixed(2)+'L'; return s+'₹'+Math.round(a).toLocaleString('en-IN'); }
function fmtPct(n,d){ if(n==null||isNaN(n))return 'N/A'; return n.toFixed(d==null?1:d)+'%'; }
function pct(a,b){ return b?(100*a/b):null; }
function downloadBlob(content,filename,mime){ if(mime==='text/csv' && typeof content==='string' && content.charCodeAt(0)!==0xFEFF) content='﻿'+content; var blob=new Blob([content],{type:mime+';charset=utf-8'}); var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},800); }
function csvOf(rows){ return rows.map(function(r){return r.map(function(v){ v=(v==null?'':''+v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }).join(',');}).join('\n'); }
function tableToCsv(id){ var t=document.getElementById(id); if(!t)return ''; var rows=[]; t.querySelectorAll('tr').forEach(function(tr){ var r=[]; tr.querySelectorAll('th,td').forEach(function(td){ r.push(td.textContent.trim()); }); rows.push(r); }); return csvOf(rows); }
function addDays(dstr,n){
  // UTC-safe: a local-time Date + toISOString() silently shifts the date on any non-UTC
  // timezone (e.g. IST) because toISOString() converts back to UTC. Stay in UTC throughout.
  var p=dstr.split('-').map(Number);
  var d=new Date(Date.UTC(p[0],p[1]-1,p[2]));
  d.setUTCDate(d.getUTCDate()+n);
  return d.toISOString().slice(0,10);
}
function clampDate(d,lo,hi){ if(d<lo)return lo; if(d>hi)return hi; return d; }

/* ---------- overall data extents (used for date presets, since this is a fixed snapshot) ---------- */
var ALL_DATES = []
  .concat((D.sales_daily||[]).map(function(r){return r.date;}))
  .concat((D.scan_daily||[]).map(function(r){return r.date;}))
  .concat((D.walkin_daily||[]).map(function(r){return r.date;}))
  .filter(Boolean).sort();
var DATA_MIN = ALL_DATES[0] || '2025-01-01';
var DATA_MAX = ALL_DATES[ALL_DATES.length-1] || '2026-01-01';

var STORE_CODES = (D.store_master||[]).map(function(s){return s.company_code;});
var CODE_TO_STORE = {}; (D.store_master||[]).forEach(function(s){ CODE_TO_STORE[s.company_code]=s; });
var CITIES = Array.from(new Set((D.store_master||[]).map(function(s){return s.city;}))).sort();
var STATES = Array.from(new Set((D.store_master||[]).map(function(s){return s.state;}))).sort();
var CATEGORIES = Array.from(new Set((D.top_products_sold||[]).map(function(r){return r.item_group_name;}).filter(Boolean))).sort();

/* ---------- global filter state ---------- */
var F = { from: DATA_MIN, to: DATA_MAX, stores: new Set(), cities: new Set(), states: new Set(), categories: new Set(), skus: new Set() };
var LAST_SUBJECT = null; // for assistant pronoun follow-ups: {type:'store', code:'PN1'} etc.

function storesInScope(){
  var codes = STORE_CODES.slice();
  if(F.cities.size) codes = codes.filter(function(c){ return F.cities.has(CODE_TO_STORE[c].city); });
  if(F.states.size) codes = codes.filter(function(c){ return F.states.has(CODE_TO_STORE[c].state); });
  if(F.stores.size) codes = codes.filter(function(c){ return F.stores.has(c); });
  return codes;
}
function inDateRange(d){ return d && d>=F.from && d<=F.to; }
function noStoreScopeFilter(){ return !F.stores.size && !F.cities.size && !F.states.size; }

/* ================= FILTERED AGGREGATES (recomputed on every filter change) =================
   Everything below reads the FULL row-level snapshots (sale_rows_raw_sample / scan_rows_raw_sample /
   walkin_rows_raw_sample / party_linked_scan_sale / walkin_sale_conversion_rows — every one of these
   is a complete row-level export, not a sample, despite some legacy "_sample" names in spsw_data.js;
   the source tables are tiny (1.9k-2.9k rows) so filtering row-level in JS on every change is cheap.
   This is the single source of truth for date+store+city+state+category+item-code filtering across
   ALL tabs — no tab should read a pre-aggregated "whole snapshot" total for a metric a user can filter. */

function aggStore(salesRows, scanRows, walkinRows, code){
  var sRows=salesRows.filter(function(r){return r.company_code===code;});
  var scRows=scanRows.filter(function(r){return r.store_code===code;});
  var wRows=walkinRows.filter(function(r){return (r.store_code||'UNMAPPED')===code;});
  var orders={}; sRows.forEach(function(r){orders[r.document_no]=1;});
  var items={}; scRows.forEach(function(r){ if(r.item_id!=null) items[r.item_id]=1; });
  var parties={}; scRows.forEach(function(r){ if(r.party_id!=null) parties[r.party_id]=1; });
  var wcust={}; wRows.forEach(function(r){ if(r.phone) wcust[r.phone]=1; });
  var net=0,pieces=0; sRows.forEach(function(r){ net+=r.net_sale; pieces+=r.pieces; });
  var ordersN=Object.keys(orders).length;
  var meta=CODE_TO_STORE[code]||{};
  return {
    code:code, name:meta.company_name||code, city:meta.city||'N/A',
    walkin_walkins: wRows.length, walkin_unique_customers: Object.keys(wcust).length,
    scan_total_scan_events: scRows.length, scan_unique_scanned_item_ids: Object.keys(items).length,
    scan_unique_parties_scanning: Object.keys(parties).length,
    sale_total_sales_value: net, sale_units_sold: pieces, sale_orders: ordersN,
    sale_aov: ordersN ? net/ordersN : null,
    sales_per_walkin: wRows.length ? net/wRows.length : null
  };
}

function computeFiltered(){
  var scope = storesInScope();
  var scopeSet = new Set(scope);
  var noFilter = noStoreScopeFilter();

  var salesRows = (D.sale_rows_raw_sample||[]).filter(function(r){
    if(!inDateRange(r.date)) return false;
    if(!scopeSet.has(r.company_code)) return false;
    if(F.categories.size && !F.categories.has(r.item_group_name)) return false;
    if(F.skus.size && !F.skus.has(r.item_code)) return false;
    return true;
  });
  var scanRows = (D.scan_rows_raw_sample||[]).filter(function(r){
    return inDateRange(r.date) && scopeSet.has(r.store_code);
  });
  var walkinRows = (D.walkin_rows_raw_sample||[]).filter(function(r){
    if(!inDateRange(r.date)) return false;
    var code = r.store_code || 'UNMAPPED';
    if(code==='UNMAPPED') return noFilter;
    return scopeSet.has(code);
  });

  var totalSales=0, totalUnits=0, ordersSet={};
  salesRows.forEach(function(r){ totalSales+=r.net_sale; totalUnits+=r.pieces; ordersSet[r.document_no]=1; });
  var totalOrders=Object.keys(ordersSet).length;
  var totalScans=scanRows.length;
  var walkinCustSet={}; walkinRows.forEach(function(r){ if(r.phone) walkinCustSet[r.phone]=1; });
  var totalWalkins=walkinRows.length, totalWalkinCust=Object.keys(walkinCustSet).length;

  var storePerf = scope.map(function(code){ return aggStore(salesRows, scanRows, walkinRows, code); });

  return {
    scope: scope,
    salesRows: salesRows, scanRows: scanRows, walkinRows: walkinRows,
    totalSales: totalSales, totalOrders: totalOrders, totalUnits: totalUnits,
    totalScans: totalScans, totalWalkins: totalWalkins, totalWalkinCust: totalWalkinCust,
    storePerf: storePerf,
    salesPerWalkin: totalWalkins ? totalSales/totalWalkins : null
  };
}

/* Top product (by item_code) within a filtered set of sale rows — used by Executive + assistant */
function computeTopProduct(salesRows){
  var byItem={};
  salesRows.forEach(function(r){
    if(!r.item_code) return;
    var a=byItem[r.item_code]=byItem[r.item_code]||{net:0,pieces:0,orders:{},item_group_name:null};
    a.net+=r.net_sale; a.pieces+=r.pieces; a.orders[r.document_no]=1;
    if(!a.item_group_name && r.item_group_name) a.item_group_name=r.item_group_name;
  });
  var best=null;
  Object.keys(byItem).forEach(function(k){ var a=byItem[k]; if(!best||a.net>best.net) best={item_code:k, net:a.net, pieces:a.pieces, orders:Object.keys(a.orders).length, item_group_name:a.item_group_name}; });
  return best;
}

/* Walk-in -> Sale phone-matched conversion within the current filter scope (date + store/city/state) */
function computeWalkinConversion(scope){
  var scopeSet=new Set(scope);
  var noFilter=noStoreScopeFilter();
  var rows=(D.walkin_sale_conversion_rows||[]).filter(function(r){
    if(!inDateRange(r.date)) return false;
    if(r.store_code==='UNMAPPED') return noFilter;
    return scopeSet.has(r.store_code);
  });
  var matched=rows.filter(function(r){ return r.matched; }).length;
  return {rows:rows, matched:matched, total:rows.length, pct: rows.length ? 100*matched/rows.length : null};
}

/* ================= CHARTS (hand-rolled inline SVG, no libs) ================= */
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
    if(rows.length<=18) svg+='<text x="'+(x+bwv/2)+'" y="'+(h-pad.b+14)+'" font-size="9.5" text-anchor="middle" fill="var(--tx2,#98a3b8)" transform="rotate(0)">'+esc((''+r[labelKey]).slice(0,10))+'</text>';
  });
  svg+='</svg>';
  container.innerHTML=svg;
}
function svgLine(container, rows, xKey, series, opts){
  opts=opts||{}; container.innerHTML='';
  if(!rows.length){ container.innerHTML='<div class="gap">No data in current filter.</div>'; return; }
  var w=opts.width||Math.max(360, container.clientWidth||600), h=opts.height||220;
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

/* ================= RENDER: HEADER / FILTERS ================= */
function fillFilterUI(){
  var storeBox=document.getElementById('msStore'); storeBox.innerHTML='';
  STORE_CODES.forEach(function(c){ var l=el('label'); l.innerHTML='<input type="checkbox" value="'+c+'"> '+c+' — '+esc(CODE_TO_STORE[c].name); storeBox.appendChild(l); });
  var cityBox=document.getElementById('msCity'); cityBox.innerHTML='';
  CITIES.forEach(function(c){ var l=el('label'); l.innerHTML='<input type="checkbox" value="'+esc(c)+'"> '+esc(c); cityBox.appendChild(l); });
  var stateBox=document.getElementById('msState'); stateBox.innerHTML='';
  STATES.forEach(function(c){ var l=el('label'); l.innerHTML='<input type="checkbox" value="'+esc(c)+'"> '+esc(c); stateBox.appendChild(l); });
  var catBox=document.getElementById('msCategory'); catBox.innerHTML='';
  CATEGORIES.forEach(function(c){ var l=el('label'); l.innerHTML='<input type="checkbox" value="'+esc(c)+'"> '+esc(c); catBox.appendChild(l); });

  document.getElementById('fFrom').value=F.from;
  document.getElementById('fTo').value=F.to;
  document.getElementById('fFrom').min=DATA_MIN; document.getElementById('fFrom').max=DATA_MAX;
  document.getElementById('fTo').min=DATA_MIN; document.getElementById('fTo').max=DATA_MAX;

  [storeBox,cityBox,stateBox,catBox].forEach(function(box){
    box.addEventListener('change', function(){ readMultiFilters(); renderAll(); });
  });
  document.getElementById('skuSearch').addEventListener('input', function(e){
    var v=e.target.value.trim().toUpperCase();
    F.skus = new Set(); if(v){ (D.top_products_sold||[]).forEach(function(p){ if(p.item_code && p.item_code.toUpperCase().indexOf(v)>=0) F.skus.add(p.item_code); }); }
    renderAll();
  });
}
function readMultiFilters(){
  function readBox(id,setter){ var s=new Set(); document.querySelectorAll('#'+id+' input:checked').forEach(function(i){ s.add(i.value); }); setter(s); }
  readBox('msStore', function(s){ F.stores=s; });
  readBox('msCity', function(s){ F.cities=s; });
  readBox('msState', function(s){ F.states=s; });
  readBox('msCategory', function(s){ F.categories=s; });
}
function applyDatePreset(preset){
  var max=DATA_MAX;
  if(preset==='today'){ F.from=max; F.to=max; }
  else if(preset==='yesterday'){ F.from=addDays(max,-1); F.to=addDays(max,-1); }
  else if(preset==='7'){ F.from=clampDate(addDays(max,-6),DATA_MIN,DATA_MAX); F.to=max; }
  else if(preset==='30'){ F.from=clampDate(addDays(max,-29),DATA_MIN,DATA_MAX); F.to=max; }
  else if(preset==='90'){ F.from=clampDate(addDays(max,-89),DATA_MIN,DATA_MAX); F.to=max; }
  else if(preset==='mtd'){ F.from=max.slice(0,8)+'01'; F.to=max; }
  else if(preset==='prevmonth'){
    var y=+max.slice(0,4), m=+max.slice(5,7);
    var pm=m-1, py=y; if(pm===0){pm=12;py=y-1;}
    var pmStr=(''+pm).padStart(2,'0');
    var firstNext = pm===12 ? (py+1)+'-01-01' : py+'-'+(''+(pm+1)).padStart(2,'0')+'-01';
    F.from=py+'-'+pmStr+'-01'; F.to=addDays(firstNext,-1);
  }
  else if(preset==='all'){ F.from=DATA_MIN; F.to=DATA_MAX; }
  document.getElementById('fFrom').value=F.from; document.getElementById('fTo').value=F.to;
  renderAll();
}

/* ================= TAB 1: EXECUTIVE ================= */
function renderExec(){
  var A=computeFiltered();
  var uniqueScanned={}; A.scanRows.forEach(function(r){ if(r.item_id!=null) uniqueScanned[r.item_id]=1; });
  var uniqueSold={}; A.salesRows.forEach(function(r){ if(r.item_code) uniqueSold[r.item_code]=1; });
  var topStoreRow = A.storePerf.slice().sort(function(a,b){return b.sale_total_sales_value-a.sale_total_sales_value;})[0];
  var topProd = computeTopProduct(A.salesRows);
  var conv = computeWalkinConversion(A.scope);

  var kpis=[
    {lbl:'Total Sales Value', val:fmtMoney(A.totalSales), sub:A.totalOrders+' orders'},
    {lbl:'Total Walk-ins', val:fmtInt(A.totalWalkins), sub:fmtInt(A.totalWalkinCust)+' unique customers (by phone)'},
    {lbl:'Total Scan Events', val:fmtInt(A.totalScans), sub:'internal POS item_id grain'},
    {lbl:'Unique Products Scanned', val:fmtInt(Object.keys(uniqueScanned).length), sub:'by opaque item_id — not an Item Code'},
    {lbl:'Unique Products Sold', val:fmtInt(Object.keys(uniqueSold).length), sub:'by Item Code (base style)'},
    {lbl:'Orders', val:fmtInt(A.totalOrders), sub:fmtInt(A.totalUnits)+' units'},
    {lbl:'Sales / Walk-in', val:A.salesPerWalkin!=null?fmtMoney(A.salesPerWalkin):'N/A', sub:'total sales ÷ total walk-ins in scope'},
    {lbl:'Top Store (Sales)', val: topStoreRow ? topStoreRow.code : 'N/A', sub:'by total sales value, in current filter'},
  ];
  var grid=document.getElementById('execKpis'); grid.innerHTML='';
  kpis.forEach(function(k){ var c=el('div','kpi'); c.innerHTML='<div class="lbl">'+k.lbl+'</div><div class="val">'+k.val+'</div><div class="sub">'+esc(k.sub)+'</div>'; grid.appendChild(c); });

  var summary = 'In the selected range ('+F.from+' to '+F.to+', scope: '+(A.scope.length===STORE_CODES.length?'all '+STORE_CODES.length+' stores':A.scope.join(', ')||'none')+'), Lucira recorded <b>'+fmtMoney(A.totalSales)+'</b> in sales across <b>'+fmtInt(A.totalOrders)+'</b> orders and <b>'+fmtInt(A.totalUnits)+'</b> units. Store footfall totalled <b>'+fmtInt(A.totalWalkins)+'</b> walk-ins ('+fmtInt(A.totalWalkinCust)+' unique customers by phone), and the in-store POS scanning process logged <b>'+fmtInt(A.totalScans)+'</b> scan events across <b>'+fmtInt(Object.keys(uniqueScanned).length)+'</b> distinct internal item ids — all within the currently selected date range and store scope. '
    +(topStoreRow? ('<b>'+topStoreRow.code+'</b> ('+esc(topStoreRow.name)+') led on sales with '+fmtMoney(topStoreRow.sale_total_sales_value)+' in this range. ') : '')
    +(topProd? ('The best-selling product by value in this range was <b>'+esc(topProd.item_code)+'</b> ('+esc(topProd.item_group_name||'')+') at '+fmtMoney(topProd.net)+'. ') : (A.totalOrders? '' : 'No sales recorded in this range. '))
    +'Walk-in-to-sale conversion, measured strictly by matching a walk-in’s phone number to a same-record sale, stands at <b>'+(conv.pct!=null?fmtPct(conv.pct,1):'N/A')+'</b> ('+fmtInt(conv.matched)+' of '+fmtInt(conv.total)+' walk-ins) within this same range/scope. '
    +'<i>Note: scan activity cannot be joined to sales at the product level in this data (0% key overlap between scan item_id/sku and any sales Item Code field, verified) — see the Scan vs Sale and Data Quality tabs for the honest breakdown.</i>';
  document.getElementById('execSummary').innerHTML=summary;
}

/* ================= TAB 2: STORE PERFORMANCE ================= */
function renderStorePerf(){
  var A=computeFiltered();
  var rows=A.storePerf.slice();
  rows.sort(function(a,b){return b.sale_total_sales_value-a.sale_total_sales_value;});
  var head=['Store Code','Store Name','City','Walk-ins','Unique Cust. (Walk-in)','Total Scan Events','Unique Scanned Item IDs','Total Sales','Units Sold','Orders','AOV','Sales / Walk-in'];
  var t=document.getElementById('tblStorePerf'); t.innerHTML='';
  var thead='<thead><tr>'+head.map(function(h){return '<th>'+h+'</th>';}).join('')+'</tr></thead>';
  var tbody='<tbody>'+rows.map(function(r){
    return '<tr><td>'+r.code+'</td><td>'+esc(r.name)+'</td><td>'+esc(r.city)+'</td>'
      +'<td class="num">'+fmtInt(r.walkin_walkins)+'</td><td class="num">'+fmtInt(r.walkin_unique_customers)+'</td>'
      +'<td class="num">'+fmtInt(r.scan_total_scan_events)+'</td><td class="num">'+fmtInt(r.scan_unique_scanned_item_ids)+'</td>'
      +'<td class="num">'+fmtMoney(r.sale_total_sales_value)+'</td><td class="num">'+fmtInt(r.sale_units_sold)+'</td>'
      +'<td class="num">'+fmtInt(r.sale_orders)+'</td><td class="num">'+(r.sale_aov!=null?fmtMoney(r.sale_aov):'N/A')+'</td>'
      +'<td class="num">'+(r.sales_per_walkin!=null?fmtMoney(r.sales_per_walkin):'N/A')+'</td></tr>';
  }).join('')+'</tbody>';
  t.innerHTML=thead+tbody;

  svgBar(document.getElementById('chStoreSales'), rows, 'code', 'sale_total_sales_value', {fmt:fmtMoney, color:'var(--c1,#4f8cff)'});
  svgBar(document.getElementById('chStoreWalkins'), rows, 'code', 'walkin_walkins', {fmt:fmtInt, color:'var(--c2,#22d3a8)'});
}

/* ================= TAB 3: PRODUCT SCAN ANALYSIS ================= */
function computeTopScanned(scanRows){
  var byItem={};
  scanRows.forEach(function(r){
    if(r.item_id==null) return;
    var a=byItem[r.item_id]=byItem[r.item_id]||{events:0, stores:{}, dates:[], parties:{}};
    a.events++;
    if(r.store_code) a.stores[r.store_code]=(a.stores[r.store_code]||0)+1;
    if(r.date) a.dates.push(r.date);
    if(r.party_id!=null) a.parties[r.party_id]=1;
  });
  var rows=Object.keys(byItem).map(function(id){
    var a=byItem[id]; var ds=a.dates.slice().sort();
    var topStore=null, topCount=-1;
    Object.keys(a.stores).forEach(function(s){ if(a.stores[s]>topCount){ topCount=a.stores[s]; topStore=s; } });
    return {
      item_id:+id, scan_events_scope:a.events,
      unique_parties_scanning: Object.keys(a.parties).length,
      first_scan: ds[0]||null, last_scan: ds[ds.length-1]||null,
      top_store: topStore, store_breakdown: a.stores
    };
  });
  rows.sort(function(a,b){ return b.scan_events_scope-a.scan_events_scope; });
  return rows;
}
function renderScanAnalysis(){
  var A=computeFiltered();
  var items=computeTopScanned(A.scanRows);

  document.getElementById('scanKpis').innerHTML=
    '<div class="kpi"><div class="lbl">Total Scan Events</div><div class="val">'+fmtInt(A.totalScans)+'</div><div class="sub">in current scope/date range</div></div>'
   +'<div class="kpi"><div class="lbl">Distinct item_id (all data)</div><div class="val">'+fmtInt(D.data_quality.scan_item_id_distinct)+'</div><div class="sub">opaque internal POS id — no catalog name available</div></div>'
   +'<div class="kpi"><div class="lbl">Scans w/ party_id</div><div class="val">'+fmtInt(D.data_quality.scan_party_id_populated)+' ('+fmtPct(D.data_quality.scan_party_id_populated_pct,1)+')</div><div class="sub">only these rows support "scans per customer"</div></div>';

  var t=document.getElementById('tblTopScanned'); t.innerHTML='';
  var head=['Item ID (opaque)','Total Scan Events','Unique Scanners (party_id)','First Scan','Last Scan','Top Store'];
  t.innerHTML='<thead><tr>'+head.map(function(h){return '<th>'+h+'</th>';}).join('')+'</tr></thead><tbody>'
    +items.slice(0,100).map(function(it){
      return '<tr><td>#'+it.item_id+'</td><td class="num">'+fmtInt(it.scan_events_scope)+'</td>'
        +'<td class="num">'+(it.unique_parties_scanning? fmtInt(it.unique_parties_scanning):'<span class="gap">no party_id</span>')+'</td>'
        +'<td>'+(it.first_scan||'N/A')+'</td><td>'+(it.last_scan||'N/A')+'</td><td>'+(it.top_store||'N/A')+'</td></tr>';
    }).join('')+'</tbody>';

  svgBar(document.getElementById('chTopScanned'), items.slice(0,15), 'item_id', 'scan_events_scope', {fmt:fmtInt, color:'var(--c3,#f4b740)'});

  // store-wise scanned-item counts
  var byStore={}; A.scope.forEach(function(c){ byStore[c]={events:0, items:new Set()}; });
  items.forEach(function(it){ Object.keys(it.store_breakdown||{}).forEach(function(c){ if(byStore[c]){ byStore[c].events+=it.store_breakdown[c]; byStore[c].items.add(it.item_id); } }); });
  var storeRows=Object.keys(byStore).map(function(c){ return {code:c, events:byStore[c].events, items:byStore[c].items.size}; });
  storeRows.sort(function(a,b){return b.events-a.events;});
  var t2=document.getElementById('tblScanByStore'); t2.innerHTML='<thead><tr><th>Store</th><th>Scan Events</th><th>Unique Item IDs Scanned</th></tr></thead><tbody>'
    +storeRows.map(function(r){return '<tr><td>'+r.code+'</td><td class="num">'+fmtInt(r.events)+'</td><td class="num">'+fmtInt(r.items)+'</td></tr>';}).join('')+'</tbody>';
}

/* ================= TAB 4: SCAN VS SALE ANALYSIS ================= */
function renderScanVsSale(){
  document.getElementById('svsGate').innerHTML =
    '<b>Verified finding:</b> a direct string/int match between scan-side identifiers (<code>item_id</code>, <code>sku</code>) '
    +'and every sales-side Item-Code-ish field (<code>Full_sku</code>, Item Code, <code>style_code</code>, <code>document_no</code>) returns <b>0 overlapping rows</b>. '
    +'There is no per-product scan→sale join in this data. The two sections below are the only two honest signals available: '
    +'(a) a low-coverage, row-level <b>measured</b> link via <code>party_id</code>, and (b) a store-level, time-aligned <b>proxy/analytical</b> correlation. They are not interchangeable — do not read (b) as a funnel. '
    +'Both sections respect the date range and store/city/state filter above.';

  var A=computeFiltered();
  var scopeSet=new Set(A.scope);
  var rows=(D.party_linked_scan_sale||[]).filter(function(r){ return inDateRange(r.scan_date) && scopeSet.has(r.scan_store); });
  var scansWithParty = A.scanRows.filter(function(r){ return r.party_id!=null; }).length;
  var distinctMatchedParties={}; rows.forEach(function(r){ distinctMatchedParties[r.party_id]=1; });

  document.getElementById('svsMeasuredKpis').innerHTML =
    '<div class="kpi"><div class="lbl">Scans with party_id (in scope)</div><div class="val">'+fmtInt(scansWithParty)+'</div><div class="sub">of '+fmtInt(A.totalScans)+' scans in current filter</div></div>'
   +'<div class="kpi"><div class="lbl">Party-ID-Matched Scan Rows (in scope)</div><div class="val">'+fmtInt(rows.length)+'</div><div class="sub">scan rows whose party_id also appears in Sales</div></div>'
   +'<div class="kpi"><div class="lbl">Distinct Matched Customers (in scope)</div><div class="val">'+fmtInt(Object.keys(distinctMatchedParties).length)+'</div><div class="sub">party_ids seen on both sides</div></div>'
   +'<div class="kpi bad"><div class="lbl">Coverage of Scans in Scope</div><div class="val">'+fmtPct(pct(rows.length,A.totalScans),1)+'</div><div class="sub">measured conversion only covers this share of scans in the current filter — the rest have no party_id at all</div></div>';

  var t=document.getElementById('tblPartyLinked'); t.innerHTML='<thead><tr><th>party_id</th><th>Scan Item ID</th><th>Scan Date</th><th>Scan Store</th><th>Linked Sale Orders</th><th>Linked Sale Value</th></tr></thead><tbody>'
    +rows.map(function(r){return '<tr><td>'+r.party_id+'</td><td>#'+r.scan_item_id+'</td><td>'+r.scan_date+'</td><td>'+(r.scan_store||'N/A')+'</td><td class="num">'+fmtInt(r.linked_sale_count)+'</td><td class="num">'+fmtMoney(r.linked_sale_net)+'</td></tr>';}).join('')+'</tbody>';

  // (b) store-level proxy correlation — reuse the already date+scope-filtered per-store aggregates
  var corrRows=A.storePerf.map(function(r){return {code:r.code, scan:r.scan_total_scan_events, sale:r.sale_total_sales_value};});
  corrRows.sort(function(a,b){return b.sale-a.sale;});
  var t2=document.getElementById('tblProxyCorr'); t2.innerHTML='<thead><tr><th>Store</th><th>Scan Volume (events)</th><th>Sales Value</th></tr></thead><tbody>'
    +corrRows.map(function(r){return '<tr><td>'+r.code+'</td><td class="num">'+fmtInt(r.scan)+'</td><td class="num">'+fmtMoney(r.sale)+'</td></tr>';}).join('')+'</tbody>';
  svgBar(document.getElementById('chProxyCorr'), corrRows, 'code', 'sale', {fmt:fmtMoney, color:'var(--c1,#4f8cff)'});
}

/* ================= TAB 5: CUSTOMER WALK-IN ANALYSIS ================= */
function renderWalkin(){
  var A=computeFiltered();
  var conv=computeWalkinConversion(A.scope);
  document.getElementById('walkinKpis').innerHTML=
    '<div class="kpi"><div class="lbl">Total Walk-ins</div><div class="val">'+fmtInt(A.totalWalkins)+'</div><div class="sub">in scope/date range</div></div>'
   +'<div class="kpi"><div class="lbl">Unique Customers</div><div class="val">'+fmtInt(A.totalWalkinCust)+'</div><div class="sub">by phone number</div></div>'
   +'<div class="kpi"><div class="lbl">Sales / Walk-in</div><div class="val">'+(A.salesPerWalkin!=null?fmtMoney(A.salesPerWalkin):'N/A')+'</div><div class="sub">store-level, not a per-customer join</div></div>'
   +'<div class="kpi"><div class="lbl">Walk-in → Sale (phone match)</div><div class="val">'+(conv.pct!=null?fmtPct(conv.pct,1):'N/A')+'</div><div class="sub">'+fmtInt(conv.matched)+' of '+fmtInt(conv.total)+' walk-ins in current filter</div></div>';

  var byStore={}; A.walkinRows.forEach(function(r){ var k=r.store_code||'UNMAPPED'; (byStore[k]=byStore[k]||{walkins:0,cust:{}}); byStore[k].walkins++; if(r.phone) byStore[k].cust[r.phone]=1; });
  var rows=Object.keys(byStore).map(function(c){return {code:c, walkins:byStore[c].walkins, cust:Object.keys(byStore[c].cust).length};});
  rows.sort(function(a,b){return b.walkins-a.walkins;});
  var t=document.getElementById('tblWalkinByStore'); t.innerHTML='<thead><tr><th>Store</th><th>Walk-ins</th><th>Unique Customers</th></tr></thead><tbody>'
    +rows.map(function(r){return '<tr><td>'+(r.code==='UNMAPPED'?'<span class="gap">UNMAPPED STORE</span>':r.code)+'</td><td class="num">'+fmtInt(r.walkins)+'</td><td class="num">'+fmtInt(r.cust)+'</td></tr>';}).join('')+'</tbody>';
  svgBar(document.getElementById('chWalkinByStore'), rows, 'code', 'walkins', {fmt:fmtInt, color:'var(--c2,#22d3a8)'});

  var dowOrder=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var dowCount={}; A.walkinRows.forEach(function(r){ if(r.dow) dowCount[r.dow]=(dowCount[r.dow]||0)+1; });
  var dowRows=dowOrder.map(function(d){return {dow:d, count:dowCount[d]||0};});
  svgBar(document.getElementById('chWalkinDow'), dowRows, 'dow', 'count', {fmt:fmtInt, color:'var(--c4,#c084fc)'});

  var monthCount={}; A.walkinRows.forEach(function(r){ if(r.month) monthCount[r.month]=(monthCount[r.month]||0)+1; });
  var monthKeys=Object.keys(monthCount).sort();
  var monthRows=monthKeys.map(function(m){return {month:m, count:monthCount[m]};});
  svgLine(document.getElementById('chWalkinMonth'), monthRows, 'month', [{key:'count',color:'var(--c6,#38bdf8)',label:'Walk-ins'}], {fmt:fmtInt});

  // walkin vs sales per store, day-aligned trend (within current filter scope)
  var byDay={};
  A.walkinRows.forEach(function(r){ var k=r.date; byDay[k]=byDay[k]||{walkins:0,sale:0}; byDay[k].walkins++; });
  A.salesRows.forEach(function(r){ var k=r.date; byDay[k]=byDay[k]||{walkins:0,sale:0}; byDay[k].sale+=r.net_sale; });
  var dayRows=Object.keys(byDay).sort().map(function(d){return {date:d, walkins:byDay[d].walkins, sale:byDay[d].sale};});
  svgLine(document.getElementById('chWalkinVsSaleTrend'), dayRows, 'date', [{key:'walkins',color:'var(--c2,#22d3a8)',label:'Walk-ins'}], {fmt:fmtInt});
}

/* ================= TAB 6: STORE x PRODUCT HEATMAP ================= */
var heatMetric='net_sale';
function renderHeatmap(){
  var A=computeFiltered();
  var stores=A.scope;
  var byItem={}; var cellMap={};
  A.salesRows.forEach(function(r){
    if(!r.item_code) return;
    var a=byItem[r.item_code]=byItem[r.item_code]||{net:0};
    a.net+=r.net_sale;
    var ck=r.item_code+'|'+r.company_code;
    var c=cellMap[ck]=cellMap[ck]||{net:0,pieces:0,orders:{}};
    c.net+=r.net_sale; c.pieces+=r.pieces; c.orders[r.document_no]=1;
  });
  var itemCodes=Object.keys(byItem).sort(function(a,b){return byItem[b].net-byItem[a].net;}).slice(0,25);
  var t=document.getElementById('tblHeatmap'); t.innerHTML='';
  var thead='<thead><tr><th>Item Code</th>'+stores.map(function(s){return '<th>'+s+'</th>';}).join('')+'<th>Total</th></tr></thead>';
  var tbody='<tbody>'+itemCodes.map(function(ic){
    var rowTotal=0;
    var tds=stores.map(function(s){
      var c=cellMap[ic+'|'+s];
      var v = c ? (heatMetric==='net_sale'?c.net:(heatMetric==='pieces'?c.pieces:Object.keys(c.orders).length)) : 0;
      rowTotal+=v;
      return '<td class="hc num">'+(v? (heatMetric==='net_sale'?fmtMoney(v):fmtInt(v)) : '<span class="gap">–</span>')+'</td>';
    }).join('');
    return '<tr><td>'+esc(ic)+'</td>'+tds+'<td class="num">'+(heatMetric==='net_sale'?fmtMoney(rowTotal):fmtInt(rowTotal))+'</td></tr>';
  }).join('')+'</tbody>';
  t.innerHTML=thead+tbody;
  if(!itemCodes.length) t.innerHTML='<tbody><tr><td class="gap">No sales in current filter.</td></tr></tbody>';
}

/* ================= TAB 7: OPPORTUNITY ANALYSIS ================= */
function computeOpportunities(storePerf){
  var n=storePerf.length;
  function rank(key){ var s=storePerf.slice().sort(function(a,b){return b[key]-a[key];}); var m={}; s.forEach(function(r,i){ m[r.code]=i; }); return m; }
  var wr=rank('walkin_walkins'), sr=rank('sale_total_sales_value'), scr=rank('scan_total_scan_events');
  return storePerf.map(function(r){
    var w=wr[r.code], s=sr[r.code], sc=scr[r.code];
    var flags=[];
    if(w<n/2 && s>=n/2) flags.push('High walk-in, low sales — conversion problem at this store');
    if(sc>=n/2 && s<n/2) flags.push('Low scan volume, high sales — sales outrunning in-store product engagement (or scanning under-used)');
    if(w<n/2 && sc>=n/2) flags.push('High walk-in, low scan volume — staff/customers may be under-using the scan process');
    if(!flags.length) flags.push('No major imbalance flagged');
    return {code:r.code, name:r.name, walkin_rank:w+1, sale_rank:s+1, scan_rank:sc+1, flags:flags};
  });
}
function renderOpportunity(){
  var A=computeFiltered();
  var opps=computeOpportunities(A.storePerf);
  var t=document.getElementById('tblOpportunity'); t.innerHTML='<thead><tr><th>Store</th><th>Walk-in Rank</th><th>Sales Rank</th><th>Scan-Volume Rank</th><th>Flags</th></tr></thead><tbody>'
    +opps.map(function(o){return '<tr><td>'+o.code+' — '+esc(o.name)+'</td><td class="num">#'+o.walkin_rank+'</td><td class="num">#'+o.sale_rank+'</td><td class="num">#'+o.scan_rank+'</td><td>'+o.flags.map(function(f){return '<div>'+esc(f)+'</div>';}).join('')+'</td></tr>';}).join('')+'</tbody>';
  document.getElementById('oppNote').innerHTML='Ranks and flags are recomputed for the <b>current date range and store/city/state filter</b>, using store-grain scan volume (total scan events), because no per-SKU scan metric exists to correlate against per-SKU sales (see Scan vs Sale tab). Rank #1 = highest in that metric among stores currently in scope.';
}

/* ================= TAB 8: DATA QUALITY ================= */
function renderDataQuality(){
  var dq=D.data_quality;
  var rows=[
    ['Scan table row count', fmtInt(dq.scan_row_count)],
    ['Scan date range', dq.scan_date_range.join(' to ')],
    ['Sale table row count', fmtInt(dq.sale_row_count)],
    ['Sale date range', dq.sale_date_range.join(' to ')],
    ['Walk-in table row count', fmtInt(dq.walkin_row_count)],
    ['Walk-in date range', dq.walkin_date_range.join(' to ')],
    ['Scan rows with party_id populated', fmtInt(dq.scan_party_id_populated)+' ('+fmtPct(dq.scan_party_id_populated_pct,1)+' of scans)'],
    ['Scan↔Sale Item Code/item_id key overlap (verified)', '0 rows — '+fmtInt(dq.scan_item_id_distinct)+' distinct scan item_ids vs '+fmtInt(dq.sale_item_code_distinct)+' distinct Item Codes / '+fmtInt(dq.sale_full_sku_distinct)+' distinct Full_sku, 0% match on any tested field'],
    ['Scan↔Sale party_id overlap (measured link)', fmtInt(dq.scan_sale_party_overlap_distinct_parties)+' distinct customers, '+fmtInt(dq.scan_sale_party_matched_scan_rows)+' of '+fmtInt(dq.scan_party_id_populated)+' party-tagged scan rows matched'],
    ['Walk-in rows with a mapped store_code', fmtInt(dq.walkin_row_count-dq.walkin_unmapped_store_rows)+' of '+fmtInt(dq.walkin_row_count)],
    ['Walk-in UNMAPPED STORE rows', fmtInt(dq.walkin_unmapped_store_rows)+' ('+fmtInt(dq.walkin_unmapped_store_unique_customers)+' unique customers) — breakdown: '+Object.keys(dq.walkin_unmapped_reason_breakdown).map(function(k){return k+': '+dq.walkin_unmapped_reason_breakdown[k];}).join(', ')],
    ['Walk-in rows with phone populated', fmtInt(dq.walkin_phone_populated)+' of '+fmtInt(dq.walkin_row_count)],
    ['Walk-in → Sale phone match (measured conversion)', fmtInt(dq.walkin_phone_matched_to_sale)+' of '+fmtInt(dq.walkin_row_count)+' walk-ins ('+fmtPct(dq.walkin_phone_matched_pct,1)+')'],
    ['Sale rows with party_id / phone populated', fmtInt(dq.sale_party_id_populated)+' / '+fmtInt(dq.sale_phone_populated)+' of '+fmtInt(dq.sale_row_count)],
  ];
  var t=document.getElementById('tblDataQuality'); t.innerHTML='<thead><tr><th>Check</th><th>Result</th></tr></thead><tbody>'
    +rows.map(function(r){return '<tr><td>'+r[0]+'</td><td>'+r[1]+'</td></tr>';}).join('')+'</tbody>';
  document.getElementById('dqNote').innerHTML='Snapshot generated: <b>'+esc(D.meta.generated_at_ist||'N/A')+'</b>. '+esc(D.meta.note||'')+' <b>This tab always reports on the full dataset regardless of the date/store filter above</b> — a data-quality/mapping audit isn’t meaningful scoped to a single day or store. Every other tab respects the active filter.';
}

/* ================= TAB 9: ASK YOUR DATA (rule-based) ================= */
function findStoreMention(q){
  var m=q.match(/\b(HO|CS1|PN1|BO1|N18|FCS|PV1|LPN)\b/i);
  if(m) return m[1].toUpperCase();
  var byName=(D.store_master||[]).find(function(s){ return q.toLowerCase().indexOf(s.city.toLowerCase())>=0; });
  if(byName) return byName.company_code;
  if(/\b(that|its|this)\s+store\b/i.test(q) && LAST_SUBJECT && LAST_SUBJECT.type==='store') return LAST_SUBJECT.code;
  return null;
}
function assistantAnswer(q){
  var ql=q.toLowerCase();
  var A=computeFiltered();

  if(/scan.*sale|sale.*scan/.test(ql) && /(sku|product|item)/.test(ql) && !/store/.test(ql)){
    return {type:'ASSUMPTION', text:"I don't have enough reliable data to answer this. There is a verified 0% key overlap between scan-side item_id/sku and every sales-side SKU field — no per-product scan→sale link exists in this dataset."};
  }
  var storeCode=findStoreMention(q);
  if(storeCode){
    LAST_SUBJECT={type:'store', code:storeCode};
    var r=A.storePerf.find(function(x){return x.code===storeCode;});
    if(!r) return {type:'FACT', text:'No record found for store code '+storeCode+' in the current filter (range '+F.from+' to '+F.to+').'};
    if(/top product|best product|what.*sell/.test(ql)){
      var storeSales=A.salesRows.filter(function(x){return x.company_code===storeCode;});
      var tp=computeTopProduct(storeSales);
      if(!tp) return {type:'FACT', text:'No sales recorded for '+storeCode+' in the current filter ('+F.from+' to '+F.to+').'};
      LAST_SUBJECT={type:'product', sku:tp.item_code};
      return {type:'FACT', text:'Top product at '+storeCode+' in the current filter: Item Code '+tp.item_code+' ('+(tp.item_group_name||'')+') at '+fmtMoney(tp.net)+', '+fmtInt(tp.pieces)+' pieces across '+fmtInt(tp.orders)+' orders. See the Store × Product Heatmap tab for the fuller per-Item-Code breakdown.'};
    }
    return {type:'FACT', text:storeCode+' ('+r.name+', '+r.city+'), current filter ('+F.from+' to '+F.to+'): sales '+fmtMoney(r.sale_total_sales_value)+', orders '+fmtInt(r.sale_orders)+', units '+fmtInt(r.sale_units_sold)+', walk-ins '+fmtInt(r.walkin_walkins)+', scan events '+fmtInt(r.scan_total_scan_events)+', unique scanned item ids '+fmtInt(r.scan_unique_scanned_item_ids)+'.'};
  }
  if(/top store/.test(ql)){
    var top=A.storePerf.slice().sort(function(a,b){return b.sale_total_sales_value-a.sale_total_sales_value;})[0];
    if(!top) return {type:'FACT', text:'No stores in the current filter scope.'};
    LAST_SUBJECT={type:'store', code:top.code};
    return {type:'FACT', text:'Top store by sales in the current filter ('+F.from+' to '+F.to+'): '+top.code+' ('+top.name+') at '+fmtMoney(top.sale_total_sales_value)+'.'};
  }
  if(/top product|best.?sell/.test(ql)){
    var tp2=computeTopProduct(A.salesRows);
    if(!tp2) return {type:'FACT', text:'No sales recorded in the current filter ('+F.from+' to '+F.to+').'};
    LAST_SUBJECT={type:'product', sku:tp2.item_code};
    return {type:'FACT', text:'Top-selling product by value in the current filter ('+F.from+' to '+F.to+'): Item Code '+tp2.item_code+' ('+(tp2.item_group_name||'')+') at '+fmtMoney(tp2.net)+', '+fmtInt(tp2.pieces)+' pieces across '+fmtInt(tp2.orders)+' orders.'};
  }
  if(/walk.?in.*(conver|sale)/.test(ql)){
    var conv=computeWalkinConversion(A.scope);
    return {type:'FACT', text:'Walk-in → sale conversion in the current filter ('+F.from+' to '+F.to+'), measured by matching phone numbers between Walk-in and Sales: '+fmtInt(conv.matched)+' of '+fmtInt(conv.total)+' walk-ins ('+(conv.pct!=null?fmtPct(conv.pct,1):'N/A')+') have at least one matching sale record. This is a real, row-level match — not a proxy.'};
  }
  if(/total sales|revenue/.test(ql)){
    return {type:'FACT', text:'Total sales value in the current filter scope ('+F.from+' to '+F.to+'): '+fmtMoney(A.totalSales)+' across '+fmtInt(A.totalOrders)+' orders.'};
  }
  if(/total scan/.test(ql)){
    return {type:'FACT', text:'Total scan events in the current filter scope: '+fmtInt(A.totalScans)+'.'};
  }
  if(/unmapped/.test(ql)){
    return {type:'FACT', text:'Walk-in rows with a store_code that doesn’t map to any real store (NULL / "HWI" / "Amazon"): '+fmtInt(D.data_quality.walkin_unmapped_store_rows)+' rows, '+fmtInt(D.data_quality.walkin_unmapped_store_unique_customers)+' unique customers. These are excluded from every real store’s numbers, never merged or dropped silently.'};
  }
  if(/priorit|opportunit|focus/.test(ql)){
    var opps=computeOpportunities(A.storePerf);
    var worst=opps.find(function(o){ return o.flags[0] && o.flags[0].indexOf('No major')<0; });
    if(worst) return {type:'INSIGHT', text:'One store worth reviewing in the current filter ('+F.from+' to '+F.to+'): '+worst.code+' — '+worst.flags.join('; ')+'. See the Opportunity Analysis tab for the full ranked list.'};
  }
  return {type:'ASSUMPTION', text:"I don't have enough reliable data to answer this precisely. Try asking about a specific store (e.g. \"How is PN1 doing?\"), the top store/product, walk-in conversion, total sales, or unmapped walk-ins. This is a rule-based assistant reading the precomputed snapshot — not a live Gemini/LLM call."};
}
function askAppend(boxId,role,text){
  var box=document.getElementById(boxId); if(!box) return;
  var m=el('div','msg '+(role==='u'?'u':'a'), esc(text));
  box.appendChild(m); box.scrollTop=box.scrollHeight;
}
function wireAskBox(boxId,inputId,sendFn){
  var inp=document.getElementById(inputId); if(!inp) return;
  function send(){
    var q=inp.value.trim(); if(!q) return;
    askAppend(boxId,'u', q); inp.value='';
    var a=assistantAnswer(q);
    askAppend(boxId,'a', '['+a.type+'] '+a.text);
  }
  inp.addEventListener('keydown', function(e){ if(e.key==='Enter') send(); });
  if(sendFn) sendFn(send);
  return send;
}
function wireAssistant(){
  var sendMain=wireAskBox('askMsgs','askInput');
  document.getElementById('askSend').addEventListener('click', sendMain);
  document.querySelectorAll('#askChips .qchip').forEach(function(c){ c.addEventListener('click', function(){ document.getElementById('askInput').value=c.textContent; sendMain(); }); });

  var sendInline=wireAskBox('askMsgsInline','askInputInline');
  document.querySelectorAll('#v9 .qchips .qchip').forEach(function(c){ c.addEventListener('click', function(){ document.getElementById('askInputInline').value=c.textContent; sendInline(); }); });
}

/* ================= MAIN RENDER + WIRING ================= */
function renderAll(){
  renderExec(); renderStorePerf(); renderScanAnalysis(); renderScanVsSale();
  renderWalkin(); renderHeatmap(); renderOpportunity(); renderDataQuality();
  document.getElementById('freshPill').innerHTML='<span class="dot"></span> Data as of '+esc(D.meta.generated_at_ist||'N/A')+' — refresh by rerunning build_spsw_data.py';
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
    F.stores=new Set(); F.cities=new Set(); F.states=new Set(); F.categories=new Set(); F.skus=new Set();
    document.querySelectorAll('.msbox input').forEach(function(i){i.checked=false;});
    document.getElementById('skuSearch').value='';
    applyDatePreset('all');
  });
  document.getElementById('moreFiltBtn').addEventListener('click', function(){ document.getElementById('fdrawer').classList.toggle('open'); });
  document.getElementById('heatMetricSel').addEventListener('change', function(e){ heatMetric=e.target.value; renderHeatmap(); });
  document.getElementById('themeBtn').addEventListener('click', function(){
    var html=document.documentElement; html.setAttribute('data-theme', html.getAttribute('data-theme')==='dark'?'light':'dark');
  });
  document.getElementById('printBtn').addEventListener('click', function(){ window.print(); });
  document.querySelectorAll('[data-csv]').forEach(function(b){ b.addEventListener('click', function(){ downloadBlob(tableToCsv(b.dataset.csv), b.dataset.name+'.csv', 'text/csv'); }); });
}

document.addEventListener('DOMContentLoaded', function(){
  fillFilterUI();
  wireTabs(); wireFilters(); wireAssistant();
  renderAll();
  var boot=document.getElementById('boot'); if(boot){ boot.classList.add('hide'); setTimeout(function(){boot.remove();},500); }
});

})();
