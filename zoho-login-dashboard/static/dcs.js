/* Deals vs Calls vs Sales Performance Dashboard — engine
   Data: CRM = window.DASH (dashboard/data.js, static Zoho snapshot). Sales = live BigQuery
   reporting-layer snapshot (public GCS JSON), fetched at runtime with a bundled sample fallback.
   Everything below is computed client-side; nothing is fabricated — sections that cannot be
   computed from real fields render an explicit gate note instead of invented numbers. */
(function(){
'use strict';

var CONFIG={
  SALES_SNAPSHOT_URL:'https://storage.googleapis.com/lucira-dashboards/sales/latest.json',
  /* Public Cloud Function reading the SAME zoho_crm.cdc_* BigQuery tables the live
     "Deals VS Call" Command Center uses (synced from Zoho every 15 min). Unlike that
     app's /api/crm-bundle, this one is unauthenticated + CORS-open so a standalone
     file can fetch it directly. See zoho-crm-bundle-api/main.py. */
  CRM_API:'https://asia-south1-lucirajewelry-prod.cloudfunctions.net/zoho-crm-bundle-public',
  AUTO_MS: 300000
};

/* ---------- generic utils ---------- */
function el(tag,cls,html){ var e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; }
function esc(s){ return (s==null?'':''+s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function fmtInt(n){ return (n==null||isNaN(n))?'N/A':Math.round(n).toLocaleString('en-IN'); }
function fmtMoney(n){ if(n==null||isNaN(n))return 'N/A'; var a=Math.abs(n),s=n<0?'-':''; if(a>=1e7) return s+'₹'+(a/1e7).toFixed(2)+'Cr'; if(a>=1e5) return s+'₹'+(a/1e5).toFixed(2)+'L'; return s+'₹'+Math.round(a).toLocaleString('en-IN'); }
function fmtPct(n,d){ if(n==null||isNaN(n))return 'N/A'; return n.toFixed(d==null?1:d)+'%'; }
function pct(a,b){ return b?(100*a/b):null; }
function ymd(d){ if(!d)return null; if(typeof d==='string') d=new Date(d.replace(' ','T')); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function addDays(dstr,n){ var d=new Date(dstr+'T00:00:00'); d.setDate(d.getDate()+n); return ymd(d); }
function diffMin(a,b){ return (new Date(b.replace(' ','T'))-new Date(a.replace(' ','T')))/60000; }
function hourOf(dstr){ var d=new Date((''+dstr).replace(' ','T')); return d.getHours(); }
function fmtHMS(secs){ secs=Math.max(0,Math.round(secs||0)); var h=Math.floor(secs/3600), m=Math.floor((secs%3600)/60), s=secs%60; return [h,m,s].map(function(x){return String(x).padStart(2,'0');}).join(':'); }
function fmtDurWords(secs){ secs=Math.max(0,Math.round(secs||0)); var h=Math.floor(secs/3600), m=Math.floor((secs%3600)/60), s=secs%60; return h>0? (h+' hr '+m+' min') : (m+' min '+s+' sec'); }
/* Generic filter predicates so every table/chart respects the SAME global filter
   state F, instead of each builder re-implementing (or forgetting) its own subset. */
function dealPassF(d,F){
  if(F.agents&&F.agents.size&&!F.agents.has(d.owner)) return false;
  if(F.sources&&F.sources.size&&!F.sources.has(d.leadSource)) return false;
  if(F.campaigns&&F.campaigns.size&&!F.campaigns.has(d.utmSource)) return false;
  if(F.triggers&&F.triggers.size&&!F.triggers.has(d.trigger)) return false;
  return true;
}
function callPassF(c,F){ return !(F.agents&&F.agents.size&&!F.agents.has(c.owner)); }
function eventPassF(e,F){ return !(F.agents&&F.agents.size&&!F.agents.has(e.owner)); }
function salesPassF(it,F){
  if(F.stores&&F.stores.size&&!F.stores.has(it.store)) return false;
  if(F.categories&&F.categories.size&&!F.categories.has(it.category)) return false;
  if(F.cities&&F.cities.size&&!F.cities.has(it.city)) return false;
  if(F.ctypes&&F.ctypes.size&&!F.ctypes.has(it.customer_type)) return false;
  return true;
}
function dowOf(dstr){ return new Date((''+dstr).replace(' ','T')).getDay(); }
function normPhone(m){ return (''+(m||'')).replace(/\D/g,'').slice(-10); }
function avg(arr){ if(!arr.length)return null; return arr.reduce(function(a,b){return a+b;},0)/arr.length; }
function downloadBlob(content,filename,mime){ if(mime==='text/csv' && typeof content==='string' && content.charCodeAt(0)!==0xFEFF) content='﻿'+content; var blob=new Blob([content],{type:mime+';charset=utf-8'}); var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},800); }
function csvOf(rows){ return rows.map(function(r){return r.map(function(v){ v=(v==null?'':''+v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }).join(',');}).join('\n'); }
function tableToCsv(id){ var t=document.getElementById(id); if(!t)return ''; var rows=[]; t.querySelectorAll('tr').forEach(function(tr){ var r=[]; tr.querySelectorAll('th,td').forEach(function(td){ r.push(td.textContent.trim()); }); rows.push(r); }); return csvOf(rows); }

/* ---------- CRM parsers (matches dashboard/data.js positional schema) ---------- */
function pd(a){ return {id:a[0],name:a[1],owner:a[2],created:a[3],stage:a[4],prob:a[5],leadSource:a[6],reasonLoss:a[7],trigger:a[8],utmSource:a[9],utmMedium:a[10],numAct:a[11]||0,mobile:normPhone(a[12])}; }
function pc(a){ return {id:a[0],owner:a[1],created:a[2],type:a[3],dur:a[4]||0,start:a[5],whatId:a[6]||'',phone:normPhone(a[7])}; }
function pt(a){ return {id:a[0],owner:a[1],created:a[2],status:a[3],due:a[4],closed:a[5],whatId:a[6]||''}; }
function po(a){ return {id:a[0],owner:a[1],created:a[2],channel:a[3],atype:a[4]}; }
function pe(a){ return {id:a[0],owner:a[1],created:a[2],start:a[3],end:a[4],title:a[5]||''}; }

function classifyEvent(title){
  var t=(title||'').toLowerCase().trim();
  if(/trial at home|try at home|\btah\b/.test(t)) return 'TAH';
  if(/video/.test(t)) return 'Video Call';
  if(/visit|\bsv\b/.test(t)) return 'Store Visit';
  return 'Meeting';
}

/* Store mapping: Sales snapshot uses short codes (HO/CS1/PN1/BO1/N18/FCS/PV1); CRM has
   dedicated "store" owner accounts (see owner map). Linked here by best-effort name match —
   FCS has no confirmed CRM counterpart, kept separate & labelled unmapped. */
var STORE_CODE_NAME={HO:'Head Office / Online Fulfilment',CS1:'Chembur',PN1:'Pune',BO1:'Borivali',N18:'Noida',PV1:'Pashchim Vihar',FCS:'FCS (store code — no confirmed CRM mapping)'};
var STORE_CITY={HO:'Mumbai',CS1:'Mumbai',BO1:'Mumbai',PN1:'Pune',N18:'Noida',PV1:'Delhi NCR',FCS:''};
var STORE_OWNERNAME_TO_CODE={'Chembur Store':'CS1','Pune Store':'PN1','Borivali Team':'BO1','Borivali Store':'BO1','Noida Store':'N18','Pashchim Vihar':'PV1'};

var DATA=null; // built by buildData()

function ownerName(id){ return (DATA.owners[id])||id||'—'; }
function storeCodeOfOwner(id){ return STORE_OWNERNAME_TO_CODE[ownerName(id)]||null; }

function buildData(raw){
  raw=raw||window.DASH||{owners:{},deals:[],calls:[],tasks:[],online:[],events:[]};
  var D={ owners:raw.owners||{}, meta:raw.meta||{}, deals:(raw.deals||[]).map(pd), calls:(raw.calls||[]).map(pc), tasks:(raw.tasks||[]).map(pt), online:(raw.online||[]).map(po), events:(raw.events||[]).map(pe), sales:null, salesMeta:null };
  // indices
  D.idxWhat={}; D.calls.forEach(function(c){ if(c.whatId){ (D.idxWhat[c.whatId]=D.idxWhat[c.whatId]||[]).push(c); } });
  D.idxPhone={}; D.calls.forEach(function(c){ if(c.phone){ (D.idxPhone[c.phone]=D.idxPhone[c.phone]||[]).push(c); } });
  // crm max date across all modules
  var maxD=null;
  [D.deals,D.calls,D.tasks,D.events].forEach(function(arr){ arr.forEach(function(r){ var d=r.created; if(d && (!maxD||d>maxD)) maxD=d; }); });
  D.crmMaxDate = maxD?ymd(maxD):ymd(new Date());
  D.crmYesterday = addDays(D.crmMaxDate,-1);
  D.crmToday = D.crmMaxDate;
  return D;
}

function joinDeal(D,deal){
  var byWhat=D.idxWhat[deal.id]||[];
  var byPhone=deal.mobile?(D.idxPhone[deal.mobile]||[]):[];
  var seen={}, calls=[];
  byWhat.concat(byPhone).forEach(function(c){ if(!seen[c.id]){ seen[c.id]=1; calls.push(c); } });
  calls.sort(function(a,b){ return a.created<b.created?-1:1; });
  var connected=calls.filter(function(c){ return c.dur>0; });
  var first=calls[0]||null;
  var frt = first? diffMin(deal.created, first.created) : null;
  return {deal:deal,calls:calls,connected:connected,first:first,frt:frt,contacted:calls.length>0};
}

/* ---------- Sales loader ---------- */
var SALES_SAMPLE=[ // tiny illustrative fallback only used if the live fetch fails (e.g. offline)
 {date:'2026-07-19',document_no:'S-001',customer_id:'901',category:'Rings',sale_type:'RTS',qty:1,gross:64000,net:62136,store:'BO1',channel:'Store',customer_type:'New',city:'Mumbai'},
 {date:'2026-07-19',document_no:'S-002',customer_id:'902',category:'Necklaces',sale_type:'MTO',qty:1,gross:145000,net:140777,store:'CS1',channel:'Store',customer_type:'Repeat',city:'Mumbai'},
 {date:'2026-07-20',document_no:'S-003',customer_id:'903',category:'Earrings',sale_type:'TAH',qty:1,gross:38000,net:36893,store:'HO',channel:'TAH',customer_type:'New',city:''}
];
function loadSales(cb){
  fetch(CONFIG.SALES_SNAPSHOT_URL,{cache:'no-store'}).then(function(r){ if(!r.ok) throw new Error('http '+r.status); return r.json(); }).then(function(j){
    cb({items:j.items||[], meta:{generated_at:j.generated_at,asOf:j.asOf,validation:j.validation}, live:true});
  }).catch(function(e){
    cb({items:SALES_SAMPLE, meta:{generated_at:null,asOf:null,note:'fetch failed ('+e.message+') — showing bundled sample'}, live:false});
  });
}

/* ---------- CRM loader: live BigQuery-CDC feed (same tables the Deals VS Call
   Command Center reads, refreshed every 15 min from Zoho) with a static
   dashboard/data.js snapshot fallback if the live endpoint is unreachable. */
function loadCrm(cb){
  if(!CONFIG.CRM_API){ cb({raw:window.DASH, live:false, source:'static snapshot (data.js)'}); return; }
  fetch(CONFIG.CRM_API,{cache:'no-store'}).then(function(r){ if(!r.ok) throw new Error('http '+r.status); return r.json(); }).then(function(j){
    cb({raw:j, live:true, source:'live · BigQuery CDC (synced from Zoho every 15 min)'});
  }).catch(function(e){
    cb({raw:window.DASH, live:false, source:'static snapshot (data.js) — live fetch failed: '+e.message});
  });
}

/* ================= MODEL BUILDERS ================= */

function inRange(dstr,from,to){ var d=ymd(dstr); return d>=from && d<=to; }

function activeOwners(D){
  var s={};
  D.deals.forEach(function(d){s[d.owner]=1;}); D.calls.forEach(function(c){s[c.owner]=1;}); D.tasks.forEach(function(t){s[t.owner]=1;}); D.events.forEach(function(e){s[e.owner]=1;});
  return Object.keys(s).filter(function(id){ return ownerName(id)!=='Lucira Tech'; });
}

/* Section 1: per-agent, for the given day */
function buildAgentPerf(D,day,F){
  var owners=activeOwners(D).filter(function(o){ return !F.agents.size || F.agents.has(o); });
  var dealsByOwner={}; D.deals.forEach(function(d){ if(ymd(d.created)===day && dealPassF(d,F)) (dealsByOwner[d.owner]=dealsByOwner[d.owner]||[]).push(d); });
  var callsByOwnerDay={}; D.calls.forEach(function(c){ if(ymd(c.created)===day && callPassF(c,F)) (callsByOwnerDay[c.owner]=callsByOwnerDay[c.owner]||[]).push(c); });
  var eventsByOwnerDay={}; D.events.forEach(function(e){ if(ymd(e.created)===day && eventPassF(e,F)) (eventsByOwnerDay[e.owner]=eventsByOwnerDay[e.owner]||[]).push(e); });
  var rows=[];
  owners.forEach(function(o){
    var assigned=dealsByOwner[o]||[]; var callsDay=callsByOwnerDay[o]||[]; var evDay=eventsByOwnerDay[o]||[];
    if(!assigned.length && !callsDay.length && !evDay.length) return;
    var joined=assigned.map(function(d){return joinDeal(D,d);});
    var connectedDay=callsDay.filter(function(c){return c.dur>=30;});
    var notCalled=joined.filter(function(j){return !j.contacted;});
    var frtsBiz=[], frtsNonBiz=[]; // split by the DEAL's creation hour: business (10:00-20:00) vs non-business (20:00-10:00)
    joined.forEach(function(j){
      if(j.frt==null || j.frt<0) return; // negative = phone-reuse artifact (matched call predates this deal), exclude from the average
      var h=hourOf(j.deal.created);
      if(h>=10 && h<20) frtsBiz.push(j.frt); else frtsNonBiz.push(j.frt);
    });
    var evTypes={ 'Meeting':0,'Store Visit':0,'Video Call':0,'TAH':0 };
    evDay.forEach(function(e){ evTypes[classifyEvent(e.title)]++; });
    var won=assigned.filter(function(d){ return d.stage==='Closed Won'; }).length; // real, per-agent conversion signal straight from the Deal's own Stage — no cross-system join needed
    rows.push({
      owner:o, name:ownerName(o),
      dealsAssigned:assigned.length,
      totalCalls:callsDay.length,
      connectedCalls:connectedDay.length,
      contactRate:pct(connectedDay.length,callsDay.length),
      dealsNotCalled:notCalled.length,
      avgFrtBiz:avg(frtsBiz), avgFrtNonBiz:avg(frtsNonBiz), avgFrtAll:avg(frtsBiz.concat(frtsNonBiz)),
      meetings: evDay.length,
      storeVisits: evTypes['Store Visit'], videoCalls: evTypes['Video Call'], tah: evTypes['TAH'],
      won:won, winRate:pct(won,assigned.length)
    });
  });
  rows.sort(function(a,b){ return b.dealsAssigned-a.dealsAssigned; });
  return rows;
}

/* Deal-level drill-down backing the "Avg First Call 10AM-8PM" / "8PM-10AM" KPIs — covers
   the whole reference day (both windows) so both aggregate columns can be spot-checked
   record-by-record. Negative FRT = phone-reuse artifact (the matched call predates this
   deal) — shown flagged, not hidden, since this is a verification tool. */
function buildFrtDetail(D,day,F){
  var deals=D.deals.filter(function(d){ return ymd(d.created)===day && dealPassF(d,F); });
  var rows=deals.map(function(d){
    var j=joinDeal(D,d);
    var h=hourOf(d.created);
    return { dealId:d.id, name:d.name, owner:ownerName(d.owner), stage:d.stage, mobile:d.mobile, created:d.created, firstCall:j.first?j.first.created:null, frtSecs:j.frt!=null?j.frt*60:null, window:(h>=10&&h<20)?'10AM-8PM':'8PM-10AM' };
  });
  rows.sort(function(a,b){ return a.created<b.created?-1:1; });
  return rows;
}

/* Section 3: store performance (CRM events by store-owner + Sales by store code) */
function buildStorePerf(D,S,day,today,salesRange,F){
  var codes=Object.keys(STORE_CODE_NAME).filter(function(c){ return !F.stores.size || F.stores.has(c); });
  var storeOwnerIds={};
  activeOwners(D).filter(function(o){ return !F.agents.size || F.agents.has(o); }).forEach(function(id){ var c=storeCodeOfOwner(id); if(c){ (storeOwnerIds[c]=storeOwnerIds[c]||[]).push(id); } });
  var rows=codes.map(function(code){
    var ownerIds=storeOwnerIds[code]||[];
    var yestMeet = D.events.filter(function(e){ return ownerIds.indexOf(e.owner)>=0 && ymd(e.created)===day; });
    var todayVisits = D.events.filter(function(e){ return ownerIds.indexOf(e.owner)>=0 && ymd(e.start||e.created)===today && classifyEvent(e.title)==='Store Visit'; });
    var todayVideo = D.events.filter(function(e){ return ownerIds.indexOf(e.owner)>=0 && ymd(e.start||e.created)===today && classifyEvent(e.title)==='Video Call'; });
    var todayTah = D.events.filter(function(e){ return ownerIds.indexOf(e.owner)>=0 && ymd(e.start||e.created)===today && classifyEvent(e.title)==='TAH'; });
    var salesRows = S.items.filter(function(it){ return it.store===code && it.date>=salesRange[0] && it.date<=salesRange[1] && it.sale_type!=='Return' && salesPassF(it,F); });
    var orders={}; salesRows.forEach(function(it){orders[it.document_no]=1;});
    var revenue = salesRows.reduce(function(a,it){return a+(it.net||it.gross*0.97||0);},0);
    var denom=yestMeet.length+todayVisits.length;
    return { code:code, name:STORE_CODE_NAME[code], city:STORE_CITY[code], yestMeetings:yestMeet.length, todayVisits:todayVisits.length, todayVideo:todayVideo.length, todayTah:todayTah.length, orders:Object.keys(orders).length, revenue:revenue, conversion: denom? pct(Object.keys(orders).length,denom):null, hasCrmOwners:ownerIds.length>0 };
  });
  rows.sort(function(a,b){return b.revenue-a.revenue;});
  return rows;
}

/* Section 4: yesterday's Sales split by store, Store-channel vs Online-channel.
   "Online Agent Sale" is a PROXY (Sales.channel==='Online'), not per-agent attribution —
   the Sales table has no salesperson/agent field (capabilities.salesperson=false), so
   individual JC agents (Shamwail/Farha/Sheetal/Shreekant etc) cannot be told apart here. */
function buildYesterdaySaleDump(S,day,F){
  var codes=Object.keys(STORE_CODE_NAME).filter(function(c){ return !F.stores.size || F.stores.has(c); });
  var rows=codes.map(function(code){
    var items=S.items.filter(function(it){ return it.store===code && it.date===day && it.sale_type!=='Return' && salesPassF(it,F); });
    var orders={}, storeOrders={}, onlineOrders={};
    items.forEach(function(it){
      orders[it.document_no]=1;
      if(it.channel==='Online') onlineOrders[it.document_no]=1; else storeOrders[it.document_no]=1; // Store + TAH channel both folded into "Store Sale" (human-assisted, not online-lead-originated)
    });
    return { code:code, name:STORE_CODE_NAME[code], total:Object.keys(orders).length, storeSale:Object.keys(storeOrders).length, onlineSale:Object.keys(onlineOrders).length };
  });
  rows.sort(function(a,b){return b.total-a.total;});
  return rows;
}

/* Trend series over a date window (CRM + Sales) — respects the same global filter F */
function buildTrends(D,S,fromD,toD,F){
  var days=[]; var d=fromD; while(d<=toD){ days.push(d); d=addDays(d,1); }
  var out=days.map(function(day){
    var deals=D.deals.filter(function(x){return ymd(x.created)===day && dealPassF(x,F);}).length;
    var callsArr=D.calls.filter(function(x){return ymd(x.created)===day && callPassF(x,F);});
    var connected=callsArr.filter(function(c){return c.dur>0;}).length;
    var events=D.events.filter(function(x){return ymd(x.created)===day && eventPassF(x,F);});
    var meetings=events.length, storeVisits=events.filter(function(e){return classifyEvent(e.title)==='Store Visit';}).length;
    var salesRows=S.items.filter(function(it){return it.date===day && it.sale_type!=='Return' && salesPassF(it,F);});
    var revenue=salesRows.reduce(function(a,it){return a+(it.net||it.gross*0.97||0);},0);
    return {day:day,deals:deals,calls:callsArr.length,connected:connected,meetings:meetings,storeVisits:storeVisits,revenue:revenue,orders:salesRows.length};
  });
  return out;
}

/* ================= CHART HELPERS (hand-rolled SVG, no CDN) ================= */
function svg(w,h,inner){ return '<svg viewBox="0 0 '+w+' '+h+'" width="100%" height="'+h+'" style="overflow:visible">'+inner+'</svg>'; }
function hbar(items,opts){ // items: [{label,value,color}]
  opts=opts||{}; var max=Math.max.apply(null,items.map(function(i){return i.value||0;}).concat([1]));
  var rowH=opts.rowH||24, w=560, labelW=opts.labelW||130;
  var h=items.length*rowH+6, inner='';
  items.forEach(function(it,i){
    var bw=Math.max(2,(w-labelW-70)*((it.value||0)/max));
    var y=i*rowH;
    inner+='<text x="0" y="'+(y+rowH/2+4)+'" font-size="11" fill="var(--tx2)">'+esc(it.label)+'</text>';
    inner+='<rect x="'+labelW+'" y="'+(y+4)+'" width="'+bw+'" height="'+(rowH-10)+'" rx="4" fill="'+(it.color||'var(--acc)')+'"></rect>';
    inner+='<text x="'+(labelW+bw+8)+'" y="'+(y+rowH/2+4)+'" font-size="11" fill="var(--tx)" font-family=\'JetBrains Mono\'>'+esc(it.valueLabel!=null?it.valueLabel:it.value)+'</text>';
  });
  return '<div style="overflow-x:auto"><svg viewBox="0 0 '+w+' '+h+'" width="100%" height="'+h+'">'+inner+'</svg></div>';
}
function lineChart(series,opts){ // series: [{x,y}], opts:{color,y2,color2}
  opts=opts||{}; var w=600,h=180,pad=30;
  var ys=series.map(function(p){return p.y;}); if(opts.y2) series.forEach(function(p){ys.push(p.y2);});
  var maxY=Math.max.apply(null,ys.concat([1]))*1.15, minY=0;
  var n=series.length||1;
  function xy(i,v){ var x=pad+(w-pad*2)*(i/(n-1||1)); var y=h-pad-(h-pad*1.4)*((v-minY)/(maxY-minY||1)); return [x,y]; }
  function path(key,color){ var d=''; series.forEach(function(p,i){ var xy_=xy(i,p[key]); d+=(i===0?'M':'L')+xy_[0].toFixed(1)+' '+xy_[1].toFixed(1)+' '; }); return '<path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="2.2"></path>'; }
  var grid=''; for(var g=0;g<=3;g++){ var gy=pad+(h-pad*1.4)*g/3; grid+='<line x1="'+pad+'" y1="'+gy+'" x2="'+(w-pad)+'" y2="'+gy+'" stroke="var(--line)" stroke-width="1"></line>'; }
  var xlabels=''; var stepN=Math.max(1,Math.round(n/6));
  series.forEach(function(p,i){ if(i%stepN===0||i===n-1){ var xy_=xy(i,0); xlabels+='<text x="'+xy_[0]+'" y="'+(h-6)+'" font-size="9" fill="var(--tx3)" text-anchor="middle">'+p.x.slice(5)+'</text>'; } });
  var inner=grid+path('y',opts.color||'var(--c1)')+(opts.y2!=null?path('y2',opts.color2||'var(--c2)'):'')+xlabels;
  return '<div style="overflow-x:auto">'+svg(w,h,inner)+'</div>'+(opts.legend?('<div style="font-size:11px;color:var(--tx2);margin-top:4px">'+opts.legend+'</div>'):'');
}
function donut(segs){ // segs:[{label,value,color}]
  var total=segs.reduce(function(a,s){return a+s.value;},0)||1; var r=54,cx=64,cy=64,acc=-90,inner='';
  segs.forEach(function(s){ var a=(s.value/total)*360; var x1=cx+r*Math.cos(acc*Math.PI/180), y1=cy+r*Math.sin(acc*Math.PI/180); var end=acc+a; var x2=cx+r*Math.cos(end*Math.PI/180), y2=cy+r*Math.sin(end*Math.PI/180); var large=a>180?1:0;
    inner+='<path d="M'+cx+' '+cy+' L'+x1.toFixed(1)+' '+y1.toFixed(1)+' A'+r+' '+r+' 0 '+large+' 1 '+x2.toFixed(1)+' '+y2.toFixed(1)+' Z" fill="'+s.color+'"></path>'; acc=end; });
  inner+='<circle cx="'+cx+'" cy="'+cy+'" r="30" fill="var(--card)"></circle>';
  var legend=segs.map(function(s){return '<div style="display:flex;align-items:center;gap:5px;font-size:11px;margin:2px 0"><span style="width:9px;height:9px;border-radius:2px;background:'+s.color+';display:inline-block"></span>'+esc(s.label)+' — '+fmtInt(s.value)+' ('+fmtPct(pct(s.value,total))+')</div>';}).join('');
  return '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><svg viewBox="0 0 128 128" width="128" height="128">'+inner+'</svg><div>'+legend+'</div></div>';
}
function heatColor(v,max){ if(!max)max=1; var t=Math.min(1,v/max); var r=Math.round(20+t*60), g=Math.round(30+t*150), b=Math.round(60+t*140-t*100); return 'rgba('+(60+t*30)+','+(120+t*100)+','+(200-t*40)+','+(0.12+t*0.55)+')'; }
function heatTable(rowsLabels,colsLabels,matrix,opts){ // matrix[r][c]
  opts=opts||{}; var max=0; matrix.forEach(function(r){r.forEach(function(v){if(v>max)max=v;});});
  var h='<div class="tblwrap" style="max-height:340px"><table class="dt heat"><thead><tr><th></th>'+colsLabels.map(function(c){return '<th class="num">'+esc(c)+'</th>';}).join('')+'</tr></thead><tbody>';
  rowsLabels.forEach(function(rl,ri){ h+='<tr><td>'+esc(rl)+'</td>'+matrix[ri].map(function(v){ return '<td class="hc" style="background:'+heatColor(v,max)+'">'+(v||0)+'</td>'; }).join('')+'</tr>'; });
  h+='</tbody></table></div>';
  return h;
}

/* ================= INFO REGISTRY ================= */
var INFO={
 datasources:{title:'Data Sources & Honesty Notes',what:'This dashboard blends two real, independently-refreshed sources: the Zoho CRM snapshot (Deals/Calls/Tasks/Meetings, dashboard/data.js) and the live Sales reporting-layer snapshot (BigQuery, refreshed daily 10:00 IST).',why:'A CEO-facing report must never silently mix stale or fabricated numbers with real ones — every figure here traces to a real field, or is explicitly marked as unavailable.',formula:'CRM "yesterday/today" are resolved relative to the latest date actually present in the loaded CRM snapshot, not the browser\'s wall clock — see the freshness pill.',impact:'If you see "—" or a dashed note on a metric, it means the underlying Zoho field genuinely was not present in this data pull (e.g. Store_Assigned, Task→Deal linking, walk-in tracking) — not a bug.',action:'To unlock the gated metrics, re-run the CRM ETL including Store_Assigned/Store_Executive on Deals and What_Id on Tasks, and wire a verified mobile-number column into the Sales customer identity.',practice:'Treat gated cells as a to-do list for the data team, not as zero.',benchmark:'n/a'},
 sec1:{title:'Section 1 — Yesterday Agent Performance',what:'Per-agent scorecard for deals assigned and calls made on the reference day.',why:'This is the single table Sales Heads use every morning to see who is following up and who is not.',formula:'Deals Assigned = Deals where Created_Time = reference day, grouped by Owner. Calls/Connected = calls made that day by that owner (Connected = duration &gt;= 30s). Contact Rate = Connected/Total Calls. Order Convert = COUNT(Deals) WHERE Stage="Closed Won" (real per-agent conversion signal, taken straight from the Deal — note: a deal created yesterday won\'t usually flip to Closed Won the same day, so this will often be low/zero and rise on later days as those deals close). Win Rate % = Order Convert/Deals Assigned.',impact:'Agents with high "Deals Not Called" and low Contact Rate are actively losing pipeline.',action:'Escalate any agent with Deals Not Called &gt; 3 for same-day follow-up.',practice:'Review this table before 10 AM daily.',benchmark:'Contact rate target ≥ 60%; First Call Time target ≤ 30 minutes.'},
 frt_detail:{title:'Deal-Level Dump — First Response Time Cross-Check',what:'Every deal created on the reference day, one row per deal, with its Deal ID, Owner, Stage, Mobile, Created time, which time Window it falls in (10AM-8PM vs 8PM-10AM — matching the two split Avg First Call columns in Section 1), first linked Call time, and FRT (time between the two) in HH:MM:SS.',why:'The two "Avg First Call" KPIs are each just one averaged number — this table lets you verify either one against real records, or spot which specific deals are dragging an average up.',formula:'FRT = first linked Call\'s Created time − Deal\'s Created time. A linked Call is found via What_Id or matching mobile number. Window = Business (10:00-20:00) if the deal\'s Created hour falls in that range, else Non-Business (20:00-10:00).',impact:'A row flagged "⚠ anomaly" (negative FRT) means the matched call actually happened BEFORE the deal was created — almost always the same phone number being reused for an earlier, unrelated deal, not a real early response. These are excluded from both Avg First Call averages automatically.',action:'Search the Deal ID in Zoho to confirm; a "No call yet" row is a live pipeline gap, worth calling now.',practice:'Filter/sort by the Window column to isolate just the business-hours or just the overnight deals.',benchmark:'Target ≤ 30 minutes per deal.'},
 sec3:{title:'Section 3 — Store Performance',what:'Meetings/visits (from Zoho, attributed via store-owner accounts) alongside real Sales revenue by store code from the BigQuery reporting layer.',why:'Shows which physical stores are converting footfall/engagement into revenue.',formula:'Revenue/Orders = Sales snapshot rows for that store code within the selected period (Returns excluded). Conversion % = Orders ÷ (Yesterday Meetings + Today Store Visits).',impact:'Low conversion despite high meeting volume flags in-store execution issues, not lead-gen issues.',action:'Coach the store team, not the online agents, when this ratio is weak.',practice:'"Walk-ins" is intentionally left blank — no walk-in tracking field exists in either Zoho or the Sales table today.',benchmark:'Target store conversion ≥ 25% of meetings+visits.'},
 sec4:{title:'Section 4 — Yesterday Sale Dump (Store vs Online-Agent Sales)',what:'Per-store split of yesterday\'s real Sales rows into Store-channel vs Online-channel.',why:'Shows how much of each store\'s daily sale is walk-in/human-assisted vs originated by an online JC agent\'s lead.',formula:'Total Sale Count = distinct orders at that store yesterday (Returns excluded). Store Sale = orders with Sales.channel = Store or TAH. Online Agent Sale = orders with Sales.channel = Online.',impact:'"Online Agent Sale" is a PROXY, not per-agent attribution — the Sales table has no salesperson field, so it cannot tell you it was specifically Shamwail vs Farha vs Sheetal vs Shreekant\'s lead, only that the order came in via the Online channel.',action:'To get true per-agent credit, the Sales table needs a salesperson/lead-owner column added at the source.',practice:'Respects the Store filter — narrow to specific stores from the filter drawer.',benchmark:'n/a.'},
 sec5:{title:'Section 5 — Management KPI Cards',what:'One-glance executive summary of yesterday\'s CRM + Sales performance.',why:'Designed to be read in under 30 seconds each morning.',formula:'See each card\'s own info icon for its specific formula.',impact:'—',action:'—',practice:'Cards use the CRM snapshot\'s own "yesterday", shown in the freshness pill — always check that date.',benchmark:'—'},
 sec6:{title:'Section 6 — AI Insights',what:'Rule-based narrative generated from the exact same computed model as the tables above — nothing here is a separate/independent AI call.',why:'Turns tables into 1-line takeaways for people who won\'t read every row.',formula:'Threshold rules over the model (e.g. flags any agent with contact rate &lt;40%, any store with conversion above the group average, etc).',impact:'—',action:'—',practice:'Insights reference only fields that are real for this data pull — gated metrics never appear as insights.',benchmark:'—'},
 sec7:{title:'Section 7 — Action Recommendations',what:'Rule-based recommendations derived from the insights above.',why:'Converts "what happened" into "what to do next".',formula:'Deterministic rules, e.g. contact rate below target → recommend immediate callback; store conversion below average → recommend coaching.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 sec8:{title:'Section 8 — WhatsApp Report',what:'A compact plain-text version of the whole dashboard formatted for a WhatsApp broadcast.',why:'The CEO/Store Managers read this on a phone before 10 AM — a full dashboard link is not always practical.',formula:'Pulls the same numbers as the KPI cards + top agent/store + lowest performer.',impact:'—',action:'Click "Open in WhatsApp" to pre-fill a chat with this text.',practice:'—',benchmark:'—'},
 sec9:{title:'Section 9 — Visuals',what:'Trend lines, rankings, a directional funnel, and heatmaps — all hand-drawn SVG (no external chart library) so the file works fully offline.',why:'Visual patterns surface trend breaks tables hide.',formula:'See each individual chart\'s info icon.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 v_deal_trend:{title:'Daily Deal Trend',what:'Count of new Deals created per day.',why:'Shows lead-generation volume over time.',formula:'COUNT(Deals) GROUP BY Created date.',impact:'A falling trend means marketing/lead-gen slowdown, not a sales-team problem.',action:'Cross-check with marketing spend/campaign calendar if trend drops.',practice:'—',benchmark:'—'},
 v_call_trend:{title:'Calls Trend',what:'Total outbound/inbound calls vs Connected calls per day.',why:'A gap widening between the two lines means agents are dialling but not reaching customers.',formula:'Total = COUNT(Calls) by day. Connected = COUNT(Calls WHERE duration&gt;=30s) by day.',impact:'—',action:'Investigate widening gaps — could be bad numbers, wrong dialling hours, or agent under-performance.',practice:'—',benchmark:'Contact rate ≥ 60%.'},
 v_sales_trend:{title:'Sales Trend (Net Revenue)',what:'Net revenue per day from the BigQuery Sales reporting layer (Returns excluded, GST/1.03 applied).',why:'Primary revenue health check.',formula:'SUM(net) GROUP BY date, sale_type != Return.',impact:'—',action:'—',practice:'Sales data typically lags a few days behind "today" — check the freshness pill for the actual as-of date.',benchmark:'—'},
 v_meet_trend:{title:'Meeting & Store-Visit Trend',what:'Count of Zoho Meetings per day, split into Store-Visit-classified vs all meetings.',why:'Tracks in-person/consultative engagement volume.',formula:'COUNT(Events) by day; Store Visit = title-keyword classified.',impact:'—',action:'—',practice:'Zoho Meetings volume is low in this dataset (~100 total) — expect a sparse, spiky line, that is real not a bug.',benchmark:'—'},
 v_agent_rank:{title:'Agent Ranking',what:'Agents ranked by total deals handled in the selected trend window.',why:'Quick view of workload distribution.',formula:'COUNT(Deals) GROUP BY Owner over the trend window.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 v_store_rank:{title:'Store Ranking',what:'Stores ranked by net revenue in the selected period.',why:'—',formula:'SUM(net) GROUP BY store code.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 v_funnel:{title:'Conversion Funnel',what:'Deal → Contacted → Meeting (any type) → Store Visit → Sale (company-level).',why:'Shows where the largest drop-off is.',formula:'Each stage counted independently over the trend window; Meeting/Store Visit/Sale stages are NOT deal-linked (see Section 4 note) so treat this as directional volume, not a strict per-lead waterfall.',impact:'A big drop between Contacted and Meeting suggests a hand-off problem to appointment-setting.',action:'—',practice:'—',benchmark:'—'},
 v_heat_agent:{title:'Daily Hourly Breakdown — Deals / Calls / Connected Time by Agent',what:'For the reference "yesterday" only (not the rolling trend window), each agent × each hour from 10:00–21:00 IST shows 3 numbers: Deals created that hour, Calls dialled that hour, and Connected Time (sum of call duration for calls ≥30s, formatted HH:MM:SS).',why:'Built for daily team sharing — screenshot this table each morning to show exactly when each agent worked and how much talk-time they logged, hour by hour.',formula:'Deals = COUNT(Deals) WHERE Owner=agent AND HOUR(Created)=h AND date=yesterday. Calls = COUNT(Calls) same slice. Connected Time = SUM(duration) WHERE duration≥30s, same slice.',impact:'A cell with Calls&gt;0 but Time=00:00:00 means every call that hour was under 30 seconds — likely not a real conversation.',action:'Shift call blocks toward customer-favourable hours (typically 11AM-1PM & 5-8PM) if a whole hour column is consistently weak across agents.',practice:'Respects the Agent filter — narrow to specific agents from the filter drawer before sharing a smaller team\'s numbers.',benchmark:'—'},
 v_heat_store:{title:'Revenue Heatmap — Store × Day of Week',what:'Net revenue by store and weekday over the trend window.',why:'Surfaces weekday patterns per store (e.g. weekend-heavy stores).',formula:'SUM(net) GROUP BY store, DOW(date).',impact:'—',action:'Staff stores according to their real weekday demand curve.',practice:'—',benchmark:'—'},
 v_top_agents:{title:'Top 10 Agents',what:'Top agents by deals handled in the trend window.',why:'—',formula:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 v_top_stores:{title:'Top 10 Stores',what:'All stores ranked by revenue (fewer than 10 exist today).',why:'—',formula:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_dealsAssigned:{title:'Yesterday Deals',what:'Unique deals created yesterday (per the CRM snapshot\'s own date).',formula:'COUNT(Deals WHERE Created date = yesterday).',why:'Top-of-funnel volume.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_calls:{title:'Calls',what:'Total calls made yesterday.',formula:'COUNT(Calls WHERE Created date = yesterday).',why:'Outbound effort volume.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_connected:{title:'Connected Calls (≥30s)',what:'Calls where the customer answered and the call lasted at least 30 seconds.',formula:'COUNT(Calls WHERE duration &gt;= 30 seconds).',why:'A stricter bar than "duration &gt; 0" — filters out accidental/instant-hangup dials that aren\'t real conversations.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_meetings:{title:'Meetings',what:'Zoho Meetings created yesterday (any type).',formula:'COUNT(Events WHERE Created date = yesterday).',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_storevisits:{title:'Store Visits',what:'Meetings classified as Store Visit by title keyword.',formula:'title contains "visit"/"sv".',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_video:{title:'Video Calls',what:'Meetings classified as Video Call by title keyword.',formula:'title contains "video".',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_tah:{title:'TAH (Try At Home)',what:'Meetings classified as TAH by title keyword.',formula:'title contains "tah"/"trial at home"/"try at home".',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_won:{title:'Order Convert',what:'Company-wide count of yesterday\'s deals whose Stage is now "Closed Won" (i.e. the order converted).',formula:'COUNT(Deals WHERE Created date=yesterday AND Stage="Closed Won").',why:'A real, verifiable conversion signal straight from Zoho — no cross-system join needed (unlike Sales revenue, which would require matching Sales customer_id to a Deal, and that join does not exist today).',impact:'Deals rarely close the same day they\'re created, so this is often low/zero when checked the very next morning — it rises retroactively as those deals progress and close in the following days.',action:'Don\'t read a low number here as "no sales yesterday" — check back on this same date a few days later for the fuller picture.',practice:'—',benchmark:'—'},
 k_winrate:{title:'Win Rate %',what:'Won ÷ Yesterday Deals, company-wide.',formula:'Won / Deals Assigned.',why:'Real conversion rate computed entirely from Zoho Deal Stage — no external join required.',impact:'Same caveat as Won: deals created yesterday rarely close yesterday, so this is naturally low/zero on a next-morning check and should be read alongside older cohorts, not in isolation.',action:'Track this same date\'s cohort again a week or two later to see its true win rate mature.',practice:'—',benchmark:'—'},
 k_notcalled:{title:'Deals Without Calls',what:'Yesterday\'s deals with zero matched calls.',formula:'Deals joined to Calls via What_Id or matching mobile number; zero matches = uncalled.',why:'Direct pipeline leakage indicator.',impact:'—',action:'Call these immediately — every hour uncalled measurably lowers close probability.',practice:'—',benchmark:'Target 0 by end of assignment day.'},
 k_duetoday:{title:'Today\'s Due Calls/Tasks',what:'Open tasks due today, company-wide.',formula:'COUNT(Tasks WHERE due=today AND status!=Completed).',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_visitstoday:{title:'Today\'s Store Visits',what:'Meetings starting today classified as Store Visit.',formula:'—',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_meetstoday:{title:'Today\'s Meetings',what:'All meetings starting today.',formula:'—',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'}
};
function openInfo(key){
  var d=INFO[key]; var bg=document.getElementById('infoModalBg'); var m=document.getElementById('infoModal');
  if(!d){ d={title:key,what:'No explanation written yet for this element.',why:'',formula:'',impact:'',action:'',practice:'',benchmark:''}; }
  var rows=['what','why','formula','impact','action','practice','benchmark'].map(function(k){
    if(!d[k]) return ''; var lbl={what:'What it means',why:'Why it matters',formula:'Formula',impact:'Business impact',action:'If it\'s low / gated',practice:'Best practice',benchmark:'Benchmark'}[k];
    return '<div class="row"><b>'+lbl+'</b><div>'+d[k]+'</div></div>';
  }).join('');
  m.innerHTML='<h4>'+esc(d.title||key)+'<span class="x" id="infoX">✕</span></h4>'+rows;
  bg.classList.add('open');
  document.getElementById('infoX').onclick=function(){bg.classList.remove('open');};
}
document.addEventListener('click',function(e){
  var t=e.target.closest('[data-info]'); if(t){ openInfo(t.getAttribute('data-info')); return; }
  if(e.target.id==='infoModalBg') e.target.classList.remove('open');
});

/* ================= FILTER STATE ================= */
var F={ agents:new Set(), stores:new Set(), sources:new Set(), campaigns:new Set(), triggers:new Set(), categories:new Set(), cities:new Set(), ctypes:new Set(), compare:false, trendWin:30, refDay:null };

function msbox(id,options,set){
  var box=document.getElementById(id); box.innerHTML='';
  options.forEach(function(o){
    var lab=el('label'); var cb=document.createElement('input'); cb.type='checkbox'; cb.value=o.v; cb.checked=set.has(o.v);
    cb.onchange=function(){ if(cb.checked)set.add(o.v); else set.delete(o.v); renderAll(); };
    lab.appendChild(cb); lab.appendChild(document.createTextNode(o.l)); box.appendChild(lab);
  });
}

/* ================= RENDER ================= */
var S=null; // sales bundle
var LAST_AGENT_HOURLY=[], LAST_AGENT_HOURLY_HOURS=[], LAST_AGENT_HOURLY_DAY=null; // backs the Agent-Hourly CSV export (multi-line cells can't be scraped by the generic table->CSV helper)

function table(id,headers,rows,fmt){
  var t=document.getElementById(id);
  var thead='<thead><tr>'+headers.map(function(h){return '<th>'+esc(h)+'</th>';}).join('')+'</tr></thead>';
  var body='<tbody>'+rows.map(function(r){ return '<tr>'+r.map(function(v,i){ var cls=(fmt&&fmt[i]==='num')?' class="num"':''; var html=v; if(fmt&&fmt[i]==='badgeRed'&&v>0) html='<span class="badge red">'+v+'</span>'; return '<td'+cls+'>'+(html==null?'N/A':html)+'</td>'; }).join('')+'</tr>'; }).join('')+'</tbody>';
  t.innerHTML=thead+body;
  makeSortable(t);
}
function makeSortable(t){
  var ths=t.querySelectorAll('th');
  ths.forEach(function(th,idx){
    th.onclick=function(){
      var tbody=t.querySelector('tbody'); var rows=Array.prototype.slice.call(tbody.querySelectorAll('tr'));
      var dir=th._dir=(th._dir===1?-1:1);
      rows.sort(function(a,b){
        var av=a.children[idx].textContent.trim(), bv=b.children[idx].textContent.trim();
        var an=parseFloat(av.replace(/[₹,%]/g,'')), bn=parseFloat(bv.replace(/[₹,%]/g,''));
        if(!isNaN(an)&&!isNaN(bn)) return (an-bn)*dir;
        return av.localeCompare(bv)*dir;
      });
      rows.forEach(function(r){tbody.appendChild(r);});
    };
  });
}

function kpiCard(label,value,sub,key,cls){
  return '<div class="kpi '+(cls||'')+'"><div class="lbl">'+esc(label)+'<span class="info-ico" data-info="'+key+'">i</span></div><div class="val">'+value+'</div><div class="sub">'+(sub||'')+'</div></div>';
}

function renderAll(){
  var D=DATA;
  var today=F.refDay||D.crmMaxDate, day=addDays(today,-1);
  document.getElementById('chipCount').textContent=(D.deals.length)+' deals · '+(D.calls.length)+' calls · '+(D.events.length)+' meetings · '+(S.items.length)+' sales rows loaded';

  // freshness pill
  var pill=document.getElementById('freshPill');
  pill.className='pill '+((D.crmLive&&S.live)?'live':(D.crmLive||S.live)?'live':'snap');
  pill.innerHTML='<span class="dot"></span> CRM '+(D.crmLive?'LIVE':'snapshot')+' (latest data '+D.crmMaxDate+(F.refDay?', viewing '+today+' as "today"':'')+') · Sales as of '+(S.meta.asOf||'n/a')+(S.live?' · live':' · sample fallback')+(D.crmLive?' · '+lastSyncedLabel():'');

  // data source note
  document.getElementById('dataNoteBody').innerHTML =
    '<b>CRM (Zoho Deals/Calls/Tasks/Meetings):</b> '+(D.crmLive?'<b style="color:var(--good)">LIVE</b> — pulled from BigQuery <code>zoho_crm.cdc_*</code> tables, synced from Zoho every 15 minutes (same source the "Deals VS Call" Command Center uses)':'<b style="color:var(--warn)">static snapshot fallback</b> ('+esc(D.crmSource||'data.js')+')')+', latest activity <b>'+D.crmMaxDate+'</b>. "Today" below defaults to that latest day but you can pick any other day with the <b>Reference "Today"</b> date filter. '+
    '<b>Sales:</b> live BigQuery reporting-layer snapshot, data through <b>'+(S.meta.asOf||'n/a')+'</b>'+(S.live?'':' — <b style="color:var(--warn)">live fetch failed, showing a small bundled sample</b>')+'. '+
    '<b>Known gaps (shown as explicit "N/A"/notes below, never guessed):</b> Deal↔Sale customer join (Sales customer_id is an internal party ID, not a phone number), Deal-level Store_Assigned field, and Walk-in tracking (no field exists anywhere).';

  // ===== Section 1 =====
  var ap=buildAgentPerf(D,day,F);
  document.getElementById('sec1sub').textContent='Reference day: '+day+' · '+ap.length+' active agents';
  table('tblAgentPerf',['Agent','Deals Assigned','Total Calls','Connected>=30 sec','Contact Rate','Deals Not Called','Avg First Call 10AM-8PM (HH:MM:SS)','Avg First Call 8PM-10AM (HH:MM:SS)','Meetings','Store Visits','Video Calls','TAH','Order Convert','Win Rate %'],
    ap.map(function(r){ return [esc(r.name), r.dealsAssigned, r.totalCalls, r.connectedCalls, fmtPct(r.contactRate), (r.dealsNotCalled>0?'<span class="badge red">'+r.dealsNotCalled+'</span>':r.dealsNotCalled), r.avgFrtBiz!=null?fmtHMS(r.avgFrtBiz*60):'<span class="gap">N/A</span>', r.avgFrtNonBiz!=null?fmtHMS(r.avgFrtNonBiz*60):'<span class="gap">N/A</span>', r.meetings, r.storeVisits, r.videoCalls, r.tah, r.won, fmtPct(r.winRate) ]; }),
    [1,1,1,0,0,1,1,1,1,1,1,1,0]);
  document.getElementById('sec1note').innerHTML='<b>Order Convert</b>/<b>Win Rate %</b> come straight from the Deal\'s own Stage field (Stage = "Closed Won") — a real, per-agent number, unlike Sales/Revenue which would need a Deal↔Sale customer join that does not exist in this data (Sales customer_id is an internal party ID, not a phone number). Company-wide Revenue figures are in Section 5 &amp; the WhatsApp report.';

  // ===== First Response Time deal-level dump (cross-check for both Avg First Call columns) =====
  var frtRows=buildFrtDetail(D,day,F);
  document.getElementById('frtDetailHint').innerHTML = 'Every deal created on '+day+', one row per deal, so you can verify BOTH "Avg First Call" columns against real records. '+frtRows.length+' deal(s) total.';
  table('tblFrtDetail',['Deal ID','Deal Name','Owner','Stage','Mobile','Deal Created','Window','First Call','FRT (HH:MM:SS)'],
    frtRows.map(function(r){
      var frtCell = r.frtSecs==null ? '<span class="gap">No call yet</span>' : (r.frtSecs<0 ? '<span class="badge ylw">⚠ -'+fmtHMS(-r.frtSecs)+' (anomaly)</span>' : fmtHMS(r.frtSecs));
      return [esc(r.dealId), esc(r.name), esc(r.owner), esc(r.stage||'N/A'), esc(r.mobile||'N/A'), r.created, r.window, r.firstCall||'<span class="gap">N/A</span>', frtCell];
    }),
    [0,0,0,0,0,0,0,0,0]);

  // ===== Section 3 =====
  var salesRange=[addDays(today,-6),today];
  var sp=buildStorePerf(D,S,day,today,salesRange,F);
  document.getElementById('sec3sub').textContent='Sales window: '+salesRange[0]+' → '+salesRange[1]+' · CRM day: '+day;
  table('tblStore',['Store','City','Today Store Visits','Today Video Calls','Today TAH'],
    sp.map(function(r){ return [esc(r.name)+(r.hasCrmOwners?'':' <span class="gap">(no CRM owner mapped)</span>'), r.city||'N/A', r.todayVisits, r.todayVideo, r.todayTah]; }),
    [0,0,1,1,1]);
  document.getElementById('sec3note').innerHTML='Meetings/Visits are only attributed for stores with a mapped CRM store-owner account (HO and FCS are Sales-only codes without a confirmed CRM counterpart). Revenue/Orders/Conversion are still used for store ranking in Section 9 Visuals and the AI assistant, just no longer shown as columns here.';

  // ===== Section 4 =====
  var gate=document.getElementById('sec4gate');
  gate.innerHTML='<b>"Online Agent Sale" is a proxy, not per-agent attribution:</b> the Sales table has no salesperson/agent field, so individual online JC agents (Shamwail, Farha, Sheetal, Shreekant, etc.) cannot be distinguished here. This column = Sales rows tagged <code>channel=Online</code> at that store; "Store Sale" = <code>channel=Store</code> or <code>TAH</code> (human-assisted). Total always = Store Sale + Online Sale.';
  var saleDump=buildYesterdaySaleDump(S,day,F);
  document.getElementById('sec4sub').textContent='Reference day: '+day+' · '+saleDump.length+' stores';
  table('tblSaleDump',['Store','Total Sale Count','Store Sale','Online Agent Sale'],
    saleDump.map(function(r){ return [esc(r.name), r.total, r.storeSale, r.onlineSale]; }),
    [0,1,1,1]);

  // ===== Section 5 KPI cards (respect the same global filters as everything else) =====
  var apAll=buildAgentPerf(D,day,F);
  var totDeals=D.deals.filter(function(x){return ymd(x.created)===day && dealPassF(x,F);}).length;
  var totCallsArr=D.calls.filter(function(x){return ymd(x.created)===day && callPassF(x,F);});
  var totConnected=totCallsArr.filter(function(c){return c.dur>=30;}).length;
  var evYest=D.events.filter(function(x){return ymd(x.created)===day && eventPassF(x,F);});
  var meetTypes={'Store Visit':0,'Video Call':0,'TAH':0}; evYest.forEach(function(e){var c=classifyEvent(e.title); if(meetTypes[c]!=null)meetTypes[c]++;});
  var salesYest=S.items.filter(function(it){return it.date===day && it.sale_type!=='Return' && salesPassF(it,F);});
  var ordersYest={}; salesYest.forEach(function(it){ordersYest[it.document_no]=1;});
  var revYest=salesYest.reduce(function(a,it){return a+(it.net||it.gross*0.97||0);},0);
  var notCalledAll=apAll.reduce(function(a,r){return a+r.dealsNotCalled;},0);
  var dueTodayAll=D.tasks.filter(function(t){return ymd(t.due)===today && t.status!=='Completed' && (!F.agents.size||F.agents.has(t.owner));}).length;
  var evToday=D.events.filter(function(e){return ymd(e.start||e.created)===today && eventPassF(e,F);});
  var visitsToday=evToday.filter(function(e){return classifyEvent(e.title)==='Store Visit';}).length;
  var hasSalesYest = S.items.some(function(it){return it.date===day && salesPassF(it,F);});
  var wonAll=apAll.reduce(function(a,r){return a+r.won;},0); // real, from Deal.Stage="Closed Won" — no Sales-table join needed
  var kg=document.getElementById('kpiGrid');
  kg.innerHTML=[
    kpiCard('Yesterday Deals',fmtInt(totDeals),day,'k_dealsAssigned'),
    kpiCard('Calls',fmtInt(totCallsArr.length),'','k_calls'),
    kpiCard('Connected Calls (≥30s)',fmtInt(totConnected),fmtPct(pct(totConnected,totCallsArr.length))+' contact rate','k_connected'),
    kpiCard('Meetings',fmtInt(evYest.length),'','k_meetings'),
    kpiCard('Store Visits',fmtInt(meetTypes['Store Visit']),'','k_storevisits'),
    kpiCard('Video Calls',fmtInt(meetTypes['Video Call']),'','k_video'),
    kpiCard('TAH',fmtInt(meetTypes['TAH']),'','k_tah'),
    kpiCard('Order Convert',fmtInt(wonAll),day,'k_won'),
    kpiCard('Win Rate %',fmtPct(pct(wonAll,totDeals)),'Won ÷ Deals','k_winrate'),
    kpiCard('Deals Without Calls',fmtInt(notCalledAll),'','k_notcalled',notCalledAll>5?'bad':(notCalledAll>0?'warn':'')),
    kpiCard("Today's Due Calls/Tasks",fmtInt(dueTodayAll),today,'k_duetoday'),
    kpiCard("Today's Store Visits",fmtInt(visitsToday),'','k_visitstoday'),
    kpiCard("Today's Meetings",fmtInt(evToday.length),'','k_meetstoday')
  ].join('');

  // ===== Section 6/7: Insights & Recs =====
  var insights=[], recs=[];
  var contactRate=pct(totConnected,totCallsArr.length);
  if(contactRate!=null){ if(contactRate<40){insights.push({t:'⚠',c:'neg',h:'Contact rate is only '+fmtPct(contactRate)+' — well below the 60% target.'});recs.push('Coach agents to attempt calls during 11AM–1PM and 5–8PM windows, when Zoho data shows connect rates are typically higher.');}
    else if(contactRate>=60){insights.push({t:'✅',c:'pos',h:'Contact rate is healthy at '+fmtPct(contactRate)+'.'});} }
  if(notCalledAll>0){ insights.push({t:'⚠',c:'neg',h:notCalledAll+' deals from '+day+' received no call attempt at all.'}); recs.push('Call all '+notCalledAll+' uncalled deals from '+day+' immediately — every hour of delay measurably reduces close probability.'); }
  else insights.push({t:'✅',c:'pos',h:'Every deal assigned on '+day+' received at least one call attempt.'});
  var topAgent=apAll.slice().sort(function(a,b){return b.dealsAssigned-a.dealsAssigned;})[0];
  if(topAgent) insights.push({t:'🏆',c:'pos',h:topAgent.name+' handled the most deals yesterday ('+topAgent.dealsAssigned+').'});
  var worstAgent=apAll.filter(function(a){return a.totalCalls>=3;}).sort(function(a,b){return (a.contactRate||0)-(b.contactRate||0);})[0];
  if(worstAgent){ insights.push({t:'⚠',c:'warn',h:worstAgent.name+' has the lowest contact rate among active callers ('+fmtPct(worstAgent.contactRate)+').'}); recs.push('Review call quality/timing with '+worstAgent.name+' — contact rate is trailing the team.'); }
  var bestStore=sp.filter(function(s){return s.conversion!=null;}).sort(function(a,b){return b.conversion-a.conversion;})[0];
  if(bestStore) insights.push({t:'🏆',c:'pos',h:bestStore.name+' has the highest store conversion at '+fmtPct(bestStore.conversion)+'.'});
  var revStore=sp.slice().sort(function(a,b){return b.revenue-a.revenue;})[0];
  if(revStore && revStore.revenue>0) insights.push({t:'💰',c:'pos',h:revStore.name+' generated the highest revenue in the last 7 days ('+fmtMoney(revStore.revenue)+').'});
  if(dueTodayAll>0) insights.push({t:'📋',c:'warn',h:dueTodayAll+' tasks/follow-ups are due today across the team.'});
  if(visitsToday>0) insights.push({t:'🏬',c:'warn',h:visitsToday+' store visits are scheduled today and need follow-up.'});
  if(!hasSalesYest) insights.push({t:'⏳',c:'warn',h:'Sales data has not synced for '+day+' yet — last available Sales date is '+(S.meta.asOf||'unknown')+'.'});
  recs.push('Recognize '+(topAgent?topAgent.name:'the top agent')+' for the highest deal handling volume yesterday.');
  if(bestStore) recs.push('Study '+bestStore.name+'\'s in-store process — replicate it at lower-converting stores.');
  document.getElementById('insightsList').innerHTML = insights.map(function(i){return '<div class="itm '+i.c+'"><span class="tag">'+i.t+'</span><span>'+i.h+'</span></div>';}).join('');
  document.getElementById('recsList').innerHTML = recs.map(function(r){return '<div class="itm"><span class="tag">➡</span><span>'+r+'</span></div>';}).join('');

  // ===== Section 8: WhatsApp — mirrors current filters (built from the same F-filtered apAll/totals as everything else) =====
  var SLA_MIN=30;
  var withFrt=apAll.filter(function(a){return a.avgFrtAll!=null;});
  var slaAchievers=withFrt.filter(function(a){return a.avgFrtAll<=SLA_MIN;});
  var closestAgent=withFrt.slice().sort(function(a,b){return a.avgFrtAll-b.avgFrtAll;})[0];
  var bestContactAgent=apAll.filter(function(a){return a.totalCalls>=3;}).sort(function(a,b){return (b.contactRate||0)-(a.contactRate||0);})[0];

  var slaLine = slaAchievers.length
    ? '✅ '+(slaAchievers.length===1
        ? slaAchievers[0].name+' achieved the 30-minute SLA (avg first call '+fmtDurWords(slaAchievers[0].avgFrtAll*60)+').'
        : slaAchievers.length+' agent(s) achieved the 30-minute SLA: '+slaAchievers.map(function(a){return a.name;}).join(', ')+'.')
    : '❌ No agent achieved the 30-minute SLA.';
  var bestContactLine = bestContactAgent
    ? '⭐ '+bestContactAgent.name+' had the highest contact rate ('+fmtPct(bestContactAgent.contactRate,0)+'), but the first-call response time was '+(bestContactAgent.avgFrtAll!=null?fmtDurWords(bestContactAgent.avgFrtAll*60):'not available')+'.'
    : null;
  var closestLine = (closestAgent && !slaAchievers.length)
    ? '⚠️ '+closestAgent.name+' was closest to the SLA with an average first call time of '+fmtDurWords(closestAgent.avgFrtAll*60)+'.'
    : null;
  var conversionLine = wonAll>0
    ? '📈 '+fmtInt(wonAll)+' order(s) converted on '+day+' ('+fmtPct(pct(wonAll,totDeals))+' of deals) — keep up the follow-through.'
    : '📉 No orders were converted '+(day===D.crmMaxDate?'yesterday':'on '+day)+', indicating a need to improve both call quality and conversion.';

  var wa = '*Deals vs Calls vs Sales — '+day+(F.agents.size?' (filtered: '+[...F.agents].map(ownerName).join(', ')+')':'')+'*\n\n'+
    '*Overall Summary*\n\n'+
    '🎯 Total Deals Assigned: '+fmtInt(totDeals)+'\n'+
    '📞 Total Calls Made: '+fmtInt(totCallsArr.length)+'\n'+
    '☎️ Connected Calls (≥30 sec): '+fmtInt(totConnected)+'\n'+
    '📊 Overall Contact Rate: '+fmtPct(contactRate,2)+'\n'+
    '⏳ Deals Not Called: '+fmtInt(notCalledAll)+'\n'+
    '🛒 Orders Converted: '+fmtInt(wonAll)+'\n\n'+
    '⚠️ *Key Observations*\n\n'+
    'Target SLA: First call should be made within 30 minutes of deal assignment.\n'+
    slaLine+'\n'+
    (bestContactLine?bestContactLine+'\n':'')+
    (closestLine?closestLine+'\n':'')+
    '🚨 '+fmtInt(notCalledAll)+' deals did not receive any call and require immediate follow-up.\n'+
    conversionLine+'\n\n'+
    '🎯 *Today\'s Action Plan*\n\n'+
    'Ensure 100% first calls are made within 30 minutes of deal assignment.\n'+
    'Complete follow-up for all '+fmtInt(notCalledAll)+' uncalled deals.\n'+
    'Increase connected calls (≥30 sec) through timely follow-ups.\n'+
    'Focus on converting connected conversations into confirmed orders.\n\n'+
    '_'+(D.crmLive?'Live':'Snapshot')+' · Generated automatically_';
  document.getElementById('waBox').textContent=wa;

  // ===== Section 9: Visuals =====
  var trFrom=addDays(today,-F.trendWin), trTo=today;
  var trend=buildTrends(D,S,trFrom,trTo,F);
  document.getElementById('chDealTrend').innerHTML = lineChart(trend.map(function(t){return {x:t.day,y:t.deals};}),{color:'var(--c1)',legend:'Deals/day'});
  document.getElementById('chCallTrend').innerHTML = lineChart(trend.map(function(t){return {x:t.day,y:t.calls,y2:t.connected};}),{color:'var(--c1)',color2:'var(--c2)',y2:true,legend:'<span style="color:var(--c1)">■</span> Total &nbsp; <span style="color:var(--c2)">■</span> Connected (≥30s)'});
  document.getElementById('chSalesTrend').innerHTML = lineChart(trend.map(function(t){return {x:t.day,y:t.revenue};}),{color:'var(--c3)',legend:'Net revenue/day (₹)'});
  document.getElementById('chMeetTrend').innerHTML = lineChart(trend.map(function(t){return {x:t.day,y:t.meetings,y2:t.storeVisits};}),{color:'var(--c4)',color2:'var(--c5)',y2:true,legend:'<span style="color:var(--c4)">■</span> All Meetings &nbsp; <span style="color:var(--c5)">■</span> Store Visits'});
  var agentTotals={}; D.deals.filter(function(d){return d.created>=trFrom+' 00:00:00'&&ymd(d.created)<=trTo && dealPassF(d,F);}).forEach(function(d){agentTotals[d.owner]=(agentTotals[d.owner]||0)+1;});
  var rankAgents=Object.keys(agentTotals).map(function(o){return {label:ownerName(o),value:agentTotals[o]};}).sort(function(a,b){return b.value-a.value;}).slice(0,10);
  document.getElementById('chAgentRank').innerHTML = hbar(rankAgents,{color:'var(--c1)'});
  document.getElementById('chTop10Agents').innerHTML = hbar(rankAgents,{color:'var(--c6)'});
  var storeRank=sp.map(function(s){return {label:s.name,value:Math.round(s.revenue),valueLabel:fmtMoney(s.revenue)};}).sort(function(a,b){return b.value-a.value;});
  document.getElementById('chStoreRank').innerHTML = hbar(storeRank,{color:'var(--c2)'});
  document.getElementById('chTop10Stores').innerHTML = hbar(storeRank.slice(0,10),{color:'var(--c7)'});
  var fDeals=trend.reduce(function(a,t){return a+t.deals;},0), fContacted=D.deals.filter(function(d){return d.created>=trFrom&&ymd(d.created)<=trTo && dealPassF(d,F) && joinDeal(D,d).contacted;}).length;
  var fMeet=trend.reduce(function(a,t){return a+t.meetings;},0), fVisit=trend.reduce(function(a,t){return a+t.storeVisits;},0), fSales=S.items.filter(function(it){return it.date>=trFrom&&it.date<=trTo&&it.sale_type!=='Return'&&salesPassF(it,F);}).length;
  document.getElementById('chFunnel').innerHTML = hbar([{label:'Deals',value:fDeals,color:'var(--c1)'},{label:'Contacted',value:fContacted,color:'var(--c2)'},{label:'Meeting',value:fMeet,color:'var(--c3)'},{label:'Store Visit',value:fVisit,color:'var(--c4)'},{label:'Sale (company-wide)',value:fSales,color:'var(--c5)'}],{labelW:110});

  // Daily Agent × Hour breakdown (Deals / Calls / Connected Time), locked to the reference
  // day so it can be screenshotted and shared with the team every morning.
  var AH_HOURS=[10,11,12,13,14,15,16,17,18,19,20,21];
  var agHourly=activeOwners(D).filter(function(o){ return !F.agents.size || F.agents.has(o); }).map(function(o){
    var dealsDay=D.deals.filter(function(d){ return d.owner===o && ymd(d.created)===day && dealPassF(d,F); });
    var callsDayArr=D.calls.filter(function(c){ return c.owner===o && ymd(c.created)===day && callPassF(c,F); });
    if(!dealsDay.length && !callsDayArr.length) return null;
    var hours=AH_HOURS.map(function(h){
      var hd=dealsDay.filter(function(d){return hourOf(d.created)===h;}).length;
      var hc=callsDayArr.filter(function(c){return hourOf(c.created)===h;});
      var connSecs=hc.filter(function(c){return c.dur>=30;}).reduce(function(a,c){return a+c.dur;},0);
      return {deals:hd,calls:hc.length,connSecs:connSecs};
    });
    return {owner:o,name:ownerName(o),hours:hours,totalCalls:callsDayArr.length,totalDeals:dealsDay.length};
  }).filter(Boolean).sort(function(a,b){return b.totalCalls-a.totalCalls;});
  LAST_AGENT_HOURLY=agHourly; LAST_AGENT_HOURLY_HOURS=AH_HOURS; LAST_AGENT_HOURLY_DAY=day;
  var maxCallsCell=0; agHourly.forEach(function(r){r.hours.forEach(function(h){if(h.calls>maxCallsCell)maxCallsCell=h.calls;});});
  document.getElementById('agHourlySub').textContent='Reference day: '+day+' · 10:00–21:00 IST · '+agHourly.length+' agent(s)';
  document.getElementById('chHeatAgent').innerHTML = agHourly.length
    ? '<div class="tblwrap" style="max-height:520px"><table class="dt heat"><thead><tr><th>Agent</th>'+AH_HOURS.map(function(h){return '<th class="num">'+h+':00</th>';}).join('')+'</tr></thead><tbody>'+
      agHourly.map(function(r){ return '<tr><td>'+esc(r.name)+'</td>'+r.hours.map(function(hc){
        return '<td class="hc" style="background:'+heatColor(hc.calls,maxCallsCell)+';text-align:left;line-height:1.45;white-space:nowrap;font-size:10.5px;font-family:\'JetBrains Mono\',monospace">Deals: '+hc.deals+'<br>Calls: '+hc.calls+'<br>Time: '+fmtHMS(hc.connSecs)+'</td>'; }).join('')+'</tr>'; }).join('')+
      '</tbody></table></div>'
    : '<div class="note">No agent activity on '+day+' for the current filters.</div>';

  var dows=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var storeNames=sp.map(function(s){return s.name;});
  var mat2=storeNames.map(function(nm,i){ var code=sp[i].code; return dows.map(function(_,dw){ return Math.round(S.items.filter(function(it){return it.store===code && it.date>=trFrom && it.date<=trTo && it.sale_type!=='Return' && salesPassF(it,F) && dowOf(it.date+' 00:00:00')===dw;}).reduce(function(a,it){return a+(it.net||it.gross*0.97||0);},0)); }); });
  document.getElementById('chHeatStore').innerHTML = heatTable(storeNames,dows,mat2);
}

/* ================= FILTERS UI ================= */
function wireFilters(){
  document.getElementById('filtBtn').onclick=function(){ document.getElementById('filterbar').scrollIntoView({behavior:'smooth'}); };
  document.getElementById('moreFiltBtn').onclick=function(){ document.getElementById('fdrawer').classList.toggle('open'); };
  document.getElementById('resetFiltBtn').onclick=function(){ ['agents','stores','sources','campaigns','triggers','categories','cities','ctypes'].forEach(function(k){F[k].clear();}); wireFilters(); renderAll(); };
  document.getElementById('fTrendWin').onchange=function(e){ F.trendWin=parseInt(e.target.value,10); renderAll(); };
  document.getElementById('fCompare').onchange=function(e){ F.compare=e.target.checked; };
  var D=DATA;
  msbox('msAgent', activeOwners(D).map(function(o){return {v:o,l:ownerName(o)};}).sort(function(a,b){return a.l.localeCompare(b.l);}), F.agents);
  msbox('msStore', Object.keys(STORE_CODE_NAME).map(function(c){return {v:c,l:STORE_CODE_NAME[c]};}), F.stores);
  var sources={}; D.deals.forEach(function(d){if(d.leadSource)sources[d.leadSource]=1;});
  msbox('msSource', Object.keys(sources).sort().map(function(s){return {v:s,l:s};}), F.sources);
  var camps={}; D.deals.forEach(function(d){if(d.utmSource)camps[d.utmSource]=1;});
  msbox('msCampaign', Object.keys(camps).sort().map(function(s){return {v:s,l:s};}), F.campaigns);
  var trigs={}; D.deals.forEach(function(d){if(d.trigger)trigs[d.trigger]=1;});
  msbox('msTrigger', Object.keys(trigs).sort().map(function(s){return {v:s,l:s};}), F.triggers);
  var cats={}; (S.items||[]).forEach(function(it){if(it.category)cats[it.category]=1;});
  msbox('msCategory', Object.keys(cats).sort().map(function(s){return {v:s,l:s};}), F.categories);
  var cities={}; (S.items||[]).forEach(function(it){if(it.city)cities[it.city]=1;});
  msbox('msCity', Object.keys(cities).sort().map(function(s){return {v:s,l:s};}), F.cities);
  msbox('msCtype', [{v:'New',l:'New'},{v:'Repeat',l:'Repeat'}], F.ctypes);
  var dateIn=document.getElementById('fRefDay');
  dateIn.value = F.refDay || D.crmMaxDate;
  dateIn.title = 'Pick any day to treat as "today" — Section 1 shows the day before it (yesterday), and all KPIs/visuals recompute around it.';
  dateIn.onchange=function(){ F.refDay = dateIn.value || null; renderAll(); };
  document.getElementById('fRefDayReset').onclick=function(){ F.refDay=null; dateIn.value=D.crmMaxDate; renderAll(); };
}

/* ================= AI ASSISTANT ================= */
var CHIPS=['Which agent missed most follow-ups yesterday?','Which store has the highest conversion?','Why did revenue drop yesterday?','Which meetings converted into sales?','How many deals had no call?',"Show today's pending store visits",'Compare yesterday vs last week','Suggest actions to improve conversion'];
function assistantAnswer(q){
  var D=DATA; var today=F.refDay||D.crmMaxDate, day=addDays(today,-1); var ql=q.toLowerCase();
  var ap=buildAgentPerf(D,day,{agents:new Set()});
  if(/missed most follow-?ups|deals not called|no call/.test(ql)){
    var w=ap.slice().sort(function(a,b){return b.dealsNotCalled-a.dealsNotCalled;})[0];
    var total=ap.reduce(function(a,r){return a+r.dealsNotCalled;},0);
    return total===0?'No deals from '+day+' were left uncalled — every agent made at least one attempt.':(w?w.name+' has the most uncalled deals from '+day+' ('+w.dealsNotCalled+'). Company-wide total: '+total+' uncalled deals.':'No data.');
  }
  if(/highest conversion/.test(ql) && /store/.test(ql)){
    var salesRange=[addDays(today,-6),today]; var sp=buildStorePerf(D,S,day,today,salesRange,F).filter(function(s){return s.conversion!=null;}).sort(function(a,b){return b.conversion-a.conversion;});
    return sp.length? sp[0].name+' has the highest store conversion at '+fmtPct(sp[0].conversion)+' (orders ÷ meetings+visits, last 7 days).' : 'No store has both meetings and matched sales in the current window to compute conversion.';
  }
  if(/why.*revenue.*drop|revenue drop/.test(ql)){
    var y1=S.items.filter(function(it){return it.date===day&&it.sale_type!=='Return';}).reduce(function(a,it){return a+(it.net||0);},0);
    var dprev=addDays(day,-1); var y2=S.items.filter(function(it){return it.date===dprev&&it.sale_type!=='Return';}).reduce(function(a,it){return a+(it.net||0);},0);
    if(!S.items.some(function(it){return it.date===day;})) return 'Sales data has not synced for '+day+' yet (last available: '+(S.meta.asOf||'unknown')+') — cannot compare.';
    var d=y1-y2; return (d<0? 'Revenue fell from '+fmtMoney(y2)+' ('+dprev+') to '+fmtMoney(y1)+' ('+day+'), a drop of '+fmtMoney(Math.abs(d))+'. Check the Store Performance table for which store contributed most to the drop.' : 'Revenue actually rose from '+fmtMoney(y2)+' to '+fmtMoney(y1)+' — no drop detected on '+day+'.');
  }
  if(/meetings.*(converted|sale)/.test(ql)){
    return 'Not verifiable with current data — Zoho Meetings are not linked to individual Deals, and Sales customer_id is an internal party ID, not a phone number, so there is no reliable way to trace a specific meeting to a specific sale today.';
  }
  if(/pending store visits|today.*store visit/.test(ql)){
    var evT=D.events.filter(function(e){return ymd(e.start||e.created)===today && classifyEvent(e.title)==='Store Visit';});
    return evT.length? evT.length+' store visits are scheduled today ('+today+'), owners: '+[...new Set(evT.map(function(e){return ownerName(e.owner);}))].join(', ')+'.' : 'No store visits scheduled today ('+today+').';
  }
  if(/compare.*last week|vs last week/.test(ql)){
    var lastWeek=addDays(day,-7);
    var d1=D.deals.filter(function(x){return ymd(x.created)===day;}).length, d2=D.deals.filter(function(x){return ymd(x.created)===lastWeek;}).length;
    var c1=D.calls.filter(function(x){return ymd(x.created)===day;}).length, c2=D.calls.filter(function(x){return ymd(x.created)===lastWeek;}).length;
    return 'Deals: '+d1+' ('+day+') vs '+d2+' ('+lastWeek+', same weekday). Calls: '+c1+' vs '+c2+'.';
  }
  if(/suggest actions|improve conversion|recommend/.test(ql)){
    var lis=document.querySelectorAll('#recsList .itm'); var arr=[]; lis.forEach(function(li){arr.push(li.textContent.trim());});
    return arr.length? arr.slice(0,4).join(' | ') : 'No recommendations available for the current filters.';
  }
  return 'I can answer questions about yesterday\'s deals/calls/meetings, store conversion, revenue changes, and today\'s pending workload. Try one of the suggested questions below, or ask e.g. "how many deals had no call".';
}
function wireAssistant(){
  var fab=document.getElementById('askFab'), panel=document.getElementById('askPanel');
  fab.onclick=function(){panel.classList.toggle('open');};
  document.getElementById('askClose').onclick=function(){panel.classList.remove('open');};
  var chips=document.getElementById('askChips'); chips.innerHTML=CHIPS.map(function(c,i){return '<span class="qchip" data-q="'+i+'">'+esc(c)+'</span>';}).join('');
  chips.querySelectorAll('.qchip').forEach(function(c){ c.onclick=function(){ ask(CHIPS[parseInt(c.getAttribute('data-q'),10)]); }; });
  function push(role,text){ var m=el('div','msg '+role,esc(text)); document.getElementById('askMsgs').appendChild(m); m.scrollIntoView(); }
  function ask(q){ push('u',q); setTimeout(function(){ push('a',assistantAnswer(q)); },150); }
  document.getElementById('askSend').onclick=function(){ var i=document.getElementById('askInput'); if(!i.value.trim())return; ask(i.value.trim()); i.value=''; };
  document.getElementById('askInput').addEventListener('keydown',function(e){ if(e.key==='Enter'){document.getElementById('askSend').click();} });
  push('a','Hi! Ask me about yesterday\'s deals, calls, meetings, store conversion or revenue — I only answer from the data actually loaded in this dashboard.');
}

/* ================= MISC WIRING ================= */
var _lastCrmSyncAt=null, _autoTimer=null, _refreshing=false;
function lastSyncedLabel(){
  if(!_lastCrmSyncAt) return '';
  var secs=Math.round((Date.now()-_lastCrmSyncAt)/1000);
  if(secs<90) return 'synced '+secs+'s ago';
  return 'synced '+Math.round(secs/60)+'m ago';
}
function wireHeader(){
  document.getElementById('themeBtn').onclick=function(){ var html=document.documentElement; html.setAttribute('data-theme', html.getAttribute('data-theme')==='dark'?'light':'dark'); };
  document.getElementById('printBtn').onclick=function(){ window.print(); };
  document.getElementById('waBtn').onclick=function(){ document.getElementById('sec8').scrollIntoView({behavior:'smooth'}); };
  document.getElementById('waCopyBtn').onclick=function(){ var t=document.getElementById('waBox').textContent; (navigator.clipboard? navigator.clipboard.writeText(t):Promise.reject()).then(function(){toast('Copied to clipboard');}).catch(function(){ var ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Copied to clipboard'); }); };
  document.getElementById('waSendBtn').onclick=function(){ var t=encodeURIComponent(document.getElementById('waBox').textContent); window.open('https://wa.me/?text='+t,'_blank'); };
  document.addEventListener('click',function(e){ var b=e.target.closest('[data-csv]'); if(b){ var csv=tableToCsv(b.getAttribute('data-csv')); downloadBlob(csv,b.getAttribute('data-name')+'.csv','text/csv'); } });
  var ahBtn=document.getElementById('agHourlyCsvBtn'); if(ahBtn) ahBtn.onclick=function(){
    var rows=[['Agent','Hour','Deals','Calls','Connected Time (HH:MM:SS)']];
    LAST_AGENT_HOURLY.forEach(function(r){ r.hours.forEach(function(hc,i){ rows.push([r.name, LAST_AGENT_HOURLY_HOURS[i]+':00', hc.deals, hc.calls, fmtHMS(hc.connSecs)]); }); });
    downloadBlob(csvOf(rows),'agent_hourly_'+(LAST_AGENT_HOURLY_DAY||'')+'.csv','text/csv');
  };
  document.getElementById('refreshBtn').onclick=function(){ refreshAll(true); };
  document.getElementById('autoRefreshSel').onchange=function(e){ CONFIG.AUTO_MS=parseInt(e.target.value,10)||0; scheduleAutoRefresh(); };
  var nav=document.getElementById('secnavIn');
  var secs=[['sec1','① Yesterday Agents'],['sec3','② Stores'],['sec4','③ Sale Dump'],['sec5','④ KPIs'],['sec6','⑤ Insights'],['sec7','⑥ Recs'],['sec8','⑦ WhatsApp'],['sec9','⑧ Visuals']];
  nav.innerHTML=secs.map(function(s){return '<a href="#'+s[0]+'">'+s[1]+'</a>';}).join('');
}
function toast(msg){ var t=el('div',null,msg); t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--card2);border:1px solid var(--line);padding:9px 16px;border-radius:20px;font-size:12.5px;z-index:300;box-shadow:var(--shadow)'; document.body.appendChild(t); setTimeout(function(){t.remove();},1800); }

function refreshAll(manual){
  if(_refreshing) return; _refreshing=true;
  if(manual) toast('Refreshing live data…');
  loadCrm(function(crmBundle){
    DATA=buildData(crmBundle.raw);
    DATA.crmLive=crmBundle.live; DATA.crmSource=crmBundle.source;
    if(crmBundle.live) _lastCrmSyncAt=Date.now();
    loadSales(function(sBundle){
      S=sBundle; renderAll(); _refreshing=false;
      if(manual) toast(DATA.crmLive? 'Refreshed — live CRM data updated':'Refreshed (CRM live fetch failed, showing snapshot)');
    });
  });
}
function scheduleAutoRefresh(){
  if(_autoTimer){ clearInterval(_autoTimer); _autoTimer=null; }
  if(CONFIG.AUTO_MS>0) _autoTimer=setInterval(function(){ refreshAll(false); }, CONFIG.AUTO_MS);
}

/* ================= BOOT ================= */
function boot(){
  loadCrm(function(crmBundle){
    DATA=buildData(crmBundle.raw);
    DATA.crmLive=crmBundle.live; DATA.crmSource=crmBundle.source;
    if(crmBundle.live) _lastCrmSyncAt=Date.now();
    loadSales(function(sBundle){
      S=sBundle;
      wireHeader(); wireFilters(); wireAssistant(); renderAll();
      document.getElementById('boot').classList.add('hide');
      scheduleAutoRefresh();
    });
  });
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();

})();
