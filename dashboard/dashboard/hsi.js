/* ═══════════════════════════════════════════════════════════════════════
   LUCIRA HOURLY STORE & DIGITAL INTELLIGENCE — engine
   ---------------------------------------------------------------------
   100% REAL, ALREADY-LIVE public data sources — zero new backend, zero
   mock data. Every number traces to one of:
     1) zoho-crm-bundle-public   (Cloud Function; reads zoho_crm.cdc_* via
        BigQuery CDC, synced from Zoho every ~30 min) — Deals/Calls/Tasks/
        Meetings/Online-Activities + a unified owner_id->owner_name map.
        Real per-record timestamp (created_time, IST) -> the ONLY source
        with genuine hour-of-day granularity in this project.
     2) zoho-leads-city-public   (same CDC project; a separate live Deals
        table with real Address_City/State — cdc_deals' own copy is 0%
        populated) — used only to attach city/state to a minority of deals.
     3) GA4 unified snapshot (public GCS JSON, built by ga4-bq-api from
        ga4_fact_sessions + the marketing mart) — real session/user counts,
        DAY-grain only (no hour column exists in ga4_fact_sessions today).
     4) Sales reporting snapshot (public GCS JSON, sales-reporting-api) —
        real Ornaverse ERP sales, DAY + STORE grain, no hour.
   WebEngage in this BigQuery project (`Lucira_Prod.Webengage_Final`) is
   CAMPAIGN-ENGAGEMENT data only (email/sms/push/whatsapp/rcs sent/
   delivered/opened/clicked, keyed by cuid = mobile number) — there is no
   suid/luid/session/device_type/landing_page/referrer field anywhere in
   this project, and no public endpoint exposes even the campaign counters
   yet. Per the "no invented mappings, no mock data" rule, WebEngage is
   NOT wired into this dashboard — see the Data Quality tab for the exact
   gap. GA4 is the real session-level substitute for "digital behaviour".
   Every gap below is a tested, confirmed fact (see dcs.js / mdi.js source
   comments + live bq checks already on record in this repo), not a guess.
   ═══════════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

var CONFIG = {
  CRM_API:   'https://asia-south1-lucirajewelry-prod.cloudfunctions.net/zoho-crm-bundle-public',
  LEADS_API: 'https://asia-south1-lucirajewelry-prod.cloudfunctions.net/zoho-leads-city-public',
  GA4_SNAPSHOT_URL:   'https://storage.googleapis.com/lucirajewelry-prod-dashboards/ga4/unified-latest-000000000000.json',
  /* REAL WebEngage hourly sessions, built 2026-08-19. WebEngage's native BigQuery data-share
     turned out to live in a SEPARATE GCP project (`test-webengage.11b56595a_shared`), which a
     first exhaustive search of `lucirajewelry-prod` never found. `system_view_v1`'s
     `user_session_started` event carries a genuine per-session `suid` (WebEngage mints this
     fresh per session — no gap-based sessionization needed) plus real luid/device_type/city.
     COUNT(DISTINCT suid) per hour, bucketed with the same Business Hours/Overnight
     business_date logic as everything else here. Published straight to GCS (not via BigQuery
     EXPORT DATA — that dataset is region `US`, this project's datasets are `asia-south1`, and
     BigQuery can't write cross-region in one job, so the query runs standalone and the result
     is uploaded to GCS directly). NOT auto-refreshing yet, see README "Known follow-ups".
     Re-run dashboard/sql/webengage_hourly_sessions_refresh.sql's query (see its header comment
     for the cross-region caveat) to update it. Supersedes the earlier GA4-derived stand-in
     (dashboard/sql/ga4_hourly_sessions_refresh.sql, kept only as a cross-check). */
  WEBENGAGE_HOURLY_URL: 'https://storage.googleapis.com/lucirajewelry-prod-dashboards/webengage/hourly-sessions-latest.json',
  SALES_SNAPSHOT_URL: 'https://storage.googleapis.com/lucira-dashboards/sales/latest.json',
  AUTO_MS: 900000, // 15 min, per spec default
  TZ: 'Asia/Kolkata',
  BIZ_START_HOUR: 10, // Business Hours: 10:00 -> 21:00 (exclusive)
  BIZ_END_HOUR: 21,   // Overnight: 21:00 -> next day 10:00 (exclusive)
  CONNECTED_SECS: 30  // Call counted "Connected" when duration > 30s (matches dcs.js agent-performance rule)
};

/* ═══════════════════════ generic utils ═══════════════════════ */
function el(tag,cls,html){ var e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; }
function esc(s){ return (s==null?'':''+s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function fmtInt(n){ return (n==null||isNaN(n))?'—':Math.round(n).toLocaleString('en-IN'); }
function fmtMoney(n){ if(n==null||isNaN(n))return '—'; var a=Math.abs(n),s=n<0?'-':''; if(a>=1e7) return s+'₹'+(a/1e7).toFixed(2)+'Cr'; if(a>=1e5) return s+'₹'+(a/1e5).toFixed(2)+'L'; return s+'₹'+Math.round(a).toLocaleString('en-IN'); }
function fmtPct(n,d){ if(n==null||isNaN(n)||!isFinite(n))return '—'; return n.toFixed(d==null?1:d)+'%'; }
function pct(a,b){ return b?(100*a/b):null; }
function ymd(d){ if(!d)return null; if(typeof d==='string') d=new Date(d.replace(' ','T')); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function parseYmd(s){ if(!s)return null; var p=s.split('-').map(Number); return new Date(p[0],p[1]-1,p[2]); }
function addDays(dstr,n){ var d=new Date(dstr+'T00:00:00'); d.setDate(d.getDate()+n); return ymd(d); }
function diffMin(a,b){ return (new Date(b.replace(' ','T'))-new Date(a.replace(' ','T')))/60000; }
function hourOf(dstr){ var d=new Date((''+dstr).replace(' ','T')); return d.getHours(); }
function fmtHMS(secs){ secs=Math.max(0,Math.round(secs||0)); var h=Math.floor(secs/3600), m=Math.floor((secs%3600)/60), s=secs%60; return [h,m,s].map(function(x){return String(x).padStart(2,'0');}).join(':'); }
function trunc(s,n){ s=String(s||''); return s.length>n?s.slice(0,n-1)+'…':s; }
function sortDesc(arr,key){ return arr.slice().sort(function(a,b){return b[key]-a[key];}); }
function sortAsc(arr,key){ return arr.slice().sort(function(a,b){return a[key]-b[key];}); }
function growth(cur,prev){ if(!prev) return cur>0?100:0; return (cur-prev)/Math.abs(prev)*100; }
function downloadBlob(content,filename,mime){ if(mime==='text/csv' && typeof content==='string' && content.charCodeAt(0)!==0xFEFF) content='﻿'+content; var blob=new Blob([content],{type:mime+';charset=utf-8'}); var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},800); }
function csvOf(rows){ return rows.map(function(r){return r.map(function(v){ v=(v==null?'':''+v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }).join(',');}).join('\n'); }
function xlsOf(rows){ function cell(v){ v=(v==null?'':''+v); var num=/^-?[\d.]+$/.test(v.replace(/,/g,'')); return '<Cell><Data ss:Type="'+(num?'Number':'String')+'">'+esc(num?v.replace(/,/g,''):v)+'</Data></Cell>'; }
  return '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Export"><Table>'+rows.map(function(r){return '<Row>'+r.map(cell).join('')+'</Row>';}).join('')+'</Table></Worksheet></Workbook>'; }
function tableToRows(tblEl){ return [].slice.call(tblEl.querySelectorAll('tr')).map(function(tr){ return [].slice.call(tr.children).map(function(c){return c.textContent.replace(/\s+/g,' ').trim();}); }); }
function normPhone(m){ return (''+(m||'')).replace(/\D/g,'').slice(-10); }
function debounce(fn,ms){ var t; return function(){ var a=arguments,c=this; clearTimeout(t); t=setTimeout(function(){fn.apply(c,a);},ms); }; }

/* ═══════════════════════ CRM parsers (matches zoho-crm-bundle-public positional schema, same as dashboard/dcs.js) ═══════════════════════ */
function pd(a){ return {id:a[0],name:a[1],owner:a[2],created:a[3],stage:a[4],prob:a[5],leadSource:a[6],reasonLoss:a[7],trigger:a[8],utmSource:a[9],utmMedium:a[10],numAct:a[11]||0,mobile:normPhone(a[12]),city:a[13]||'',state:a[14]||'',modified:a[15]||null}; }
function pc(a){ return {id:a[0],owner:a[1],created:a[2],type:a[3],dur:a[4]||0,start:a[5],whatId:a[6]||'',phone:normPhone(a[7]),result:a[8]||''}; }
function pt(a){ return {id:a[0],owner:a[1],created:a[2],status:a[3],due:a[4],closed:a[5],whatId:a[6]||''}; }
function po(a){ return {id:a[0],owner:a[1],created:a[2],channel:a[3],atype:a[4]}; }
function pe(a){ return {id:a[0],owner:a[1],created:a[2],start:a[3],end:a[4],title:a[5]||''}; }

/* Only real source of Store Visit / TAH / Video Call in this CRM: Zoho Meeting titles.
   Confirmed live (see zoho-crm-bundle-api/main.py comment + dashboard/dcs.js): the Tasks
   module's own Task_Type field has just 13 non-blank values across the WHOLE org, so it
   cannot classify activity at any real scale. Meetings carry no What_Id link to a Deal on
   ~10% of rows, so "linked to a specific deal" coverage is partial and shown as such. */
function classifyEvent(title){
  var t=(title||'').toLowerCase().trim();
  if(/trial at home|try at home|\btah\b/.test(t)) return 'TAH';
  if(/video/.test(t)) return 'Video Call';
  if(/visit|\bsv\b/.test(t)) return 'Store Visit';
  return 'Other';
}
function isTaskDone(t){ return (''+(t.status||'')).toLowerCase().indexOf('complet')>=0; }

/* Store mapping: NOT a per-record field (Zoho's own Store_Assigned is 0% populated across
   Deals/Calls/Tasks — confirmed live 2026-08). The only real store signal is 6 dedicated
   "store" CRM owner accounts. Every other owner's activity is genuinely Store = Unmapped —
   shown as such everywhere, never guessed. */
var STORE_CODE_NAME={HO:'Head Office / Online Fulfilment',CS1:'Chembur',PN1:'Pune',BO1:'Borivali',N18:'Noida',PV1:'Pashchim Vihar'};
var STORE_CITY={HO:'Mumbai',CS1:'Mumbai',BO1:'Mumbai',PN1:'Pune',N18:'Noida',PV1:'Delhi NCR'};
var STORE_OWNERNAME_TO_CODE={'Chembur Store':'CS1','Pune Store':'PN1','Borivali Team':'BO1','Borivali Store':'BO1','Noida Store':'N18','Pashchim Vihar':'PV1'};

var DATA=null; // set by buildData()
function webengageHourlySessions(day,hour){ var r=DATA&&DATA.webengageHourly&&DATA.webengageHourly[day+'|'+hour]; return r?r.sessions:null; }
function ownerName(id){ return (DATA && DATA.owners[id]) || id || '—'; }
function storeCodeOfOwner(id){ return STORE_OWNERNAME_TO_CODE[ownerName(id)]||null; }
function storeNameOf(code){ return code? (STORE_CODE_NAME[code]||code) : 'Unmapped'; }

/* ═══════════════════════ BUSINESS DATE / TIME WINDOW LOGIC ═══════════════════════
   Business Hours: 10:00 -> 20:59  (spec's "10 AM to 9 PM", 9 PM itself starts Overnight)
   Overnight:      21:00 -> 09:59 next calendar day, all attributed to the PRIOR business_date
   10:00 AM starts a brand-new business_date. This exact split already exists, tested, in
   dashboard/dcs.js as inWindowA()/windowBDeals() — generalized here to every record type. */
var BUSINESS_HOURS=[10,11,12,13,14,15,16,17,18,19,20];
var OVERNIGHT_HOURS=[21,22,23,0,1,2,3,4,5,6,7,8,9];
function hourLabel(h){ if(h===0)return '12 AM'; if(h<12)return h+' AM'; if(h===12)return '12 PM'; return (h-12)+' PM'; }
function businessDateOf(ts){
  if(!ts) return null;
  var d=ymd(ts), h=hourOf(ts);
  if(h>=CONFIG.BIZ_START_HOUR && h<CONFIG.BIZ_END_HOUR) return {business_date:d, window:'Business Hours', hour:h};
  if(h>=CONFIG.BIZ_END_HOUR) return {business_date:d, window:'Overnight', hour:h};
  return {business_date:addDays(d,-1), window:'Overnight', hour:h};
}

/* ═══════════════════════ DATA INGEST ═══════════════════════ */
var SOURCES={crm:{ok:false,at:null,err:null}, leads:{ok:false,at:null,err:null}, ga4:{ok:false,at:null,err:null}, webengageHourly:{ok:false,at:null,err:null,generated:null}, sales:{ok:false,at:null,err:null}};

function fetchJSON(url){ return fetch(url,{cache:'no-store'}).then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }); }
/* WEBENGAGE_HOURLY_URL is a hand-published newline-delimited JSON file (one object per line,
   not a single JSON document) — parsed differently from the other 3 sources. */
function fetchNDJSON(url){ return fetch(url,{cache:'no-store'}).then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); var lastMod=r.headers.get('last-modified'); return r.text().then(function(t){ return {rows:t.split('\n').filter(Boolean).map(function(l){return JSON.parse(l);}), lastMod:lastMod}; }); }); }

function loadAll(){
  return Promise.all([
    fetchJSON(CONFIG.CRM_API).then(function(j){ SOURCES.crm={ok:true,at:new Date().toISOString(),err:null}; return j; }).catch(function(e){ SOURCES.crm={ok:false,at:null,err:e.message}; return {owners:{},deals:[],calls:[],tasks:[],online:[],events:[],meta:{}}; }),
    fetchJSON(CONFIG.LEADS_API).then(function(j){ SOURCES.leads={ok:true,at:new Date().toISOString(),err:null}; return j; }).catch(function(e){ SOURCES.leads={ok:false,at:null,err:e.message}; return null; }),
    fetchJSON(CONFIG.GA4_SNAPSHOT_URL).then(function(j){ SOURCES.ga4={ok:true,at:new Date().toISOString(),err:null}; return j; }).catch(function(e){ SOURCES.ga4={ok:false,at:null,err:e.message}; return null; }),
    fetchJSON(CONFIG.SALES_SNAPSHOT_URL).then(function(j){ SOURCES.sales={ok:true,at:new Date().toISOString(),err:null}; return j; }).catch(function(e){ SOURCES.sales={ok:false,at:null,err:e.message}; return null; }),
    fetchNDJSON(CONFIG.WEBENGAGE_HOURLY_URL).then(function(r){ SOURCES.webengageHourly={ok:true,at:new Date().toISOString(),err:null,generated:r.lastMod}; return r.rows; }).catch(function(e){ SOURCES.webengageHourly={ok:false,at:null,err:e.message,generated:null}; return []; })
  ]).then(function(res){ return buildData(res[0],res[1],res[2],res[3],res[4]); });
}

/* Global unique-deal rule reused verbatim from dcs.js: one deal per Mobile+CreatedDate
   (calendar day), latest wins on a collision. Deals with no mobile pass through unduped. */
function dedupeDealsGlobal(deals){
  var byKey={}, noMobile=[];
  deals.forEach(function(d){
    if(!d.mobile){ noMobile.push(d); return; }
    var key=d.mobile+'|'+ymd(d.created);
    var cur=byKey[key];
    if(!cur){ byKey[key]=d; return; }
    var tCur=cur.modified||cur.created, tNew=d.modified||d.created;
    if(tNew>tCur) byKey[key]=d;
  });
  return Object.keys(byKey).map(function(k){return byKey[k];}).concat(noMobile);
}

function buildData(crmRaw,leadsRaw,ga4Raw,salesRaw,webengageHourlyRows){
  crmRaw=crmRaw||{owners:{},deals:[],calls:[],tasks:[],online:[],events:[],meta:{}};
  var cityById={};
  if(leadsRaw && leadsRaw.raw){ leadsRaw.raw.forEach(function(r){ if(r && r.length) cityById[r[0]]={city:r[2]||'',state:r[3]||''}; }); }
  var webengageHourlyIdx={};
  (webengageHourlyRows||[]).forEach(function(r){ webengageHourlyIdx[r.business_date+'|'+r.hour]={sessions:+r.sessions,users:+r.users,window:r.time_window}; });
  var D={
    owners: crmRaw.owners||{}, meta: crmRaw.meta||{},
    deals: (crmRaw.deals||[]).map(function(a){ var d=pd(a); var c=cityById[d.id]; if(c){ d.city=c.city; d.state=c.state; } return d; }),
    calls: (crmRaw.calls||[]).map(pc),
    tasks: (crmRaw.tasks||[]).map(pt),
    online:(crmRaw.online||[]).map(po),
    events:(crmRaw.events||[]).map(pe),
    ga4: ga4Raw, sales: salesRaw, webengageHourly: webengageHourlyIdx
  };
  D.dealsRawCount=D.deals.length;
  D.deals=dedupeDealsGlobal(D.deals);
  D.dupDealsRemoved=D.dealsRawCount-D.deals.length;

  // classified meetings = the real Store Visit / TAH / Video Call / Other activity feed
  D.activities=D.events.map(function(e){ var bd=businessDateOf(e.created); return Object.assign({},e,{type:classifyEvent(e.title),store:storeCodeOfOwner(e.owner)},bd||{}); });

  D.idxWhat={}; D.calls.forEach(function(c){ if(c.whatId){ (D.idxWhat[c.whatId]=D.idxWhat[c.whatId]||[]).push(c); } });
  D.idxWhatTask={}; D.tasks.forEach(function(t){ if(t.whatId){ (D.idxWhatTask[t.whatId]=D.idxWhatTask[t.whatId]||[]).push(t); } });

  // business-date/window tags precomputed once on every row for fast filtering
  D.deals.forEach(function(d){ Object.assign(d, businessDateOf(d.created)||{}); d.store=storeCodeOfOwner(d.owner); d.connected=d.calls; });
  D.calls.forEach(function(c){ Object.assign(c, businessDateOf(c.created)||{}); c.store=storeCodeOfOwner(c.owner); c.connectedFlag=(c.dur||0)>CONFIG.CONNECTED_SECS; });
  D.tasks.forEach(function(t){ Object.assign(t, businessDateOf(t.created)||{}); t.store=storeCodeOfOwner(t.owner); t.done=isTaskDone(t); });

  var maxD=null;
  [D.deals,D.calls,D.tasks,D.activities].forEach(function(arr){ arr.forEach(function(r){ var d=r.created; if(d && (!maxD||d>maxD)) maxD=d; }); });
  D.crmMaxTs = maxD;
  D.crmMaxDate = maxD?ymd(maxD):ymd(new Date());
  D.crmMaxBiz = maxD?businessDateOf(maxD).business_date:D.crmMaxDate;
  return D;
}

/* ═══════════════════════ FILTER STATE + PREDICATES ═══════════════════════ */
var F={ bizDate:null, window:'all', owners:new Set(), dealOwners:new Set(), stores:new Set(), cities:new Set(),
        stages:new Set(), taskStatus:new Set(), callStatus:new Set(), sources:new Set(), campaigns:new Set(), hour:null };

/* Mutates the SAME object in place — never reassign `F` itself. window.HSI.F is bound once,
   by reference, at module load (see `F:F` in the export below); reassigning `F = {...}` here
   would silently orphan that exported reference, so every filter control in hsi-views.js
   (which only ever touches HSI.F) would stop reaching the predicates below, which close over
   this module's own `F` variable. Mutating in place keeps both sides pointing at one object. */
function resetFilters(){
  F.bizDate=DATA?DATA.crmMaxBiz:null; F.window='all'; F.hour=null;
  F.owners=new Set(); F.dealOwners=new Set(); F.stores=new Set(); F.cities=new Set();
  F.stages=new Set(); F.taskStatus=new Set(); F.callStatus=new Set(); F.sources=new Set(); F.campaigns=new Set();
}

function winOK(r){ if(F.window==='business') return r.window==='Business Hours'; if(F.window==='overnight') return r.window==='Overnight'; return true; }
function hourOK(r){ return F.hour==null || r.hour===F.hour; }
function storeOK(r){ return !F.stores.size || F.stores.has(r.store||'Unmapped'); }
function ownerOK(r){ return !F.owners.size || F.owners.has(r.owner); }
/* "Dim" variants apply every DIMENSION filter (owner/store/stage/source/…) but deliberately
   skip window/hour — used by the Hourly Monitor's own per-hour/per-window loop, which already
   pins the exact hour+window it's building a row for. Reusing the hour/window-aware variants
   there would double-filter: after a drill-down sets F.hour, every OTHER hour's row would
   collide with that pin and render as zero. All other tabs use the full (non-"Dim") variants
   below, which DO respect F.window/F.hour so a drill-down click scopes the whole dashboard. */
function dealPassFDim(d){ return ownerOK(d) && (!F.dealOwners.size||F.dealOwners.has(d.owner)) && storeOK(d)
  && (!F.stages.size||F.stages.has(d.stage||'(blank)')) && (!F.sources.size||F.sources.has(d.leadSource||'(blank)'))
  && (!F.campaigns.size||F.campaigns.has(d.utmSource||'(blank)')) && (!F.cities.size||F.cities.has(d.city||'Unknown')); }
function callPassFDim(c){ return ownerOK(c) && storeOK(c) && (!F.callStatus.size||F.callStatus.has(c.connectedFlag?'Connected':'Not Connected')); }
function taskPassFDim(t){ return ownerOK(t) && storeOK(t) && (!F.taskStatus.size||F.taskStatus.has(t.done?'Completed':'Pending')); }
function activityPassFDim(a){ return ownerOK(a) && storeOK(a); }
function dealPassF(d){ return dealPassFDim(d) && winOK(d) && hourOK(d); }
function callPassF(c){ return callPassFDim(c) && winOK(c) && hourOK(c); }
function taskPassF(t){ return taskPassFDim(t) && winOK(t) && hourOK(t); }
function activityPassF(a){ return activityPassFDim(a) && winOK(a) && hourOK(a); }

function scopedTo(arr,day){ return arr.filter(function(r){ return r.business_date===day; }); }

/* ═══════════════════════ CHART PRIMITIVES (hand-rolled SVG, no CDN) ═══════════════════════ */
var C_INK='#f4f1ea', C_MUTED='#7d7a72', C_GRID='rgba(255,255,255,.06)';
function refreshThemeColors(){ var s=getComputedStyle(document.body); C_INK=s.getPropertyValue('--ink').trim(); C_MUTED=s.getPropertyValue('--muted').trim(); C_GRID=s.getPropertyValue('--grid').trim(); }
function legendFor(series){ if(series.length<2) return ''; return '<div class="legend">'+series.map(function(s){return '<span><i style="background:'+s.color+'"></i>'+esc(s.name)+'</span>';}).join('')+'</div>'; }
function lineArea(series,keys,opts){
  opts=opts||{}; var W=760,H=opts.height||220,P={t:16,r:14,b:30,l:44};
  var iw=W-P.l-P.r, ih=H-P.t-P.b;
  var mx=0; series.forEach(function(s){s.data.forEach(function(v){ if(v>mx)mx=v; });}); if(mx===0)mx=1; mx*=1.15;
  var nk=keys.length; function xf(i){ return P.l+(nk<=1?iw/2:i/(nk-1)*iw); } function yf(v){ return P.t+ih-(v/mx)*ih; }
  var g=''; for(var i=0;i<=3;i++){ var val=mx*i/3, y=yf(val); g+='<line x1="'+P.l+'" y1="'+y+'" x2="'+(W-P.r)+'" y2="'+y+'" stroke="'+C_GRID+'"/><text x="'+(P.l-8)+'" y="'+(y+3)+'" fill="'+C_MUTED+'" font-size="9.5" text-anchor="end">'+fmtInt(val)+'</text>'; }
  var lstep=Math.max(1,Math.ceil(nk/12));
  keys.forEach(function(k,i){ if(i%lstep && i!==nk-1) return; g+='<text x="'+xf(i)+'" y="'+(H-8)+'" fill="'+C_MUTED+'" font-size="9" text-anchor="middle">'+esc(k)+'</text>'; });
  var paths='', labels='';
  series.forEach(function(s,si){ var col=s.color; var pts=s.data.map(function(v,i){return [xf(i),yf(v)];});
    var line=pts.map(function(p,i){return (i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1);}).join(' ');
    if(series.length===1){ var id='la'+si+Math.floor(Math.random()*1e5);
      paths+='<defs><linearGradient id="'+id+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+col+'" stop-opacity=".22"/><stop offset="1" stop-color="'+col+'" stop-opacity="0"/></linearGradient></defs><path d="'+line+' L'+xf(nk-1)+' '+(P.t+ih)+' L'+xf(0)+' '+(P.t+ih)+' Z" fill="url(#'+id+')"/>'; }
    paths+='<path d="'+line+'" fill="none" stroke="'+col+'" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
    pts.forEach(function(p,i){ paths+='<circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="8" fill="transparent" data-tip="<b>'+esc(keys[i])+'</b><br>'+esc(s.name)+': '+fmtInt(s.data[i])+'"/><circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="2.6" fill="'+col+'"/>'; });
  });
  return '<div class="scroll-x"><svg class="chart" viewBox="0 0 '+W+' '+H+'" style="min-width:520px">'+g+paths+labels+'</svg></div>'+legendFor(series);
}
function bars(data,opts){ opts=opts||{}; var W=opts.width||680,H=opts.height||220,P={t:14,r:12,b:38,l:42};
  var iw=W-P.l-P.r,ih=H-P.t-P.b; var mx=Math.max(1,Math.max.apply(null,data.map(function(d){return Math.abs(d.value);})));
  var bw=Math.min(46,iw/data.length*0.56), gap=iw/data.length; var g='';
  for(var i=0;i<=3;i++){ var y=P.t+ih-ih*i/3; g+='<line x1="'+P.l+'" y1="'+y+'" x2="'+(W-P.r)+'" y2="'+y+'" stroke="'+C_GRID+'"/><text x="'+(P.l-7)+'" y="'+(y+3)+'" fill="'+C_MUTED+'" font-size="9.5" text-anchor="end">'+fmtInt(mx*i/3)+'</text>'; }
  data.forEach(function(d,idx){ var h=Math.abs(d.value)/mx*ih; var x=P.l+gap*idx+(gap-bw)/2; var y=P.t+ih-h;
    g+='<rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(1,h).toFixed(1)+'" rx="4" fill="'+(d.color||'var(--gold)')+'" data-tip="<b>'+esc(d.label)+'</b><br>'+fmtInt(d.value)+'" '+(d.onclick?'style="cursor:pointer" data-idx="'+idx+'"':'')+'/>';
    g+='<text x="'+(x+bw/2).toFixed(1)+'" y="'+(y-6).toFixed(1)+'" fill="'+C_INK+'" font-size="10" font-weight="600" text-anchor="middle">'+fmtInt(d.value)+'</text>';
    g+='<text x="'+(x+bw/2).toFixed(1)+'" y="'+(H-14)+'" fill="'+C_MUTED+'" font-size="10" text-anchor="middle">'+esc(trunc(d.label,10))+'</text>'; });
  return '<svg class="chart" viewBox="0 0 '+W+' '+H+'" data-clickbars="'+(opts.clickId||'')+'">'+g+'</svg>';
}
function hbars(data){ var mx=Math.max(1,Math.max.apply(null,data.map(function(d){return Math.abs(d.value);})));
  return '<div style="display:flex;flex-direction:column;gap:9px">'+data.map(function(d){ var w=Math.abs(d.value)/mx*100;
    return '<div style="display:grid;grid-template-columns:140px 1fr auto;gap:10px;align-items:center;font-size:12px"><div style="color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="'+esc(d.label)+'">'+esc(d.label)+'</div><div style="background:var(--surface-3);border-radius:6px;height:15px;overflow:hidden"><div style="width:'+w.toFixed(1)+'%;height:100%;background:'+(d.color||'var(--gold)')+';border-radius:6px"></div></div><b style="font-variant-numeric:tabular-nums;min-width:56px;text-align:right">'+fmtInt(d.value)+'</b></div>'; }).join('')+'</div>';
}
function donut(data,opts){ opts=opts||{}; var total=data.reduce(function(a,d){return a+Math.abs(d.value);},0)||1; var R=82,r=52,cx=96,cy=96;
  var a=-Math.PI/2,g='';
  data.forEach(function(d){ var frac=Math.abs(d.value)/total; var a2=a+frac*Math.PI*2;
    var x1=cx+R*Math.cos(a),y1=cy+R*Math.sin(a),x2=cx+R*Math.cos(a2),y2=cy+R*Math.sin(a2);
    var xi2=cx+r*Math.cos(a2),yi2=cy+r*Math.sin(a2),xi1=cx+r*Math.cos(a),yi1=cy+r*Math.sin(a);
    var large=frac>0.5?1:0;
    g+='<path d="M'+x1.toFixed(1)+' '+y1.toFixed(1)+' A'+R+' '+R+' 0 '+large+' 1 '+x2.toFixed(1)+' '+y2.toFixed(1)+' L'+xi2.toFixed(1)+' '+yi2.toFixed(1)+' A'+r+' '+r+' 0 '+large+' 0 '+xi1.toFixed(1)+' '+yi1.toFixed(1)+' Z" fill="'+d.color+'" data-tip="<b>'+esc(d.label)+'</b><br>'+fmtInt(d.value)+' · '+fmtPct(frac*100)+'"/>';
    a=a2; });
  var cen=opts.center||fmtInt(total);
  g+='<text x="'+cx+'" y="'+(cy-3)+'" fill="'+C_INK+'" font-size="19" font-weight="700" text-anchor="middle" font-family="var(--serif)">'+esc(cen)+'</text><text x="'+cx+'" y="'+(cy+15)+'" fill="'+C_MUTED+'" font-size="9.5" text-anchor="middle">'+esc(opts.centerSub||'')+'</text>';
  return '<svg class="chart" viewBox="0 0 192 192" style="max-height:220px">'+g+'</svg><div class="legend">'+data.map(function(d){return '<span><i style="background:'+d.color+'"></i>'+esc(d.label)+' · '+fmtInt(d.value)+' · '+fmtPct(Math.abs(d.value)/total*100)+'</span>';}).join('')+'</div>';
}

/* ═══════════════════════ CARD / TABLE / FUNNEL HELPERS ═══════════════════════ */
function card(title,body,opts){ opts=opts||{}; return '<div class="card '+(opts.cls||'')+'"><div class="pad">'
  +(title?'<div class="ct"><h3>'+esc(title)+'</h3><div class="ct-r">'+(opts.hint?'<span class="hint">'+opts.hint+'</span>':'')+(/<table|<svg/i.test(body)?'<button class="cmenu-btn" data-cmenu title="Export">⋮</button>':'')+'</div></div>':'')
  +body+'</div></div>'; }
function secHead(eyebrow,title,sub){ return '<div class="sec-head"><div><div class="eyebrow">'+esc(eyebrow)+'</div><h2>'+esc(title)+'</h2>'+(sub?'<div class="sub">'+sub+'</div>':'')+'</div></div>'; }
function gate(text){ return '<div class="gate-note">'+text+'</div>'; }

function table(host,cols,rows,opts){
  opts=opts||{}; host.innerHTML='';
  var thead='<thead><tr>'+cols.map(function(c){return '<th data-k="'+c.k+'">'+esc(c.h)+(c.sort===false?'':' ⇅')+'</th>';}).join('')+'</tr></thead>';
  var tbody='<tbody>'+rows.map(function(r,ri){
    return '<tr data-ri="'+ri+'">'+cols.map(function(c){ var v=c.f?c.f(r):r[c.k]; return '<td class="'+(c.num?'num':'')+'">'+(v==null?'—':v)+'</td>'; }).join('')+'</tr>';
  }).join('')+'</tbody>';
  var tfoot=''; if(opts.foot){ tfoot='<tfoot><tr>'+cols.map(function(c){return '<td class="'+(c.num?'num':'')+'">'+(opts.foot[c.k]!=null?opts.foot[c.k]:'')+'</td>';}).join('')+'</tr></tfoot>'; }
  var tbl=el('table','dt',thead+tbody+tfoot); host.appendChild(tbl);
  if(!rows.length){ host.appendChild(el('div','empty','No data for this selection.')); }
  tbl.querySelectorAll('th').forEach(function(th,ci){
    th.onclick=function(){ var k=cols[ci].k, asc=th.dataset.asc!=='1';
      tbl.querySelectorAll('th').forEach(function(x){delete x.dataset.asc;}); th.dataset.asc=asc?'1':'0';
      rows.sort(function(a,b){ var va=a[k],vb=b[k]; if(typeof va==='string') return asc?(''+va).localeCompare(vb):(''+vb).localeCompare(va); return asc?(va-vb):(vb-va); });
      table(host,cols,rows,opts); };
  });
  if(opts.onRowClick){ tbl.querySelectorAll('tbody tr').forEach(function(tr,ri){ tr.style.cursor='pointer'; tr.onclick=function(){ opts.onRowClick(rows[ri]); }; }); }
  host._csv=function(){ return csvOf([cols.map(function(c){return c.h;})].concat(rows.map(function(r){return cols.map(function(c){ var v=c.f?c.f(r):r[c.k]; return (''+(v==null?'':v)).replace(/<[^>]+>/g,''); });}))); };
}

function renderFunnel(host,stages){
  var base=stages.length && stages[0].n || 1;
  host.innerHTML='<div class="funnel">'+stages.map(function(s,i){
    var prev=i>0?stages[i-1].n:s.n;
    return '<div class="frow"><div>'+esc(s.label)+'</div><div class="ftrack"><div class="fbar" style="width:'+Math.max(2,100*s.n/base)+'%">'+fmtInt(s.n)+'</div></div><div>'+fmtPct(pct(s.n,base),0)+' of total</div><div>'+(i>0?fmtPct(pct(s.n,prev),0)+' vs prev':'—')+'</div></div>';
  }).join('')+'</div>';
}

/* Enhanced multiselect with a search box, Select All / Clear All */
function buildMultiselect(host,options,labelFn,setRef,onChange){
  labelFn=labelFn||function(o){return o;};
  host.innerHTML='';
  var wrap=el('div','msbox2');
  var search=el('input','inp'); search.placeholder='Search…'; search.style.marginBottom='6px';
  var tools=el('div','ms-tools'); var allBtn=el('button','ms-mini','Select all'); var clrBtn=el('button','ms-mini','Clear');
  tools.appendChild(allBtn); tools.appendChild(clrBtn);
  var list=el('div','ms-list');
  options.forEach(function(o){
    var lbl=el('label'); var cb=el('input'); cb.type='checkbox'; cb.checked=setRef.has(o);
    cb.onchange=function(){ if(cb.checked) setRef.add(o); else setRef.delete(o); onChange(); };
    lbl.appendChild(cb); lbl.appendChild(document.createTextNode(' '+labelFn(o)));
    lbl.dataset.txt=labelFn(o).toLowerCase();
    list.appendChild(lbl);
  });
  search.oninput=debounce(function(){ var q=search.value.toLowerCase(); list.querySelectorAll('label').forEach(function(l){ l.style.display=l.dataset.txt.indexOf(q)>=0?'':'none'; }); },120);
  allBtn.onclick=function(){ options.forEach(function(o){setRef.add(o);}); onChange(); };
  clrBtn.onclick=function(){ setRef.clear(); onChange(); };
  wrap.appendChild(search); wrap.appendChild(tools); wrap.appendChild(list);
  host.appendChild(wrap);
  if(!options.length) host.innerHTML='<div class="empty" style="padding:10px">—</div>';
}
function uniqueVals(arr,fn){ var s={}; arr.forEach(function(x){ var v=fn(x); if(v) s[v]=1; }); return Object.keys(s).sort(); }

window.HSI = {
  CONFIG:CONFIG, el:el, esc:esc, fmtInt:fmtInt, fmtMoney:fmtMoney, fmtPct:fmtPct, pct:pct, ymd:ymd, parseYmd:parseYmd, addDays:addDays,
  hourOf:hourOf, fmtHMS:fmtHMS, trunc:trunc, sortDesc:sortDesc, sortAsc:sortAsc, growth:growth, downloadBlob:downloadBlob, csvOf:csvOf, xlsOf:xlsOf, tableToRows:tableToRows,
  classifyEvent:classifyEvent, isTaskDone:isTaskDone, STORE_CODE_NAME:STORE_CODE_NAME, STORE_CITY:STORE_CITY,
  businessDateOf:businessDateOf, BUSINESS_HOURS:BUSINESS_HOURS, OVERNIGHT_HOURS:OVERNIGHT_HOURS, hourLabel:hourLabel,
  loadAll:loadAll, get DATA(){return DATA;}, set DATA(v){DATA=v;}, ownerName:ownerName, storeCodeOfOwner:storeCodeOfOwner, storeNameOf:storeNameOf, webengageHourlySessions:webengageHourlySessions,
  F:F, resetFilters:resetFilters, dealPassF:dealPassF, callPassF:callPassF, taskPassF:taskPassF, activityPassF:activityPassF,
  dealPassFDim:dealPassFDim, callPassFDim:callPassFDim, taskPassFDim:taskPassFDim, activityPassFDim:activityPassFDim, scopedTo:scopedTo,
  refreshThemeColors:refreshThemeColors, lineArea:lineArea, bars:bars, hbars:hbars, donut:donut, legendFor:legendFor,
  card:card, secHead:secHead, gate:gate, table:table, renderFunnel:renderFunnel, buildMultiselect:buildMultiselect, uniqueVals:uniqueVals,
  SOURCES:SOURCES
};
})();
