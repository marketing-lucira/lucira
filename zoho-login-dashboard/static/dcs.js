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
function pd(a){ return {id:a[0],name:a[1],owner:a[2],created:a[3],stage:a[4],prob:a[5],leadSource:a[6],reasonLoss:a[7],trigger:a[8],utmSource:a[9],utmMedium:a[10],numAct:a[11]||0,mobile:normPhone(a[12]),modified:a[13]||null}; }
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

/* Global unique-deal rule (client spec): one deal per Mobile Number + Created Date
   (calendar day, not owner-scoped — unlike dedupeByMobileDay() below which is owner-scoped
   for the Agent Performance table only). When the same mobile has 2+ deals the same day,
   keep only the latest (by Modified_Time if present, else Created_Time); the rest are
   dropped from EVERY metric in the dashboard, not just this one. Deals with no mobile number
   can't be safely matched against each other, so they pass through unduped (each counted
   individually) and are simply excluded from the mobile-keyed Sales join later. */
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

function buildData(raw){
  raw=raw||window.DASH||{owners:{},deals:[],calls:[],tasks:[],online:[],events:[]};
  var D={ owners:raw.owners||{}, meta:raw.meta||{}, deals:(raw.deals||[]).map(pd), calls:(raw.calls||[]).map(pc), tasks:(raw.tasks||[]).map(pt), online:(raw.online||[]).map(po), events:(raw.events||[]).map(pe), sales:null, salesMeta:null };
  D.dealsRawCount = D.deals.length;
  D.deals = dedupeDealsGlobal(D.deals);
  D.dupDealsRemoved = D.dealsRawCount - D.deals.length;
  // indices
  D.idxWhat={}; D.calls.forEach(function(c){ if(c.whatId){ (D.idxWhat[c.whatId]=D.idxWhat[c.whatId]||[]).push(c); } });
  D.idxPhone={}; D.calls.forEach(function(c){ if(c.phone){ (D.idxPhone[c.phone]=D.idxPhone[c.phone]||[]).push(c); } });
  D.idxWhatTask={}; D.tasks.forEach(function(t){ if(t.whatId){ (D.idxWhatTask[t.whatId]=D.idxWhatTask[t.whatId]||[]).push(t); } });
  D.hasModified = D.deals.some(function(d){ return !!d.modified; });
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

/* ================= AGENT PERFORMANCE TABLE (extended) ================= */
/* Adds the metrics from the client's later "Agent Performance Dashboard" spec that Section 1
   doesn't cover: mobile+date deduped Assigned Deals split into two shift windows, WhatsApp
   Deals (via Deal_Trigger_Event, not Lead_Source), a strict 30-min First-Response SLA,
   Activities (Calls+Tasks linked to a Deal), Total Talk Time, Modified Deals and Old
   Customer Activities. Runs over a user-picked date range (Yesterday/Last 7/Last 30/Custom)
   instead of Section 1's single reference day, and sums per-day so the "same mobile number
   twice in one day" dedup rule is applied one calendar day at a time, as specified. */

/* Deal_Trigger_Event bucketing — based on the REAL distinct values found in this CRM's Deals
   export (etl/raw/Deals.json): Payment, Fresh, ProductView/NitroProductView, Forms, Checkout,
   ATC/Add to Cart, Login, WhatsApp/Whatsapp Chat/chat, Purchase, Signup, AbandonedCart, Closed,
   Schemes. This is an e-commerce funnel-event field, NOT a contact-channel field — there is no
   "Store Visit"/"Video Call"/"Phone Call"/"Reminder"/"Follow-up" vocabulary in this CRM.
   classifyEvent() above (Zoho Meeting titles) is the only real source for Store Visit/Video
   Call/TAH — those are meeting sub-types, unrelated to Deal_Trigger_Event. */
var TRIGGER_BUCKETS=['WhatsApp','Chat','Payment','Checkout','Add to Cart','Abandoned Cart','Product View','Signup','Login','Forms','Schemes','Fresh','Closed','Other'];
function classifyTrigger(t){
  var s=(t||'').toLowerCase().trim();
  if(!s) return 'Other';
  if(s.indexOf('whatsapp')>=0) return 'WhatsApp';
  if(s.indexOf('chat')>=0) return 'Chat';
  if(s.indexOf('payment')>=0 || s.indexOf('purchase')>=0) return 'Payment';
  if(s.indexOf('checkout')>=0) return 'Checkout';
  if(s.indexOf('abandon')>=0) return 'Abandoned Cart';
  if(s.indexOf('atc')>=0 || s.indexOf('cart')>=0) return 'Add to Cart';
  if(s.indexOf('productview')>=0 || s.indexOf('product view')>=0 || s.indexOf('nitro')>=0) return 'Product View';
  if(s.indexOf('sign up')>=0 || s.indexOf('signup')>=0 || s.indexOf('singup')>=0) return 'Signup';
  if(s.indexOf('login')>=0) return 'Login';
  if(s.indexOf('form')>=0) return 'Forms';
  if(s.indexOf('scheme')>=0) return 'Schemes';
  if(s.indexOf('fresh')>=0) return 'Fresh';
  if(s.indexOf('closed')>=0) return 'Closed';
  return 'Other';
}

function dealTasksFor(D,deal){ return D.idxWhatTask[deal.id]||[]; }
/* Activities on a deal, dated `day` = Calls + Tasks linked via What_Id. Zoho Meetings have no
   What_Id on this feed (can't be tied to a Deal) and there is no Notes module pulled at all —
   both are excluded from Activities, not silently invented. */
function dealActivitiesOnDay(D,deal,day){
  var c=joinDeal(D,deal).calls.filter(function(x){ return ymd(x.created)===day; }).length;
  var t=dealTasksFor(D,deal).filter(function(x){ return ymd(x.created)===day; }).length;
  return c+t;
}
/* Distinct Mobile + Date dedup, latest-created wins per the client's spec. Deals with no
   mobile can't be safely deduped against each other, so they pass through individually. */
function dedupeByMobileDay(deals){
  var byKey={}, out=[];
  deals.forEach(function(d){
    if(!d.mobile){ out.push(d); return; }
    var key=d.owner+'|'+d.mobile+'|'+ymd(d.created);
    if(!byKey[key] || d.created>byKey[key].created) byKey[key]=d;
  });
  Object.keys(byKey).forEach(function(k){ out.push(byKey[k]); });
  return out;
}
function inWindowA(ts){ var h=hourOf(ts); return h>=10 && h<21; } // 10:00–21:00
function windowADeals(deals,day){ return deals.filter(function(d){ return ymd(d.created)===day && inWindowA(d.created); }); }
/* 21:00 on `day` -> 10:00 the next day — spans midnight, so both calendar days must be scanned */
function windowBDeals(ownerAllDeals,day){
  var nextDay=addDays(day,1);
  return ownerAllDeals.filter(function(d){
    var dd=ymd(d.created);
    if(dd===day && hourOf(d.created)>=21) return true;
    if(dd===nextDay && hourOf(d.created)<10) return true;
    return false;
  });
}
function agentDayMetricsExt(D,owner,day,F){
  var ownerDeals=D.deals.filter(function(d){ return d.owner===owner && dealPassF(d,F); });
  var todays=ownerDeals.filter(function(d){ return ymd(d.created)===day; });
  var winA=dedupeByMobileDay(windowADeals(todays,day));
  var winB=dedupeByMobileDay(windowBDeals(ownerDeals,day));
  var assigned=winA.concat(winB);
  var waDeals=assigned.filter(function(d){ return classifyTrigger(d.trigger)==='WhatsApp'; }).length;

  var callsToday=D.calls.filter(function(c){ return c.owner===owner && ymd(c.created)===day && callPassF(c,F); });
  var totalCalls=callsToday.length;
  var connected=callsToday.filter(function(c){ return c.dur>30; }).length;
  var notConnected=callsToday.filter(function(c){ return c.dur===0; }).length;
  var talkSecs=callsToday.filter(function(c){ return c.dur>30; }).reduce(function(a,c){return a+c.dur;},0);

  var frts=winA.map(function(d){ return joinDeal(D,d).frt; });
  var within30=frts.filter(function(f){ return f!=null && f>=0 && f<=30; }).length;
  var after30=frts.filter(function(f){ return f!=null && f>=0 && f>30; }).length;

  var totalActivities=ownerDeals.reduce(function(a,d){ return a+dealActivitiesOnDay(D,d,day); },0);
  var oldCustomerActivities=ownerDeals.filter(function(d){ return ymd(d.created)<day; })
    .reduce(function(a,d){ return a+dealActivitiesOnDay(D,d,day); },0);
  var modifiedDeals = D.hasModified
    ? ownerDeals.filter(function(d){ return ymd(d.created)<day && d.modified && ymd(d.modified)===day; }).length
    : null; // null = gated — Modified_Time isn't exposed by the live bundle yet, see honesty note

  return {
    assigned:assigned.length, winA:winA.length, winB:winB.length, waDeals:waDeals,
    totalCalls:totalCalls, connected:connected, notConnected:notConnected, talkSecs:talkSecs,
    within30:within30, after30:after30, frtBase:winA.length,
    totalActivities:totalActivities, oldCustomerActivities:oldCustomerActivities,
    modifiedDeals:modifiedDeals, assignedDealsForTrigger:assigned
  };
}
function sumMetricsExt(rows){
  var s={ assigned:0,winA:0,winB:0,waDeals:0,totalCalls:0,connected:0,notConnected:0,talkSecs:0,
    within30:0,after30:0,frtBase:0,totalActivities:0,oldCustomerActivities:0,modifiedDeals:0,modifiedGated:false,
    assignedDealsForTrigger:[] };
  rows.forEach(function(r){
    s.assigned+=r.assigned; s.winA+=r.winA; s.winB+=r.winB; s.waDeals+=r.waDeals;
    s.totalCalls+=r.totalCalls; s.connected+=r.connected; s.notConnected+=r.notConnected; s.talkSecs+=r.talkSecs;
    s.within30+=r.within30; s.after30+=r.after30; s.frtBase+=r.frtBase;
    s.totalActivities+=r.totalActivities; s.oldCustomerActivities+=r.oldCustomerActivities;
    if(r.modifiedDeals==null) s.modifiedGated=true; else s.modifiedDeals+=r.modifiedDeals;
    s.assignedDealsForTrigger=s.assignedDealsForTrigger.concat(r.assignedDealsForTrigger);
  });
  return s;
}
function buildAgentPerfExt(D,from,to,F){
  var days=[]; var d=from; while(d<=to){ days.push(d); d=addDays(d,1); }
  var owners=activeOwners(D).filter(function(o){ return !F.agents.size || F.agents.has(o); });
  var rows=owners.map(function(o){
    var perDay=days.map(function(day){ return agentDayMetricsExt(D,o,day,F); });
    var s=sumMetricsExt(perDay);
    return {
      owner:o, name:ownerName(o),
      assigned:s.assigned, winA:s.winA, winB:s.winB, waDeals:s.waDeals,
      totalCalls:s.totalCalls, connected:s.connected, notConnected:s.notConnected,
      connectedPct:pct(s.connected,s.totalCalls),
      within30:s.within30, after30:s.after30, frtBase:s.frtBase, slaPct:pct(s.within30,s.frtBase),
      totalActivities:s.totalActivities, avgActivitiesPerDeal: s.assigned? s.totalActivities/s.assigned : null,
      talkSecs:s.talkSecs, modifiedDeals:s.modifiedGated?null:s.modifiedDeals,
      oldCustomerActivities:s.oldCustomerActivities,
      assignedDealsForTrigger:s.assignedDealsForTrigger
    };
  }).filter(function(r){ return r.assigned>0 || r.totalCalls>0 || r.totalActivities>0; });
  rows.sort(function(a,b){ return b.assigned-a.assigned; });
  return rows;
}
function buildTriggerTableExt(rows){
  return rows.map(function(r){
    var buckets={}; TRIGGER_BUCKETS.forEach(function(b){ buckets[b]=0; });
    r.assignedDealsForTrigger.forEach(function(d){ buckets[classifyTrigger(d.trigger)]++; });
    return { name:r.name, total:r.assignedDealsForTrigger.length, buckets:buckets };
  }).filter(function(r){ return r.total>0; }).sort(function(a,b){ return b.total-a.total; });
}
function buildInsightsExt(rows,rangeLabel){
  var out=[];
  if(!rows.length){ out.push({t:'ℹ️',c:'warn',h:'No agent activity found for '+rangeLabel+'.'}); return out; }
  function top(arr,keyFn,filterFn){ var f=filterFn?arr.filter(filterFn):arr.slice(); if(!f.length)return null; return f.reduce(function(a,b){ return keyFn(b)>keyFn(a)?b:a; }); }
  function bottom(arr,keyFn,filterFn){ var f=filterFn?arr.filter(filterFn):arr.slice(); if(!f.length)return null; return f.reduce(function(a,b){ return keyFn(b)<keyFn(a)?b:a; }); }
  var mostDeals=top(rows,function(r){return r.assigned;},function(r){return r.assigned>0;});
  if(mostDeals) out.push({t:'🏆',c:'pos',h:mostDeals.name+' received the highest number of deals ('+fmtInt(mostDeals.assigned)+') in '+rangeLabel+'.'});
  var bestSla=top(rows,function(r){return r.slaPct==null?-1:r.slaPct;});
  if(bestSla && bestSla.slaPct!=null) out.push({t:'⚡',c:'pos',h:bestSla.name+' has the best 30-minute response SLA at '+fmtPct(bestSla.slaPct,0)+'.'});
  var missedSla=rows.filter(function(r){ return r.after30>0; }).sort(function(a,b){return b.after30-a.after30;});
  if(missedSla.length) out.push({t:'⏰',c:'neg',h:missedSla.length+' agent(s) missed the 30-minute SLA on at least one deal — worst: '+missedSla[0].name+' ('+fmtInt(missedSla[0].after30)+' late first-calls).'});
  else out.push({t:'✅',c:'pos',h:'No agent missed the 30-minute first-response SLA in '+rangeLabel+'.'});
  var lowestConn=bottom(rows,function(r){return r.connectedPct==null?101:r.connectedPct;},function(r){return r.totalCalls>0;});
  if(lowestConn) out.push({t:'📉',c:'warn',h:lowestConn.name+' has the lowest Connected % at '+fmtPct(lowestConn.connectedPct,0)+' — review call quality/timing.'});
  var mostTalk=top(rows,function(r){return r.talkSecs;},function(r){return r.talkSecs>0;});
  if(mostTalk) out.push({t:'📞',c:'pos',h:mostTalk.name+' logged the highest talk time: '+fmtHMS(mostTalk.talkSecs)+'.'});
  var mostAct=top(rows,function(r){return r.totalActivities;},function(r){return r.totalActivities>0;});
  if(mostAct) out.push({t:'🔥',c:'pos',h:mostAct.name+' performed the most activities ('+fmtInt(mostAct.totalActivities)+').'});
  var mostOld=top(rows,function(r){return r.oldCustomerActivities;},function(r){return r.oldCustomerActivities>0;});
  if(mostOld) out.push({t:'👥',c:'pos',h:mostOld.name+' followed up with old customers the most ('+fmtInt(mostOld.oldCustomerActivities)+' activities on pre-existing deals).'});
  else out.push({t:'👥',c:'warn',h:'No follow-up activity was logged on older (pre-existing) deals in '+rangeLabel+'.'});
  var pending=rows.reduce(function(a,r){return a+Math.max(0,r.winA-r.within30-r.after30);},0);
  out.push({t:'📋',c:'warn',h:fmtInt(pending)+' deal(s) assigned in the 10AM–9PM window still have no first call logged yet.'});
  var priority=rows.slice().sort(function(a,b){ var pa=Math.max(0,a.winA-a.within30-a.after30), pb=Math.max(0,b.winA-b.within30-b.after30); return pb-pa; })[0];
  if(priority) out.push({t:'🎯',c:'warn',h:'Prioritize '+priority.name+' today — carries the largest pool of not-yet-called deals in the 10AM–9PM window.'});
  out.push({t:'🧭',c:'pos',h:'Management focus today: close the SLA gap'+(missedSla.length?' with '+missedSla[0].name:'')+' and follow up on the '+fmtInt(pending)+' deal(s) with no first call yet.'});
  return out;
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
    /* Order Convert = unique CUSTOMERS (deduped by Mobile) whose deal is Stage="Closed Won" and
       whose Modified_Time — the real closing/follow-up date, not Created_Time — falls on `day`.
       Two fixes over the old logic: (1) it no longer counts a same-day-created deal as "won" just
       because its CURRENT stage happens to read Closed Won at whatever later date the snapshot was
       pulled — it now requires the close to have actually landed on `day` (Modified_Time), same gate
       already used for old deals; (2) a customer with 2+ duplicate deals closing the same day is one
       converted order, not two — deduped by Mobile before counting. Gated N/A (like Modified Deals)
       when the data source doesn't expose Modified_Time yet, falling back to the old "created today,
       currently Closed Won" signal (still mobile-deduped) so the column never goes blank. */
    var wonOwnerDeals = D.hasModified ? D.deals.filter(function(d){
      return d.owner===o && d.stage==='Closed Won' && d.modified && ymd(d.modified)===day && dealPassF(d,F);
    }) : assigned.filter(function(d){ return d.stage==='Closed Won'; });
    var wonSeen={}, wonUnique=[];
    wonOwnerDeals.forEach(function(d){ var k=d.mobile||('__nomobile_'+d.id); if(!wonSeen[k]){ wonSeen[k]=1; wonUnique.push(d); } });
    var won = wonUnique.filter(function(d){ return ymd(d.created)===day; }).length;
    var oldWon = D.hasModified ? wonUnique.filter(function(d){ return ymd(d.created)<day; }).length : null;
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
      won:won, oldWon:oldWon, wonTotal:(oldWon==null?won:won+oldWon), winRate:pct(won,assigned.length)
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

/* Overall Call Dump (cross-check for the Hourly Talk Time Trend chart) — one row per call
   logged on the reference day, so every "Connected (>=30s)" total in the trend line can be
   verified against real records instead of trusting the aggregate. */
function buildCallDump(D,day,F){
  var calls=D.calls.filter(function(c){ return ymd(c.created)===day && callPassF(c,F); });
  var rows=calls.map(function(c){
    var dur=c.dur||0;
    return { callId:c.id, owner:ownerName(c.owner), type:c.type||'N/A', created:c.created, hour:hourOf(c.created), durSecs:dur, connected:dur>=30 };
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

/* ================= Section 12: Deal → Sale Conversion (Same-Day, Mobile+Date) =================
   Client spec: dedupe deals (dedupeDealsGlobal, applied once in buildData — every metric in
   this file already runs on unique deals), then map each unique deal to the Sales table using
   Mobile Number + Date (Day-wise) — a deal counts as converted ONLY if that same mobile number
   also has a Sales row on the SAME calendar day (confirmed with the client: same-day match,
   not any-time). Sales are grouped by Mobile + Sale Date FIRST — one customer's multiple
   line-items/orders on the same day (a single bill can be several rows in Sales_overview_table)
   collapse into ONE sale event with a summed amount, so a multi-item bill isn't miscounted as
   several conversions. Needs `customer_mobile` on the Sales snapshot (see sales-reporting-api/
   main.py) — if that field isn't present yet (old snapshot), hasMobileData is false and the UI
   shows an honest gate instead of a fake zero. */
function buildSalesByMobileDay(items){
  var m={};
  (items||[]).forEach(function(it){
    if(it.sale_type==='Return') return; // a return is not a conversion event
    var mob=normPhone(it.customer_mobile||'');
    if(mob.length!==10) return; // no verified mobile on this row — can't be mobile-joined
    var key=mob+'|'+it.date;
    var e=m[key]||(m[key]={mobile:mob,date:it.date,gross:0,net:0,qty:0,orders:{},lines:0});
    e.gross+=it.gross||0; e.net+=(it.net!=null?it.net:(it.gross||0)*0.97); e.qty+=it.qty||0;
    if(it.document_no) e.orders[it.document_no]=1;
    e.lines++;
  });
  return m;
}
function buildDealSaleConversion(D,S,fromD,toD,F){
  var hasMobileData=(S.items||[]).some(function(it){return normPhone(it.customer_mobile||'').length===10;});
  var byMobileDay=buildSalesByMobileDay(S.items);
  var deals=D.deals.filter(function(d){ return d.mobile && inRange(d.created,fromD,toD) && dealPassF(d,F); });
  var matched=[]; // [{deal,sale}]
  deals.forEach(function(d){
    var s=byMobileDay[d.mobile+'|'+ymd(d.created)];
    if(s) matched.push({deal:d,sale:s});
  });
  var custSet={}; deals.forEach(function(d){custSet[d.mobile]=1;});
  var convCustSet={}; matched.forEach(function(m){convCustSet[m.deal.mobile]=1;});
  var totalSalesAmt=matched.reduce(function(a,m){return a+m.sale.net;},0);
  var byAgent={};
  matched.forEach(function(m){
    var o=m.deal.owner, e=byAgent[o]||(byAgent[o]={owner:o,name:ownerName(o),sales:0,amount:0});
    e.sales++; e.amount+=m.sale.net;
  });
  var dealsPerAgent={};
  deals.forEach(function(d){ dealsPerAgent[d.owner]=(dealsPerAgent[d.owner]||0)+1; });
  var agentRows=Object.keys(byAgent).map(function(o){
    var e=byAgent[o]; return {owner:o,name:e.name,deals:dealsPerAgent[o]||0,sales:e.sales,amount:e.amount,convPct:pct(e.sales,dealsPerAgent[o]||0)};
  }).sort(function(a,b){return b.amount-a.amount;});
  var days=[]; var d=fromD; while(d<=toD){ days.push(d); d=addDays(d,1); }
  var dealsByDay={}; deals.forEach(function(dl){ var k=ymd(dl.created); dealsByDay[k]=(dealsByDay[k]||0)+1; });
  var matchedByDay={}; matched.forEach(function(m){ var k=ymd(m.deal.created); var e=matchedByDay[k]||(matchedByDay[k]={count:0,amount:0}); e.count++; e.amount+=m.sale.net; });
  var dayRows=days.map(function(day){
    var dl=dealsByDay[day]||0, mm=matchedByDay[day]||{count:0,amount:0};
    return {day:day,deals:dl,sales:mm.count,amount:mm.amount,convPct:pct(mm.count,dl)};
  });
  return {
    hasMobileData:hasMobileData,
    totalUniqueDeals:deals.length,
    dupDealsRemoved:D.dupDealsRemoved,
    sameDaySales:matched.length,
    totalSalesAmount:totalSalesAmt,
    convertedCustomers:Object.keys(convCustSet).length,
    totalCustomers:Object.keys(custSet).length,
    conversionPct:pct(Object.keys(convCustSet).length,Object.keys(custSet).length),
    agentRows:agentRows,
    dayRows:dayRows
  };
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
function lineChart(series,opts){ // series: [{x,y}], opts:{color,y2,color2,dataLabels,labelFmt}
  opts=opts||{}; var w=600, h=opts.dataLabels?230:180, pad=30;
  var padTop=opts.dataLabels?40:pad, padBottom=opts.dataLabels?42:pad; // extra headroom so labels never crowd the line/edges
  var ys=series.map(function(p){return p.y;}); if(opts.y2) series.forEach(function(p){ys.push(p.y2);});
  var maxY=Math.max.apply(null,ys.concat([1]))*(opts.dataLabels?1.3:1.15), minY=0;
  var n=series.length||1;
  function xy(i,v){ var x=pad+(w-pad*2)*(i/(n-1||1)); var y=h-padBottom-(h-padTop-padBottom)*((v-minY)/(maxY-minY||1)); return [x,y]; }
  function path(key,color){ var d=''; series.forEach(function(p,i){ var xy_=xy(i,p[key]); d+=(i===0?'M':'L')+xy_[0].toFixed(1)+' '+xy_[1].toFixed(1)+' '; }); return '<path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="2.2"></path>'; }
  var grid=''; for(var g=0;g<=3;g++){ var gy=padTop+(h-padTop-padBottom)*g/3; grid+='<line x1="'+pad+'" y1="'+gy+'" x2="'+(w-pad)+'" y2="'+gy+'" stroke="var(--line)" stroke-width="1"></line>'; }
  var xlabels=''; var stepN=Math.max(1,Math.round(n/6));
  series.forEach(function(p,i){ if(i%stepN===0||i===n-1){ var xy_=xy(i,0); var lbl=/^\d{4}-\d{2}-\d{2}/.test(p.x)?p.x.slice(5):p.x; xlabels+='<text x="'+xy_[0]+'" y="'+(h-padBottom+16)+'" font-size="9" fill="var(--tx3)" text-anchor="middle">'+lbl+'</text>'; } });
  var dlabels='';
  if(opts.dataLabels){ var fmt=opts.labelFmt||function(v){return v;};
    series.forEach(function(p,i){ if(!p.y) return; var xy_=xy(i,p.y);
      var prevV=i>0?series[i-1].y:p.y, nextV=i<n-1?series[i+1].y:p.y;
      var isValley = p.y<=prevV && p.y<=nextV && !(p.y>=prevV && p.y>=nextV); // dip surrounded by higher/equal neighbours -> label goes below, else above
      var ly = isValley ? xy_[1]+20 : xy_[1]-14;
      if(ly<padTop-22) ly=xy_[1]+20; if(ly>h-padBottom+18) ly=xy_[1]-14;
      dlabels+='<text x="'+xy_[0].toFixed(1)+'" y="'+ly.toFixed(1)+'" font-size="10" fill="'+(opts.color||'var(--c1)')+'" text-anchor="middle" font-weight="700">'+fmt(p.y)+'</text>'; }); }
  var inner=grid+path('y',opts.color||'var(--c1)')+(opts.y2!=null?path('y2',opts.color2||'var(--c2)'):'')+xlabels+dlabels;
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
 sec1:{title:'Section 1 — Yesterday Agent Performance',what:'Per-agent scorecard for deals assigned and calls made on the reference day.',why:'This is the single table Sales Heads use every morning to see who is following up and who is not.',formula:'Deals Assigned = Deals where Created_Time = reference day, grouped by Owner. Calls/Connected = calls made that day by that owner (Connected = duration &gt;= 30s). Contact Rate = Connected/Total Calls. Order Convert = COUNT(DISTINCT Mobile) WHERE Stage="Closed Won" AND Modified_Time (closing/follow-up date) = reference day — deduped per customer so a repeat close for the same mobile number the same day is one order, not two. Win Rate % = Order Convert/Deals Assigned.',impact:'Agents with high "Deals Not Called" and low Contact Rate are actively losing pipeline.',action:'Escalate any agent with Deals Not Called &gt; 3 for same-day follow-up.',practice:'Review this table before 10 AM daily.',benchmark:'Contact rate target ≥ 60%; First Call Time target ≤ 30 minutes.'},
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
 v_hourly_talktime_trend:{title:'Hourly Talk Time Trend (Yesterday)',what:'Total connected talk time (sum of call duration for calls ≥30s, across all agents) for each hour from 10:00–21:00 IST on the reference day, plotted as a trend line with each point labelled in HH:MM:SS.',why:'Shows which hours of the day generate the most real conversation time company-wide, at a glance next to the per-agent breakdown table below.',formula:'For each hour h: SUM(duration) WHERE duration≥30s AND HOUR(Created)=h AND date=yesterday, summed across all agents.',impact:'A dip in a normally-busy hour (e.g. 11AM-1PM or 5-8PM) signals reduced calling activity or connectivity that hour — cross-check the per-agent table below to see who was inactive.',action:'—',practice:'Respects the Agent filter — same reference day and filter as the Daily Hourly Breakdown table below it.',benchmark:'—'},
 call_dump:{title:'Overall Call Dump — Talk Time Cross-Check',what:'Every call logged on the reference day, one row per call, so the Hourly Talk Time Trend above can be verified against real records instead of trusting the aggregate.',why:'The trend line only sums calls lasting ≥30 seconds — this dump shows every call including the ones that got excluded, and exactly why (the Connected column).',formula:'One row per Call record WHERE date(Created)=yesterday. Connected (>=30s) = duration >= 30 seconds — the same rule used to build the hourly totals above.',impact:'A row with Connected=No still counts toward "Calls Made" everywhere else on this dashboard, but never toward talk time — use this to explain any gap between call volume and talk-time totals for a given hour/agent.',action:'Search the Call ID in Zoho to confirm a specific record.',practice:'Respects the Agent filter — same reference day and filter as the chart above it.',benchmark:'—'},
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
 k_sales:{title:'Sales (Orders)',what:'Distinct Sales orders yesterday, company-wide.',formula:'COUNT(DISTINCT document_no WHERE date=yesterday, sale_type != Return).',why:'—',impact:'Cannot be split by agent/deal — no verified customer join exists between CRM and Sales (see data note).',action:'—',practice:'—',benchmark:'—'},
 k_revenue:{title:'Revenue',what:'Net sales revenue yesterday, company-wide.',formula:'SUM(net) WHERE date=yesterday, sale_type != Return.',why:'—',impact:'—',action:'—',practice:'Sales data can lag several days — if 0/—, check the freshness pill for the Sales as-of date.',benchmark:'—'},
 k_conv:{title:'Deal → Sale Conversion % (indicative)',what:'Sales orders ÷ Yesterday deals, company-wide.',formula:'Orders / Deals.',why:'A rough directional ratio only.',impact:'NOT a verified attribution — the Sales table\'s customer_id is an internal party ID, not a phone number, so individual orders cannot be traced back to individual Deals today.',action:'To make this a true conversion rate, add a mobile-number column to the Sales customer identity (it was built once already — see project history — but the change did not survive the last daily refresh).',practice:'Present this number as "indicative" to leadership, never as a hard conversion rate.',benchmark:'—'},
 k_won:{title:'Order Convert',what:'Company-wide count of unique customers (deduped by Mobile) whose deal is now Stage "Closed Won" AND whose Modified_Time (closing/follow-up date) falls on this day — whether that deal was created on this day or created earlier and only closed on this day (see the "of which: Old Deal" column in Agent Performance for that second group).',formula:'COUNT(DISTINCT Mobile) WHERE Stage="Closed Won" AND Modified date=day.',why:'A real, verifiable conversion signal straight from Zoho — no cross-system join needed (unlike Sales revenue, which would require matching Sales customer_id to a Deal, and that join does not exist today). Gating on the actual close date (not just "current stage reads Closed Won") and deduping by Mobile stops the same customer\'s duplicate deals from inflating the count.',impact:'If both this and "of which: Old Deal" are 0, that can still legitimately mean no closes landed on this day yet — it rises retroactively as more deals close in following days.',action:'Don\'t read a low number here as "no sales yesterday" — check back on this same date a few days later for the fuller picture.',practice:'—',benchmark:'—'},
 k_winrate:{title:'Win Rate %',what:'Won ÷ Yesterday Deals, company-wide — scoped to deals both created AND closed on this same day, deduped by Mobile (excludes older deals counted in Order Convert, so the ratio stays a clean Won÷Assigned).',formula:'Won (created day=day AND Modified/closing date=day, deduped by Mobile) / Deals Assigned.',why:'Real conversion rate computed entirely from Zoho Deal Stage — no external join required.',impact:'Deals created yesterday rarely close yesterday, so this is naturally low/zero on a next-morning check and should be read alongside older cohorts, not in isolation.',action:'Track this same date\'s cohort again a week or two later to see its true win rate mature.',practice:'—',benchmark:'—'},
 k_notcalled:{title:'Deals Without Calls',what:'Yesterday\'s deals with zero matched calls.',formula:'Deals joined to Calls via What_Id or matching mobile number; zero matches = uncalled.',why:'Direct pipeline leakage indicator.',impact:'—',action:'Call these immediately — every hour uncalled measurably lowers close probability.',practice:'—',benchmark:'Target 0 by end of assignment day.'},
 k_duetoday:{title:'Today\'s Due Calls/Tasks',what:'Open tasks due today, company-wide.',formula:'COUNT(Tasks WHERE due=today AND status!=Completed).',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_visitstoday:{title:'Today\'s Store Visits',what:'Meetings starting today classified as Store Visit.',formula:'—',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_meetstoday:{title:'Today\'s Meetings',what:'All meetings starting today.',formula:'—',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 secAgentExt:{title:'Section 9 — Agent Wise Performance Table',what:'Per-agent scorecard over a picked date range (Yesterday by default, or Last 7/30 days, or a custom range), covering Assigned Deals (deduped by Mobile+Date, latest deal wins), the two shift windows, WhatsApp Deals, Calls, 30-minute First-Response SLA, Activities, Talk Time, Modified Deals and Old Customer Activities.',why:'Extends Section 1 with the exact metric set the client specified, aggregated over any range rather than a single day.',formula:'See each KPI card\'s own info icon; column-level formulas are documented in the honesty note above the table.',impact:'Modified Deals reads N/A until the backend query extracts Modified_Time — not fabricated as zero.',action:'—',practice:'Uses the same Agent filter as the rest of the dashboard (filter drawer).',benchmark:'30-min SLA target ≥ 80%.'},
 secTrigExt:{title:'Section 10 — Deal Trigger Event Table',what:'Agent × Deal_Trigger_Event breakdown, bucketed on the REAL values found in this CRM (an e-commerce funnel vocabulary: WhatsApp, Chat, Payment, Checkout, Add to Cart, Abandoned Cart, Product View, Signup, Login, Forms, Schemes, Fresh, Closed).',why:'The client\'s original spec assumed contact-channel categories (Store Visit/Video Call/Phone Call/Reminder/Follow-up) that do not exist in Deal_Trigger_Event — this table shows what the field actually contains instead of forcing it into categories with no matching data.',formula:'COUNT(assigned deals) GROUP BY classifyTrigger(Deal_Trigger_Event), per agent, over the selected date range.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 secAiExt:{title:'Section 11 — AI Insights (Agent Performance)',what:'Rule-based narrative generated from the Agent Wise Performance Table above — highest-volume agent, best/missed SLA, lowest Connected %, highest talk time, most activities, most old-customer follow-up, pending deals, and a priority call for today.',why:'One-glance answers to the exact questions the client asked for.',formula:'Threshold/ranking rules over buildAgentPerfExt() — same computed model as the table, nothing separately fabricated.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_extassigned:{title:'Assigned Deals',what:'Deals assigned in the selected range, deduped by Mobile+Date (latest deal per mobile per day wins), split into 10AM–9PM and 9PM–10AM(next day) shift windows.',formula:'DISTINCT(Owner, Mobile, Created date), keep max(Created_Time) per group.',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_extconn:{title:'Connected %',what:'Connected Calls (duration &gt; 30s) ÷ Total Calls, for the selected range.',formula:'Connected/Total × 100.',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_extsla:{title:'30-min First Response SLA',what:'Of deals assigned in the 10AM–9PM window, the share whose first linked call happened within 30 minutes of Deal creation.',formula:'Calls Within 30 Min ÷ Total 10AM–9PM Assigned Deals × 100.',why:'—',impact:'—',action:'—',practice:'—',benchmark:'Target ≥ 80%.'},
 k_extact:{title:'Total Activities',what:'Calls + Tasks linked to a Deal (via What_Id) dated within the selected range, across all of that agent\'s deals (including older ones).',formula:'COUNT(Calls)+COUNT(Tasks) WHERE What_Id=deal AND date in range.',why:'Zoho Meetings and Notes are not linked to Deals in this feed, so they are excluded, not invented.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_exttalk:{title:'Total Talk Time',what:'Sum of Connected (&gt;30s) call durations for the agent in the selected range, HH:MM:SS.',formula:'SUM(duration) WHERE duration&gt;30s.',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_extmod:{title:'Modified Deals',what:'Deals created before the reference day that were modified on it.',formula:'COUNT(Deals WHERE Created &lt; day AND Modified date = day).',why:'—',impact:'Currently gated: Modified_Time exists in the raw BigQuery data but is not yet extracted by the live bundle query — reads N/A rather than 0 until that backend change ships.',action:'Add JSON_VALUE(data,\'$.Modified_Time\') to the deals SELECT in zoho-crm-bundle-api/main.py (and the other two backends) and redeploy.',practice:'—',benchmark:'—'},
 secConv:{title:'Section 12 — Deal → Sale Conversion (Same-Day, Mobile+Date Match)',what:'Maps unique Deals to the Sales table (Ornaverse ERP, via the sales-reporting-api snapshot) using Mobile Number + Date — a Deal only counts as converted if that same mobile number also has a Sales row on the exact same calendar day.',why:'Client-specified: remove duplicate deals, then join to real Sales using Mobile+Date to get a true (not indicative) Sales/Revenue/Conversion figure — closing the gap Section 1 and the KPI cards above leave gated.',formula:'Dedup: keep 1 deal per Mobile+Created-Date (latest Modified/Created time wins), applied globally to every metric in this dashboard. Join: Deal.mobile+Deal.created_date == Sale.customer_mobile+Sale.date (same day only, confirmed with the client — not any-time). Sales are first grouped by Mobile+Date so one multi-item bill = one sale event, amount summed.',impact:'This is a SAME-DAY conversion metric by design — a deal that converts to a sale 3 days later will correctly show as NOT converted here (see Deal vs Sale Comparison table for the day-by-day breakdown).',action:'Needs customer_mobile exposed on the Sales snapshot (sales-reporting-api/main.py) — if the gate note above is showing, that redeploy has not run yet.',practice:'Uses the same date-range control as the Agent Wise Performance table above (Yesterday/Last 7/Last 30/Custom).',benchmark:'—'},
 k_convUnique:{title:'Total Unique Deals',what:'Deals in the selected range after the global Mobile+Date dedup (one deal per mobile per day, latest wins), that also carry a mobile number (a mobile is required to attempt the Sales join).',formula:'COUNT(deduped Deals WHERE created date in range AND mobile is present).',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_convDup:{title:'Duplicate Deals Removed',what:'Deals dropped by the global Mobile+Date dedup rule, across the ENTIRE loaded dataset (not scoped to the selected range — this is a one-time data-cleaning count).',formula:'Raw deal count − deduped deal count, keyed on Mobile+Created Date, latest (Modified_Time else Created_Time) kept.',why:'Transparency: shows how much of the raw feed was same-mobile-same-day duplicates before any metric was computed.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_convSameDay:{title:'Same Day Sales',what:'Count of unique deals (in the selected range) whose mobile number also has a Sales record on that exact same calendar day.',formula:'COUNT(deals WHERE EXISTS sale WHERE sale.customer_mobile=deal.mobile AND sale.date=deal.created_date).',why:'—',impact:'A multi-item bill on the same day is still ONE sale event here (sales pre-grouped by Mobile+Date), so this never over-counts a single visit as multiple conversions.',action:'—',practice:'—',benchmark:'—'},
 k_convAmount:{title:'Total Sales Amount (Deal-Linked)',what:'Sum of net sales amount, but ONLY for the sale events matched to a unique deal by Mobile+Date — not company-wide revenue (that figure is in Section 5 / the WhatsApp report).',formula:'SUM(net) over matched (deal,sale) pairs for the selected range.',why:'Client explicitly asked for the deal-linked figure, distinct from total company revenue.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_convCust:{title:'Converted Customers',what:'Distinct mobile numbers, among this range\'s unique deals, that had a same-day sale.',formula:'COUNT(DISTINCT mobile WHERE matched).',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_convPct:{title:'Conversion %',what:'Converted Customers ÷ Total Unique Customers (distinct mobiles with a deal in range) × 100.',formula:'Converted Customers / Total Unique Customers × 100.',why:'Customer-based, not deal-based, so a customer with 2 deal-days in range isn\'t double-counted in the denominator.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 tblConvAgent:{title:'Agent-Wise Sales (Deal-Linked)',what:'Per-agent breakdown of the Deal→Sale conversion match: how many of that agent\'s unique deals converted same-day, and the linked sales amount.',formula:'GROUP BY Deal.owner over the matched (deal,sale) pairs.',why:'Attributes deal-linked revenue to the agent who owned the originating deal — something Section 4\'s company-wide "Online Agent Sale" proxy cannot do.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 chConvTrend:{title:'Day-wise Sales Trend (Deal-Linked)',what:'Deal-linked sales amount (net), one point per day in the selected range.',formula:'SUM(matched sale.net) GROUP BY deal.created_date.',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 tblConvCompare:{title:'Deal vs Sale Comparison',what:'Day-by-day: how many unique deals were created, how many converted same-day, and the resulting conversion % — the daily breakdown behind the range-level KPI cards above.',formula:'Per day: Unique Deals = COUNT(deduped deals that day). Same-Day Sales = COUNT(matched). Conversion % = Same-Day Sales ÷ Unique Deals.',why:'Lets you spot which specific days drove the range average, and see same-mobile deals that did NOT convert same-day (they may still convert later — this table only measures same-day).',impact:'—',action:'—',practice:'—',benchmark:'—'}
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
/* Separate date-range state for the Agent Wise Performance Table / Trigger Event Table /
   extra AI Insights below — those need Yesterday(default)/Last 7/Last 30/Custom, distinct
   from Section 1-9's single "Reference Today" day picker. Shares F.agents (same Agent filter
   in the drawer applies to both). */
var F2={ mode:'yesterday', from:null, to:null };
function computeRange2(D){
  var y=addDays(D.crmMaxDate,-1);
  if(F2.mode==='yesterday') return {from:y,to:y,label:'Yesterday ('+y+')'};
  if(F2.mode==='last7'){ var f7=addDays(y,-6); return {from:f7,to:y,label:'Last 7 Days ('+f7+' → '+y+')'}; }
  if(F2.mode==='last30'){ var f30=addDays(y,-29); return {from:f30,to:y,label:'Last 30 Days ('+f30+' → '+y+')'}; }
  var cf=F2.from||y, ct=F2.to||y; if(cf>ct){ var tmp=cf; cf=ct; ct=tmp; }
  return {from:cf,to:ct,label:'Custom ('+cf+' → '+ct+')'};
}
var LAST_EXT_CTX=null; // backs the AI-assistant answers for the new questions
var LAST_CONV_CTX=null; // backs Section 12 Deal→Sale Conversion CSV export + assistant answers

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
  var body='<tbody>'+rows.map(function(r){ return '<tr>'+r.map(function(v,i){ var cls=(fmt&&fmt[i]==='num')?' class="num"':''; var html=v; if(fmt&&fmt[i]==='badgeRed'&&v>0) html='<b style="color:var(--bad)">'+v+'</b>'; return '<td'+cls+'>'+(html==null?'N/A':html)+'</td>'; }).join('')+'</tr>'; }).join('')+'</tbody>';
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
  table('tblAgentPerf',['Agent','Deals Assigned','Total Calls','Connected>=30 sec','Contact Rate','Avg First Call 10AM-8PM (HH:MM:SS)','Avg First Call 8PM-10AM (HH:MM:SS)','Meetings','Store Visits','Video Calls','TAH','Order Convert','of which: Old Deal','Win Rate %','Sales (Orders)','Revenue','Deal→Sale Conv.%'],
    ap.map(function(r){ return [esc(r.name), r.dealsAssigned, r.totalCalls, r.connectedCalls, fmtPct(r.contactRate), r.avgFrtBiz!=null?fmtHMS(r.avgFrtBiz*60):'<span class="gap">N/A</span>', r.avgFrtNonBiz!=null?fmtHMS(r.avgFrtNonBiz*60):'<span class="gap">N/A</span>', r.meetings, r.storeVisits, r.videoCalls, r.tah, r.wonTotal, r.oldWon==null?'<span class="gap">N/A</span>':r.oldWon, fmtPct(r.winRate), '<span class="gap">N/A</span>', '<span class="gap">N/A</span>', '<span class="gap">N/A</span>' ]; }),
    [1,1,1,0,1,1,1,1,1,1,1,1,0,0,0,0]);
  document.getElementById('sec1note').innerHTML='<b>Order Convert</b> = unique customers (deduped by Mobile) whose deal is now Stage "Closed Won" <i>and</i> whose Modified_Time (closing/follow-up date) is '+day+' — whether that deal was created on '+day+' or created earlier and only closed on '+day+'. The <b>"of which: Old Deal"</b> column breaks out that second group so an old lead\'s sale is never silently missing from the day\'s total, and a customer with duplicate deals closing the same day is only ever counted once. <b>Win Rate %</b> stays scoped to deals both created AND closed on '+day+' (Won ÷ Deals Assigned) for a clean cohort rate. Both come straight from the Deal\'s own Stage/Modified_Time fields — real, per-agent numbers, unlike Sales/Revenue which would need a Deal↔Sale customer join that does not exist in this data (Sales customer_id is an internal party ID, not a phone number). The <b>Sales/Revenue/Conversion</b> columns are n/a per agent for that reason — see the ⓘ info icons and the data-source note above. Company-wide Sales/Revenue figures are in Section 5 &amp; the WhatsApp report.'+(ap.some(function(r){return r.oldWon==null;})?' <b style="color:var(--warn)">"of which: Old Deal" shows N/A, and Order Convert falls back to the old "created today, currently Closed Won" signal (still Mobile-deduped) — this data source doesn\'t expose Modified_Time yet.</b>':'');

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
  var wonAll=apAll.reduce(function(a,r){return a+r.wonTotal;},0); // real, from Deal.Stage="Closed Won" — includes old deals that closed on `day` (Modified_Time), not just same-day-created ones
  var wonSameDay=apAll.reduce(function(a,r){return a+r.won;},0); // same-day-created cohort only — keeps Win Rate % as a clean Won÷Assigned ratio
  var kg=document.getElementById('kpiGrid');
  kg.innerHTML=[
    kpiCard('Yesterday Deals',fmtInt(totDeals),day,'k_dealsAssigned'),
    kpiCard('Calls',fmtInt(totCallsArr.length),'','k_calls'),
    kpiCard('Connected Calls (≥30s)',fmtInt(totConnected),fmtPct(pct(totConnected,totCallsArr.length))+' contact rate','k_connected'),
    kpiCard('Meetings',fmtInt(evYest.length),'','k_meetings'),
    kpiCard('Store Visits',fmtInt(meetTypes['Store Visit']),'','k_storevisits'),
    kpiCard('Video Calls',fmtInt(meetTypes['Video Call']),'','k_video'),
    kpiCard('TAH',fmtInt(meetTypes['TAH']),'','k_tah'),
    kpiCard('Sales (Orders)',hasSalesYest?fmtInt(Object.keys(ordersYest).length):'N/A',hasSalesYest?'matches current filters':'no sales data synced for '+day+' yet (through '+(S.meta.asOf||'?')+')','k_sales'),
    kpiCard('Revenue',hasSalesYest?fmtMoney(revYest):'N/A','matches current filters','k_revenue'),
    kpiCard('Deal→Sale Conv.% (indicative)',hasSalesYest?fmtPct(pct(Object.keys(ordersYest).length,totDeals)):'N/A','not a verified attribution','k_conv'),
    kpiCard('Order Convert',fmtInt(wonAll),day,'k_won'),
    kpiCard('Win Rate %',fmtPct(pct(wonSameDay,totDeals)),'Won ÷ Deals','k_winrate'),
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

  // ===== Section 8: WhatsApp =====
  var SLA_MIN=30;
  var withFrt=apAll.filter(function(a){return a.avgFrtAll!=null;});
  var slaAchievers=withFrt.filter(function(a){return a.avgFrtAll<=SLA_MIN;});
  var closestAgent=withFrt.slice().sort(function(a,b){return a.avgFrtAll-b.avgFrtAll;})[0];
  var bestContactAgent=apAll.filter(function(a){return a.totalCalls>=3;}).sort(function(a,b){return (b.contactRate||0)-(a.contactRate||0);})[0];
  var bestContactLine = bestContactAgent
    ? '⭐ '+bestContactAgent.name+' had the highest contact rate ('+fmtPct(bestContactAgent.contactRate,0)+'), but the first-call response time was '+(bestContactAgent.avgFrtAll!=null?fmtDurWords(bestContactAgent.avgFrtAll*60):'not available')+'.'
    : null;
  var slaLine = slaAchievers.length
    ? '✅ '+(slaAchievers.length===1
        ? slaAchievers[0].name+' achieved the 30-minute SLA (avg first call '+fmtDurWords(slaAchievers[0].avgFrtAll*60)+').'
        : slaAchievers.length+' agent(s) achieved the 30-minute SLA: '+slaAchievers.map(function(a){return a.name;}).join(', ')+'.')
    : '❌ No agent achieved the 30-minute SLA.';
  var closestLine = (closestAgent && !slaAchievers.length)
    ? '⚠️ '+closestAgent.name+' was closest to the SLA with an average first call time of '+fmtDurWords(closestAgent.avgFrtAll*60)+'.'
    : null;
  var conversionLine = wonAll>0
    ? '📈 '+fmtInt(wonAll)+' order(s) converted on '+day+(wonAll>wonSameDay?' (incl. '+fmtInt(wonAll-wonSameDay)+' older lead(s) closing that day)':'')+' — keep up the follow-through.'
    : '📉 No orders were converted '+(day===D.crmMaxDate?'yesterday':'on '+day)+', indicating a need to improve both call quality and conversion.';

  var wa = '*Deals vs Calls vs Sales Report*\n'+day+(D.crmLive?' (live)':' (CRM snapshot day)')+'\n\n'+
    'Yesterday Deals: '+fmtInt(totDeals)+'\n'+
    'Calls: '+fmtInt(totCallsArr.length)+' | Connected (≥30s): '+fmtInt(totConnected)+' ('+fmtPct(contactRate)+')\n'+
    'Meetings: '+fmtInt(evYest.length)+' | Store Visits: '+fmtInt(meetTypes['Store Visit'])+' | Video Calls: '+fmtInt(meetTypes['Video Call'])+' | TAH: '+fmtInt(meetTypes['TAH'])+'\n'+
    'Sales: '+(hasSalesYest?fmtInt(Object.keys(ordersYest).length):'N/A')+' orders | Revenue: '+(hasSalesYest?fmtMoney(revYest):'N/A')+'\n'+
    'Order Convert: '+fmtInt(wonAll)+' | Win Rate: '+fmtPct(pct(wonSameDay,totDeals))+'\n\n'+
    "Today's Due Calls/Tasks: "+fmtInt(dueTodayAll)+'\n'+
    "Today's Meetings: "+fmtInt(evToday.length)+' | Store Visits: '+fmtInt(visitsToday)+'\n\n'+
    'Deals Without Calls: '+fmtInt(notCalledAll)+'\n\n'+
    'Top Agent: '+(topAgent?topAgent.name+' ('+topAgent.dealsAssigned+' deals)':'N/A')+'\n'+
    'Top Store (revenue, 7d): '+(revStore&&revStore.revenue>0?revStore.name+' ('+fmtMoney(revStore.revenue)+')':'N/A')+'\n'+
    'Lowest Performer (contact rate): '+(worstAgent?worstAgent.name+' ('+fmtPct(worstAgent.contactRate)+')':'N/A')+'\n\n'+
    '*Key Observations*\n'+
    'Target SLA: First call should be made within 30 minutes of deal assignment.\n'+
    slaLine+'\n'+
    (bestContactLine?bestContactLine+'\n':'')+
    (closestLine?closestLine+'\n':'')+
    conversionLine+'\n\n'+
    '_Generated automatically · Sales data as of '+(S.meta.asOf||'N/A')+'_';
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
      var hdArr=dealsDay.filter(function(d){return hourOf(d.created)===h;});
      var hc=callsDayArr.filter(function(c){return hourOf(c.created)===h;});
      var connSecs=hc.filter(function(c){return c.dur>=30;}).reduce(function(a,c){return a+c.dur;},0);
      var notDialed=hdArr.filter(function(d){return !joinDeal(D,d).contacted;}).length;
      return {deals:hdArr.length,calls:hc.length,connSecs:connSecs,notDialed:notDialed};
    });
    return {owner:o,name:ownerName(o),hours:hours,totalCalls:callsDayArr.length,totalDeals:dealsDay.length};
  }).filter(Boolean).sort(function(a,b){return b.totalCalls-a.totalCalls;});
  LAST_AGENT_HOURLY=agHourly; LAST_AGENT_HOURLY_HOURS=AH_HOURS; LAST_AGENT_HOURLY_DAY=day;
  var hourlyTalk=AH_HOURS.map(function(h,idx){ var sum=0; agHourly.forEach(function(r){sum+=r.hours[idx].connSecs;}); return {x:h+':00',y:sum}; });
  var elHTT=document.getElementById('chHourlyTalkTrend');
  if(elHTT) elHTT.innerHTML = hourlyTalk.some(function(p){return p.y>0;})
    ? lineChart(hourlyTalk,{color:'var(--c3)',legend:'Total connected talk time (≥30s calls) per hour, '+day,dataLabels:true,labelFmt:fmtHMS})
    : '<div class="note">No connected calls on '+day+' for the current filters.</div>';

  // ===== Overall Call Dump (cross-check for the chart above) =====
  var callDumpRows=buildCallDump(D,day,F);
  var connCount=callDumpRows.filter(function(r){return r.connected;}).length;
  document.getElementById('callDumpHint').innerHTML = 'Every call logged on '+day+', one row per call, so you can verify the Hourly Talk Time Trend above against real records. '+callDumpRows.length+' call(s) total, '+connCount+' connected (≥30s).';
  table('tblCallDump',['Call ID','Owner','Type','Call Time','Hour (IST)','Duration (HH:MM:SS)','Connected (≥30s)'],
    callDumpRows.map(function(r){
      return [esc(r.callId), esc(r.owner), esc(r.type), r.created, r.hour+':00', fmtHMS(r.durSecs), r.connected?'<span class="badge grn">Yes</span>':'<span class="gap">No</span>'];
    }),
    [0,0,0,0,0,0,0]);
  var maxCallsCell=0; agHourly.forEach(function(r){r.hours.forEach(function(h){if(h.calls>maxCallsCell)maxCallsCell=h.calls;});});
  document.getElementById('agHourlySub').textContent='Reference day: '+day+' · 10:00–21:00 IST · '+agHourly.length+' agent(s)';
  document.getElementById('chHeatAgent').innerHTML = agHourly.length
    ? '<div class="tblwrap" style="max-height:520px"><table class="dt heat"><thead><tr><th>Agent</th>'+AH_HOURS.map(function(h){return '<th class="num">'+h+':00</th>';}).join('')+'</tr></thead><tbody>'+
      agHourly.map(function(r){ return '<tr><td>'+esc(r.name)+'</td>'+r.hours.map(function(hc){
        return '<td class="hc" style="background:'+heatColor(hc.calls,maxCallsCell)+';text-align:left;line-height:1.45;white-space:nowrap;font-size:10.5px;font-family:\'JetBrains Mono\',monospace">Deals: '+hc.deals+'<br>Calls: '+hc.calls+'<br>Not Dialed: '+hc.notDialed+'<br>Time: '+fmtHMS(hc.connSecs)+'</td>'; }).join('')+'</tr>'; }).join('')+
      '</tbody></table></div>'
    : '<div class="note">No agent activity on '+day+' for the current filters.</div>';

  var dows=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var storeNames=sp.map(function(s){return s.name;});
  var mat2=storeNames.map(function(nm,i){ var code=sp[i].code; return dows.map(function(_,dw){ return Math.round(S.items.filter(function(it){return it.store===code && it.date>=trFrom && it.date<=trTo && it.sale_type!=='Return' && salesPassF(it,F) && dowOf(it.date+' 00:00:00')===dw;}).reduce(function(a,it){return a+(it.net||it.gross*0.97||0);},0)); }); });
  document.getElementById('chHeatStore').innerHTML = heatTable(storeNames,dows,mat2);

  // ===== Agent Wise Performance Table + Deal Trigger Event Table + extra AI Insights =====
  renderAgentPerfExt();
}

function renderAgentPerfExt(){
  var D=DATA;
  var range2=computeRange2(D);
  var rows2=buildAgentPerfExt(D,range2.from,range2.to,F);
  var trig2=buildTriggerTableExt(rows2);
  var ins2=buildInsightsExt(rows2,range2.label);
  LAST_EXT_CTX={rows:rows2,rangeLabel:range2.label};

  document.getElementById('rangeSub').textContent=range2.label;
  var totAssigned=rows2.reduce(function(a,r){return a+r.assigned;},0);
  var totCalls=rows2.reduce(function(a,r){return a+r.totalCalls;},0);
  var totConn=rows2.reduce(function(a,r){return a+r.connected;},0);
  var totWithin30=rows2.reduce(function(a,r){return a+r.within30;},0);
  var totFrtBase=rows2.reduce(function(a,r){return a+r.frtBase;},0);
  var totAct=rows2.reduce(function(a,r){return a+r.totalActivities;},0);
  var totTalk=rows2.reduce(function(a,r){return a+r.talkSecs;},0);
  var anyGatedMod=rows2.some(function(r){return r.modifiedDeals==null;});
  var totMod=anyGatedMod?null:rows2.reduce(function(a,r){return a+r.modifiedDeals;},0);
  document.getElementById('kpiGridExt').innerHTML=[
    kpiCard('Assigned Deals',fmtInt(totAssigned),'10AM–9PM: '+fmtInt(rows2.reduce(function(a,r){return a+r.winA;},0))+' · 9PM–10AM: '+fmtInt(rows2.reduce(function(a,r){return a+r.winB;},0)),'k_extassigned'),
    kpiCard('Connected %',fmtPct(pct(totConn,totCalls),0),fmtInt(totCalls)+' calls','k_extconn'),
    kpiCard('30-min SLA %',fmtPct(pct(totWithin30,totFrtBase),0),fmtInt(totWithin30)+'/'+fmtInt(totFrtBase)+' within 30 min','k_extsla',pct(totWithin30,totFrtBase)!=null&&pct(totWithin30,totFrtBase)<80?'bad':''),
    kpiCard('Total Activities',fmtInt(totAct),'Avg/Deal: '+(totAssigned?(totAct/totAssigned).toFixed(2):'N/A'),'k_extact'),
    kpiCard('Total Talk Time',fmtHMS(totTalk),'','k_exttalk'),
    kpiCard('Modified Deals',totMod==null?'N/A':fmtInt(totMod),totMod==null?'gated — see honesty note':'','k_extmod')
  ].join('');

  document.getElementById('agentPerfExtSub').textContent=range2.label+' · '+rows2.length+' active agent(s)';
  table('tblAgentPerfExt',['Agent Name','Assigned Deals','10AM–9PM Assigned','9PM–10AM Assigned','WhatsApp Deals','Total Calls','Connected Calls','Connected %','Calls Within 30 Min','Calls After 30 Min','Total Activities','Avg Activities/Deal','Total Talk Time','Modified Deals','Old Customer Activities'],
    rows2.map(function(r){ return [esc(r.name), r.assigned, r.winA, r.winB, r.waDeals, r.totalCalls, r.connected, fmtPct(r.connectedPct), r.within30, r.after30, r.totalActivities, r.avgActivitiesPerDeal!=null?r.avgActivitiesPerDeal.toFixed(2):'N/A', fmtHMS(r.talkSecs), r.modifiedDeals==null?'<span class="gap">N/A</span>':r.modifiedDeals, r.oldCustomerActivities ]; }),
    [1,1,1,1,1,1,0,1,1,1,0,0,0,1]);

  document.getElementById('trigExtSub').textContent=range2.label+' · bucketed on the real Deal_Trigger_Event vocabulary — see honesty note';
  table('tblTrigExt',['Agent Name','Total Trigger Events'].concat(TRIGGER_BUCKETS),
    trig2.map(function(r){ return [esc(r.name), r.total].concat(TRIGGER_BUCKETS.map(function(b){ return r.buckets[b]; })); }),
    [1].concat(TRIGGER_BUCKETS.map(function(){return 1;})));

  document.getElementById('insightsListExt').innerHTML = ins2.map(function(i){return '<div class="itm '+i.c+'"><span class="tag">'+i.t+'</span><span>'+i.h+'</span></div>';}).join('');

  // ===== Section 12: Deal → Sale Conversion (Same-Day, Mobile+Date) =====
  var conv=buildDealSaleConversion(DATA,S,range2.from,range2.to,F);
  LAST_CONV_CTX=conv;
  document.getElementById('convSub').textContent=range2.label+(conv.hasMobileData?'':' · Sales snapshot has no customer_mobile field yet');
  var gateConv=document.getElementById('convGate');
  if(!conv.hasMobileData){
    gateConv.style.display='';
    gateConv.innerHTML='<b>Deal→Sale mobile match is not active yet:</b> the live Sales snapshot this dashboard reads does not currently expose a customer mobile number field. Sales_overview_table itself has one (Cus_mobile, 99.8% populated) — it just needs to be added to the sales-reporting-api snapshot and redeployed. Cards below read 0/N.A. honestly rather than a fabricated match.';
  } else {
    gateConv.style.display='none';
  }
  document.getElementById('kpiGridConv').innerHTML=[
    kpiCard('Total Unique Deals',fmtInt(conv.totalUniqueDeals),range2.label,'k_convUnique'),
    kpiCard('Duplicate Deals Removed',fmtInt(conv.dupDealsRemoved),'entire loaded dataset, not just this range','k_convDup'),
    kpiCard('Same Day Sales',conv.hasMobileData?fmtInt(conv.sameDaySales):'N/A','deal + sale, same mobile + same day','k_convSameDay'),
    kpiCard('Total Sales Amount (Deal-Linked)',conv.hasMobileData?fmtMoney(conv.totalSalesAmount):'N/A','net, matched sales only','k_convAmount'),
    kpiCard('Converted Customers',conv.hasMobileData?fmtInt(conv.convertedCustomers):'N/A',conv.hasMobileData?('of '+fmtInt(conv.totalCustomers)+' unique customers'):'','k_convCust'),
    kpiCard('Conversion %',conv.hasMobileData?fmtPct(conv.conversionPct):'N/A','converted customers ÷ unique customers','k_convPct')
  ].join('');
  table('tblConvAgent',['Agent','Unique Deals','Same-Day Sales','Sales Amount (Deal-Linked)','Conversion %'],
    conv.agentRows.map(function(r){ return [esc(r.name), r.deals, r.sales, fmtMoney(r.amount), fmtPct(r.convPct)]; }),
    [1,1,0,0]);
  document.getElementById('chConvTrend').innerHTML = conv.hasMobileData
    ? lineChart(conv.dayRows.map(function(r){return {x:r.day,y:r.amount};}),{color:'var(--c2)',legend:'Deal-linked sales amount/day (₹, net)'})
    : '<div class="note">Activates once the Sales snapshot carries customer_mobile.</div>';
  table('tblConvCompare',['Day','Unique Deals','Same-Day Sales','Conversion %'],
    conv.dayRows.map(function(r){ return [r.day, r.deals, conv.hasMobileData?r.sales:'<span class="gap">N/A</span>', conv.hasMobileData?fmtPct(r.convPct):'<span class="gap">N/A</span>']; }),
    [0,1,1,0]);
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

/* ================= AGENT PERFORMANCE DATE-RANGE FILTER ================= */
function wireFilters2(){
  var D=DATA;
  var seg=document.getElementById('segRangeExt');
  seg.querySelectorAll('button').forEach(function(b){
    b.onclick=function(){
      seg.querySelectorAll('button').forEach(function(x){x.classList.remove('on');});
      b.classList.add('on'); F2.mode=b.getAttribute('data-m');
      var isCustom=F2.mode==='custom';
      document.getElementById('lblFromExt').style.display=isCustom?'flex':'none';
      document.getElementById('lblToExt').style.display=isCustom?'flex':'none';
      if(isCustom && !F2.from){ var y=addDays(D.crmMaxDate,-1); F2.from=y; F2.to=y; document.getElementById('fFromExt').value=y; document.getElementById('fToExt').value=y; }
      renderAgentPerfExt();
    };
  });
  var y=addDays(D.crmMaxDate,-1);
  document.getElementById('fFromExt').max=y; document.getElementById('fToExt').max=y;
  document.getElementById('fFromExt').onchange=function(e){ F2.from=e.target.value||null; renderAgentPerfExt(); };
  document.getElementById('fToExt').onchange=function(e){ F2.to=e.target.value||null; renderAgentPerfExt(); };
}

/* ================= AI ASSISTANT ================= */
var CHIPS=['Which agent missed most follow-ups yesterday?','Which store has the highest conversion?','Why did revenue drop yesterday?','Which meetings converted into sales?','How many deals had no call?',"Show today's pending store visits",'Compare yesterday vs last week','Suggest actions to improve conversion',
  'Which agent performed the best?','Show WhatsApp deals','Show deals where the first call was made after 30 minutes','Which agent worked on old customers?','Which agent modified the highest number of deals?',"What should be today's priority?"];
function extRows(){ return LAST_EXT_CTX?LAST_EXT_CTX.rows:[]; }
function extLabel(){ return LAST_EXT_CTX?LAST_EXT_CTX.rangeLabel:'the selected range'; }
function assistantAnswerExt(ql){
  var rows=extRows(), label=extLabel();
  if(!rows.length) return null;
  if(/best performer|performed the best|highest number of deal/.test(ql) && !/modif/.test(ql)){
    var best=rows.slice().sort(function(a,b){return b.assigned-a.assigned;})[0];
    return best.name+' performed best on volume with '+fmtInt(best.assigned)+' assigned deals'+(best.slaPct!=null?' and a '+fmtPct(best.slaPct,0)+' 30-min SLA':'')+' in '+label+' (Agent Wise Performance Table).';
  }
  if(/whatsapp deal/.test(ql)){
    var wa=rows.reduce(function(a,r){return a+r.waDeals;},0);
    var top3=rows.filter(function(r){return r.waDeals>0;}).sort(function(a,b){return b.waDeals-a.waDeals;}).slice(0,5);
    return fmtInt(wa)+' WhatsApp-triggered deals in '+label+'.'+(top3.length?' Top: '+top3.map(function(r){return r.name+' ('+r.waDeals+')';}).join(', ')+'.':'');
  }
  if(/after 30 minutes|missed sla|late first/.test(ql)){
    var late=rows.filter(function(r){return r.after30>0;}).sort(function(a,b){return b.after30-a.after30;});
    return late.length? late.map(function(r){return r.name+' ('+r.after30+')';}).join(', ')+' had first calls made after 30 minutes in '+label+'.' : 'No deals had a first call after 30 minutes in '+label+'.';
  }
  if(/old customer/.test(ql)){
    var oc=rows.filter(function(r){return r.oldCustomerActivities>0;}).sort(function(a,b){return b.oldCustomerActivities-a.oldCustomerActivities;});
    return oc.length? oc[0].name+' worked on old customers the most ('+oc[0].oldCustomerActivities+' activities on pre-existing deals) in '+label+'.' : 'No activity logged on older deals in '+label+'.';
  }
  if(/modif/.test(ql)){
    if(rows.every(function(r){return r.modifiedDeals==null;})) return 'Modified Deals is currently gated — the live feed does not yet expose each Deal\'s Modified_Time field, so this can\'t be answered accurately (see honesty note in the Agent Performance section).';
    var mod=rows.slice().sort(function(a,b){return (b.modifiedDeals||0)-(a.modifiedDeals||0);})[0];
    return mod.name+' modified the highest number of older deals ('+fmtInt(mod.modifiedDeals)+') in '+label+'.';
  }
  if(/today.?s priority|priorit/.test(ql)){
    var p=rows.slice().sort(function(a,b){ var pa=Math.max(0,a.winA-a.within30-a.after30), pb=Math.max(0,b.winA-b.within30-b.after30); return pb-pa; })[0];
    return p? 'Prioritize '+p.name+' today — carries the largest pool of not-yet-called deals in the 10AM–9PM window ('+label+').' : 'No clear priority signal for '+label+'.';
  }
  return null;
}
function assistantAnswer(q){
  var D=DATA; var today=F.refDay||D.crmMaxDate, day=addDays(today,-1); var ql=q.toLowerCase();
  var ap=buildAgentPerf(D,day,{agents:new Set()});
  var extAns=assistantAnswerExt(ql); if(extAns) return extAns;
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
    var rows=[['Agent','Hour','Deals','Calls','Not Dialed','Connected Time (HH:MM:SS)']];
    LAST_AGENT_HOURLY.forEach(function(r){ r.hours.forEach(function(hc,i){ rows.push([r.name, LAST_AGENT_HOURLY_HOURS[i]+':00', hc.deals, hc.calls, hc.notDialed, fmtHMS(hc.connSecs)]); }); });
    downloadBlob(csvOf(rows),'agent_hourly_'+(LAST_AGENT_HOURLY_DAY||'')+'.csv','text/csv');
  };
  document.getElementById('refreshBtn').onclick=function(){ refreshAll(true); };
  document.getElementById('autoRefreshSel').onchange=function(e){ CONFIG.AUTO_MS=parseInt(e.target.value,10)||0; scheduleAutoRefresh(); };
  var nav=document.getElementById('secnavIn');
  var secs=[['sec1','① Yesterday Agents'],['sec3','② Stores'],['sec4','③ Sale Dump'],['sec5','④ KPIs'],['sec6','⑤ Insights'],['sec7','⑥ Recs'],['sec8','⑦ WhatsApp'],['sec9','⑧ Visuals'],['secAgentExt','⑨ Agent Performance'],['secTrigExt','⑩ Trigger Events'],['secAiExt','⑪ AI Insights (Agents)'],['secConv','⑫ Deal→Sale Conversion']];
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
      wireHeader(); wireFilters(); wireFilters2(); wireAssistant(); renderAll();
      document.getElementById('boot').classList.add('hide');
      scheduleAutoRefresh();
    });
  });
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();

})();
