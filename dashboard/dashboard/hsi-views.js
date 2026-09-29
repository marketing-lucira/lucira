/* ═══════════════════════════════════════════════════════════════════════
   LUCIRA HOURLY STORE & DIGITAL INTELLIGENCE — aggregation + views
   Builds on window.HSI (hsi.js). All aggregation is client-side over the
   real bundle fetched by HSI.loadAll(); nothing here invents a number.
   ═══════════════════════════════════════════════════════════════════════ */
(function(){
'use strict';
var H=window.HSI;
var TABS=[
  {id:'exec',    label:'Executive'},
  {id:'hourly',  label:'Hourly Monitor'},
  {id:'sessions',label:'Sessions'},
  {id:'deals',   label:'Deals'},
  {id:'calls',   label:'Calls'},
  {id:'tasks',   label:'Tasks'},
  {id:'store',   label:'Store Performance'},
  {id:'owner',   label:'Owner Performance'},
  {id:'prevday', label:'Previous Business Day'},
  {id:'alerts',  label:'Alerts'},
  {id:'dq',      label:'Data Quality'}
];
var TAB='exec';

/* ═══════════════════════ derived "current business day" ═══════════════════════
   Anchored to the freshest business_date actually present in the live CRM feed
   (30-min sync), never to the browser clock — same honesty pattern already used
   by walkin-source-api ("most recent day actually in the data"). */
function curBiz(){ return H.DATA.crmMaxBiz; }
function prevBiz(){ return H.addDays(curBiz(),-1); }
function curHourCutoff(){ // latest hour with any record on curBiz, for hour-capped "so far" comparisons
  var d=H.DATA, day=curBiz(), mx=-1;
  d.deals.concat(d.calls,d.activities,d.tasks).forEach(function(r){ if(r.business_date===day && r.hour>mx) mx=r.hour; });
  return mx<0?23:mx;
}

/* ═══════════════════════ AGGREGATION ═══════════════════════ */
function hourRow(day,hour){
  var d=H.DATA;
  // uses the "Dim"-only predicates (owner/store/stage/…) — day+hour are already pinned by this
  // loop itself, so the hour/window-aware predicates must NOT also apply here (see hsi.js note).
  var deals=d.deals.filter(function(x){return x.business_date===day&&x.hour===hour&&H.dealPassFDim(x);});
  var calls=d.calls.filter(function(x){return x.business_date===day&&x.hour===hour&&H.callPassFDim(x);});
  var acts=d.activities.filter(function(x){return x.business_date===day&&x.hour===hour&&H.activityPassFDim(x);});
  var tasks=d.tasks.filter(function(x){return x.business_date===day&&x.hour===hour&&H.taskPassFDim(x);});
  var connected=calls.filter(function(c){return c.connectedFlag;});
  var sv=acts.filter(function(a){return a.type==='Store Visit';}), tah=acts.filter(function(a){return a.type==='TAH';}), vc=acts.filter(function(a){return a.type==='Video Call';});
  var done=tasks.filter(function(t){return t.done;});
  return {hour:hour,label:H.hourLabel(hour),sessions:H.webengageHourlySessions(day,hour),deals:deals.length,calls:calls.length,connected:connected.length,
    storeVisit:sv.length,tah:tah.length,videoCall:vc.length,totalTasks:tasks.length,completed:done.length,pending:tasks.length-done.length};
}
function hourlyTables(day){ return { business:H.BUSINESS_HOURS.map(function(h){return hourRow(day,h);}), overnight:H.OVERNIGHT_HOURS.map(function(h){return hourRow(day,h);}) }; }
function sumRows(rows,keys){ var t={}; keys.forEach(function(k){t[k]=rows.reduce(function(a,r){return a+(r[k]||0);},0);}); return t; }

function dayAgg(day,hourCap){
  var d=H.DATA;
  var deals=d.deals.filter(function(x){return x.business_date===day && H.dealPassF(x) && (hourCap==null||withinCap(x,hourCap));});
  var calls=d.calls.filter(function(x){return x.business_date===day && H.callPassF(x) && (hourCap==null||withinCap(x,hourCap));});
  var acts=d.activities.filter(function(x){return x.business_date===day && H.activityPassF(x) && (hourCap==null||withinCap(x,hourCap));});
  var tasks=d.tasks.filter(function(x){return x.business_date===day && H.taskPassF(x) && (hourCap==null||withinCap(x,hourCap));});
  var connected=calls.filter(function(c){return c.connectedFlag;});
  var done=tasks.filter(function(t){return t.done;});
  return { day:day, deals:deals.length, calls:calls.length, connected:connected.length,
    storeVisit:acts.filter(function(a){return a.type==='Store Visit';}).length,
    tah:acts.filter(function(a){return a.type==='TAH';}).length,
    videoCall:acts.filter(function(a){return a.type==='Video Call';}).length,
    totalTasks:tasks.length, completed:done.length, pending:tasks.length-done.length };
}
// business-hours-only "so far" window uses the record's own hour (0..23 business-day-relative);
// overnight records always count (the overnight window is already fully elapsed relative to a same-day cap)
function withinCap(r,cap){ if(r.window==='Overnight') return true; return r.hour<=cap; }

function ga4Series(){
  var g=H.DATA.ga4; if(!g||!g.session) return null;
  var daily=(g.session.daily||[]).slice().sort(function(a,b){return a.date<b.date?-1:1;});
  return { daily:daily, totals:g.session.totals||{}, devices:g.session.devices||[], cities:g.session.cities||[],
    channels:g.session.channels||[], sourceMedium:g.session.sourceMedium||[], generated_at:g.generated_at, mart:g.mart };
}
/* Real, live (through TODAY — WebEngage's suid-keyed session data has no meaningful lag, unlike
   GA4) day totals built from the same webengage_hourly_sessions data the Hourly Monitor uses —
   strictly better than the GA4 "unified" day snapshot (ga4Series() below), which can be
   weeks stale (see Data Quality). Used for Executive KPIs; the Sessions tab still uses the GA4
   unified snapshot for device/city/channel breakdowns not present in the WebEngage hourly data
   (device_type/city ARE in system_view_v1 too — just not rolled into this hourly table yet). */
function webengageDaySessions(day){
  var hrs=H.BUSINESS_HOURS.concat(H.OVERNIGHT_HOURS); var sessions=0,any=false;
  hrs.forEach(function(h){ var s=H.webengageHourlySessions(day,h); if(s!=null){ any=true; sessions+=s; } });
  return any? {sessions:sessions} : null;
}

function salesItemsInRange(fromD,toD){ var s=H.DATA.sales; if(!s||!s.items) return []; return s.items.filter(function(it){return it.date>=fromD && it.date<=toD;}); }
function salesByDayStore(fromD,toD){
  var items=salesItemsInRange(fromD,toD); var m={};
  items.forEach(function(it){ var k=it.date+'|'+(it.store||'—'); if(!m[k]) m[k]={date:it.date,store:it.store,orders:{},net:0}; m[k].orders[it.document_no]=1; m[k].net+=(it.net||0); });
  return Object.keys(m).map(function(k){ var r=m[k]; return {date:r.date,store:r.store,orders:Object.keys(r.orders).length,net:r.net}; });
}

function ownerAgg(){
  var d=H.DATA, byOwner={};
  function get(id){ if(!byOwner[id]) byOwner[id]={owner:id,name:H.ownerName(id),store:H.storeCodeOfOwner(id),deals:0,calls:0,connected:0,storeVisit:0,tah:0,videoCall:0,totalTasks:0,completed:0,pending:0}; return byOwner[id]; }
  d.deals.filter(H.dealPassF).forEach(function(x){ get(x.owner).deals++; });
  d.calls.filter(H.callPassF).forEach(function(x){ var o=get(x.owner); o.calls++; if(x.connectedFlag) o.connected++; });
  d.activities.filter(H.activityPassF).forEach(function(x){ var o=get(x.owner); if(x.type==='Store Visit') o.storeVisit++; else if(x.type==='TAH') o.tah++; else if(x.type==='Video Call') o.videoCall++; });
  d.tasks.filter(H.taskPassF).forEach(function(x){ var o=get(x.owner); o.totalTasks++; if(x.done) o.completed++; else o.pending++; });
  return Object.keys(byOwner).map(function(k){ var r=byOwner[k]; r.connectedPct=H.pct(r.connected,r.calls); r.storeName=H.storeNameOf(r.store); return r; });
}
function storeAgg(fromD,toD){
  var d=H.DATA, codes=Object.keys(H.STORE_CODE_NAME).concat(['Unmapped']);
  var out=codes.map(function(c){ return {store:c,name:H.storeNameOf(c==='Unmapped'?null:c),deals:0,calls:0,connected:0,storeVisit:0,tah:0,videoCall:0,totalTasks:0,completed:0,pending:0,orders:0,net:0}; });
  var byCode={}; out.forEach(function(o){byCode[o.store]=o;});
  function key(r){ return r.store||'Unmapped'; }
  d.deals.filter(H.dealPassF).forEach(function(x){ byCode[key(x)].deals++; });
  d.calls.filter(H.callPassF).forEach(function(x){ var o=byCode[key(x)]; o.calls++; if(x.connectedFlag) o.connected++; });
  d.activities.filter(H.activityPassF).forEach(function(x){ var o=byCode[key(x)]; if(x.type==='Store Visit') o.storeVisit++; else if(x.type==='TAH') o.tah++; else if(x.type==='Video Call') o.videoCall++; });
  d.tasks.filter(H.taskPassF).forEach(function(x){ var o=byCode[key(x)]; o.totalTasks++; if(x.done) o.completed++; else o.pending++; });
  if(fromD&&toD){ salesByDayStore(fromD,toD).forEach(function(r){ var o=byCode[r.store]; if(o){ o.orders+=r.orders; o.net+=r.net; } }); }
  return out;
}
function taskAging(){
  var d=H.DATA, now=d.crmMaxTs?new Date(d.crmMaxTs.replace(' ','T')):new Date();
  var open=d.tasks.filter(function(t){return !t.done && H.taskPassF(t);});
  var buckets=[{label:'0–2 Hours',n:0},{label:'2–4 Hours',n:0},{label:'4–8 Hours',n:0},{label:'8–24 Hours',n:0},{label:'> 24 Hours',n:0}];
  var rows=open.map(function(t){
    var created=new Date((t.created||'').replace(' ','T')); var ageH=(now-created)/3600000;
    var b = ageH<=2?0:ageH<=4?1:ageH<=8?2:ageH<=24?3:4; buckets[b].n++;
    var overdue = t.due && (new Date((t.due||'').replace(' ','T'))<now);
    return {owner:H.ownerName(t.owner),store:H.storeNameOf(t.store),status:t.status||'—',created:t.created,due:t.due||'—',aging:ageH,overdue:overdue};
  });
  return {buckets:buckets,rows:rows,overdueCount:rows.filter(function(r){return r.overdue;}).length};
}

function computeAlerts(){
  var out=[]; var day=curBiz(), prev=prevBiz(), cap=curHourCutoff();
  var cur=dayAgg(day,cap), pr=dayAgg(prev,cap);
  if(cur.deals < pr.deals*0.5 && cur.calls > 0){ out.push({sev:'warn',kpi:'Deals vs Calls',store:'—',owner:'—',hour:'—',cur:cur.deals,exp:pr.deals,diff:cur.deals-pr.deals,action:'Deals created today-so-far ('+cur.deals+') are well below the same hours on the previous business day ('+pr.deals+') despite ongoing call activity — check lead intake/assignment.'}); }
  if(cur.calls>0){ var connPct=H.pct(cur.connected,cur.calls); if(connPct!=null && connPct<40){ out.push({sev:'crit',kpi:'Call Connectivity',store:'—',owner:'—',hour:'—',cur:connPct.toFixed(1)+'%',exp:'≥40%',diff:null,action:'Overall connected-call rate today-so-far is '+connPct.toFixed(1)+'% — below the 40% reference floor. Review dialing windows/numbers.'}); } }
  var owners=ownerAgg();
  owners.filter(function(o){return o.store;}).forEach(function(o){
    if(o.calls>=5 && o.connectedPct!=null && o.connectedPct<30){ out.push({sev:'warn',kpi:'Low Call Connectivity',store:o.storeName,owner:o.name,hour:'—',cur:o.connectedPct.toFixed(1)+'%',exp:'≥30%',diff:null,action:o.name+' ('+o.storeName+') has '+o.calls+' calls but only '+o.connectedPct.toFixed(1)+'% connected — coach on call timing / number quality.'}); }
  });
  var pendingByOwner={}; H.DATA.tasks.filter(H.taskPassF).forEach(function(t){ if(!t.done){ pendingByOwner[t.owner]=(pendingByOwner[t.owner]||0)+1; } });
  var pendVals=Object.values(pendingByOwner); var medPend=pendVals.length?pendVals.slice().sort(function(a,b){return a-b;})[Math.floor(pendVals.length/2)]:0;
  Object.keys(pendingByOwner).forEach(function(id){ var n=pendingByOwner[id]; if(n> (medPend*2+3)){ out.push({sev:'warn',kpi:'High Pending Tasks',store:H.storeNameOf(H.storeCodeOfOwner(id)),owner:H.ownerName(id),hour:'—',cur:n,exp:'~'+medPend,diff:n-medPend,action:H.ownerName(id)+' has '+n+' pending tasks, well above the '+medPend+'-task company median — review workload/backlog.'}); } });
  owners.filter(function(o){return o.store;}).forEach(function(o){
    if(o.deals===0 && o.calls===0 && o.storeVisit===0 && o.tah===0 && o.videoCall===0){ out.push({sev:'info',kpi:'No Activity',store:o.storeName,owner:o.name,hour:'—',cur:0,exp:'>0',diff:null,action:o.name+' ('+o.storeName+') shows zero deals/calls/meetings in the current filtered scope — confirm this store is staffed/active in this window.'}); }
  });
  var storeAggr=storeAgg(day,day);
  storeAggr.forEach(function(s){ if(s.storeVisit>=5){ var convPct=H.pct(s.orders,s.storeVisit); if(convPct!=null && convPct<10){ out.push({sev:'warn',kpi:'High Store Visit / Low Conversion',store:s.name,owner:'—',hour:'—',cur:convPct.toFixed(1)+'%',exp:'≥10%',diff:null,action:s.name+' logged '+s.storeVisit+' Store Visit meetings but only '+s.orders+' sales orders today ('+convPct.toFixed(1)+'% conversion) — flag for a store-level follow-up review.'}); } } });
  { var wCur=webengageDaySessions(day), wPrev=webengageDaySessions(prev);
    if(wCur && wPrev){ var sessGrowth=H.growth(wCur.sessions,wPrev.sessions);
      if(sessGrowth>25 && cur.deals===0){ out.push({sev:'info',kpi:'High Session / Low Deal',store:'—',owner:'—',hour:'—',cur:fmtN(wCur.sessions),exp:fmtN(wPrev.sessions),diff:null,action:'Real WebEngage sessions on '+day+' rose '+sessGrowth.toFixed(0)+'% vs the previous business day, but 0 CRM deals were created that same business day — note: this is a date-level correlation (WebEngage\'s cuid=mobile key isn\'t yet joined to Deals in this aggregation), not a funnel drop-off proof.'}); }
    }
  }
  var sev={crit:0,warn:1,info:2}; out.sort(function(a,b){return sev[a.sev]-sev[b.sev];});
  return out;
}
function fmtN(v){ return H.fmtInt(+v); }

function dataQuality(){
  var d=H.DATA, S=H.SOURCES;
  var missingOwner=0,missingTs=0; d.deals.concat(d.calls,d.tasks,d.activities).forEach(function(r){ if(!r.owner) missingOwner++; if(!r.created) missingTs++; });
  var totalActivityRows=d.deals.length+d.calls.length+d.tasks.length+d.activities.length;
  var mappedOwnerRows=d.deals.concat(d.calls,d.tasks,d.activities).filter(function(r){return !!r.store;}).length;
  var dealsWithCity=d.deals.filter(function(x){return x.city;}).length;
  var g=ga4Series(); var ga4Lag=null;
  if(g&&g.generated_at){ ga4Lag=Math.round((new Date()-new Date(g.generated_at))/86400000); }
  var salesAsOf=d.sales?d.sales.asOf:null;
  return {
    crm:{ok:S.crm.ok,generated:d.meta&&d.meta.generated,note:S.crm.ok?'Live — synced from Zoho every ~30 min via BigQuery CDC (zoho_crm.cdc_*).':'Fetch failed: '+S.crm.err},
    leads:{ok:S.leads.ok,coverage:H.pct(dealsWithCity,d.deals.length),note:'City/State join covers '+H.fmtInt(dealsWithCity)+' of '+H.fmtInt(d.deals.length)+' deals ('+H.fmtPct(H.pct(dealsWithCity,d.deals.length))+') — cdc_deals\' own Address_City is 0% populated; this comes from a separate live Deals table matched by Deal ID.'},
    ga4:{ok:S.ga4.ok,generated:g&&g.generated_at,lagDays:ga4Lag,note: ga4Lag!=null? ('Day-level "unified" snapshot generated '+g.generated_at+' — '+ga4Lag+' day(s) stale. Now used only for the Sessions tab\'s device/city/channel breakdowns (WebEngage below is the primary Sessions source everywhere else).') : 'GA4 unified snapshot unavailable.'},
    webengageHourly:{ok:S.webengageHourly.ok,generated:S.webengageHourly.generated,note: S.webengageHourly.ok? ('REAL hourly sessions from WebEngage\'s own native BigQuery data-share — `test-webengage.11b56595a_shared.system_view_v1`, the `user_session_started` event, COUNT(DISTINCT suid) per hour. This is WebEngage\'s own session identifier (minted fresh per session by their SDK), not a derived one. Confirmed live through today at build time. Bucketed with the same Business Hours/Overnight business_date logic as the rest of this dashboard. Powers the Hourly Monitor\'s Sessions column and the Executive Sessions KPI. NOT owner/store-filterable (WebEngage carries no CRM dimension) and not yet on an auto-refresh schedule — re-run dashboard/sql/webengage_hourly_sessions_refresh.sql\'s query to update it (currently a 45-day rolling window, one-time build 2026-08-19). Note: this data lives in a DIFFERENT GCP project/region (`test-webengage`, region US) than the rest of this project (`lucirajewelry-prod`, region asia-south1) — BigQuery cannot write cross-region in one job, so this is published straight to GCS rather than via a BigQuery EXPORT DATA table.') : 'Hourly sessions unavailable: '+S.webengageHourly.err},
    sales:{ok:S.sales.ok,asOf:salesAsOf,note: salesAsOf? ('Snapshot as of '+salesAsOf+' (day+store grain, no hour-of-day; store code is real, e.g. CS1/PN1/BO1/N18/PV1/HO).') : 'Sales snapshot unavailable.'},
    webengage:{ok:S.webengageHourly.ok,note:'CORRECTED 2026-08-19: an earlier version of this dashboard concluded WebEngage had no usable session data, based on an exhaustive search of `lucirajewelry-prod` alone. That was wrong — WebEngage\'s real, live, native BigQuery data-share exists in a SEPARATE GCP project (`test-webengage`, dataset `11b56595a_shared`), which a project-scoped search could never find. It has genuine `suid`-keyed sessions (`system_view_v1.user_session_started`) live through today, plus rich real e-commerce events in `application_view_v1` (pageView, productView, addToCart, etc. — ~150K/week). See webengageHourly above for what\'s wired in now. `Lucira_Prod.Webengage_Final` and `Webengage_lucira_global_events_table` in `lucirajewelry-prod` remain campaign-counter-only / 9-month-stale dead ends, unrelated to this real source.'},
    recordsLoaded:{deals:d.deals.length,calls:d.calls.length,tasks:d.tasks.length,meetings:d.activities.length},
    duplicates:{dealsRemoved:d.dupDealsRemoved,rule:'Same Mobile Number + Created Date (calendar day) → keep latest by Modified/Created time.'},
    missingOwner:missingOwner, missingTimestamp:missingTs,
    missingStore:{count:totalActivityRows-mappedOwnerRows,total:totalActivityRows,note:'Store is derived ONLY from 6 known store-owner CRM accounts (Chembur/Pune/Borivali/Noida/Pashchim Vihar Store + HO). Zoho\'s own Store_Assigned field is 0% populated on Deals/Calls/Tasks — every other owner\'s activity is genuinely "Unmapped", not a data error.'},
    missingTaskType:{note:'Zoho Tasks\' own Task_Type field has only 13 non-blank values across the ENTIRE org — unusable for classification at scale. Store Visit / TAH / Video Call activity_type is instead classified from Zoho Meeting titles (classifyEvent keyword match), which is the real, tested source used by this project\'s other CRM dashboards.'},
    invalidSessionIds:{note:'Not applicable — GA4 is consumed here as a pre-aggregated daily/dimensional snapshot (no row-level session export in this project\'s public data), so a null/invalid suid-equivalent check has nothing to check against.'},
    failedJoins:{leadsCity:H.pct(dealsWithCity,d.deals.length)}
  };
}

/* ═══════════════════════ FILTER DRAWER ═══════════════════════ */
function buildFilterDrawer(){
  var D=H.DATA, F=H.F;
  document.getElementById('bizDateInput').value=F.bizDate||curBiz();
  document.getElementById('windowSel').value=F.window;
  H.buildMultiselect(document.getElementById('msOwner'), Object.keys(D.owners).sort(function(a,b){return H.ownerName(a).localeCompare(H.ownerName(b));}), H.ownerName, F.owners, render);
  H.buildMultiselect(document.getElementById('msDealOwner'), Object.keys(D.owners).sort(function(a,b){return H.ownerName(a).localeCompare(H.ownerName(b));}), H.ownerName, F.dealOwners, render);
  H.buildMultiselect(document.getElementById('msStore'), Object.keys(H.STORE_CODE_NAME).concat(['Unmapped']), function(c){return c==='Unmapped'?'Unmapped':H.STORE_CODE_NAME[c];}, F.stores, render);
  H.buildMultiselect(document.getElementById('msCity'), H.uniqueVals(D.deals,function(d){return d.city||'Unknown';}), null, F.cities, render);
  H.buildMultiselect(document.getElementById('msStage'), H.uniqueVals(D.deals,function(d){return d.stage||'(blank)';}), null, F.stages, render);
  H.buildMultiselect(document.getElementById('msTaskStatus'), ['Completed','Pending'], null, F.taskStatus, render);
  H.buildMultiselect(document.getElementById('msCallStatus'), ['Connected','Not Connected'], null, F.callStatus, render);
  H.buildMultiselect(document.getElementById('msSource'), H.uniqueVals(D.deals,function(d){return d.leadSource||'(blank)';}), null, F.sources, render);
  H.buildMultiselect(document.getElementById('msCampaign'), H.uniqueVals(D.deals,function(d){return d.utmSource||'(blank)';}), null, F.campaigns, render);
}
function activeFilterChips(){
  var F=H.F, chips=[];
  if(F.window!=='all') chips.push('Window: '+(F.window==='business'?'Business Hours':'Overnight'));
  if(F.hour!=null) chips.push('Hour: '+H.hourLabel(F.hour));
  [['owners','Owner'],['dealOwners','Deal Owner'],['stores','Store'],['cities','City'],['stages','Stage'],['taskStatus','Task'],['callStatus','Call'],['sources','Source'],['campaigns','Campaign']].forEach(function(p){
    if(F[p[0]].size) chips.push(p[1]+': '+F[p[0]].size+' selected');
  });
  return chips;
}

/* ═══════════════════════ RENDER: EXECUTIVE ═══════════════════════ */
function kpiCard(label,cur,prev,fmt,extra){
  fmt=fmt||H.fmtInt; var g=(prev!=null&&prev!==0)?H.growth(cur,prev):null;
  var sign=g==null?0:(g>0.5?1:g<-0.5?-1:0);
  return '<div class="kpi '+(sign>0?'pos':sign<0?'neg':'neu')+'"><div class="lab">'+esc(label)+'</div><div class="val">'+fmt(cur)+'</div>'
    +(prev!=null?'<div class="row"><span class="delta '+(sign>0?'up':sign<0?'down':'flat')+'">'+(sign>0?'▲':sign<0?'▼':'▬')+' '+(g==null?'—':Math.abs(g).toFixed(1)+'%')+'</span><span class="sub2">vs prev. business day ('+fmt(prev)+')</span></div>':'')
    +(extra?'<div class="sub2" style="margin-top:4px">'+extra+'</div>':'')+'</div>';
}
function esc(s){ return H.esc(s); }

function renderExec(main){
  var day=curBiz(), prev=prevBiz();
  var cur=dayAgg(day,null), pr=dayAgg(prev,null);
  var gCur=webengageDaySessions(day), gPrev=webengageDaySessions(prev);
  var salesToday=storeAgg(day,day).reduce(function(a,s){return {orders:a.orders+s.orders,net:a.net+s.net};},{orders:0,net:0});
  var salesPrev=storeAgg(prev,prev).reduce(function(a,s){return {orders:a.orders+s.orders,net:a.net+s.net};},{orders:0,net:0});
  var html=H.secHead('Command Center','Executive Overview','Business date <b>'+day+'</b> (latest business day with live CRM data) vs previous business day <b>'+prev+'</b>. Sessions are real WebEngage sessions (COUNT DISTINCT suid, same source as the Hourly Monitor) — live through today, not a stale snapshot.');
  html+='<div class="grid g-4">'
    + kpiCard('Total Sessions (WebEngage)', gCur?gCur.sessions:null, gPrev?gPrev.sessions:null)
    + kpiCard('Deals Created', cur.deals, pr.deals)
    + kpiCard('Calls Made', cur.calls, pr.calls)
    + kpiCard('Connected Calls', cur.connected, pr.connected)
    + kpiCard('Store Visits Raised', cur.storeVisit, pr.storeVisit)
    + kpiCard('TAH Raised', cur.tah, pr.tah)
    + kpiCard('Video Calls Raised', cur.videoCall, pr.videoCall)
    + kpiCard('Total Tasks Raised', cur.totalTasks, pr.totalTasks)
    + kpiCard('Tasks Completed', cur.completed, pr.completed)
    + kpiCard('Pending Tasks', cur.pending, pr.pending)
    + kpiCard('Sales Orders', salesToday.orders, salesPrev.orders, null, H.fmtMoney(salesToday.net)+' net')
    +'</div>';
  var alerts=computeAlerts().slice(0,4);
  html+='<div style="margin-top:20px">'+H.secHead('Attention','Top Signals')+'<div class="grid g-2">'+(alerts.length?alerts.map(function(a){
    return '<div class="alert '+(a.sev==='crit'?'crit':a.sev==='warn'?'warn':'info')+'"><div class="ic">'+(a.sev==='crit'?'⛔':a.sev==='warn'?'⚠':'ℹ')+'</div><div><h4>'+esc(a.kpi)+'</h4><p>'+a.action+'</p></div></div>';
  }).join(''):'<div class="empty">No alerts triggered in the current filter scope.</div>')+'</div></div>';
  main.innerHTML=html;
  wireCardMenus(main);
}

/* ═══════════════════════ RENDER: HOURLY MONITOR ═══════════════════════ */
function renderHourly(main){
  var day=H.F.bizDate||curBiz();
  var t=hourlyTables(day);
  var bizCols=[{h:'Hour',k:'label'},{h:'Sessions',k:'sessions',num:true,f:function(r){return r.sessions==null?'<span title="No WebEngage session data for this hour/date in the 45-day rolling window.">—</span>':'<span title="Real WebEngage sessions (COUNT DISTINCT suid — WebEngage\'s own native session identifier, not derived) for this hour, from test-webengage.11b56595a_shared.system_view_v1. NOT owner/store-filterable — WebEngage sessions carry no CRM owner/store dimension, so this number stays constant regardless of the Owner/Store filters while the other columns in this row change.">'+H.fmtInt(r.sessions)+'</span>';}},{h:'Deals',k:'deals',num:true},{h:'Calls',k:'calls',num:true},{h:'Connected',k:'connected',num:true},{h:'Store Visit (Meeting)',k:'storeVisit',num:true},{h:'TAH (Meeting)',k:'tah',num:true},{h:'Video Call (Meeting)',k:'videoCall',num:true},{h:'Total Tasks',k:'totalTasks',num:true},{h:'Completed',k:'completed',num:true},{h:'Pending',k:'pending',num:true}];
  var totB=sumRows(t.business,['sessions','deals','calls','connected','storeVisit','tah','videoCall','totalTasks','completed','pending']);
  var totO=sumRows(t.overnight,['sessions','deals','calls','connected','storeVisit','tah','videoCall','totalTasks','completed','pending']);
  var showBiz = H.F.window!=='overnight', showOvn = H.F.window!=='business';
  var html=H.secHead('Live Monitor','Hourly Store & Digital Monitor','Business date: <b>'+day+'</b> · Sessions = real WebEngage sessions per hour (suid-keyed, built '+ (H.SOURCES.webengageHourly.generated? new Date(H.SOURCES.webengageHourly.generated).toLocaleString('en-IN'):'—') +', not owner/store-filterable — hover the column header). "Store Visit / TAH / Video Call" come from the Zoho <b>Meetings</b> module (classified from the meeting title) — the Tasks module\'s own Task_Type field is unusable at scale (13 non-blank values org-wide). Click a row to drill into that hour (scopes every other tab; this table itself always keeps showing all hours).');
  html+='<div class="fld" style="max-width:260px;margin-bottom:14px"><label>Business Date</label><input type="date" class="inp" id="hourlyDayPick" value="'+day+'"></div>';
  main.innerHTML=html;

  if(showBiz){
    var c1=document.createElement('div'); c1.innerHTML=H.card('Business Hours Activity — 10 AM to 9 PM','',{}); main.appendChild(c1.firstChild);
    var host=main.querySelector('.card:last-child .pad');
    var t1host=H.el('div'); host.appendChild(t1host);
    H.table(t1host,bizCols,t.business,{foot:Object.assign({label:'TOTAL'},totB),onRowClick:function(r){ H.F.hour=r.hour; render(); }});
    host.appendChild(H.el('div','','<div style="margin-top:14px">'+H.bars(t.business.map(function(r){return {label:r.label,value:r.deals,color:'var(--gold)'};}))+'</div>'));
  }
  if(showOvn){
    var card2=document.createElement('div'); card2.innerHTML=H.card('Overnight Activity — 9 PM to 10 AM','',{}); main.appendChild(card2.firstChild);
    var host2=main.querySelector('.card:last-child .pad');
    var t2host=H.el('div'); host2.appendChild(t2host);
    H.table(t2host,bizCols,t.overnight,{foot:Object.assign({label:'TOTAL'},totO),onRowClick:function(r){ H.F.hour=r.hour; render(); }});
    host2.appendChild(H.el('div','','<div style="margin-top:14px">'+H.bars(t.overnight.map(function(r){return {label:r.label,value:r.deals,color:'var(--series-1)'};}))+'</div>'));
  }

  var card3=document.createElement('div'); card3.innerHTML=H.card('Hourly Funnel (Business Hours)','',{}); main.appendChild(card3.firstChild);
  var fhost=main.querySelector('.card:last-child .pad');
  var stages=[{label:'Deals Created',n:totB.deals},{label:'Calls Made',n:totB.calls},{label:'Connected Calls',n:totB.connected},{label:'Store Visit Meetings',n:totB.storeVisit},{label:'TAH Meetings',n:totB.tah},{label:'Video Call Meetings',n:totB.videoCall}];
  H.renderFunnel(fhost,stages);
  fhost.insertAdjacentHTML('beforeend','<div class="gate-note" style="margin-top:10px">Read this as independent per-stage VOLUME for the business date, not a cohort funnel — a call counted here can belong to a deal created on a different day, so "Calls" exceeding "Deals" is expected, not an error. Sessions and Sale/Order steps are intentionally omitted for now — Sales/Orders has no hour-of-day timestamp, and while WebEngage sessions DO carry a real identity key (`cuid` = mobile number, the same key already used for the Deal City join), that Sessions→Deal join hasn\'t been built into this hourly aggregation yet, so it\'s left out rather than half-built. See Previous Business Day tab for a day-level Sales view.</div>');

  document.getElementById('hourlyDayPick').onchange=function(e){ H.F.bizDate=e.target.value; render(); };
  wireCardMenus(main);
}

/* ═══════════════════════ RENDER: SESSIONS (GA4) ═══════════════════════ */
function renderSessions(main){
  var g=ga4Series();
  var html=H.secHead('Digital Behaviour','Session Intelligence (GA4)','Real GA4 session/user data — DAY grain only, no suid/device_type/landing_page hour-level export in this project\'s public snapshot. WebEngage in this environment has no session-level fields at all (see Data Quality).');
  if(!g){ main.innerHTML=html+H.gate('GA4 snapshot could not be loaded ('+(H.SOURCES.ga4.err||'unknown error')+').'); return; }
  var last30=g.daily.slice(-30);
  var tot=last30.reduce(function(a,r){return {sessions:a.sessions+ +r.sessions,users:a.users+ +r.users,pv:a.pv+ +r.pageViews};},{sessions:0,users:0,pv:0});
  html+='<div class="grid g-4">'
    + kpiCard('Sessions (last 30d)', tot.sessions, null)
    + kpiCard('Unique Users (last 30d)', tot.users, null)
    + kpiCard('Sessions / User', tot.users? (tot.sessions/tot.users):null, null, function(v){return v==null?'—':v.toFixed(2);})
    + kpiCard('Avg Pages / Session', tot.sessions? (tot.pv/tot.sessions):null, null, function(v){return v==null?'—':v.toFixed(2);})
    +'</div>';
  html+='<div class="grid g-2" style="margin-top:18px">'
    + H.card('Sessions — last 30 days', H.lineArea([{name:'Sessions',color:'var(--gold)',data:last30.map(function(r){return +r.sessions;})}], last30.map(function(r){return r.date.slice(5);})))
    + H.card('Sessions by Device (window total)', H.donut(g.devices.map(function(dv,i){return {label:dv.name,value:+dv.sessions,color:'var(--series-'+((i%5)+1)+')'};}),{centerSub:'SESSIONS'}))
    +'</div>';
  html+='<div class="grid g-2" style="margin-top:18px">'
    + H.card('Sessions by City (window total, top 10)', H.hbars(H.sortDesc(g.cities.map(function(c){return {label:c.name,value:+c.sessions};}),'value').slice(0,10)))
    + H.card('Sessions by Channel (window total)', H.hbars(H.sortDesc((g.channels||[]).map(function(c){return {label:c.name||c.channel,value:+(c.sessions||0)};}),'value').slice(0,10)))
    +'</div>';
  html+=H.gate('Pincode-level session breakdown is not available: GA4\'s own geo dimension stops at City. A separate, indirect WebEngage→pincode join exists elsewhere in this project (matching WebEngage cuid=mobile to a Zoho Deal\'s Address_Zip) covering only ~340 of ~180K WebEngage contacts — too sparse and out of scope to merge into this session view without overstating precision.');
  main.innerHTML=html;
  wireCardMenus(main);
}

/* ═══════════════════════ RENDER: DEALS ═══════════════════════ */
function renderDeals(main){
  var d=H.DATA, deals=d.deals.filter(H.dealPassF);
  var won=deals.filter(function(x){return x.stage==='Closed Won';}).length;
  var lost=deals.filter(function(x){return x.stage==='Closed Lost';}).length;
  var open=deals.length-won-lost;
  var html=H.secHead('Pipeline','Deal Intelligence','Deal Stage vocabulary in this CRM is funnel-style (Prospect/ATC/Checkout/Payment/Closed Won/Closed Lost) — "Open" below folds every non-closed stage together (no distinct "WIP" stage exists). Deal Amount is populated on <0.5% of deals org-wide, so Deal Value is not shown as a headline KPI.');
  html+='<div class="grid g-4">'
    +kpiCard('Deals Created',deals.length,null)+kpiCard('Deals Open',open,null)+kpiCard('Deals Closed Won',won,null)+kpiCard('Deals Closed Lost',lost,null)
    +'</div>';
  var byOwner=H.sortDesc(ownerAgg().filter(function(o){return o.deals>0;}),'deals');
  var byStore=H.sortDesc(storeAgg(),'deals').filter(function(s){return s.deals>0;});
  html+='<div class="grid g-2" style="margin-top:18px">'
    + H.card('Owner Performance — Deals', H.hbars(byOwner.slice(0,12).map(function(o){return {label:o.name,value:o.deals};})))
    + H.card('Store Performance — Deals', H.hbars(byStore.map(function(s){return {label:s.name,value:s.deals};})))
    +'</div>';
  html+=H.card('Deal Owner Detail','',{});
  main.innerHTML=html;
  var host=main.querySelector('.card:last-child .pad'); var t=H.el('div'); host.appendChild(t);
  H.table(t,[{h:'Owner',k:'name'},{h:'Store',k:'storeName'},{h:'Deals',k:'deals',num:true},{h:'Calls',k:'calls',num:true},{h:'Connected %',k:'connectedPct',num:true,f:function(r){return H.fmtPct(r.connectedPct);}}], byOwner, {});
  wireCardMenus(main);
}

/* ═══════════════════════ RENDER: CALLS ═══════════════════════ */
function renderCalls(main){
  var d=H.DATA, calls=d.calls.filter(H.callPassF);
  var connected=calls.filter(function(c){return c.connectedFlag;});
  var connPct=H.pct(connected.length,calls.length);
  var byOwner=H.sortDesc(ownerAgg().filter(function(o){return o.calls>0;}),'calls');
  var byStore=H.sortDesc(storeAgg(),'calls').filter(function(s){return s.calls>0;});
  var html=H.secHead('Contact Center','Call Intelligence','"Connected" = duration > '+H.CONFIG.CONNECTED_SECS+'s (the threshold already used by this CRM\'s Agent Performance table). Zoho\'s Call_Result field is not reliably populated enough to split "Not Connected" into Missed vs Busy vs No Answer, so those stay folded into one "Not Connected" bucket.');
  html+='<div class="grid g-4">'+kpiCard('Total Calls',calls.length,null)+kpiCard('Connected Calls',connected.length,null)+kpiCard('Not Connected',calls.length-connected.length,null)+kpiCard('Connected %',connPct,null,H.fmtPct)+'</div>';
  html+='<div class="grid g-2" style="margin-top:18px">'
    + H.card('Owner — Calls vs Connected', H.hbars(byOwner.slice(0,12).map(function(o){return {label:o.name,value:o.calls};})))
    + H.card('Store — Calls vs Connected', H.hbars(byStore.map(function(s){return {label:s.name,value:s.calls};})))
    +'</div>';
  html+=H.card('Calls → Deals (Owner detail)','',{});
  main.innerHTML=html;
  var host=main.querySelector('.card:last-child .pad'); var t=H.el('div'); host.appendChild(t);
  H.table(t,[{h:'Owner',k:'name'},{h:'Store',k:'storeName'},{h:'Calls',k:'calls',num:true},{h:'Connected',k:'connected',num:true},{h:'Connected %',k:'connectedPct',num:true,f:function(r){return H.fmtPct(r.connectedPct);}},{h:'Deals',k:'deals',num:true},{h:'Call→Deal %',k:'c2d',num:true,f:function(r){return H.fmtPct(H.pct(r.deals,r.calls));}}], byOwner, {});
  wireCardMenus(main);
}

/* ═══════════════════════ RENDER: TASKS ═══════════════════════ */
function renderTasks(main){
  var d=H.DATA, tasks=d.tasks.filter(H.taskPassF), acts=d.activities.filter(H.activityPassF);
  var done=tasks.filter(function(t){return t.done;});
  var aging=taskAging();
  var html=H.secHead('Workload','Task & Activity Intelligence','Two DIFFERENT real Zoho modules, kept separate: "Total/Completed/Pending Tasks" = the generic Zoho Tasks module (status-based only — Task_Type is unusable, see Data Quality). "Store Visit / TAH / Video Call" = Zoho Meetings, classified from the meeting title.');
  html+='<div class="grid g-4">'
    +kpiCard('Total Tasks',tasks.length,null)+kpiCard('Completed',done.length,null)+kpiCard('Pending',tasks.length-done.length,null)
    +kpiCard('Store Visit / TAH / Video Call', acts.filter(function(a){return a.type!=='Other';}).length, null)
    +'</div>';
  html+='<div class="grid g-2" style="margin-top:18px">'
    + H.card('Meeting Type Split', H.donut(['Store Visit','TAH','Video Call','Other'].map(function(t,i){return {label:t,value:acts.filter(function(a){return a.type===t;}).length,color:'var(--series-'+(i+1)+')'};}),{centerSub:'MEETINGS'}))
    + H.card('Task Aging (open tasks)', H.bars(aging.buckets.map(function(b){return {label:b.label,value:b.n,color:'var(--warn)'};})))
    +'</div>';
  html+=H.gate((aging.overdueCount)+' of '+aging.rows.length+' open tasks (in the current filter scope) are past their Due_Date (overdue).');
  var DETAIL_CAP=500;
  var sortedAging=H.sortDesc(aging.rows,'aging');
  var shown=sortedAging.slice(0,DETAIL_CAP);
  html+=H.card('Task Aging Detail — oldest '+H.fmtInt(shown.length)+' of '+H.fmtInt(sortedAging.length)+' open tasks','',{});
  main.innerHTML=html;
  var host=main.querySelector('.card:last-child .pad');
  if(sortedAging.length>DETAIL_CAP) host.insertAdjacentHTML('beforeend','<div class="gate-note" style="margin-bottom:12px">Showing the '+DETAIL_CAP+' oldest open tasks by aging (out of '+H.fmtInt(sortedAging.length)+' total in scope) to keep this table fast to render. Narrow the Owner/Store filter in the drawer to see a smaller, complete slice.</div>');
  var t=H.el('div'); host.appendChild(t);
  H.table(t,[{h:'Owner',k:'owner'},{h:'Store',k:'store'},{h:'Status',k:'status'},{h:'Created',k:'created'},{h:'Due',k:'due'},{h:'Aging (hrs)',k:'aging',num:true,f:function(r){return r.aging.toFixed(1);}},{h:'Overdue',k:'overdue',f:function(r){return r.overdue?'<span class="pill bad">Overdue</span>':'<span class="pill ok">On time</span>';}}], shown, {});
  wireCardMenus(main);
}

/* ═══════════════════════ RENDER: STORE PERFORMANCE ═══════════════════════ */
function renderStore(main){
  var day=curBiz();
  var stores=H.sortDesc(storeAgg(H.addDays(day,-29),day),'deals');
  var html=H.secHead('Retail Network','Store Performance','Store attribution covers ONLY the 6 known store-owner CRM accounts + Sales\' real `store` code. Any Deal/Call/Task/Meeting owned by a non-store CRM account is genuinely "Unmapped" — not dropped, shown as its own row below.');
  html+=H.card('Store Ranking (last 30 business days, Sales = last 30 calendar days)','',{});
  main.innerHTML=html;
  var host=main.querySelector('.card:last-child .pad'); var t=H.el('div'); host.appendChild(t);
  H.table(t,[{h:'Store',k:'name'},{h:'Deals',k:'deals',num:true},{h:'Calls',k:'calls',num:true},{h:'Connected',k:'connected',num:true},{h:'Store Visit',k:'storeVisit',num:true},{h:'TAH',k:'tah',num:true},{h:'Video Call',k:'videoCall',num:true},{h:'Tasks',k:'totalTasks',num:true},{h:'Completed',k:'completed',num:true},{h:'Pending',k:'pending',num:true},{h:'Orders',k:'orders',num:true},{h:'Net Sales',k:'net',num:true,f:function(r){return H.fmtMoney(r.net);}}], stores, {});
  var card2=document.createElement('div'); card2.innerHTML=H.card('Store Ranking Chart','',{}); main.appendChild(card2.firstChild);
  main.querySelector('.card:last-child .pad').innerHTML=H.hbars(stores.filter(function(s){return s.deals>0;}).map(function(s){return {label:s.name,value:s.deals};}));
  wireCardMenus(main);
}

/* ═══════════════════════ RENDER: OWNER PERFORMANCE ═══════════════════════ */
function renderOwner(main){
  var owners=H.sortDesc(ownerAgg().filter(function(o){return o.deals+o.calls+o.storeVisit+o.tah+o.videoCall+o.totalTasks>0;}),'deals');
  var topDeals=H.sortDesc(owners,'deals').slice(0,5), topConn=H.sortDesc(owners.filter(function(o){return o.calls>=3;}),'connectedPct').slice(0,5);
  var topPending=H.sortDesc(owners,'pending').slice(0,5), bottom=H.sortAsc(owners,'deals').slice(0,5);
  var html=H.secHead('People','Owner Intelligence','owner_id is the join key throughout (unified across Deals/Calls/Tasks/Meetings by the live CRM feed); owner_name is shown. Selecting an Owner in the filter drawer updates every tab in this dashboard.');
  html+='<div class="grid g-2">'
    + H.card('Top Owners — Deals', H.hbars(topDeals.map(function(o){return {label:o.name,value:o.deals};})))
    + H.card('Highest Call Conversion (min. 3 calls)', H.hbars(topConn.map(function(o){return {label:o.name,value:Math.round(o.connectedPct||0)};})))
    + H.card('Highest Pending Tasks', H.hbars(topPending.map(function(o){return {label:o.name,value:o.pending};})))
    + H.card('Lowest Deal Volume (needs attention)', H.hbars(bottom.map(function(o){return {label:o.name,value:o.deals};})))
    +'</div>';
  html+=H.card('Owner Detail — All Activity','',{});
  main.innerHTML=html;
  var host=main.querySelector('.card:last-child .pad'); var t=H.el('div'); host.appendChild(t);
  H.table(t,[{h:'Owner',k:'name'},{h:'Store',k:'storeName'},{h:'Deals',k:'deals',num:true},{h:'Calls',k:'calls',num:true},{h:'Connected %',k:'connectedPct',num:true,f:function(r){return H.fmtPct(r.connectedPct);}},{h:'Store Visit',k:'storeVisit',num:true},{h:'TAH',k:'tah',num:true},{h:'Video Call',k:'videoCall',num:true},{h:'Tasks',k:'totalTasks',num:true},{h:'Completed',k:'completed',num:true},{h:'Pending',k:'pending',num:true}], owners, {onRowClick:function(r){ H.F.owners=new Set([r.owner]); render(); }});
  wireCardMenus(main);
}

/* ═══════════════════════ RENDER: PREVIOUS BUSINESS DAY ═══════════════════════ */
function renderPrevDay(main){
  var day=prevBiz();
  var t=hourlyTables(day);
  var totB=sumRows(t.business,['storeVisit','tah','videoCall']); var totO=sumRows(t.overnight,['storeVisit','tah','videoCall']);
  var stores=H.sortDesc(storeAgg(day,day).filter(function(s){return s.totalTasks+s.storeVisit+s.tah+s.videoCall>0;}),'totalTasks');
  var owners=H.sortDesc(ownerAgg().filter(function(o){return o.totalTasks>0;}),'totalTasks');
  var aging=taskAging();
  var html=H.secHead('Yesterday','Previous Business Day Activity','Previous business day = <b>'+day+'</b> (the day before the freshest date actually in the live CRM feed).');
  html+='<div class="grid g-4">'+kpiCard('Store Visits Raised',totB.storeVisit+totO.storeVisit,null)+kpiCard('TAH Raised',totB.tah+totO.tah,null)+kpiCard('Video Calls Raised',totB.videoCall+totO.videoCall,null)+kpiCard('Overdue Tasks (as of now)',aging.overdueCount,null)+'</div>';
  html+='<div class="grid g-2" style="margin-top:18px">'
    + H.card('Business Hours — Store Activity', H.bars(t.business.map(function(r){return {label:r.label,value:r.storeVisit+r.tah+r.videoCall,color:'var(--gold)'};})))
    + H.card('Overnight — Store Activity', H.bars(t.overnight.map(function(r){return {label:r.label,value:r.storeVisit+r.tah+r.videoCall,color:'var(--series-1)'};})))
    +'</div>';
  html+=H.card('Store-wise Task Table','',{});
  main.innerHTML=html;
  var h1=main.querySelector('.card:last-child .pad'); var t1=H.el('div'); h1.appendChild(t1);
  H.table(t1,[{h:'Store',k:'name'},{h:'Store Visit',k:'storeVisit',num:true},{h:'TAH',k:'tah',num:true},{h:'Video Call',k:'videoCall',num:true},{h:'Total Tasks',k:'totalTasks',num:true},{h:'Completed',k:'completed',num:true},{h:'Pending',k:'pending',num:true}], stores, {});
  var c2=document.createElement('div'); c2.innerHTML=H.card('Owner-wise Task Table','',{}); main.appendChild(c2.firstChild);
  var h2=main.querySelector('.card:last-child .pad'); var t2=H.el('div'); h2.appendChild(t2);
  H.table(t2,[{h:'Owner',k:'name'},{h:'Store',k:'storeName'},{h:'Store Visit',k:'storeVisit',num:true},{h:'TAH',k:'tah',num:true},{h:'Video Call',k:'videoCall',num:true},{h:'Total Tasks',k:'totalTasks',num:true},{h:'Completed',k:'completed',num:true},{h:'Pending',k:'pending',num:true}], owners, {});
  wireCardMenus(main);
}

/* ═══════════════════════ RENDER: ALERTS ═══════════════════════ */
function renderAlerts(main){
  var alerts=computeAlerts();
  var html=H.secHead('Attention Required','Alert & Opportunity Engine','Rule-based, computed live from the same filtered data as every other tab — thresholds are documented inline on each alert.');
  html+='<div class="grid" style="grid-template-columns:1fr;gap:12px">'+(alerts.length?alerts.map(function(a){
    return '<div class="alert '+(a.sev==='crit'?'crit':a.sev==='warn'?'warn':'info')+'"><div class="ic">'+(a.sev==='crit'?'⛔':a.sev==='warn'?'⚠':'ℹ')+'</div><div style="flex:1"><h4>'+esc(a.kpi)+(a.store&&a.store!=='—'?' · '+esc(a.store):'')+(a.owner&&a.owner!=='—'?' · '+esc(a.owner):'')+'</h4><p>'+a.action+'</p><div style="margin-top:6px;font-size:11px;color:var(--muted)">Current: <b>'+esc(a.cur)+'</b> &nbsp;·&nbsp; Reference: <b>'+esc(a.exp)+'</b></div></div></div>';
  }).join(''):'<div class="empty">No alerts triggered in the current filter scope — widen the date/owner/store filters if you expected results.</div>')+'</div>';
  main.innerHTML=html;
}

/* ═══════════════════════ RENDER: DATA QUALITY ═══════════════════════ */
function renderDQ(main){
  var q=dataQuality();
  var html=H.secHead('Trust & Freshness','Data Quality','Every gap below is a confirmed fact, not a guess — see hsi.js source comments for the underlying checks.');
  html+='<div class="grid g-2">'
    + H.card('Source Freshness','<table class="dt"><tbody>'
      +'<tr><td>Zoho CRM (Deals/Calls/Tasks/Meetings)</td><td class="num">'+(q.crm.ok?'<span class="pill ok">Live</span>':'<span class="pill bad">Failed</span>')+'</td></tr>'
      +'<tr><td colspan="2" style="color:var(--muted);font-size:11.5px">'+q.crm.note+' Last fetch: '+(q.crm.generated||'—')+'</td></tr>'
      +'<tr><td>GA4 Sessions (day-level snapshot)</td><td class="num">'+(q.ga4.ok?'<span class="pill warn">Stale</span>':'<span class="pill bad">Failed</span>')+'</td></tr>'
      +'<tr><td colspan="2" style="color:var(--muted);font-size:11.5px">'+q.ga4.note+'</td></tr>'
      +'<tr><td>WebEngage Sessions (real hourly)</td><td class="num">'+(q.webengageHourly.ok?'<span class="pill ok">Live</span>':'<span class="pill bad">Failed</span>')+'</td></tr>'
      +'<tr><td colspan="2" style="color:var(--muted);font-size:11.5px">'+q.webengageHourly.note+'</td></tr>'
      +'<tr><td>Sales / Orders</td><td class="num">'+(q.sales.ok?'<span class="pill ok">Live</span>':'<span class="pill bad">Failed</span>')+'</td></tr>'
      +'<tr><td colspan="2" style="color:var(--muted);font-size:11.5px">'+q.sales.note+'</td></tr>'
      +'<tr><td>WebEngage (see correction below)</td><td class="num">'+(q.webengage.ok?'<span class="pill ok">Live</span>':'<span class="pill bad">Not wired</span>')+'</td></tr>'
      +'<tr><td colspan="2" style="color:var(--muted);font-size:11.5px">'+q.webengage.note+'</td></tr>'
      +'</tbody></table>')
    + H.card('Records Loaded','<table class="dt"><tbody>'
      +'<tr><td>Deals</td><td class="num">'+H.fmtInt(q.recordsLoaded.deals)+'</td></tr>'
      +'<tr><td>Calls</td><td class="num">'+H.fmtInt(q.recordsLoaded.calls)+'</td></tr>'
      +'<tr><td>Tasks</td><td class="num">'+H.fmtInt(q.recordsLoaded.tasks)+'</td></tr>'
      +'<tr><td>Meetings</td><td class="num">'+H.fmtInt(q.recordsLoaded.meetings)+'</td></tr>'
      +'<tr><td>Duplicate deals removed</td><td class="num">'+H.fmtInt(q.duplicates.dealsRemoved)+'</td></tr>'
      +'<tr><td colspan="2" style="color:var(--muted);font-size:11.5px">Rule: '+q.duplicates.rule+'</td></tr>'
      +'</tbody></table>')
    +'</div>';
  html+='<div class="grid g-2" style="margin-top:18px">'
    + H.card('Missing / Unmapped', '<table class="dt"><tbody>'
      +'<tr><td>Missing Owner</td><td class="num">'+H.fmtInt(q.missingOwner)+'</td></tr>'
      +'<tr><td>Missing Timestamp</td><td class="num">'+H.fmtInt(q.missingTimestamp)+'</td></tr>'
      +'<tr><td>Missing Store (Unmapped)</td><td class="num">'+H.fmtInt(q.missingStore.count)+' / '+H.fmtInt(q.missingStore.total)+'</td></tr>'
      +'<tr><td colspan="2" style="color:var(--muted);font-size:11.5px">'+q.missingStore.note+'</td></tr>'
      +'<tr><td>Missing Task Type</td><td class="num">N/A</td></tr>'
      +'<tr><td colspan="2" style="color:var(--muted);font-size:11.5px">'+q.missingTaskType.note+'</td></tr>'
      +'<tr><td>Invalid/Null Session IDs</td><td class="num">N/A</td></tr>'
      +'<tr><td colspan="2" style="color:var(--muted);font-size:11.5px">'+q.invalidSessionIds.note+'</td></tr>'
      +'</tbody></table>')
    + H.card('Join Coverage', '<table class="dt"><tbody>'
      +'<tr><td>Deals ↔ City/State (leads-city join)</td><td class="num">'+H.fmtPct(q.failedJoins.leadsCity)+'</td></tr>'
      +'<tr><td colspan="2" style="color:var(--muted);font-size:11.5px">'+q.leads.note+'</td></tr>'
      +'</tbody></table>')
    +'</div>';
  main.innerHTML=html;
}

/* ═══════════════════════ WIRING: card export menu, tabs, drawer, boot ═══════════════════════ */
function wireCardMenus(scope){
  scope.querySelectorAll('[data-cmenu]').forEach(function(btn){
    btn.onclick=function(e){ e.stopPropagation();
      var card=btn.closest('.card'); var tbl=card.querySelector('table.dt'); var svg=card.querySelector('svg');
      var menu=document.getElementById('cmenu'); menu.innerHTML='';
      if(tbl){ var b1=H.el('button','','⬇ Export to CSV'); b1.onclick=function(){ H.downloadBlob(H.csvOf(H.tableToRows(tbl)),'export.csv','text/csv'); menu.classList.remove('on'); }; menu.appendChild(b1);
        var b2=H.el('button','','⬇ Export to Excel'); b2.onclick=function(){ H.downloadBlob(H.xlsOf(H.tableToRows(tbl)),'export.xls','application/vnd.ms-excel'); menu.classList.remove('on'); }; menu.appendChild(b2); }
      if(svg){ var b3=H.el('button','','⬇ Download chart (SVG)'); b3.onclick=function(){ H.downloadBlob('<?xml version="1.0" encoding="UTF-8"?>\n'+new XMLSerializer().serializeToString(svg),'chart.svg','image/svg+xml'); menu.classList.remove('on'); }; menu.appendChild(b3); }
      var r=btn.getBoundingClientRect(); menu.style.left=Math.max(8,r.right-200)+'px'; menu.style.top=(r.bottom+6)+'px'; menu.classList.add('on');
    };
  });
}
document.addEventListener('click',function(e){ if(!e.target.closest('#cmenu')&&!e.target.closest('[data-cmenu]')){ var m=document.getElementById('cmenu'); if(m) m.classList.remove('on'); } });

function setTab(id){ TAB=id; document.querySelectorAll('.tab').forEach(function(t){ t.classList.toggle('active',t.dataset.tab===id); }); render(); }
function render(){
  var main=document.getElementById('main');
  document.getElementById('chips').innerHTML=activeFilterChips().map(function(c){return '<span class="chip">'+esc(c)+'</span>';}).join('');
  if(!H.DATA){ main.innerHTML='<div class="empty">Loading live data…</div>'; return; }
  H.refreshThemeColors();
  ({exec:renderExec,hourly:renderHourly,sessions:renderSessions,deals:renderDeals,calls:renderCalls,tasks:renderTasks,store:renderStore,owner:renderOwner,prevday:renderPrevDay,alerts:renderAlerts,dq:renderDQ}[TAB]||renderExec)(main);
  document.querySelectorAll('.tip[data-tip]').length; // no-op, tooltips handled via title attr fallback
}

function boot(){
  var tabsHost=document.getElementById('tabs');
  tabsHost.innerHTML=TABS.map(function(t){return '<div class="tab'+(t.id==='exec'?' active':'')+'" data-tab="'+t.id+'">'+esc(t.label)+'</div>';}).join('');
  tabsHost.querySelectorAll('.tab').forEach(function(t){ t.onclick=function(){ setTab(t.dataset.tab); }; });

  document.getElementById('windowSel').onchange=function(e){ H.F.window=e.target.value; render(); };
  document.getElementById('bizDateInput').onchange=function(e){ H.F.bizDate=e.target.value; render(); };
  document.getElementById('btnApply').onclick=function(){ closeDrawer(); render(); };
  document.getElementById('btnReset').onclick=function(){ H.resetFilters(); buildFilterDrawer(); render(); };
  document.getElementById('btnFilter').onclick=openDrawer;
  document.getElementById('btnDrawerClose').onclick=closeDrawer;
  document.getElementById('scrim').onclick=closeDrawer;
  document.getElementById('btnTheme').onclick=function(){ var html=document.documentElement; var t=html.getAttribute('data-theme')==='dark'?'light':'dark'; html.setAttribute('data-theme',t); H.refreshThemeColors(); render(); };
  document.getElementById('btnFull').onclick=function(){ if(!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen(); };
  document.getElementById('btnPrint').onclick=function(){ window.print(); };
  document.getElementById('btnRefreshNow').onclick=function(){ loadAndRender(true); };

  function openDrawer(){ document.getElementById('drawer').classList.add('on'); document.getElementById('scrim').classList.add('on'); buildFilterDrawer(); }
  function closeDrawer(){ document.getElementById('drawer').classList.remove('on'); document.getElementById('scrim').classList.remove('on'); }

  loadAndRender(false);
  if(H.CONFIG.AUTO_MS>0) setInterval(function(){ loadAndRender(true); }, H.CONFIG.AUTO_MS);
}

function loadAndRender(isRefresh){
  var dot=document.getElementById('srcDot'), txt=document.getElementById('srcTxt'), fresh=document.getElementById('freshPill');
  H.loadAll().then(function(D){
    H.DATA=D; if(!H.F.bizDate) H.resetFilters();
    dot.classList.add('live'); txt.textContent='Live · CRM 30-min sync';
    fresh.textContent='Updated '+new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})+' · Latest business day: '+D.crmMaxBiz;
    document.getElementById('loader').classList.add('done'); document.getElementById('app').classList.add('ready');
    render();
  }).catch(function(e){
    txt.textContent='Load failed: '+e.message;
    document.getElementById('loader').classList.add('done'); document.getElementById('app').classList.add('ready');
  });
}

document.addEventListener('DOMContentLoaded',boot);
window.HSIV={setTab:setTab,render:render};
})();
