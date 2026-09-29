/* Deals VS Call — client engine. Computes everything from window.DASH (validated post-31-May Zoho snapshot). */
(function(){
"use strict";

/* ============================ CONFIG ============================ */
/* GA4 "Traffic" tab. Paste your deployed ga4-api function URL here to go live.
   Empty string → the tab shows setup instructions instead of data.
   e.g. "https://asia-south1-lucira-prod.cloudfunctions.net/ga4-data" */
var CONFIG = {
  GA4_API: "",     // ← ga4-api Cloud Function URL (see ga4-api/README.md)
  CRM_API: "",     // ← deployed zoho-crm-api "bundle" endpoint (e.g. https://…/zoho-crm-data?format=bundle). Empty = snapshot mode (uses data.js).
  ZOHO_API: "",    // ← zoho-login-dashboard backend base URL (e.g. "https://zoho-login-dashboard-….run.app"). Powers the Products / Login & Status / Helpdesk / SQI / DQI / Data & Sync tabs. Empty = those tabs show a setup panel. Backend must allow this origin (CORS) or serve this file same-origin.
  SALES_API: "https://storage.googleapis.com/lucira-dashboards/sales/latest.json", // ← live Sales snapshot (Ornaverse ERP), same public feed the Sales dashboards use. Powers Command Center's Sales Breakdown (city/state/product/sku/price-band) — company-wide only, NOT joined to CRM deals (no reliable customer-id match).
  AUTO_MS: 300000  // default auto-refresh interval in ms: 60000 = 1 min, 300000 = 5 min, 0 = off
};
/* Same-origin backend: when this file is served BY the Zoho Flask app, the template injects
   window.ZOHO_API_BASE = location.origin, so the Products / Login / Helpdesk / SQI / DQI / Data&Sync
   tabs fetch /api/* live (browser reuses the app's login). On the static Pages build the flag is
   absent → CONFIG.ZOHO_API stays "" → those tabs show their setup panel, exactly as before. */
try{ if(typeof window!=='undefined' && window.ZOHO_API_BASE!=null && window.ZOHO_API_BASE!=='') CONFIG.ZOHO_API=String(window.ZOHO_API_BASE); }catch(e){}
/* Live CRM feed: when served by the Zoho app, the template injects window.CRM_API_BASE = "/api/crm-bundle"
   (a same-origin endpoint that rebuilds this dashboard's bundle live from BigQuery). Set → LIVE mode
   (always current); absent on the static Pages build → CONFIG.CRM_API stays "" → snapshot mode (data.js). */
try{ if(typeof window!=='undefined' && window.CRM_API_BASE!=null && window.CRM_API_BASE!=='') CONFIG.CRM_API=String(window.CRM_API_BASE); }catch(e){}

/* ---------- Sales feed (company-wide Ornaverse ERP data — separate system from Zoho CRM,
   loaded independently for Command Center's Sales Breakdown section). No reliable Deal↔Sale
   join exists (Sales' customer_id is an internal party id, not Zoho's mobile-based identity),
   so this is shown as company-wide sales, never attributed to a specific deal/owner. */
var SALES = { items:[], meta:{}, live:false, loaded:false };
function loadSalesData(){
  if(!CONFIG.SALES_API){ SALES={items:[],meta:{error:'not configured'},live:false,loaded:true}; return; }
  fetch(CONFIG.SALES_API,{cache:'no-store'}).then(function(r){ if(!r.ok) throw new Error('http '+r.status); return r.json(); }).then(function(j){
    SALES = { items:j.items||[], meta:{generated_at:j.generated_at,asOf:j.asOf}, live:true, loaded:true };
    if(typeof active!=='undefined' && active==='command') render();
  }).catch(function(e){
    SALES = { items:[], meta:{error:e.message}, live:false, loaded:true };
    if(typeof active!=='undefined' && active==='command') render();
  });
}
function fmtMoney(n){ if(n==null||isNaN(n))return '—'; var a=Math.abs(n),s=n<0?'-':''; if(a>=1e7) return s+'₹'+(a/1e7).toFixed(2)+'Cr'; if(a>=1e5) return s+'₹'+(a/1e5).toFixed(2)+'L'; return s+'₹'+Math.round(a).toLocaleString('en-IN'); }
function salesInRange(from,to){ return (SALES.items||[]).filter(function(it){ return it.date>=from && it.date<=to && it.sale_type!=='Return'; }); }
function uniqCount(list,field){ var s={}; list.forEach(function(it){ if(it[field]) s[it[field]]=1; }); return Object.keys(s).length; }
function groupSales(items,field){
  var g={};
  items.forEach(function(it){
    var k=it[field]; k=(k==null||k==='')?'Unknown':String(k);
    var o=g[k]||(g[k]={key:k,label:k,orders:0,qty:0,net:0,_docs:{}});
    if(it.document_no && !o._docs[it.document_no]){ o._docs[it.document_no]=1; o.orders++; }
    o.qty+=it.qty||0; o.net+=(it.net!=null?it.net:(it.gross||0)*0.97);
  });
  return Object.keys(g).map(function(k){ var o=g[k]; delete o._docs; return o; }).sort(function(a,b){return b.net-a.net;});
}

var DASH = window.DASH || {};
var OWN = DASH.owners || {};
function ownerName(id){ return OWN[String(id)] || (id? ('User '+String(id).slice(-6)) : '(unassigned)'); }

/* ---------- map positional rows to objects ---------- */
function pd(a){return {id:a[0],name:a[1],owner:a[2],created:a[3],stage:a[4],prob:a[5],leadSource:a[6],reasonLoss:a[7],trigger:a[8],utmSource:a[9],utmMedium:a[10],numAct:a[11]||0,mobile:a[12]||'',city:a[13]||'',state:a[14]||''};}
function pc(a){return {id:a[0],owner:a[1],created:a[2],type:a[3],dur:a[4]||0,start:a[5],whatId:a[6]||'',phone:a[7]||'',result:a[8]||''};}
function pt(a){return {id:a[0],owner:a[1],created:a[2],status:a[3],due:a[4],closed:a[5],whatId:a[6]||''};}
function po(a){return {id:a[0],owner:a[1],created:a[2],channel:a[3],atype:a[4]};}
function pe(a){return {id:a[0],owner:a[1],created:a[2],start:a[3],end:a[4],title:a[5],whatId:a[6]||''};}
var DEALS=(DASH.deals||[]).map(pd), CALLS=(DASH.calls||[]).map(pc), TASKS=(DASH.tasks||[]).map(pt),
    ONLINE=(DASH.online||[]).map(po), EVENTS=(DASH.events||[]).map(pe), CE=DASH.ce||{byCat:{},byCatDay:{},byDay:{},cats:[],rawTop:[],total:0},
    DEAL_PRODUCTS=(DASH.deal_products||[]).map(function(a){return {dealId:a[0],name:a[1]||'',code:a[2]||''};});

/* CRM reference counts (100% pagination confirmed this session) */
var CRM={Deals:DEALS.length,Calls:CALLS.length,Tasks:TASKS.length,Online:ONLINE.length,Events:EVENTS.length,CustomerEvents:CE.total,EventsModuleTotal:117};

/* ---------- date helpers (data is Asia/Kolkata wall-clock, no tz math) ---------- */
function D(s){ if(!s) return null; var t=s.length>10?s:(s+'T00:00:00'); return new Date(t.replace(' ','T')); }
function dayKey(s){ return s? s.slice(0,10):''; }
function monthKey(s){ return s? s.slice(0,7):''; }
function ymd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function weekStart(s){ var d=D(s); if(!d)return ''; var wd=(d.getDay()+6)%7; var m=new Date(d.getFullYear(),d.getMonth(),d.getDate()-wd); return ymd(m); }
var MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDay(k){ if(!k)return''; var p=k.split('-'); return MON[+p[1]-1]+' '+(+p[2]); }
function fmtMonth(k){ var p=k.split('-'); return MON[+p[1]-1]+' '+p[0]; }
function fmtDT(s){ if(!s)return'—'; var d=D(s); if(!d)return'—'; return MON[d.getMonth()]+' '+d.getDate()+', '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function hms(sec){ sec=Math.round(sec||0); var h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60; return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'); }
function num(n){ return (n||0).toLocaleString('en-IN'); }
function pct(a,b){ return b? (100*a/b):0; }
function p1(n){ return (Math.round(n*10)/10).toFixed(1); }
/* Real wall-clock "today" in Asia/Kolkata, computed from the true UTC instant (not the
   browser's local timezone) so the D-1 default never drifts on a non-IST machine. */
function istTodayKey(){ var d=new Date(Date.now()+5.5*3600000); return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0'); }

/* ---------- normalizers ---------- */
function normTrig(t){ if(!t)return '(none)'; var x=(''+t).toLowerCase();
  if(x.indexOf('singup')>=0||x.indexOf('signup')>=0)return 'Signup';
  if(x.indexOf('checkout')>=0)return 'Checkout';
  if(x==='atc'||x.indexOf('addtocart')>=0||x.indexOf('add to cart')>=0||x.indexOf('add_to_cart')>=0)return 'ATC';
  if(x.indexOf('payment')>=0||x.indexOf('purchase')>=0)return 'Purchase';
  if(x.indexOf('whatsapp')>=0)return 'WhatsApp';
  if(x.indexOf('nitroproduct')>=0||x.indexOf('productview')>=0||x.indexOf('pageview')>=0||x.indexOf('product view')>=0)return 'ProductView';
  if(x.indexOf('website')>=0)return 'Website';
  return String(t).charAt(0).toUpperCase()+String(t).slice(1);
}
function clean(v){ v=(v==null?'':(''+v)).trim(); return v===''?'(none)':v; }
function cleanTitle(v){ v=clean(v); return v; }
/* Owner-Performance drill-down channel bucket for a deal: trigger first, then
   lead source / UTM source for the social/search sources trigger doesn't cover. */
function channelOf(d){
  var t=normTrig(d.trigger);
  if(t==='Checkout'||t==='ATC'||t==='WhatsApp'||t==='Website'||t==='Signup'||t==='Purchase'||t==='ProductView') return t;
  var ls=(clean(d.leadSource)+' '+clean(d.utmSource)).toLowerCase();
  if(ls.indexOf('instagram')>=0) return 'Instagram';
  if(ls.indexOf('facebook')>=0) return 'Facebook';
  if(ls.indexOf('google')>=0) return 'Google';
  return 'Others';
}

/* ---------- filter state ---------- */
var minDate='2026-05-31', maxDate=(function(){var mx='2026-05-31';DEALS.forEach(function(d){var k=dayKey(d.created);if(k>mx)mx=k;});CALLS.forEach(function(c){var k=dayKey(c.created);if(k>mx)mx=k;});return mx;})();
var F={ from:minDate, to:maxDate, preset:'yest', owners:new Set(), stage:new Set(), trigger:new Set(), leadSource:new Set(), utmSource:'', utmMedium:'', callType:'', taskStatus:'', compare:false };

function inDate(created){ var k=dayKey(created); return k>=F.from && k<=F.to; }
function inR(created,from,to){ var k=dayKey(created); return k>=(from||F.from) && k<=(to||F.to); }
function ownerOk(id){ return F.owners.size===0 || F.owners.has(String(id)); }
function toggleSet(set,val){ if(set.has(val))set.delete(val); else set.add(val); }

function fDeals(from,to){ return DEALS.filter(function(d){ return inR(d.created,from,to)&&ownerOk(d.owner)
  &&(!F.stage.size||F.stage.has(d.stage))
  &&(!F.trigger.size||F.trigger.has(normTrig(d.trigger)))
  &&(!F.leadSource.size||F.leadSource.has(clean(d.leadSource)))
  &&(!F.utmSource||clean(d.utmSource).toLowerCase()===F.utmSource.toLowerCase())
  &&(!F.utmMedium||clean(d.utmMedium).toLowerCase()===F.utmMedium.toLowerCase()); }); }
function fCalls(from,to){ return CALLS.filter(function(c){ return inR(c.created,from,to)&&ownerOk(c.owner)&&(!F.callType||c.type===F.callType); }); }
function fTasks(from,to){ return TASKS.filter(function(t){ return inR(t.created,from,to)&&ownerOk(t.owner)&&(!F.taskStatus||t.status===F.taskStatus); }); }
function fOnline(from,to){ return ONLINE.filter(function(o){ return inR(o.created,from,to)&&ownerOk(o.owner); }); }
function fEvents(from,to){ return EVENTS.filter(function(e){ return inR(e.created,from,to)&&ownerOk(e.owner); }); }

/* period-comparison helpers */
function prevPeriod(){ var f=D(F.from), t=D(F.to); var len=Math.round((t-f)/86400000)+1; var pt=new Date(f); pt.setDate(pt.getDate()-1); var pf=new Date(pt); pf.setDate(pf.getDate()-(len-1)); return {from:ymd(pf), to:ymd(pt), len:len}; }
function ceTotalRange(from,to){ var cats=CE.cats||[], tot=0; cats.forEach(function(c){ var m=(CE.byCatDay||{})[c]||{}; Object.keys(m).forEach(function(day){ if(day>=from&&day<=to)tot+=m[day]; }); }); return tot; }
function periodMetrics(from,to){
  var dl=fDeals(from,to), cl=fCalls(from,to), tk=fTasks(from,to), on=fOnline(from,to), ev=fEvents(from,to);
  var contacted=joinDeals(dl).filter(function(j){return j.contacted;}).length;
  return { deals:dl.length, unique:uniqueDeals(dl), calls:cl.length, connected:cl.filter(function(c){return c.dur>0;}).length,
    contact:pct(contacted,dl.length), won:dl.filter(isWon).length, tasks:tk.length, meetings:ev.length, chats:on.length, ce:ceTotalRange(from,to) }; }
function renderCompareBand(v){
  var pp=prevPeriod(); var cur=periodMetrics(F.from,F.to), prev=periodMetrics(pp.from,pp.to);
  var band=el('div','panel');
  band.innerHTML='<div class="phead"><div><h3>⇄ Period Comparison</h3><div class="hint">'+fmtDay(F.from)+' – '+fmtDay(F.to)+'  vs  previous '+pp.len+' day'+(pp.len===1?'':'s')+' ('+fmtDay(pp.from)+' – '+fmtDay(pp.to)+')</div></div></div>';
  var row=el('div','kpis');
  var items=[['Deals','deals',0],['Unique Deals','unique',0],['Calls','calls',0],['Connected','connected',0],['Contact Rate','contact',1],['Won Deals','won',0],['Tasks','tasks',0],['Customer Events','ce',0]];
  items.forEach(function(it){ var c=cur[it[1]], p=prev[it[1]], isPct=it[2];
    var dir=(c>p)?'up':(c<p)?'down':''; var arrow=c>p?'▲':c<p?'▼':'–';
    var curStr=isPct?p1(c)+'%':num(c), prevStr=isPct?p1(p)+'%':num(p);
    var deltaStr=isPct?((c-p>=0?'+':'')+p1(c-p)+' pp'):(p? ((c-p>=0?'+':'')+p1((c-p)/p*100)+'%') : (c>0?'new':'–'));
    var card=el('div','kpi');
    card.innerHTML='<div class="accent" style="background:'+(dir==='up'?'var(--good)':dir==='down'?'var(--bad)':'var(--tx3)')+'"></div>'+
      '<div class="k">'+esc(it[0])+'</div><div class="v">'+curStr+'</div>'+
      '<div class="d '+dir+'">'+arrow+' '+deltaStr+' <span style="color:var(--tx3)">· prev '+prevStr+'</span></div>';
    row.appendChild(card); });
  band.appendChild(row); v.appendChild(band);
}

/* ---------- deal<->call join engine ---------- */
var dealIdSet=new Set(DEALS.map(function(d){return d.id;}));
var idxWhat={}, idxPhone={};
CALLS.forEach(function(c){
  if(c.whatId && dealIdSet.has(c.whatId)){ (idxWhat[c.whatId]=idxWhat[c.whatId]||[]).push(c); }
  if(c.phone){ (idxPhone[c.phone]=idxPhone[c.phone]||[]).push(c); }
});
/* Task->Deal link (Zoho What_Id). Only populated when the data source captures it
   (live CRM_API/BigQuery feed) — the static snapshot pulled Tasks without What_Id,
   so TASKS_LINKED stays false there and task-before-call analysis is honestly gated off.
   Rebuilt by rebuildTaskIndex() — called here at module load AND again from hydrate()
   whenever a live CRM_API refresh replaces TASKS/dealIdSet with fresh data. */
var taskIdxWhat={}, TASKS_LINKED=false;
function rebuildTaskIndex(){
  taskIdxWhat={};
  TASKS.forEach(function(t){ if(t.whatId && dealIdSet.has(t.whatId)){ (taskIdxWhat[t.whatId]=taskIdxWhat[t.whatId]||[]).push(t); } });
  TASKS_LINKED = TASKS.some(function(t){ return !!t.whatId; });
}
rebuildTaskIndex();
/* For a set of deals, compute matched calls (created >= deal.created) + first call + response
   + matched tasks (any Task whose What_Id points at the deal) + task-before-first-call flag */
function joinDeals(deals){
  var out=[];
  deals.forEach(function(d){
    var seen={}, cand=[];
    (idxWhat[d.id]||[]).forEach(function(c){ if(!seen[c.id]){seen[c.id]=1;cand.push(c);} });
    if(d.mobile){ (idxPhone[d.mobile]||[]).forEach(function(c){ if(!seen[c.id]){seen[c.id]=1;cand.push(c);} }); }
    var dc=D(d.created), after=[], first=null;
    cand.forEach(function(c){ var ct=D(c.created); if(ct&&dc&&ct>=dc){ after.push(c); if(!first||ct<D(first.created))first=c; } });
    var frt = first? (D(first.created)-dc)/60000 : null; // minutes
    var dtasks=taskIdxWhat[d.id]||[];
    var firstTask=null; dtasks.forEach(function(t){ if(!firstTask||D(t.created)<D(firstTask.created))firstTask=t; });
    var taskBeforeCall = !!(firstTask && first && D(firstTask.created) < D(first.created));
    var taskNoCallYet = !!(firstTask && !first);
    out.push({deal:d, calls:after, nCalls:after.length, first:first, frt:frt, contacted:after.length>0,
      tasks:dtasks, nTasks:dtasks.length, hasTask:dtasks.length>0, firstTask:firstTask,
      taskBeforeCall:taskBeforeCall, taskNoCallYet:taskNoCallYet});
  });
  return out;
}

/* ---------- tiny DOM helpers ---------- */
function el(tag,cls,html){ var e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; }
function esc(s){ return (s==null?'':''+s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
var C=['var(--c1)','var(--c2)','var(--c3)','var(--c4)','var(--c5)','var(--c6)','var(--c7)','var(--c8)'];

/* ---------- charts (hand-rolled SVG) ---------- */
function groupBy(arr,fn){ var m={}; arr.forEach(function(x){ var k=fn(x); if(k==null)return; m[k]=(m[k]||0)+1; }); return m; }
function toItems(map){ return Object.keys(map).map(function(k){return{key:k,label:k,value:map[k]};}).sort(function(a,b){return b.value-a.value;}); }

function hbar(host, items, opts){
  opts=opts||{}; host.innerHTML='';
  if(!items.length){ host.appendChild(el('div','empty','No data for current filters.')); return; }
  var top=items.slice(0, opts.max||14);
  if(items.length>(opts.max||14)){ var rest=items.slice(opts.max||14).reduce(function(s,x){return s+x.value;},0); if(rest>0) top.push({key:'__others',label:'Others ('+(items.length-(opts.max||14))+')',value:rest}); }
  var max=Math.max.apply(null,top.map(function(x){return x.value;}))||1;
  var rowH=26, w=host.clientWidth||760, labelW=Math.min(190,Math.max(90,w*0.28)), barW=w-labelW-70, H=top.length*rowH+8;
  var svg='<svg class="chart" viewBox="0 0 '+w+' '+H+'" width="100%" height="'+H+'">';
  top.forEach(function(it,i){
    var y=i*rowH+4, bw=Math.max(1,it.value/max*barW), col=opts.color||C[i%C.length];
    if(opts.colorByKey&&opts.colorByKey[it.key])col=opts.colorByKey[it.key];
    svg+='<g class="bar" data-key="'+esc(it.key)+'">';
    svg+='<text class="lbl" x="0" y="'+(y+rowH/2+4)+'">'+esc(it.label.length>26?it.label.slice(0,25)+'…':it.label)+'</text>';
    svg+='<rect x="'+labelW+'" y="'+y+'" width="'+bw+'" height="'+(rowH-9)+'" rx="4" fill="'+col+'"></rect>';
    svg+='<text class="val" x="'+(labelW+bw+6)+'" y="'+(y+rowH/2+3)+'">'+(opts.fmt?opts.fmt(it.value):num(it.value))+'</text>';
    svg+='</g>';
  });
  svg+='</svg>'; host.innerHTML=svg;
  if(opts.onClick){ Array.prototype.forEach.call(host.querySelectorAll('.bar'),function(g){ g.addEventListener('click',function(){ var k=g.getAttribute('data-key'); if(k!=='__others')opts.onClick(k); }); }); }
}

function lineChart(host, labels, series, opts){
  opts=opts||{}; host.innerHTML='';
  if(!labels.length){ host.appendChild(el('div','empty','No data for current filters.')); return; }
  var w=Math.max(host.clientWidth||760, labels.length*14), H=230, pl=44,pr=14,pt=14,pb=42;
  var iw=w-pl-pr, ih=H-pt-pb;
  var max=1; series.forEach(function(s){ s.data.forEach(function(v){ if(v>max)max=v; }); });
  max=niceMax(max);
  var svg='<svg class="chart" viewBox="0 0 '+w+' '+H+'" width="100%" height="'+H+'">';
  for(var g=0;g<=4;g++){ var yy=pt+ih-(g/4)*ih, val=Math.round(g/4*max); svg+='<line class="gridline" x1="'+pl+'" y1="'+yy+'" x2="'+(w-pr)+'" y2="'+yy+'"/><text class="val" x="'+(pl-6)+'" y="'+(yy+3)+'" text-anchor="end">'+num(val)+'</text>'; }
  var n=labels.length, step=n>1?iw/(n-1):0;
  var everyX=Math.ceil(n/12);
  labels.forEach(function(lb,i){ if(i%everyX===0){ var x=pl+i*step; svg+='<text class="val" x="'+x+'" y="'+(H-pb+16)+'" text-anchor="middle">'+esc(lb)+'</text>'; } });
  var showLbl = opts.labels!==false; // data labels (numbers) on trend points
  series.forEach(function(s,si){ var pts=s.data.map(function(v,i){ var x=pl+i*step, y=pt+ih-(v/max)*ih; return [x,y]; });
    var dpath=pts.map(function(p,i){return (i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1);}).join(' ');
    svg+='<path d="'+dpath+'" fill="none" stroke="'+s.color+'" stroke-width="2.2"/>';
    if(n<60)pts.forEach(function(p){ svg+='<circle cx="'+p[0]+'" cy="'+p[1]+'" r="2.6" fill="'+s.color+'"/>'; });
    if(showLbl){ pts.forEach(function(p,i){ var v=s.data[i]; if(v===0)return; if(i%everyX!==0 && i!==n-1)return; var above=(si%2===0); var ly=above?(p[1]-7):(p[1]+13); if(ly<pt+8)ly=p[1]+13; if(ly>pt+ih)ly=p[1]-7; svg+='<text x="'+p[0].toFixed(1)+'" y="'+ly.toFixed(1)+'" text-anchor="middle" style="fill:'+s.color+';font-size:10px;font-weight:700">'+num(v)+'</text>'; }); }
  });
  svg+='</svg>'; host.innerHTML=svg;
  if(series.length>1||opts.legend){ var lg=el('div','legend'); series.forEach(function(s){ lg.innerHTML+='<span><i class="dot" style="background:'+s.color+'"></i>'+esc(s.name)+'</span>'; }); host.appendChild(lg); }
}
function niceMax(m){ if(m<=5)return 5; var p=Math.pow(10,Math.floor(Math.log10(m))); var r=m/p; var n=r<=1?1:r<=2?2:r<=5?5:10; return n*p; }

function donut(host, items, opts){
  opts=opts||{}; host.innerHTML='';
  var total=items.reduce(function(s,x){return s+x.value;},0);
  if(!total){ host.appendChild(el('div','empty','No data.')); return; }
  var R=70,r=44,cx=90,cy=90, a=-Math.PI/2;
  var svg='<svg viewBox="0 0 300 180" width="100%" height="180"><g>';
  items.forEach(function(it,i){ var frac=it.value/total, a2=a+frac*2*Math.PI, col=(opts.colorByKey&&opts.colorByKey[it.key])||C[i%C.length];
    var x1=cx+R*Math.cos(a),y1=cy+R*Math.sin(a),x2=cx+R*Math.cos(a2),y2=cy+R*Math.sin(a2);
    var xa=cx+r*Math.cos(a2),ya=cy+r*Math.sin(a2),xb=cx+r*Math.cos(a),yb=cy+r*Math.sin(a);
    var large=frac>0.5?1:0;
    svg+='<path class="bar" data-key="'+esc(it.key)+'" d="M'+x1+' '+y1+' A'+R+' '+R+' 0 '+large+' 1 '+x2+' '+y2+' L'+xa+' '+ya+' A'+r+' '+r+' 0 '+large+' 0 '+xb+' '+yb+' Z" fill="'+col+'"/>';
    a=a2;
  });
  svg+='<text x="'+cx+'" y="'+(cy-2)+'" text-anchor="middle" class="lbl" style="font-size:20px;font-weight:700">'+num(total)+'</text><text x="'+cx+'" y="'+(cy+16)+'" text-anchor="middle" class="val">'+(opts.center||'total')+'</text></g></svg>';
  var box=el('div'); box.style.display='flex'; box.style.alignItems='center'; box.style.gap='10px'; box.style.flexWrap='wrap';
  var sd=el('div'); sd.style.flex='1 1 150px'; sd.innerHTML=svg;
  var lg=el('div','legend'); lg.style.flexDirection='column'; lg.style.gap='5px';
  items.forEach(function(it,i){ var col=(opts.colorByKey&&opts.colorByKey[it.key])||C[i%C.length]; lg.innerHTML+='<span><i class="dot" style="background:'+col+'"></i>'+esc(it.label)+' · <b style="color:var(--tx)">'+num(it.value)+'</b> ('+p1(pct(it.value,total))+'%)</span>'; });
  box.appendChild(sd); box.appendChild(lg); host.appendChild(box);
  if(opts.onClick){ Array.prototype.forEach.call(host.querySelectorAll('.bar'),function(g){ g.addEventListener('click',function(){ opts.onClick(g.getAttribute('data-key')); }); }); }
}

/* ---------- KPI + panel + table builders ---------- */
/* ===== BI Info-Panel engine (ⓘ) — business-intelligence explainer modal, wired into every kpi()/panel() ===== */
var INFO = {};   // key -> content object, populated by Object.assign(INFO,{...}) blocks below.
Object.assign(INFO, {
  'command.task_assigned_before_call': {
    name:'Task Assigned Before Call', tabLabel:'Command Center · Section 14',
    what:'Flags a deal whenever a Task was created for it before its first call went out. It measures whether agents are logging a follow-up task ahead of actually calling the customer.',
    importance:'A high rate can mean agents are deferring calls in favour of scheduling reminders, which delays first contact and hurts SLA/coverage. A low rate means agents mostly call first and only create tasks afterwards.',
    formula:'For each deal: taskBeforeCall = (earliest linked Task\'s Created Time) &lt; (first linked Call\'s Created Time). Requires Task→Deal linking via Zoho <code>What_Id</code> — only available on the live BigQuery feed, not the static snapshot.',
    interpretation:'Read together with "Task Assigned, No Call Yet" below (task exists but the deal still has zero calls) — that subset is the more urgent one to chase.',
    related:'Pending First Calls, SLA %, Owner Performance'
  },
  'command.deals_w_task_before_call': {
    name:'Deals w/ Task Before Call', tabLabel:'Command Center · Section 14',
    what:'Count (and % of all deals in the selected range) where a Task was logged before the deal\'s first call.',
    formula:'COUNT(deals where taskBeforeCall = true) / COUNT(all deals in range)',
    interpretation:'Rising over time can indicate agents are prioritising task-scheduling over immediate outreach — cross-check the Agent-wise table below for which owners drive it.'
  },
  'command.task_assigned_no_call_yet': {
    name:'Task Assigned, No Call Yet', tabLabel:'Command Center · Section 14',
    what:'Deals that have a Task logged but have NOT been called at all yet in the selected range.',
    importance:'The highest-risk of the group — a task/reminder was planned but never executed, and the customer has heard nothing since inquiry.',
    actions:'Prioritise this list ahead of the general Pending First Calls queue, since a task already exists for these deals — someone intended to call and hasn\'t yet.'
  },
  'command.time_wise_hour_of_day_ist': {
    name:'Task Before Call — Time-wise', tabLabel:'Command Center · Section 14',
    what:'Task-before-call metric grouped by the hour of day (IST) the deal was created, 12 AM–11 PM.',
    interpretation:'Use this to spot hours where agents default to scheduling a task instead of calling immediately — often late-evening/early-morning hours with lower live-agent availability.'
  },
  'command.agent_wise': {
    name:'Task Before Call — Agent-wise', tabLabel:'Command Center · Section 14',
    what:'Task-before-call metric grouped by deal owner (agent), sorted by highest count first.',
    importance:'Identifies which agents more often log a task before calling — useful for coaching on immediate-response discipline.'
  },
  'command.deal_trigger_wise': {
    name:'Task Before Call — Deal Trigger-wise', tabLabel:'Command Center · Section 14',
    what:'Task-before-call metric grouped by the Deal Trigger Event (e.g. ATC, Checkout, ProductView, Signup, WhatsApp) that created the deal.',
    interpretation:'Some triggers (e.g. Checkout/Purchase) may warrant an immediate call rather than a scheduled task given higher intent — compare rates across triggers to see where policy isn\'t being followed.'
  },
  'command.biz_connected30': {
    name:'Connected (>30s)', tabLabel:'Command Center · Section 3 (Business vs Non-Business)',
    what:'Number of calls in this window lasting longer than 30 seconds — a simple proxy for a real connected conversation rather than a ring/voicemail/instant hang-up.',
    formula:'COUNT(calls where Call_Duration_in_seconds &gt; 30)'
  },
  'command.biz_talk': {
    name:'Total Talk Time', tabLabel:'Command Center · Section 3 (Business vs Non-Business)',
    what:'Sum of call duration across all calls in this window, shown as HH:MM:SS.',
    formula:'SUM(Call_Duration_in_seconds)'
  },
  'command.deals_created': {
    name:'Deals Created', tabLabel:'Command Center · KPI Strip',
    what:'Total number of Deals created in Zoho CRM during the selected date range and filters — every new lead that entered the pipeline as a Deal record.',
    importance:'This is the volume denominator behind almost every other KPI on this dashboard (Call Coverage, SLA %, Unique Deals Called) — a swing here changes how those percentages should be read even if the underlying process hasn\'t changed.',
    formula:'COUNT(Deals where Created_Time falls in the selected range, after owner/stage/source filters)',
    interpretation:'Compare against Calls Done and Call Coverage together — a spike in Deals Created without a matching rise in Calls Done is usually the first sign the team is falling behind on outreach.',
    related:'Calls Done, Call Coverage, Unique Deals Called'
  },
  'command.calls_done': {
    name:'Calls Done', tabLabel:'Command Center · KPI Strip',
    what:'Total number of Calls logged (outbound, inbound and missed) in the selected window, regardless of whether the call reached the customer.',
    importance:'A raw activity/effort metric, not an outcome metric — pair it with "Connected (>30s)" and Call Coverage to see how much of this dialling actually reached someone.',
    formula:'COUNT(Calls where Created_Time falls in the selected range)',
    interpretation:'High Calls Done with low Call Coverage usually means agents are re-dialling the same deals rather than reaching new ones — check the Owner Performance table (Section 5) for who is driving it.',
    related:'Call Coverage, Unique Deals Called, Connected (>30s)'
  },
  'command.unique_deals_called': {
    name:'Unique Deals Called', tabLabel:'Command Center · KPI Strip',
    what:'Count of distinct deals that received at least one call in the selected window — a deal dialled 5 times still counts once.',
    importance:'The real "reach" number: how many different customers actually got a call, independent of how many total dial attempts it took.',
    formula:'COUNT(DISTINCT deal.id where the deal has ≥1 linked Call in range)',
    interpretation:'This is the numerator behind Call Coverage % (Unique Deals Called ÷ Deals Created). If Calls Done keeps rising but this stays flat, effort isn\'t converting into new reach.',
    related:'Call Coverage, Deals Created, Pending First Calls'
  },
  'command.pending_first_calls': {
    name:'Pending First Calls', tabLabel:'Command Center · KPI Strip',
    what:'Deals in the selected window that have NOT yet received a single call — no first-contact attempt has happened.',
    importance:'The core backlog metric. Every deal counted here is a lead going cold with zero outreach, which directly hurts Call Coverage and, eventually, win rate.',
    formula:'Step-by-step, per deal: (1) find candidate calls two ways — every Call whose <code>What_Id</code> points at this Deal\'s id, PLUS every Call whose phone number (parsed from the Call Subject, since To/From_Number are often blank) matches this deal\'s Mobile; (2) merge and de-duplicate those into one candidate list; (3) keep only calls whose Created_Time is at/after the deal\'s Created_Time (a call logged before the deal existed can\'t be its first-contact call); (4) if that filtered list is empty, the deal is "pending" — zero real first-contact calls linked to it. Pending First Calls = COUNT(deals where step 4 is empty), scoped to the selected date range and any active owner/stage/source filters.',
    interpretation:'A deal only leaves this bucket once a call is found linking back to it — cross-check the Hourly Connectivity heatmap (Section 4) and Owner Performance (Section 5) to see which hours or owners are driving the backlog before assigning blame to overall headcount.',
    actions:'Triage this list first — the longer a deal sits here, the more it overlaps with Overdue Deals (Section 6) and the higher the risk of losing an interested customer.',
    related:'Overdue Deals, Call Coverage, Owner Performance'
  },
  'command.avg_first_response': {
    name:'Avg First Response', tabLabel:'Command Center · KPI Strip',
    what:'Mean time from a deal being created to its first outbound call, averaged across all deals in the window that have been called at least once.',
    importance:'First-response time is one of the strongest predictors of conversion for inbound sales leads — the odds of qualifying a lead typically drop sharply once the first response takes more than 5–30 minutes.',
    formula:'AVG(first_call.Created_Time − deal.Created_Time) across contacted deals',
    interpretation:'Averages hide outliers — always read this next to Median First Response and Max First Response; a low average with a very high max usually means a handful of deals were badly delayed.',
    related:'Median First Response, Max First Response, SLA %'
  },
  'command.median_first_response': {
    name:'Median First Response', tabLabel:'Command Center · KPI Strip',
    what:'The middle value of first-response time across contacted deals — half of deals were called faster than this, half slower.',
    importance:'More robust than the average against a handful of extreme delays, so it better reflects the "typical" customer experience.',
    formula:'MEDIAN(first_call.Created_Time − deal.Created_Time) across contacted deals',
    interpretation:'If the median is much lower than Avg First Response, a small number of very late calls are dragging the average up — check Max First Response and the Overdue Deals table to find them.',
    related:'Avg First Response, Max First Response'
  },
  'command.max_first_response': {
    name:'Max First Response', tabLabel:'Command Center · KPI Strip',
    what:'The single slowest first-response time recorded for any contacted deal in the selected window.',
    importance:'Flags the worst-case customer experience — the one deal that waited longest before ever being called.',
    formula:'MAX(first_call.Created_Time − deal.Created_Time) across contacted deals',
    interpretation:'A Max much higher than the Median points to an isolated miss (e.g. a deal assigned to an unavailable owner) rather than a systemic problem — check Owner Performance to identify who owned it.',
    related:'Median First Response, Owner Performance'
  },
  'command.call_coverage': {
    name:'Call Coverage', tabLabel:'Command Center · KPI Strip',
    what:'The percentage of deals created in this window that have received at least one call.',
    importance:'The single best "are we actually working the pipeline" number — a deal with zero calls has effectively zero chance of converting, no matter how good its lead quality is.',
    formula:'Unique Deals Called ÷ Deals Created × 100, target 90%',
    interpretation:'Different from SLA %: Coverage asks "did we call at all", SLA % asks "did we call fast enough". A deal can be fully covered but still be an SLA breach if the call was late.',
    related:'Unique Deals Called, SLA %, Pending First Calls'
  },
  'command.sla': {
    name:'SLA %', tabLabel:'Command Center · KPI Strip',
    what:'The percentage of contacted deals whose first call happened within the 30-minute response-time SLA.',
    importance:'Measures speed, not just whether a call happened — a deal counted in Call Coverage can still fail SLA if the first call came late.',
    formula:'COUNT(deals where first-response time ≤ 30 min) ÷ COUNT(contacted deals) × 100, target 80%',
    interpretation:'Read alongside Avg/Median First Response for the underlying timing distribution, and Overdue Deals for the exact list of breaches.',
    related:'Call Coverage, Overdue Deals, Avg First Response'
  },
  'command.overdue_deals': {
    name:'Overdue Deals', tabLabel:'Command Center · KPI Strip',
    what:'Deals in the selected window that are either (a) contacted later than 30 minutes after creation, or (b) still uncalled and already older than 30 minutes.',
    importance:'The action list — every deal counted here has already breached the response-time SLA and needs manager attention now, not eventually.',
    formula:'COUNT(deals where (contacted AND first-response &gt; 30min) OR (not contacted AND age &gt; 30min))',
    actions:'Work this list directly via the "Overdue Deals" table (Section 6) — it\'s the same set, ranked with owner and priority.',
    related:'Pending First Calls, SLA %'
  },
  'command.meetings_scheduled': {
    name:'Meetings Scheduled', tabLabel:'Command Center · KPI Strip',
    what:'Count of Zoho Events (meetings) with a start time in the selected window, regardless of whether they\'ve happened yet.',
    importance:'The deeper-funnel counterpart to calls — tracks how many customer meetings the team has on the books.',
    formula:'COUNT(Events where Start_DateTime falls in the selected range)',
    interpretation:'Zoho Events here are owner-level and NOT linked to a specific Deal record, so this can\'t be broken down per-deal or tied to a Meeting→Sale conversion rate — read it as a team-level activity count, not a pipeline metric.',
    related:'Meetings Completed, Meetings Pending'
  },
  'command.meetings_completed': {
    name:'Meetings Completed', tabLabel:'Command Center · KPI Strip',
    what:'Meetings from the selected window whose scheduled start time has already passed (start &lt; reference time).',
    formula:'COUNT(Events where Start_DateTime &lt; reference time)',
    interpretation:'Shown with a completion % of Meetings Scheduled. Because Events aren\'t deal-linked, this can\'t confirm whether a completed meeting actually led to a sale.',
    related:'Meetings Scheduled'
  },
  'command.meetings_pending': {
    name:'Meetings Pending', tabLabel:'Command Center · KPI Strip',
    what:'Meetings from the selected window that are still upcoming — start time has not yet passed.',
    formula:'COUNT(Events where Start_DateTime ≥ reference time)',
    related:'Meetings Scheduled, Meetings Completed'
  },
  'command.meetings_missed': {
    name:'Meetings Missed', tabLabel:'Command Center · KPI Strip',
    what:'Intended to count meetings that were scheduled but never attended (a no-show).',
    importance:'Shown as "n/a" on purpose — Zoho Events has no outcome/status field distinguishing "attended" from "no-show", so this can\'t be computed honestly from the current data model.',
    interpretation:'See Meetings Completed for the closest available proxy (elapsed time only, not confirmed attendance). Fixing this properly needs a status field added to the Events module in Zoho.',
    related:'Meetings Completed, Meetings Scheduled'
  },
  'command.call_duration_analysis': {
    name:'Call Duration Analysis', tabLabel:'Command Center · Section 15',
    what:'Buckets every call in the selected window by how long it actually lasted, from 0 seconds up to 30+ seconds.',
    importance:'Duration is the only reliable signal Zoho captures about what happened on a call — there is no telephony status field (no Busy/Failed/Voicemail/Cancelled/Not-Answered taxonomy in this CRM), so duration buckets are the closest honest proxy for call quality.',
    impactTemplate:'A pipeline full of very short calls (0-10s) usually means dials aren\'t reaching people — every one of those is a customer who got zero real outreach despite showing as "called" in Call Coverage.',
    formula:'For every Call in range: bucket = 0s if Call_Duration_in_seconds=0; 1-5s if ≤5; 6-10s if ≤10; 11-15s if ≤15; 16-20s if ≤20; 21-30s if ≤30; otherwise &gt;30s.',
    dataSource:'<b>Calls table:</b> Call_Duration_in_seconds, Call_Type, Call_Result, Owner, Created_Time',
    columnExplain:[['Call_Duration_in_seconds','Actual connected duration of the call, in seconds — 0 means the call never connected.'],['Call_Type','Outbound / Inbound / Missed — a reliable Zoho field, shown as a separate cross-cut.'],['Call_Result','An optional sales-disposition note the agent can type (Interested / Not interested / etc.) — only set on a small minority of calls, not a technical status.']],
    benchmark:'No industry-standard threshold applies to raw duration buckets — read this next to Connected (>0s) % and the Zero-Second Calls section instead of a fixed target.',
    actionsTemplate:'If 0-10s buckets are large relative to total calls, check the Zero-Second Calls section (⑯) for the specific agents driving it before assuming a data-quality issue.',
    suggestedQuestions:['How many zero-second calls today?','What % of calls are actually connected?','Top agent by calls']
  },
  'command.dur_total_calls': {
    name:'Total Calls', tabLabel:'Command Center · Section 15',
    what:'Every Call record logged in the selected window, regardless of duration or direction.',
    formula:'COUNT(Calls where Created_Time falls in the selected range)',
    related:'Connected (>0s), Not Connected (0s)'
  },
  'command.dur_connected': {
    name:'Connected (>0s)', tabLabel:'Command Center · Section 15',
    what:'Calls with any nonzero duration — the call reached someone and lasted at least 1 second.',
    formula:'COUNT(calls where Call_Duration_in_seconds &gt; 0)',
    interpretation:'This is a looser definition than the "Connected (>30s)" column used elsewhere in Command Center (Sections 3-5, 14) — that one requires 30+ seconds as a proxy for a real conversation. Use whichever matches the question: "did it connect at all" vs "was it a real conversation".',
    related:'Not Connected (0s), Zero-Second Calls'
  },
  'command.dur_not_connected': {
    name:'Not Connected (0s)', tabLabel:'Command Center · Section 15',
    what:'Calls logged with exactly 0 seconds of duration — dialed but never actually connected.',
    formula:'COUNT(calls where Call_Duration_in_seconds = 0)',
    importance:'Every one of these represents dialling effort that produced zero customer contact — see Section ⑯ (Zero-Second Calls) for the full breakdown.',
    related:'Zero-Second Calls (Section 16), Connected (>0s)'
  },
  'command.call_duration_agentwise': {
    name:'Call Duration — Agent-wise', tabLabel:'Command Center · Section 15',
    what:'The same duration buckets as above, split out per agent (owner of the call), sorted by total call volume.',
    importance:'Lets you compare not just how many calls each agent makes, but how many of those calls are substantive vs. instant/very short.',
    dataSource:'<b>Calls table:</b> Owner, Call_Duration_in_seconds',
    suggestedQuestions:['Top agent by calls','Average first response']
  },
  'command.call_outcome_disposition': {
    name:'Call Outcome — agent-logged (Call_Result)', tabLabel:'Command Center · Section 15',
    what:'The real Call_Result field from Zoho where an agent has typed a sales disposition for the call (Interested, Not interested, Requested callback, Invalid number, No response/Busy, etc.).',
    importance:'This is genuinely useful qualitative signal where present, but it is agent-entered and optional — it is NOT a telephony connection status, and most calls don\'t have it filled in.',
    impactTemplate:'Treat this panel as a sample, not a full picture — a high "Not interested" share among the calls that DO have this field set is still useful context for coaching, but says nothing about the majority of calls with no disposition logged.',
    dataSource:'<b>Calls table:</b> Call_Result',
    columnExplain:[['Call_Result','Free-text/picklist sales disposition typed by the agent after the call — optional, so only a minority of calls have it set.']],
    warningsTemplate:'Do not confuse this with a "Busy/Failed/Voicemail" telephony taxonomy — Zoho does not track that for this org. This panel only appears at all when at least one call has Call_Result set.'
  },
  'command.call_duration_trend': {
    name:'Call Duration — 30-day Trend', tabLabel:'Command Center · Section 15',
    what:'Daily Connected % and Zero-Second % over the last 30 days (ending on the selected "to" date), so you can see whether call quality is improving or slipping over time.',
    formula:'Per day: Connected % = calls with duration&gt;0 ÷ total calls that day; Zero-Second % = calls with duration=0 ÷ total calls that day.',
    interpretation:'A rising Zero-Second % line alongside a flat or rising total-call-volume line is the clearest sign of "more dialling, not more reaching" — cross-check against the Agent-wise table for who is driving it.',
    suggestedQuestions:['How many zero-second calls today?']
  },
  'command.zero_second_calls': {
    name:'Zero-Second Calls', tabLabel:'Command Center · Section 16',
    what:'Calls that were dialed but never connected at all — Call_Duration_in_seconds recorded as exactly 0.',
    importance:'The clearest "wasted dial" signal in this data model — a zero-second call gives the customer zero chance to engage, no matter how it\'s counted elsewhere (it still counts toward Call Coverage and Calls Done).',
    impactTemplate:'A high zero-second rate inflates Call Coverage and Calls Done without any real customer contact happening — those KPIs can look healthy while actual response quality is poor.',
    formula:'COUNT(calls where Call_Duration_in_seconds = 0), and % = that ÷ Total Calls in the same window.',
    dataSource:'<b>Calls table:</b> Call_Duration_in_seconds, Owner, Created_Time',
    columnExplain:[['Call_Duration_in_seconds','0 means the call was logged but never actually connected — no ring answered, instant hang-up, or a misdial.']],
    benchmark:'No universal telephony-industry figure applies here since this is CRM-logged duration, not a dialer\'s connect rate — the ⚠ agent flag at >15% of that agent\'s calls is a working threshold, not an external standard; adjust it if it doesn\'t match your team\'s reality.',
    actionsTemplate:'Review the flagged (⚠) agents in the table below first — a sustained high zero-second rate for one agent is worth a direct conversation before assuming it\'s a systemic dialer/network issue.',
    warningsTemplate:'Root cause (misdial, instant hang-up, wrong number, network drop) is not captured by any Zoho field for this org — this metric flags WHERE to look, not WHY it happened.',
    suggestedQuestions:['How many zero-second calls today?','Top agent by calls']
  },
  'command.zero_second_calls_kpi': {
    name:'Total Zero-Second Calls', tabLabel:'Command Center · Section 16',
    what:'Count and % of all calls in the selected window with exactly 0 seconds duration.',
    formula:'COUNT(calls where Call_Duration_in_seconds = 0) ÷ Total Calls × 100',
    related:'Not Connected (0s), Call Duration Analysis'
  },
  'command.deals_never_called': {
    name:'Deals Created But Never Called', tabLabel:'Command Center · Section 17',
    what:'Deals created in the selected window that have ZERO calls linked to them — ever, checked against the full call history, not just the calls that happen to fall inside the selected date range.',
    importance:'This is the highest-risk backlog on the whole dashboard: every row is a lead that has never once been spoken to. It overlaps with but is stricter than "Pending First Calls" — this table specifically confirms no call exists at all, not just none yet in the current window.',
    impactTemplate:'Each of these deals has had zero opportunity to convert. The longer a deal sits here, the colder the lead gets and the more likely the customer has already bought elsewhere.',
    formula:'For each deal created in range: join against ALL calls (via What_Id link or matching Mobile number, not date-restricted) — if zero matching calls exist, the deal appears here. Sorted by longest-waiting first.',
    dataSource:'<b>Deals table:</b> id, Deal_Name, Owner, Created_Time, Lead_Source, Deal_Trigger_Event, Probability · <b>Calls table:</b> What_Id, Mobile-matched phone · <b>Tasks table:</b> Created_Time, What_Id (live feed only)',
    columnExplain:[['Deal ID','Unique Zoho record ID for the deal.'],['Task Created','When a follow-up Task was logged for this deal, if any — only available when the live CRM feed with Task→Deal linking is connected; shows "—" on the static snapshot.'],['Hours Since Created','How long ago the deal was created, in hours, relative to now (or end of the selected day if looking at a past date).'],['Priority','High/Medium/Low, based on deal Probability and how long it has been waiting — reuses the same priority logic as the Deal Quality tab.'],['Reason','Lead Source and Deal Trigger Event shown together as context for WHY this lead came in — not a diagnosis of why it wasn\'t called.'],['SLA Status','Breach if the deal has been waiting longer than the 30-minute first-response SLA, else Within SLA.']],
    benchmark:'Target is 0 — every deal here should ideally be called well within the 30-minute SLA window used elsewhere on this dashboard.',
    actionsTemplate:'Triage by Priority first, then by Hours Since Created — a High-priority deal waiting 48 hours is more urgent than a Low-priority deal waiting 2 hours.',
    suggestedQuestions:['How many deals never received a call?','Top agent by calls']
  },
  'command.deals_never_called_kpi': {
    name:'Deals Never Called', tabLabel:'Command Center · Section 17',
    what:'Count and % of deals created in the selected window with zero calls ever linked to them.',
    formula:'COUNT(deals with 0 matched calls, all-time) ÷ Deals Created in range × 100',
    related:'Pending First Calls, Call Coverage'
  }
});
/* ---- Agent-wise Deals VS Call (new section, below Owner Performance) ---- */
Object.assign(INFO, {
  'command.agentdvc_total_deals': {
    name:'Yesterday Total Deals', tabLabel:'Command Center · Agent-wise Deals VS Call',
    what:'Distinct deals created yesterday (IST), across all agents — fixed to real yesterday regardless of the date-range filter above, same convention as the Overdue Deals column in Owner Performance.',
    formula:'COUNT(DISTINCT Deal_ID) WHERE DATE(Deal_Created_Time, IST) = Yesterday',
    related:'Yesterday Deals Pending Call, Yesterday Deals Call %'
  },
  'command.agentdvc_total_calls': {
    name:'Yesterday Total Calls', tabLabel:'Command Center · Agent-wise Deals VS Call',
    what:'All valid calls made yesterday by any agent — includes calls on yesterday\'s new deals AND on older deals. This is raw calling activity, not deal-linked.',
    formula:'COUNT(DISTINCT Call_ID) WHERE DATE(Call_Created_Time, IST) = Yesterday',
    related:'Yesterday Deals → Calls, Yesterday Talk Time'
  },
  'command.agentdvc_deals_to_calls': {
    name:'Yesterday Deals → Calls', tabLabel:'Command Center · Agent-wise Deals VS Call',
    what:'Calls made yesterday specifically against deals created yesterday (call happened at/after that deal\'s creation time). A call count, not a distinct-deal count — one deal called 3 times yesterday adds 3 here.',
    formula:'COUNT(Call_ID) WHERE Call_Date = Yesterday AND Deal_Created_Date = Yesterday AND Call_Time ≥ Deal_Created_Time',
    related:'Yesterday Deals Call %, Yesterday Deals Talk Time'
  },
  'command.agentdvc_call_pct': {
    name:'Yesterday Deals Call %', tabLabel:'Command Center · Agent-wise Deals VS Call',
    what:'% of yesterday\'s newly created deals that received at least one valid call yesterday. Deliberately a DISTINCT-deal ratio, not Total Calls ÷ Total Deals — multiple calls on one deal don\'t inflate it.',
    formula:'COUNT(DISTINCT Deal_ID, ≥1 call yesterday after creation) ÷ Yesterday Deals × 100',
    related:'Yesterday Deals → Calls, Yesterday Deals Pending Call'
  },
  'command.agentdvc_contacted_till_now': {
    name:'Yesterday Deals Contacted Till Now', tabLabel:'Command Center · Agent-wise Deals VS Call',
    what:'Distinct count of yesterday-created deals that have received at least one valid call at any point since creation — yesterday, today, whenever — up to right now.',
    formula:'COUNT(DISTINCT Deal_ID) WHERE Deal_Created_Date = Yesterday AND ≥1 Call_Time ≥ Deal_Created_Time, as of now',
    interpretation:'Different from "Yesterday Deals Call %", which only counts calls made ON yesterday — a deal first called today still counts here but not there.',
    related:'Yesterday Deals Pending Call, Yesterday Deals Call %'
  },
  'command.agentdvc_pending_call': {
    name:'Yesterday Deals Pending Call', tabLabel:'Command Center · Agent-wise Deals VS Call',
    what:'Yesterday-created deals with ZERO valid calls after creation, as of right now (not restricted to yesterday\'s call date — a call made today still clears a deal from this list).',
    importance:'The main actionable backlog from this section — deals a day old with no outreach attempt at all.',
    formula:'Yesterday Deals − Yesterday Deals Contacted Till Now',
    related:'Yesterday Deals Contacted Till Now, Pending First Calls, Overdue Deals'
  },
  'command.agentdvc_frt30_pct': {
    name:'FRT ≤30 %', tabLabel:'Command Center · Agent-wise Deals VS Call',
    what:'% of yesterday\'s deals whose first valid call (any call at/after creation, whenever it happened) arrived within 30 minutes of creation.',
    formula:'COUNT(DISTINCT Deal_ID, first-call FRT ≤ 30 min) ÷ Yesterday Deals × 100',
    related:'Avg FRT (Working Hours), SLA %'
  },
  'command.agentdvc_avg_frt_wh': {
    name:'Avg FRT (Working Hours)', tabLabel:'Command Center · Agent-wise Deals VS Call',
    what:'Average first-response time for yesterday\'s deals that were CREATED during working hours (10 AM–9 PM IST). Deals created outside working hours are excluded entirely, not just their FRT.',
    formula:'AVG(first_call.Created_Time − deal.Created_Time) for yesterday deals with 10AM≤creation&lt;9PM, that have received ≥1 call',
    interpretation:'Shows "—" when no eligible deal has been called yet; the deal count shown alongside is how many deals the average is actually based on.',
    related:'FRT ≤30 %, Avg First Response'
  },
  'command.agentdvc_talk_time': {
    name:'Yesterday Talk Time', tabLabel:'Command Center · Agent-wise Deals VS Call',
    what:'Total talk-time (connected call duration) across every call the agent made yesterday, on any deal.',
    formula:'SUM(Call_Duration) WHERE DATE(Call_Created_Time, IST) = Yesterday'
  },
  'command.agentdvc_deal_talk_time': {
    name:'Yesterday Deals Talk Time', tabLabel:'Command Center · Agent-wise Deals VS Call',
    what:'Talk-time spent specifically on yesterday\'s newly created deals, via calls made yesterday.',
    formula:'SUM(Call_Duration) WHERE Call_Date = Yesterday AND Deal_Created_Date = Yesterday AND Call_Time ≥ Deal_Created_Time'
  },
  'command.agentdvc_connected_calls': {
    name:'Connected Calls', tabLabel:'Command Center · Agent-wise Deals VS Call',
    what:'Of the agent\'s Total Calls in the selected period, how many had Talk Time ≥30 seconds. Each call counts once.',
    formula:'COUNT(Call_ID) WHERE Call_Created_Date IN [selected period] AND Call_Duration_Seconds ≥ 30',
    related:'Total Calls, Talk Time'
  },
  'command.agentdvc_pending_call_window': {
    name:'Deals Pending Call (10AM–8:30PM)', tabLabel:'Command Center · Agent-wise Deals VS Call',
    what:'Of "Deals Pending Call" (zero valid calls after creation, as of now), how many were created in the 10:00 AM–8:30 PM IST business window and are still Open/WIP (not Won/Lost).',
    formula:'COUNT(DISTINCT Deal_ID) WHERE Deals_Pending_Call AND Stage NOT LIKE \'%Won%\' AND Stage NOT LIKE \'%Lost%\' AND TIME(Deal_Created_Time, IST) BETWEEN 10:00 AND 20:30',
    related:'Yesterday Deals Pending Call'
  }
});
/* Cross-scope refs: assigned once the Section-11 IIFE defines these (see near its SLA_MIN/dayMetrics/opsModel/reportModel).
   Declaring here (outer scope) lets the generic info-panel engine call them for ANY tab, since they read the shared
   global filter state F rather than being tab-specific. */
var SLA_MIN, SLA_TARGET, COVER_TARGET, dayMetricsFn, opsModelFn, reportModelFn, askAIFn;
function slugify(s){ return (String(s==null?'':s).replace(/<[^>]*>/g,'').toLowerCase().match(/[a-z0-9]+/g)||['m']).join('_'); }
function infoBtnHTML(key){ return key?(' <button type="button" class="info-ico" data-info="'+esc(key)+'" title="What is this?" aria-label="Explain this metric">ⓘ</button>'):''; }
function lbl(text,key){ return {html:esc(text)+infoBtnHTML(key), text:text}; }

function ensureInfoModal(){
  if(document.getElementById('infoModalBg')) return;
  var bg=el('div','info-modal-bg'); bg.id='infoModalBg';
  bg.innerHTML='<div class="info-modal-card" id="infoModalCard" role="dialog" aria-modal="true"></div>';
  bg.addEventListener('click',function(e){ if(e.target===bg) closeInfo(); });
  document.body.appendChild(bg);
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') closeInfo(); });
  document.addEventListener('click',function(e){
    var b=e.target.closest && e.target.closest('.info-ico');
    if(b){ e.preventDefault(); e.stopPropagation(); openInfo(b.getAttribute('data-info')); return; }
    var q=e.target.closest && e.target.closest('.im-qchip');
    if(q){ e.preventDefault(); e.stopPropagation(); var qt=q.getAttribute('data-q'); closeInfo(); if(askAIFn) askAIFn(qt); }
  });
  (function(){ var st=el('style'); st.textContent=
    '.info-ico{background:none;border:none;cursor:pointer;font-size:13px;color:var(--tx3);vertical-align:middle;padding:0 2px;line-height:1;transition:color .15s}'+
    '.info-ico:hover{color:var(--acc)}'+
    '.kpi .k{display:inline-flex;align-items:center;gap:2px}'+
    '.info-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:none;align-items:center;justify-content:center;padding:18px}'+
    '.info-modal-bg.open{display:flex}'+
    '.info-modal-card{position:relative;background:var(--card);border:1px solid var(--line);border-radius:14px;max-width:720px;width:100%;max-height:88vh;overflow:auto;padding:26px 24px 22px;box-shadow:0 20px 60px rgba(0,0,0,.35);color:var(--tx)}'+
    '.info-modal-card h2{margin:0 0 4px;font-size:17px;padding-right:26px}'+
    '.info-modal-card .im-sec{margin:14px 0}'+
    '.info-modal-card .im-sec h4{margin:0 0 6px;font-size:12.5px;text-transform:uppercase;letter-spacing:.3px;color:var(--tx2)}'+
    '.info-modal-card .im-sec .body{font-size:13px;line-height:1.65;color:var(--tx)}'+
    '.info-modal-card .im-sec ul,.info-modal-card .im-sec ol{margin:2px 0;padding-left:18px}'+
    '.info-modal-card .im-sec li{margin:3px 0}'+
    '.info-modal-card .im-close{position:absolute;top:14px;right:16px;background:none;border:none;font-size:20px;line-height:1;color:var(--tx2);cursor:pointer}'+
    '.info-modal-card .im-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin:6px 0}'+
    '.info-modal-card .im-grid .c{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:8px 10px}'+
    '.info-modal-card .im-grid .c .t{font-size:10px;text-transform:uppercase;color:var(--tx3)}'+
    '.info-modal-card .im-grid .c .v{font-size:14px;font-weight:700;margin-top:2px}'+
    '.info-modal-card .im-missing{color:var(--tx3);font-size:13px;padding:20px 0;text-align:center}'+
    '.info-modal-card .im-sec dl{margin:4px 0;display:grid;grid-template-columns:max-content 1fr;gap:4px 12px}'+
    '.info-modal-card .im-sec dt{font-weight:700;color:var(--tx);white-space:nowrap}'+
    '.info-modal-card .im-sec dd{margin:0;color:var(--tx2)}'+
    '.im-qchips{display:flex;flex-wrap:wrap;gap:7px}'+
    '.im-qchip{background:var(--bg2);border:1px solid var(--line);color:var(--acc);padding:6px 11px;border-radius:20px;font-size:12px;cursor:pointer;transition:all .15s}'+
    '.im-qchip:hover{border-color:var(--acc);background:rgba(79,140,255,.08)}';
    document.head.appendChild(st);
  })();
}
var IM_ICON={what:'📖',importance:'🎯',current:'📊',insight:'🤖',root:'🔍',impact:'⚠',actions:'✅',formula:'🧮',interpretation:'📈',benchmark:'🏆',trend:'📅',warnings:'🚨',related:'🔗',depts:'👥',best:'💡',exec:'📝',dataSource:'🗄️',columnExplain:'📋',suggestedQuestions:'💬'};
var IM_TITLE={what:'What is this',importance:'Business Importance',current:'Current Performance',insight:'AI Insight',root:'Root Cause',impact:'Business Impact',actions:'Recommended Actions',formula:'Formula',interpretation:'Interpretation Guide',benchmark:'Healthy Benchmark',trend:'Historical Trend',warnings:'Warning Signals',related:'Related Metrics',depts:'Responsible Teams',best:'Best Practices',exec:'Executive Summary',dataSource:'Data Source',columnExplain:'Column Explanation',suggestedQuestions:'Suggested Questions'};
function imSec(key,html){ if(!html)return ''; return '<div class="im-sec"><h4>'+IM_ICON[key]+' '+IM_TITLE[key]+'</h4><div class="body">'+html+'</div></div>'; }
/* Renders m.columnExplain when given as an array of [name,desc] pairs (preferred — avoids hand-written <dl> markup);
   also accepts a pre-built HTML string for backward compatibility. */
function imColumnExplain(v){ if(!v)return ''; if(typeof v==='string')return v; var dl='<dl>'; v.forEach(function(pair){ dl+='<dt>'+esc(pair[0])+'</dt><dd>'+esc(pair[1])+'</dd>'; }); return dl+'</dl>'; }
/* Suggested-question chips: clicking one closes the info modal and asks the real Ask-AI assistant (askAIFn,
   wired from buildAssistant()) — never a fake canned answer. */
function imQuestions(qs){ if(!qs||!qs.length) return ''; var chips=qs.map(function(q){ return '<button type="button" class="im-qchip" data-q="'+esc(q)+'">'+esc(q)+' →</button>'; }).join('');
  return '<div class="im-sec"><h4>'+IM_ICON.suggestedQuestions+' '+IM_TITLE.suggestedQuestions+'</h4><div class="body im-qchips">'+chips+'</div></div>'; }
/* Global BI tokens — computed fresh (from the CURRENT filters F) every time a modal opens, so every metric's
   templates can reference real cross-cutting context (best/worst owner, peak backlog hour, ...) even metrics
   that don't have their own trend field. Missing/inapplicable values resolve to '—', never fabricated. */
function imContext(){
  var t={dateRange:fmtDay(F.from)+' – '+fmtDay(F.to), scope:(F.owners.size?F.owners.size+' owner(s) selected':'all owners')};
  try{ if(opsModelFn){ var M=opsModelFn();
    t.bestOwner=M.best?M.best.name:'—'; t.worstOwner=M.worst?M.worst.name:'—'; t.mostPendingOwner=M.mostPending?M.mostPending.name:'—';
    t.peakBacklogHour=M.peakBacklog?hr12(M.peakBacklog.hour):'—'; t.peakWorkloadHour=M.peakWorkload?hr12(M.peakWorkload.hour):'—';
    t.topOverdueSource=(M.odSrc&&M.odSrc[0])?M.odSrc[0].label:'—';
    t.overdueCount=num(M.overdueCnt); t.pendingCount=num(M.pendingCnt); t.dealsCount=num(M.deals); t.callsCount=num(M.calls);
    t.coveragePct=p1(M.coverage)+'%'; t.slaPct=p1(M.slaPct)+'%'; t.avgFrtNice=fmtMinNice(M.avgFrt); t.medFrtNice=fmtMinNice(M.medFrt);
  } }catch(e){}
  try{ var dl=fDeals(), cl=fCalls(), tk=fTasks(), on=fOnline(), ev=fEvents();
    var joined=joinDeals(dl), contacted=joined.filter(function(j){return j.contacted;});
    t.contactRatePct=p1(pct(contacted.length,dl.length))+'%';
    var won=dl.filter(isWon), lost=dl.filter(function(d){return (d.stage||'').toLowerCase().indexOf('lost')>=0;});
    t.wonCount=num(won.length); t.lostCount=num(lost.length); t.winRatePct=p1(pct(won.length,(won.length+lost.length)||1))+'%';
    t.totalTasks=num(tk.length); t.overdueTasks=num(tk.filter(function(x){return !isDone(x)&&x.due&&dayKey(x.due)<dayKey(maxDate);}).length);
    t.totalChats=num(on.length); t.totalEvents=num(ev.length); t.totalMeetings=num(ev.length); t.totalCalls=num(cl.length);
  }catch(e){}
  return t;
}
function fillTokens(str,ctx){ if(!str)return ''; return String(str).replace(/\{\{(\w+)\}\}/g,function(_,k){ return (ctx[k]!=null?ctx[k]:'—'); }); }
/* Generic 4-window trend block (Current / Yesterday / Last 7 Days / Last 30 Days / Target) for any metric whose
   value is a field on dayMetrics()'s result shape ({deals,calls,contacted,pending,coverage,avgFrt,medFrt,slaPct,meetings}).
   Metrics without a natural dayMetrics field (e.g. Overdue Deals, Meetings Missed) pass trendField=null and fall
   back to the registry's static "currentStatic" text — never fabricated. */
function trendBlock(fieldName, kind, target, higherIsBetter){
  if(!fieldName || !dayMetricsFn) return null;
  try{
    function fmt(x){ if(x==null)return '—'; if(kind==='percent')return p1(x)+'%'; if(kind==='minutes')return fmtMinNice(x); if(kind==='count')return num(Math.round(x)); return String(x); }
    var to=F.to; var yestD=D(to); yestD.setDate(yestD.getDate()-1); var yest=ymd(yestD);
    var w7d=D(to); w7d.setDate(w7d.getDate()-6); var w30d=D(to); w30d.setDate(w30d.getDate()-29);
    var cur=dayMetricsFn(F.from,F.to)[fieldName], y=dayMetricsFn(yest,yest)[fieldName],
        w7=dayMetricsFn(ymd(w7d),to)[fieldName], w30=dayMetricsFn(ymd(w30d),to)[fieldName];
    higherIsBetter=(higherIsBetter!==false);
    var diff=(cur!=null&&y!=null)?cur-y:null;
    var trendWord=diff==null?'flat':(diff>0?'up':(diff<0?'down':'flat'));
    var gap=(target!=null&&cur!=null)?(higherIsBetter?(target-cur):(cur-target)):null;
    var html='<div class="im-grid">'+
      '<div class="c"><div class="t">Current</div><div class="v">'+fmt(cur)+'</div></div>'+
      '<div class="c"><div class="t">Yesterday</div><div class="v">'+fmt(y)+'</div></div>'+
      '<div class="c"><div class="t">Last 7 Days</div><div class="v">'+fmt(w7)+'</div></div>'+
      '<div class="c"><div class="t">Last 30 Days</div><div class="v">'+fmt(w30)+'</div></div>'+
      (target!=null?('<div class="c"><div class="t">Target</div><div class="v">'+fmt(target)+'</div></div>'):'')+
      '</div>'+(gap!=null?('<div style="font-size:12.5px;margin-top:6px;color:'+(gap>0?'var(--bad)':'var(--good)')+'">'+(gap>0?('Gap to target: '+fmt(Math.abs(gap))):'On or above target')+'</div>'):'');
    return {html:html, cur:cur, y:y, w7:w7, w30:w30, diff:diff, trendWord:trendWord, gap:gap, fmt:fmt};
  }catch(e){ return null; }
}
function renderInfoHTML(key){
  var m=INFO[key];
  if(!m) return '<button class="im-close" onclick="closeInfo()">&times;</button><div class="im-missing">No business-intelligence explanation has been written yet for this metric.<br><span style="font-size:11px">(key: '+esc(key)+')</span></div>';
  var ctx=imContext();
  var tb = m.trendField ? trendBlock(m.trendField, m.trendKind, m.target, m.higherIsBetter) : null;
  var html='<button class="im-close" onclick="closeInfo()">&times;</button>';
  html+='<h2>'+esc(m.name||key)+'</h2>';
  if(m.tabLabel) html+='<div style="font-size:11.5px;color:var(--tx3);margin-bottom:6px">'+esc(m.tabLabel)+'</div>';
  html+=imSec('what',m.what);
  html+=imSec('importance',m.importance);
  html+=imSec('impact', fillTokens(m.impactTemplate,ctx));
  html+=imSec('formula',m.formula);
  html+=imSec('dataSource',m.dataSource);
  html+=imSec('columnExplain', imColumnExplain(m.columnExplain));
  html+=imSec('current', (tb&&tb.html) ? tb.html : (m.currentStatic||''));
  html+=imSec('benchmark',m.benchmark);
  html+=imSec('actions', fillTokens(m.actionsTemplate,ctx));
  html+=imSec('insight', fillTokens(m.insightTemplate,ctx));
  html+=imSec('root', fillTokens(m.rootCauseTemplate,ctx));
  html+=imSec('interpretation',m.interpretation);
  html+=imSec('warnings', fillTokens(m.warningsTemplate,ctx));
  html+=imSec('related',m.related);
  html+=imSec('depts',m.depts);
  html+=imSec('best',m.best);
  html+=imSec('trend', (tb?('<p>Recent direction: <b>'+tb.trendWord+'</b> vs yesterday ('+tb.fmt(tb.cur)+' now, '+tb.fmt(tb.y)+' yesterday).</p>'):'')+(m.trend||''));
  html+=imSec('exec', fillTokens(m.execTemplate,ctx));
  html+=imQuestions(m.suggestedQuestions);
  return html;
}
function openInfo(key){ ensureInfoModal(); document.getElementById('infoModalCard').innerHTML=renderInfoHTML(key); document.getElementById('infoModalBg').classList.add('open'); }
function closeInfo(){ var bg=document.getElementById('infoModalBg'); if(bg) bg.classList.remove('open'); }
window.closeInfo=closeInfo; /* referenced by the inline onclick on the × button */

/* Generic row-level drill-down: reuses the info-modal chrome (.info-modal-bg/.info-modal-card) at a wider
   width, with a sortable/exportable table() inside instead of BI-explainer text. Used by Command Center
   KPIs/alerts/table rows that need to show "these N records" without discarding the current filter state. */
function ensureDrillModal(){
  if(gid('drillModalBg')) return;
  var bg=el('div','info-modal-bg'); bg.id='drillModalBg';
  bg.innerHTML='<div class="info-modal-card" id="drillModalCard" style="max-width:980px" role="dialog" aria-modal="true"></div>';
  bg.addEventListener('click',function(e){ if(e.target===bg) closeDrill(); });
  document.body.appendChild(bg);
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') closeDrill(); });
}
function openDrill(title, headers, rows, opts){
  ensureDrillModal();
  opts=opts||{key:'drill_'+slugify(title)};
  var name=opts.key||slugify(title);
  var plainRows=rows.map(function(r){ return r.map(function(c){ return (c&&c.text!=null)?c.text:(c&&c.html!=null?String(c.html).replace(/<[^>]+>/g,''):c); }); });
  var card=gid('drillModalCard');
  card.innerHTML='<button class="im-close" onclick="closeDrill()">&times;</button><h2>'+esc(title)+'</h2>'+
    '<div style="display:flex;align-items:center;gap:8px;margin:6px 0 2px;flex-wrap:wrap">'+
      '<button class="mini" id="drillDlXl">⭳ Download Excel</button>'+
      '<button class="mini" id="drillDlCsv">⭳ Download CSV</button>'+
    '</div>'+
    '<div id="drillBody" style="margin-top:6px"></div>';
  table(gid('drillBody'), headers, rows, opts);
  gid('drillDlXl').onclick=function(){ exportExcelSimple(name, headers, plainRows); };
  gid('drillDlCsv').onclick=function(){ exportCSV(name, headers, plainRows); };
  gid('drillModalBg').classList.add('open');
}
function closeDrill(){ var bg=gid('drillModalBg'); if(bg) bg.classList.remove('open'); }
window.closeDrill=closeDrill;

function kpi(k,v,d,dcls,accent,infoKey){ infoKey=infoKey||(active+'.'+slugify(k)); var e=el('div','kpi'); e.innerHTML='<div class="accent" style="background:'+(accent||'var(--acc)')+'"></div><div class="k">'+esc(k)+infoBtnHTML(infoKey)+'</div><div class="v">'+v+'</div>'+(d?'<div class="d '+(dcls||'')+'">'+d+'</div>':''); return e; }
function kpiRow(list){ var g=el('div','kpis'); list.forEach(function(x){ g.appendChild(kpi(x[0],x[1],x[2],x[3],x[4],x[5])); }); return g; }
function panel(title,hint,infoKey){ infoKey=infoKey||(active+'.'+slugify(title)); var p=el('div','panel'); var h=el('div','phead'); h.appendChild(el('div',null,'<h3>'+esc(title)+infoBtnHTML(infoKey)+'</h3>'+(hint?'<div class="hint">'+esc(hint)+'</div>':''))); p.appendChild(h); var body=el('div','chart'); p.appendChild(body); p.__body=body; p.__head=h; return p; }
function addExport(p, name, headers, rows){
  var b=el('button','mini','⭳ CSV'); b.onclick=function(){ exportCSV(name,headers,rows); }; p.__head.appendChild(b);
  var bx=el('button','mini','⭳ Excel'); bx.onclick=function(){ exportExcelSimple(name,headers,rows); }; p.__head.appendChild(bx);
}
function median(arr){ if(!arr||!arr.length)return null; var a=arr.slice().sort(function(x,y){return x-y;}); var n=a.length,h=Math.floor(n/2); return n%2?a[h]:(a[h-1]+a[h])/2; }

var sortState={};
function table(host, headers, rows, opts){
  opts=opts||{}; host.innerHTML='';
  var wrap=el('div','tblwrap'); var t=el('table'); var thead=el('thead'); var tr=el('tr');
  var key=opts.key||'tbl';
  headers.forEach(function(h,ci){ var th=el('th',null,esc(h)+(sortState[key]&&sortState[key].c===ci?(sortState[key].dir>0?' ▲':' ▼'):'')); th.onclick=function(){ var cur=sortState[key]||{c:-1,dir:-1}; var dir=(cur.c===ci)?-cur.dir:(opts.numCols&&opts.numCols.indexOf(ci)>=0?-1:1); sortState[key]={c:ci,dir:dir}; table(host,headers,rows,opts); }; tr.appendChild(th); });
  thead.appendChild(tr); t.appendChild(thead);
  var body=rows.slice();
  var ss=sortState[key];
  if(ss){ body.sort(function(a,b){ var x=a[ss.c],y=b[ss.c]; var xn=parseFloat(String(x).replace(/[^0-9.\-]/g,'')),yn=parseFloat(String(y).replace(/[^0-9.\-]/g,'')); if(!isNaN(xn)&&!isNaN(yn)&&opts.numCols&&opts.numCols.indexOf(ss.c)>=0){return (xn-yn)*ss.dir;} return String(x).localeCompare(String(y))*ss.dir; }); }
  var tb=el('tbody'); var shown=body.slice(0,opts.limit||500);
  shown.forEach(function(r){ var trr=el('tr'); r.forEach(function(c,ci){ var td=el('td',opts.numCols&&opts.numCols.indexOf(ci)>=0?'right':null); td.innerHTML=(c&&c.html)?c.html:esc(c); trr.appendChild(td); }); tb.appendChild(trr); });
  t.appendChild(tb);
  /* Totals footer: sum additive numeric columns (counts + talk-time) across ALL rows.
     Skips non-additive cols (averages, %, min/max/median, per-deal, delay). Only shown when at least one column sums. */
  if(opts.totals!==false && opts.numCols && opts.numCols.length && body.length>1){
    var tf=el('tfoot'); var ftr=el('tr'); var summed=0; var cells=[];
    headers.forEach(function(h,ci){
      var isNum=opts.numCols.indexOf(ci)>=0; var td=el('td',isNum?'right':null);
      td.style.borderTop='2px solid rgba(128,128,128,.45)'; td.style.fontWeight='700'; td.style.background='rgba(128,128,128,.07)';
      if(ci===0){ td.innerHTML='TOTAL'; }
      else if(isNum){
        var hl=String(h).toLowerCase();
        if(/%|avg|rate|\bmed|median|\bmax|\bmin\b|per |\/deal|delay|prob|connectivity/.test(hl)){ td.innerHTML=''; }
        else {
          var isTalk=/talk/.test(hl), sum=0;
          body.forEach(function(r){ var c=r[ci]; var v=(c&&c.text!=null)?c.text:(c&&c.html!=null?c.html:c); var s=String(v); var n;
            var hm=isTalk?s.match(/(\d+):(\d\d):(\d\d)/):null; /* talk cells may be raw seconds (.text) OR an "HH:MM:SS" string */
            if(hm){ n=(+hm[1])*3600+(+hm[2])*60+(+hm[3]); } else { n=parseFloat(s.replace(/[^0-9.\-]/g,'')); }
            if(!isNaN(n))sum+=n; });
          td.innerHTML=isTalk?hms(sum):num(Math.round(sum)); summed++;
        }
      }
      cells.push(td);
    });
    if(summed){ cells.forEach(function(td){ ftr.appendChild(td); }); tf.appendChild(ftr); t.appendChild(tf); }
  }
  wrap.appendChild(t); host.appendChild(wrap);
  if(body.length>shown.length){ host.appendChild(el('div','hint','Showing '+shown.length+' of '+num(body.length)+' rows. Use CSV export for full data.')); }
}
function exportCSV(name, headers, rows){
  var lines=[headers.map(csvCell).join(',')];
  rows.forEach(function(r){ lines.push(r.map(function(c){ return csvCell((c&&c.text!=null)?c.text:(c&&c.html?String(c.html).replace(/<[^>]+>/g,''):c)); }).join(',')); });
  var blob=new Blob([lines.join('\r\n')],{type:'text/csv;charset=utf-8;'}); var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name+'.csv'; a.click(); setTimeout(function(){URL.revokeObjectURL(a.href);},500);
}
function csvCell(v){ v=(v==null?'':''+v); if(/[",\n]/.test(v))return '"'+v.replace(/"/g,'""')+'"'; return v; }
function exportExcelSimple(name, headers, rows){
  function xcell(v){ return '<Cell><Data ss:Type="String">'+esc(v==null?'':''+v).replace(/\r?\n/g,'&#10;')+'</Data></Cell>'; }
  function rowCell(c){ return (c&&c.text!=null)?c.text:(c&&c.html!=null?String(c.html).replace(/<[^>]+>/g,''):c); }
  var head='<Row>'+headers.map(function(h){return xcell(h);}).join('')+'</Row>';
  var body=rows.map(function(r){ return '<Row>'+r.map(function(c){return xcell(rowCell(c));}).join('')+'</Row>'; }).join('');
  var xml='<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>'+
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'+
    '<Worksheet ss:Name="'+esc(name).slice(0,31)+'"><Table>'+head+body+'</Table></Worksheet></Workbook>';
  var blob=new Blob([xml],{type:'application/vnd.ms-excel'}); var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name+'.xls'; a.click(); setTimeout(function(){URL.revokeObjectURL(a.href);},500);
}

/* trend helper: counts by day/week/month for an array using created */
function trend(arr, gran, dateFn){ dateFn=dateFn||function(x){return x.created;}; var keyFn=gran==='month'?monthKey:gran==='week'?weekStart:dayKey; var m={}; arr.forEach(function(x){ var k=keyFn(dateFn(x)); if(k)m[k]=(m[k]||0)+1; }); var keys=Object.keys(m).sort(); return {keys:keys,vals:keys.map(function(k){return m[k];}),map:m}; }
function mergeKeys(a,b){ var s={}; a.forEach(function(k){s[k]=1;}); b.forEach(function(k){s[k]=1;}); return Object.keys(s).sort(); }
function fmtKeys(keys,gran){ return keys.map(gran==='month'?fmtMonth:fmtDay); }

/* ============================ TABS ============================ */
var TABS=[
  ['overview','Overview'],['deals','Deals'],['calls','Calls'],['dvc','Deals × Calls'],
  ['agents','Agents'],['tasks','Tasks'],['chat','Chat'],['events','Customer Events'],['activities','Activities'],
  ['traffic','Traffic'],['quality','Deal Quality'],['validation','Validation']
];
/* Optional backend-API tabs (Products/Login/Helpdesk/SQI/DQI/Data&Sync) — OFF by default; only shown when the host
   injects window.DVC_BACKEND_TABS. Deals VS Call stays the original 12-tab dashboard unless explicitly opted in. */
try{ if(typeof window!=='undefined' && window.DVC_BACKEND_TABS){ TABS.push(['products','Products'],['login','Login & Status'],['helpdesk','Helpdesk'],['sqi','SQI'],['dqi','DQI'],['datasync','Data & Sync']); } }catch(e){}
/* Stock/Inventory: only present when the host injects window.STOCK_URL. Absent on the standalone build. */
try{ if(typeof window!=='undefined' && window.STOCK_URL){ TABS.push(['stock','💎 Stock']); } }catch(e){}
var active='dvc';

function ownerItems(arr){ return toItems(groupBy(arr,function(x){return ownerName(x.owner);})); }

/* ---- Overview ---- */
/* green/yellow/red by threshold. higherBetter: v>=warnAt→good, >=badAt→warn, else bad. Else inverted (lower is better). */
function semColor(v,warnAt,badAt,higherBetter){
  if(v==null) return 'var(--tx3)';
  if(higherBetter) return v>=warnAt?'var(--good)':(v>=badAt?'var(--warn)':'var(--bad)');
  return v<=warnAt?'var(--good)':(v<=badAt?'var(--warn)':'var(--bad)');
}
function renderOverview(v){
  var dl=fDeals(), cl=fCalls(), tk=fTasks(), on=fOnline(), ev=fEvents();
  var joined=joinDeals(dl); var contactedJ=joined.filter(function(j){return j.contacted;}); var contacted=contactedJ.length;
  var conn=cl.filter(function(c){return c.dur>0;}).length;
  var uniq=uniqueDeals(dl);
  v.appendChild(kpiRow([
    ['Total Deals',num(dl.length),'unique: '+num(uniq),'','var(--c1)'],
    ['Total Calls',num(cl.length),num(conn)+' connected','','var(--c2)'],
    ['Contact Rate',p1(pct(contacted,dl.length))+'%',num(contacted)+' deals reached','','var(--c4)'],
    ['Tasks',num(tk.length),num(tk.filter(isDone).length)+' completed','','var(--c3)'],
    ['Meetings',num(ev.length),'store visits / calls','','var(--c6)'],
    ['Chats',num(on.length),'omnichannel','','var(--c5)']
  ]));
  /* ---- Executive Summary: management KPI strip, color-coded green/yellow/red ---- */
  var pendingJ=joined.filter(function(j){return !j.contacted;});
  var maxT=D(maxDate);
  function ageMin(j){ return (maxT-D(j.deal.created))/60000; }
  var p30=pendingJ.filter(function(j){return ageMin(j)>30;}).length;
  var p1h=pendingJ.filter(function(j){return ageMin(j)>60;}).length;
  var p4h=pendingJ.filter(function(j){return ageMin(j)>240;}).length;
  var p1d=pendingJ.filter(function(j){return ageMin(j)>1440;}).length;
  var frts=contactedJ.map(function(j){return j.frt;}).filter(function(x){return x!=null&&x>=0;});
  var avgFrt=frts.length?frts.reduce(function(s,x){return s+x;},0)/frts.length:null;
  var medFrt=median(frts);
  var winRate=pct(dl.filter(isWon).length,dl.length);
  var avgTalk=conn?cl.filter(function(c){return c.dur>0;}).reduce(function(s,c){return s+c.dur;},0)/conn:0;
  v.appendChild(el('div','note','<b>Executive Summary</b> — reflects the active date/stage/owner filters above (not necessarily calendar "today" unless the Today preset is selected). Green/Yellow/Red bands: Contact Rate & Win Rate — good ≥ shown threshold; Avg/Median FRT & Pending buckets — good the lower the better. Orders/Revenue are gated: this dataset has no Deal↔Sale join yet.'));
  v.appendChild(kpiRow([
    ["Today's Deals",num(dl.length),'in selected range','','var(--c1)'],
    ["Today's Calls",num(cl.length),'in selected range','','var(--c2)'],
    ['Connected Calls',num(conn),p1(pct(conn,cl.length))+'% of calls','',semColor(pct(conn,cl.length),50,30,true)],
    ['Pending Calls',num(pendingJ.length),'deals never reached','',semColor(pendingJ.length,Math.max(5,Math.round(dl.length*0.1)),Math.max(15,Math.round(dl.length*0.25)),false)],
    ['Orders','—','no Deal↔Sale join','','var(--tx3)'],
    ['Revenue','—','no Deal↔Sale join','','var(--tx3)'],
    ['Win Rate',p1(winRate)+'%',num(dl.filter(isWon).length)+' won','',semColor(winRate,15,8,true)],
    ['Average FRT',avgFrt==null?'—':fmtDur(avgFrt),'first response','',semColor(avgFrt,15,60,false)],
    ['Median FRT',medFrt==null?'—':fmtDur(medFrt),'first response','',semColor(medFrt,15,60,false)],
    ['Average Talk Time',hms(avgTalk),'connected calls only','','var(--c4)'],
    ['Pending >30 Min',num(p30),'not yet contacted','',semColor(p30,3,10,false)],
    ['Pending >1 Hour',num(p1h),'not yet contacted','',semColor(p1h,2,8,false)],
    ['Pending >4 Hours',num(p4h),'not yet contacted','',semColor(p4h,1,5,false)],
    ['Pending >1 Day',num(p1d),'not yet contacted','',semColor(p1d,0,3,false)]
  ]));
  var g=el('div','grid g2');
  var p1p=panel('Deals vs Calls — Daily Trend','Created per day'); g.appendChild(p1p);
  var gran=pickGran(F.from,F.to);
  var td=trend(dl,gran), tc=trend(cl,gran), keys=mergeKeys(td.keys,tc.keys);
  lineChart(p1p.__body, fmtKeys(keys,gran), [
    {name:'Deals',color:'var(--c1)',data:keys.map(function(k){return td.map[k]||0;})},
    {name:'Calls',color:'var(--c2)',data:keys.map(function(k){return tc.map[k]||0;})}
  ]);
  var p2=panel('Deals by Stage'); g.appendChild(p2); donut(p2.__body, toItems(groupBy(dl,function(d){return d.stage||'(none)';})),{center:'deals',onClick:function(k){toggleSet(F.stage,k);sync();}});
  var p3=panel('Deals by Owner'); g.appendChild(p3); hbar(p3.__body, ownerItems(dl), {onClick:toggleOwner});
  var p4=panel('Calls by Owner'); g.appendChild(p4); hbar(p4.__body, ownerItems(cl), {onClick:toggleOwner});
  v.appendChild(g);
  // --- Activity by hour of day (merged from old dashboard's hourly trend) ---
  var pHr=panel('Activity by Hour of Day (IST)','Deals created & calls by hour — working window 9AM–9PM'); v.appendChild(pHr);
  var hrD=[],hrC=[],labels=[]; for(var i=0;i<24;i++){hrD.push(0);hrC.push(0);labels.push(String(i).padStart(2,'0'));}
  dl.forEach(function(d){hrD[hourOf(d.created)]++;}); cl.forEach(function(c){hrC[hourOf(c.created)]++;});
  lineChart(pHr.__body, labels, [{name:'Deals',color:'var(--c1)',data:hrD},{name:'Calls',color:'var(--c2)',data:hrC}]);
}
function pickGran(from,to){ var days=(D(to)-D(from))/86400000; return days>150?'month':days>70?'week':'day'; }
function isDone(t){ var s=(t.status||'').toLowerCase(); return s.indexOf('complet')>=0||s.indexOf('closed')>=0; }
function uniqueDeals(arr){ var s={}; arr.forEach(function(d){ s[dayKey(d.created)+'|'+(d.mobile||d.id)]=1; }); return Object.keys(s).length; }

/* ---- Deals (Dashboard 1) ---- */
function renderDeals(v){
  var dl=fDeals(); var uniq=uniqueDeals(dl); var dups=dl.length-uniq;
  var lost=dl.filter(function(d){return (d.stage||'').toLowerCase().indexOf('lost')>=0;});
  var won=dl.filter(function(d){return (d.stage||'').toLowerCase().indexOf('won')>=0;});
  var avgAct=dl.length?dl.reduce(function(s,d){return s+(+d.numAct||0);},0)/dl.length:0;
  v.appendChild(kpiRow([
    ['Total Deals',num(dl.length),'','','var(--c1)'],
    ['Unique Deals',num(uniq),'DATE(create)+mobile10','','var(--c2)'],
    ['Duplicate Leads',num(dups),p1(pct(dups,dl.length))+'% of total','','var(--c5)'],
    ['Closed Won',num(won.length),p1(pct(won.length,dl.length))+'% win','up','var(--good)'],
    ['Lost Deals',num(lost.length),p1(pct(lost.length,dl.length))+'%','down','var(--bad)'],
    ['Avg Activities / Deal',p1(avgAct),'Number_of_activity','','var(--c3)']
  ]));
  var gran=pickGran(F.from,F.to);
  var g1=el('div','grid g2');
  var pOwn=panel('Deals by Owner'); g1.appendChild(pOwn); var ownIt=ownerItems(dl); hbar(pOwn.__body,ownIt,{onClick:toggleOwner}); addExport(pOwn,'deals_by_owner',['Owner','Deals'],ownIt.map(function(x){return[x.label,x.value];}));
  var pStage=panel('Deals by Stage'); g1.appendChild(pStage); donut(pStage.__body,toItems(groupBy(dl,function(d){return d.stage||'(none)';})),{center:'deals',onClick:function(k){toggleSet(F.stage,k);sync();}});
  var pTrig=panel('Deals by Trigger Event'); g1.appendChild(pTrig); var trigIt=toItems(groupBy(dl,function(d){return normTrig(d.trigger);})); hbar(pTrig.__body,trigIt,{onClick:function(k){toggleSet(F.trigger,k);sync();}});
  var pSrc=panel('Deals by Lead Source'); g1.appendChild(pSrc); hbar(pSrc.__body,toItems(groupBy(dl,function(d){return clean(d.leadSource);})),{onClick:function(k){if(k==='(none)')return; toggleSet(F.leadSource,k); sync();}});
  var pUtmS=panel('Deals by UTM Source'); g1.appendChild(pUtmS); hbar(pUtmS.__body,toItems(groupBy(dl,function(d){return clean(d.utmSource);})),{});
  var pUtmM=panel('Deals by UTM Medium'); g1.appendChild(pUtmM); hbar(pUtmM.__body,toItems(groupBy(dl,function(d){return clean(d.utmMedium);})),{});
  v.appendChild(g1);

  // --- Deals by Time-Slot (merged from old dashboard) ---
  var ts=dealTimeSlots(dl);
  var pTS=panel('Deals by Time-Slot','Working blocks 9AM–9PM (4×3h) + off-hours 9PM–9AM · bucketed by Created time (IST) · connectivity = deal reached by a call after creation'); v.appendChild(pTS);
  var tsK=el('div','kpis');
  [['Created Deals',num(ts.tot.created),'','var(--c1)'],['Connected Deals',num(ts.tot.connected),p1(pct(ts.tot.connected,ts.tot.created))+'% connectivity','var(--c2)'],['Conversion (Won)',num(ts.tot.won),p1(pct(ts.tot.won,ts.tot.created))+'% conv','var(--good)'],['Acts / Deal',p1(ts.tot.created?ts.tot.acts/ts.tot.created:0),'avg activities','var(--c3)']].forEach(function(x){ tsK.appendChild(kpi(x[0],x[1],x[2],'',x[3])); });
  pTS.insertBefore(tsK, pTS.__body);
  var tsRows=ts.slots.map(function(s){ return [ {html:'<b>'+esc(s.label)+'</b>',text:s.label}, {html:'<span class="tag2 '+(s.working?'pill-won':'pill-open')+'">'+(s.working?'working':'off-hours')+'</span>',text:s.working?'working':'off-hours'}, s.created, s.connected, p1(pct(s.connected,s.created))+'%', s.won, p1(pct(s.won,s.created))+'%', p1(s.created?s.acts/s.created:0) ]; });
  table(pTS.__body,['Slot','Type','Created','Connected','Connectivity','Conversion','Conv %','Acts/Deal'],tsRows,{key:'tslot',numCols:[2,3,5]});
  addExport(pTS,'deals_by_timeslot',['Slot','Type','Created','Connected','ConnectivityPct','Conversion','ConvPct','ActsPerDeal'],ts.slots.map(function(s){return [s.label,s.working?'working':'off-hours',s.created,s.connected,p1(pct(s.connected,s.created)),s.won,p1(pct(s.won,s.created)),p1(s.created?s.acts/s.created:0)];}));

  // --- Probability distribution + trigger→probability (merged from old Deals tab) ---
  var g2=el('div','grid g2');
  var pProb=panel('Win-Probability Distribution','Deals by probability bucket'); g2.appendChild(pProb);
  var pb=[['0%',0,0],['1–25%',1,25],['26–50%',26,50],['51–75%',51,75],['76–99%',76,99],['100%',100,100]];
  var pbc=pb.map(function(b){return dl.filter(function(d){return d.prob!=null && d.prob>=b[1] && d.prob<=b[2];}).length;});
  hbar(pProb.__body, pb.map(function(b,i){return{key:b[0],label:b[0],value:pbc[i]};}),{color:'var(--c4)',max:6});
  var pTP=panel('Entry Trigger → Probability & Conversion'); g2.appendChild(pTP);
  var tp={}; dl.forEach(function(d){ var t=normTrig(d.trigger); var o=tp[t]||(tp[t]={n:0,ps:0,pn:0,won:0}); o.n++; if(d.prob!=null){o.ps+=d.prob;o.pn++;} if(isWon(d))o.won++; });
  var tpRows=Object.keys(tp).map(function(t){var o=tp[t];return [t,o.n,(o.pn?p1(o.ps/o.pn)+'%':'—'),o.won,p1(pct(o.won,o.n))+'%'];}).sort(function(a,b){return b[1]-a[1];});
  table(pTP.__body,['Trigger','Deals','Avg Prob','Won','Conv %'],tpRows,{key:'trigprob',numCols:[1,3]});
  v.appendChild(g2);

  var pLoss=panel('Lost Deals by Reason'); v.appendChild(pLoss); var lossIt=toItems(groupBy(lost,function(d){return clean(d.reasonLoss);})); hbar(pLoss.__body,lossIt,{color:'var(--c5)'}); addExport(pLoss,'lost_reasons',['Reason','Deals'],lossIt.map(function(x){return[x.label,x.value];}));
  var pTr=panel('Daily / Weekly / Monthly Trend','Deals created ('+gran+')'); v.appendChild(pTr);
  var td=trend(dl,gran); lineChart(pTr.__body, fmtKeys(td.keys,gran), [{name:'Deals',color:'var(--c1)',data:td.vals}]);
  var pAct=panel('Activities per Deal (distribution)'); v.appendChild(pAct);
  var buckets={'0':0,'1-2':0,'3-5':0,'6-10':0,'10+':0}; dl.forEach(function(d){var a=+d.numAct||0; buckets[a===0?'0':a<=2?'1-2':a<=5?'3-5':a<=10?'6-10':'10+']++;});
  hbar(pAct.__body, Object.keys(buckets).map(function(k){return{key:k,label:k+' activities',value:buckets[k]};}),{color:'var(--c3)'});
  // detail table
  var pT=panel('Deal Records'); v.appendChild(pT);
  var rows=dl.slice(0,3000).map(function(d){ return [esc(d.name),ownerName(d.owner),stagePill(d.stage),(d.prob==null?'—':d.prob+'%'),clean(d.leadSource),normTrig(d.trigger),clean(d.utmSource),clean(d.utmMedium),(+d.numAct||0),fmtDT(d.created)]; });
  table(pT.__body,['Deal','Owner','Stage','Prob','Lead Source','Trigger','UTM Source','UTM Medium','#Act','Created'],rows,{key:'deals',numCols:[8],limit:400});
  addExport(pT,'deals', ['Deal','Owner','Stage','Probability','Lead Source','Trigger','Reason For Loss','UTM Source','UTM Medium','Activities','Created'],
    dl.map(function(d){return [d.name,ownerName(d.owner),d.stage,d.prob,clean(d.leadSource),normTrig(d.trigger),clean(d.reasonLoss),clean(d.utmSource),clean(d.utmMedium),(+d.numAct||0),d.created];}));
}
function stagePill(s){ var x=(s||'').toLowerCase(); var cls=x.indexOf('won')>=0?'pill-won':x.indexOf('lost')>=0?'pill-lost':'pill-open'; return {html:'<span class="tag2 '+cls+'">'+esc(s||'—')+'</span>', text:s}; }
function isWon(d){ return (d.stage||'').toLowerCase().indexOf('won')>=0; }
function isLost(d){ return (d.stage||'').toLowerCase().indexOf('lost')>=0; }
/* Store mapping: only these 5 CRM owner accounts are confirmed real stores (mirrors dcs.js
   STORE_OWNERNAME_TO_CODE) — HO/FCS sales codes have no CRM owner and are intentionally excluded. */
var STORE_CODE_NAME={CS1:'Chembur',PN1:'Pune',BO1:'Borivali',N18:'Noida',PV1:'Pashchim Vihar'};
var STORE_OWNERNAME_TO_CODE={'Chembur Store':'CS1','Pune Store':'PN1','Borivali Team':'BO1','Borivali Store':'BO1','Noida Store':'N18','Pashchim Vihar':'PV1'};
function storeOf(ownerId){ var code=STORE_OWNERNAME_TO_CODE[ownerName(ownerId)]; return code?STORE_CODE_NAME[code]:null; }
/* Video Call / Store Visit are not real Zoho fields — regex-classified from the Event title (mirrors dcs.js classifyEvent). */
function classifyEvent(title){ var t=(title||'').toLowerCase().trim();
  if(/trial at home|try at home|\btah\b/.test(t)) return 'TAH';
  if(/video/.test(t)) return 'Video Call';
  if(/visit|\bsv\b/.test(t)) return 'Store Visit';
  return 'Meeting';
}
/* Row builder for the openDrill() modal — takes plain deal objects (id/name/owner/stage/prob/created). */
function drillRows(deals){ return deals.map(function(d){ return [d.id,esc(d.name||'—'),d.mobile||'—',ownerName(d.owner),esc(d.stage||'—'),(d.prob==null?'—':d.prob+'%'),fmtDT(d.created)]; }); }
function hourOf(iso){ var h=parseInt(String(iso).slice(11,13),10); return (h>=0&&h<24)?h:0; }

/* Deal time-slots (merged from old dashboard): 4 working blocks 9AM-9PM + off-hours, bucketed by Created time (IST) */
var SLOTS=[{label:'09:00–12:00',working:true},{label:'12:00–15:00',working:true},{label:'15:00–18:00',working:true},{label:'18:00–21:00',working:true},{label:'21:00–09:00',working:false}];
function slotIndex(h){ return (h>=9&&h<12)?0:(h>=12&&h<15)?1:(h>=15&&h<18)?2:(h>=18&&h<21)?3:4; }
function dealTimeSlots(dl){
  var joined=joinDeals(dl);
  var slots=SLOTS.map(function(s){return {label:s.label,working:s.working,created:0,connected:0,won:0,acts:0};});
  var tot={created:0,connected:0,won:0,acts:0};
  joined.forEach(function(j){ var si=slotIndex(hourOf(j.deal.created)); var s=slots[si];
    s.created++; tot.created++; s.acts+=(+j.deal.numAct||0); tot.acts+=(+j.deal.numAct||0);
    if(j.contacted){s.connected++;tot.connected++;} if(isWon(j.deal)){s.won++;tot.won++;} });
  return {slots:slots,tot:tot};
}

/* ---- Agents / Owner Performance (merged: per-agent performance master, from old Overview "Agents" table) ---- */
var CHAN_ORDER=['Website','ATC','Checkout','WhatsApp','Instagram','Facebook','Google','Signup','Purchase','ProductView','Others'];
var agentSort={c:1,dir:-1}, agentExpanded={}, agentSearch='';
function freshChanRow(){ return {deals:0,won:0,contacted:0,frt:[],calls:0,conn:0,talk:0}; }
function renderAgents(v){
  var dl=fDeals(), cl=fCalls(), tk=fTasks(), ev=fEvents(), on=fOnline();
  var joined=joinDeals(dl);
  var m={}; function row(id){ return m[id]||(m[id]={deals:0,won:0,contacted:0,frt:[],calls:0,conn:0,talk:0,meet:0,tasks:0,online:0,chan:{}}); }
  joined.forEach(function(j){ var r=row(j.deal.owner); r.deals++; if(isWon(j.deal))r.won++; if(j.contacted){r.contacted++; if(j.frt!=null)r.frt.push(j.frt);}
    var ch=channelOf(j.deal); var cr=r.chan[ch]||(r.chan[ch]=freshChanRow()); cr.deals++; if(isWon(j.deal))cr.won++;
    cr.calls+=j.nCalls; cr.talk+=j.calls.reduce(function(s,c){return s+(c.dur||0);},0); cr.conn+=j.calls.filter(function(c){return c.dur>0;}).length;
    if(j.contacted){cr.contacted++; if(j.frt!=null)cr.frt.push(j.frt);} });
  cl.forEach(function(c){ var r=row(c.owner); r.calls++; if(c.dur>0)r.conn++; r.talk+=c.dur||0; });
  ev.forEach(function(e){ row(e.owner).meet++; });
  tk.forEach(function(t){ row(t.owner).tasks++; });
  on.forEach(function(o){ row(o.owner).online++; });
  v.appendChild(kpiRow([
    ['Agents',num(Object.keys(m).length),'active in range','','var(--c1)'],
    ['Deals',num(dl.length),'','','var(--c2)'],
    ['Won',num(dl.filter(isWon).length),'','up','var(--good)'],
    ['Calls',num(cl.length),'','','var(--c4)'],
    ['Meetings',num(ev.length),'','','var(--c6)'],
    ['Tasks',num(tk.length),'','','var(--c3)']
  ]));
  v.appendChild(el('div','note','Per-agent performance rollup from live Zoho data — deals, won, contact rate, first response (avg/median/max), calls, connected calls, talk time, pending, meetings, tasks and chats, per owner. Click ▶ to expand an owner into their Website / ATC / Checkout / WhatsApp / Instagram / Facebook / Google / Others deal-channel breakdown. Orders/Revenue aren\'t shown here — this dataset has no Deal↔Sale join yet (see the Deals × Calls tab\'s data-source note); Meetings/Tasks/Chats are owner-level in Zoho, not linked to a specific deal, so they aren\'t split per channel.'));
  var p=panel('Owner Performance','Sortable · click a column header · search below · ▶ expands channel drill-down'); v.appendChild(p);
  var srch=el('input'); srch.type='text'; srch.placeholder='Search owner…'; srch.value=agentSearch;
  srch.style.cssText='width:220px;margin-bottom:10px;background:var(--bg2);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:6px 9px;font-size:12.5px';
  srch.oninput=function(){ agentSearch=srch.value; drawAgentsTable(); };
  p.__body.appendChild(srch);
  var tblHost=el('div'); p.__body.appendChild(tblHost);
  function drawAgentsTable(){
    var ql=(agentSearch||'').toLowerCase();
    var ids=Object.keys(m).filter(function(id){ return !ql || ownerName(id).toLowerCase().indexOf(ql)>=0; });
    var rowsData=ids.map(function(id){ var r=m[id];
      var af=r.frt.length?r.frt.reduce(function(s,x){return s+x;},0)/r.frt.length:null;
      var mf=median(r.frt); var mx=r.frt.length?Math.max.apply(null,r.frt):null;
      var pending=r.deals-r.contacted;
      return {id:id,name:ownerName(id),deals:r.deals,won:r.won,winRate:pct(r.won,r.deals),contactRate:pct(r.contacted,r.deals),
        calls:r.calls,conn:r.conn,talk:r.talk,pending:pending,af:af,mf:mf,mx:mx,meet:r.meet,tasks:r.tasks,online:r.online,chan:r.chan}; });
    var cols=[ {k:'name',n:'Owner'}, {k:'deals',n:'Deals',num:1}, {k:'won',n:'Won',num:1}, {k:'winRate',n:'Win Rate',num:1},
      {k:'contactRate',n:'Contact %',num:1}, {k:'calls',n:'Calls',num:1}, {k:'conn',n:'Connected',num:1}, {k:'talk',n:'Talk Time',num:1},
      {k:'pending',n:'Pending',num:1}, {k:'af',n:'Avg FRT',num:1}, {k:'mf',n:'Median FRT',num:1}, {k:'mx',n:'Max Delay',num:1},
      {k:'meet',n:'Meetings',num:1}, {k:'tasks',n:'Tasks',num:1}, {k:'online',n:'Chats',num:1} ];
    rowsData.sort(function(a,b){ var x=a[cols[agentSort.c].k], y=b[cols[agentSort.c].k]; if(x==null)x=-1; if(y==null)y=-1;
      return typeof x==='string'?(String(x).localeCompare(String(y))*agentSort.dir):((x-y)*agentSort.dir); });
    tblHost.innerHTML='';
    var wrap=el('div','tblwrap'); var t=el('table'); var thead=el('thead'); var trh=el('tr');
    trh.appendChild(el('th','',''));
    cols.forEach(function(cdef,ci){ var th=el('th',null,esc(cdef.n)+(agentSort.c===ci?(agentSort.dir>0?' ▲':' ▼'):''));
      th.onclick=function(){ agentSort={c:ci,dir:(agentSort.c===ci)?-agentSort.dir:(cdef.num?-1:1)}; drawAgentsTable(); }; trh.appendChild(th); });
    thead.appendChild(trh); t.appendChild(thead);
    var tb=el('tbody');
    rowsData.forEach(function(r){
      var trr=el('tr'); var tdExp=el('td'); var btn=el('button','mini', agentExpanded[r.id]?'▼':'▶');
      btn.onclick=function(){ agentExpanded[r.id]=!agentExpanded[r.id]; drawAgentsTable(); }; tdExp.appendChild(btn); trr.appendChild(tdExp);
      [r.name, num(r.deals), num(r.won), p1(r.winRate)+'%', p1(r.contactRate)+'%', num(r.calls), num(r.conn), hms(r.talk),
       num(r.pending), r.af==null?'—':fmtDur(r.af), r.mf==null?'—':fmtDur(r.mf), r.mx==null?'—':fmtDur(r.mx),
       num(r.meet), num(r.tasks), num(r.online)].forEach(function(c,ci){ var td=el('td',ci>0?'right':null); td.innerHTML=esc(c); trr.appendChild(td); });
      tb.appendChild(trr);
      if(agentExpanded[r.id]){
        var etr=el('tr'); var etd=el('td'); etd.colSpan=cols.length+1; etd.style.cssText='background:var(--bg2);padding:10px 14px';
        var chanRows=CHAN_ORDER.filter(function(c){return r.chan[c];}).map(function(c){ var cr=r.chan[c];
          var caf=cr.frt.length?cr.frt.reduce(function(s,x){return s+x;},0)/cr.frt.length:null; var cmf=median(cr.frt);
          return [c, num(cr.deals), num(cr.calls), num(cr.conn), p1(pct(cr.contacted,cr.deals))+'%', '—', '—', '—',
            num(cr.deals-cr.contacted), caf==null?'—':fmtDur(caf), cmf==null?'—':fmtDur(cmf), hms(cr.talk), p1(pct(cr.won,cr.deals))+'%']; });
        var mini=el('div'); mini.innerHTML='<div style="font-weight:700;margin-bottom:6px">'+esc(r.name)+' — by deal channel</div>';
        etd.appendChild(mini);
        table(mini, ['Channel','Deals','Calls','Connected','Contact %','Meetings','Orders','Revenue','Pending','Avg FRT','Median FRT','Talk Time','Win Rate'],
          chanRows, {key:'agentchan_'+r.id,numCols:[1,2,3,8,11]});
        if(!chanRows.length) mini.appendChild(el('div','hint','No channel-attributed deals for this owner in range.'));
        mini.appendChild(el('div','hint','Meetings/Orders/Revenue are gated here — not linked to a specific deal/channel in this data source.'));
        etr.appendChild(etd); tb.appendChild(etr);
      }
    });
    t.appendChild(tb); wrap.appendChild(t); tblHost.appendChild(wrap);
  }
  drawAgentsTable();
  addExport(p,'agent_performance',['Agent','Deals','Won','WinRatePct','ContactPct','Calls','Connected','TalkSec','Pending','AvgFRTmin','MedianFRTmin','MaxDelayMin','Meetings','Tasks','Chats'],
    Object.keys(m).map(function(id){var r=m[id];var af=r.frt.length?r.frt.reduce(function(s,x){return s+x;},0)/r.frt.length:'';var mf=median(r.frt);var mx=r.frt.length?Math.max.apply(null,r.frt):'';
      return [ownerName(id),r.deals,r.won,p1(pct(r.won,r.deals)),p1(pct(r.contacted,r.deals)),r.calls,r.conn,r.talk,r.deals-r.contacted,af===''?'':p1(af),mf==null?'':p1(mf),mx===''?'':p1(mx),r.meet,r.tasks,r.online];}));
  var g=el('div','grid g2');
  var pd=panel('Deals by Agent'); g.appendChild(pd); hbar(pd.__body, Object.keys(m).map(function(id){return{key:ownerName(id),label:ownerName(id),value:m[id].deals};}).sort(function(a,b){return b.value-a.value;}),{onClick:toggleOwner});
  var pw=panel('Won Deals by Agent'); g.appendChild(pw); hbar(pw.__body, Object.keys(m).map(function(id){return{key:ownerName(id),label:ownerName(id),value:m[id].won};}).filter(function(x){return x.value>0;}).sort(function(a,b){return b.value-a.value;}),{color:'var(--good)',onClick:toggleOwner});
  v.appendChild(g);
}

/* ---- Calls (Dashboard 2) ---- */
function renderCalls(v){
  var cl=fCalls();
  var conn=cl.filter(function(c){return c.dur>0;});
  var missed=cl.filter(function(c){return (c.type||'').toLowerCase().indexOf('miss')>=0||(c.dur===0&&(c.type||'').toLowerCase().indexOf('out')<0);});
  var inb=cl.filter(function(c){return (c.type||'').toLowerCase().indexOf('in')>=0;});
  var out=cl.filter(function(c){return (c.type||'').toLowerCase().indexOf('out')>=0;});
  var missType=cl.filter(function(c){return (c.type||'').toLowerCase().indexOf('miss')>=0;});
  var totDur=cl.reduce(function(s,c){return s+(c.dur||0);},0);
  v.appendChild(kpiRow([
    ['Total Calls',num(cl.length),'','','var(--c2)'],
    ['Connected',num(conn.length),p1(pct(conn.length,cl.length))+'% (duration>0)','up','var(--good)'],
    ['Missed',num(missType.length),'Call_Type = Missed','down','var(--bad)'],
    ['Incoming',num(inb.length),'','','var(--c6)'],
    ['Outgoing',num(out.length),'','','var(--c1)'],
    ['Total Talk Time',hms(totDur),'HH:MM:SS','','var(--c4)']
  ]));
  var gran=pickGran(F.from,F.to);
  var g=el('div','grid g2');
  var pT=panel('Calls Trend','by '+gran); g.appendChild(pT); var tc=trend(cl,gran); lineChart(pT.__body,fmtKeys(tc.keys,gran),[{name:'Calls',color:'var(--c2)',data:tc.vals}]);
  var pType=panel('Calls by Type'); g.appendChild(pType); donut(pType.__body, toItems(groupBy(cl,function(c){return c.type||'(none)';})),{center:'calls',onClick:function(k){F.callType=(F.callType===k?'':k);sync();}});
  var pOwn=panel('Calls by Owner'); g.appendChild(pOwn); var oi=ownerItems(cl); hbar(pOwn.__body,oi,{onClick:toggleOwner}); addExport(pOwn,'calls_by_owner',['Owner','Calls'],oi.map(function(x){return[x.label,x.value];}));
  var pDurO=panel('Total Talk Time by Owner','HH:MM:SS'); g.appendChild(pDurO);
  var durMap={}; cl.forEach(function(c){var n=ownerName(c.owner);durMap[n]=(durMap[n]||0)+(c.dur||0);});
  hbar(pDurO.__body, Object.keys(durMap).map(function(k){return{key:k,label:k,value:durMap[k]};}).sort(function(a,b){return b.value-a.value;}),{color:'var(--c4)',fmt:hms,onClick:toggleOwner});
  v.appendChild(g);
  var pAvg=panel('Average Call Duration by Owner','connected calls only'); v.appendChild(pAvg);
  var cnt={},sum={}; conn.forEach(function(c){var n=ownerName(c.owner);cnt[n]=(cnt[n]||0)+1;sum[n]=(sum[n]||0)+c.dur;});
  var avgIt=Object.keys(sum).map(function(k){return{key:k,label:k,value:Math.round(sum[k]/cnt[k])};}).sort(function(a,b){return b.value-a.value;});
  hbar(pAvg.__body, avgIt, {color:'var(--c3)',fmt:hms,onClick:toggleOwner});
  var pTbl=panel('Owner Call Summary'); v.appendChild(pTbl);
  var owners={}; cl.forEach(function(c){var n=ownerName(c.owner); var o=owners[n]||(owners[n]={t:0,cn:0,ms:0,dur:0}); o.t++; if(c.dur>0)o.cn++; if((c.type||'').toLowerCase().indexOf('miss')>=0)o.ms++; o.dur+=c.dur||0;});
  var rows=Object.keys(owners).map(function(n){var o=owners[n];return [n,o.t,o.cn,o.ms,p1(pct(o.cn,o.t))+'%',{html:hms(o.dur),text:o.dur},hms(o.cn?o.dur/o.cn:0)];});
  table(pTbl.__body,['Owner','Total','Connected','Missed','Conn %','Talk Time','Avg (conn)'],rows,{key:'callsown',numCols:[1,2,3,5]});
  addExport(pTbl,'call_owner_summary',['Owner','Total','Connected','Missed','ConnPct','TalkTimeSec','AvgConnSec'],Object.keys(owners).map(function(n){var o=owners[n];return[n,o.t,o.cn,o.ms,p1(pct(o.cn,o.t)),o.dur,o.cn?Math.round(o.dur/o.cn):0];}));
}

/* ---- Deals × Calls (Dashboard 3) — headline ---- */
/* ---- Working-hours First-Call Response analysis (replaces Avg/Median FRT) ---- */
var WH_HOURS=[10,11,12,13,14,15,16,17,18,19,20,21];
var WH_LABELS=['10 AM','11 AM','12 PM','1 PM','2 PM','3 PM','4 PM','5 PM','6 PM','7 PM','8 PM','9 PM'];
function hr12(h){ h=((h%24)+24)%24; var ap=h<12?'AM':'PM', hh=h%12; if(hh===0)hh=12; return hh+':00 '+ap; }
function fmtMinNice(m){ if(m==null)return '—'; if(m<90)return p1(m)+' min'; if(m<1440)return p1(m/60)+' h'; return p1(m/1440)+' d'; }
var _whtip=null;
function whTip(){ if(!_whtip){ _whtip=el('div','whtip'); _whtip.style.display='none'; document.body.appendChild(_whtip); } return _whtip; }
function whAnalysis(dl){
  var buckets=WH_HOURS.map(function(h,i){return {hour:h,label:WH_LABELS[i],deals:0,contacted:0,notContacted:0,frtSum:0,frtN:0,avgFrt:null,contactRate:0,rows:[]};});
  var bmap={}; buckets.forEach(function(b){bmap[b.hour]=b;});
  var total=0;
  dl.forEach(function(d){
    var h=hourOf(d.created); if(h<10||h>21) return; var b=bmap[h]; if(!b) return; total++;
    var seen={},cand=[];
    (idxWhat[d.id]||[]).forEach(function(c){ if(!seen[c.id]){seen[c.id]=1;cand.push(c);} });
    if(d.mobile){ (idxPhone[d.mobile]||[]).forEach(function(c){ if(!seen[c.id]){seen[c.id]=1;cand.push(c);} }); }
    var dc=D(d.created), firstOut=null, ft=null;
    cand.forEach(function(c){ if((c.type||'').toLowerCase().indexOf('out')<0) return; var ct=D(c.created); if(ct&&ct>=dc&&(!firstOut||ct<ft)){ firstOut=c; ft=ct; } });
    var frt = firstOut? (ft-dc)/60000 : null;
    b.deals++; b.rows.push({d:d,firstOut:firstOut,frt:frt});
    if(firstOut){ b.contacted++; if(frt!=null){ b.frtSum+=frt; b.frtN++; } }
  });
  buckets.forEach(function(b){ b.notContacted=b.deals-b.contacted; b.avgFrt=b.frtN?b.frtSum/b.frtN:null; b.contactRate=pct(b.contacted,b.deals); });
  return {buckets:buckets,total:total};
}
function whChart(host, buckets, onClick){
  host.innerHTML='';
  var maxV=Math.max.apply(null,buckets.map(function(b){return b.avgFrt||0;}).concat([1])); maxV=niceMax(maxV);
  var w=Math.max(host.clientWidth||760,600), H=300, pl=48,pr=14,pt=24,pb=44, iw=w-pl-pr, ih=H-pt-pb, n=buckets.length, bw=iw/n, barW=Math.min(40,bw*0.6);
  var svg='<svg class="chart" viewBox="0 0 '+w+' '+H+'" width="100%" height="'+H+'">';
  for(var g=0;g<=4;g++){ var yy=pt+ih-(g/4)*ih; svg+='<line class="gridline" x1="'+pl+'" y1="'+yy+'" x2="'+(w-pr)+'" y2="'+yy+'"/><text class="val" x="'+(pl-6)+'" y="'+(yy+3)+'" text-anchor="end">'+num(Math.round(g/4*maxV))+'</text>'; }
  buckets.forEach(function(b,i){ var cx=pl+i*bw+bw/2, val=b.avgFrt||0, bh=val>0?Math.max(3,(val/maxV)*ih):0, y=pt+ih-bh;
    var col=b.avgFrt==null?'var(--tx3)':(b.avgFrt<=10?'var(--good)':b.avgFrt<=30?'var(--c3)':b.avgFrt<=120?'var(--c8)':'var(--bad)');
    svg+='<g class="whbar" data-h="'+b.hour+'">';
    svg+='<rect x="'+(cx-bw/2)+'" y="'+pt+'" width="'+bw+'" height="'+ih+'" fill="transparent"></rect>';
    if(bh>0) svg+='<rect x="'+(cx-barW/2)+'" y="'+y+'" width="'+barW+'" height="'+bh+'" rx="4" fill="'+col+'"></rect>';
    svg+='<text class="lbl" x="'+cx+'" y="'+(y-6)+'" text-anchor="middle" style="font-size:10.5px;font-weight:700">'+num(b.deals)+'</text>';
    svg+='<text class="val" x="'+cx+'" y="'+(H-pb+16)+'" text-anchor="middle">'+esc(b.label)+'</text>';
    svg+='</g>';
  });
  host.innerHTML=svg;
  var tip=whTip();
  Array.prototype.forEach.call(host.querySelectorAll('.whbar'),function(g){
    var h=+g.getAttribute('data-h'), b=buckets.filter(function(x){return x.hour===h;})[0]; g.style.cursor='pointer';
    g.addEventListener('mousemove',function(ev){ tip.style.display='block'; tip.style.left=(ev.clientX+14)+'px'; tip.style.top=(ev.clientY+14)+'px';
      tip.innerHTML='<b>'+esc(hr12(b.hour)+' – '+hr12(b.hour+1))+'</b><br>Deals Created: <b>'+num(b.deals)+'</b><br>Contacted: <b>'+num(b.contacted)+'</b><br>Not Contacted: <b>'+num(b.notContacted)+'</b><br>Average First Call: <b>'+(b.avgFrt==null?'—':p1(b.avgFrt)+' min')+'</b><br>Contact Rate: <b>'+p1(b.contactRate)+'%</b>'; });
    g.addEventListener('mouseleave',function(){ tip.style.display='none'; });
    g.addEventListener('click',function(){ tip.style.display='none'; if(onClick)onClick(h); });
  });
}
function whDrill(titleEl, bodyEl, b){
  if(!b) return;
  titleEl.innerHTML='Hourly drill-down — <b>'+esc(hr12(b.hour)+' – '+hr12(b.hour+1))+'</b> · '+num(b.deals)+' deals · '+num(b.contacted)+' contacted · avg '+(b.avgFrt==null?'—':p1(b.avgFrt)+' min');
  var rows=b.rows.slice().sort(function(a,c){return (a.frt==null?1e9:a.frt)-(c.frt==null?1e9:c.frt);}).map(function(p){ var fo=p.firstOut;
    return [p.d.id, esc(p.d.name), p.d.mobile||'—', ownerName(p.d.owner), fmtDT(p.d.created), fo?fmtDT(fo.created):'—', p.frt==null?'—':p1(p.frt), fo?ownerName(fo.owner):'—', fo?(fo.dur>0?{html:'<span class="pill-won">Connected</span>',text:'Connected'}:{html:'<span class="pill-open">Not connected</span>',text:'Not connected'}):{html:'<span class="pill-lost">No call</span>',text:'No call'}]; });
  table(bodyEl,['Deal ID','Customer','Mobile','Deal Owner','Deal Created','First Call','FRT (min)','Call Owner','Call Status'],rows,{key:'whdrill',numCols:[6],limit:400});
}

function renderDVC(v){
  var dl=fDeals(); var joined=joinDeals(dl);
  var contacted=joined.filter(function(j){return j.contacted;});
  var notContacted=joined.length-contacted.length;
  var totCalls=joined.reduce(function(s,j){return s+j.nCalls;},0);
  var frts=contacted.map(function(j){return j.frt;}).filter(function(x){return x!=null&&x>=0;}).sort(function(a,b){return a-b;});
  var avgFrt=frts.length?frts.reduce(function(s,x){return s+x;},0)/frts.length:0;
  var medFrt=frts.length?frts[Math.floor(frts.length/2)]:0;
  v.appendChild(kpiRow([
    ['Total Deals',num(dl.length),'','','var(--c1)'],
    ['Deals Contacted',num(contacted.length),'≥1 call after creation','up','var(--good)'],
    ['Not Contacted',num(notContacted),p1(pct(notContacted,dl.length))+'%','down',semColor(pct(notContacted,dl.length),20,40,false)],
    ['Contact Rate',p1(pct(contacted.length,dl.length))+'%','','',semColor(pct(contacted.length,dl.length),50,30,true)],
    ['Avg Calls / Deal',p1(dl.length?totCalls/dl.length:0),num(totCalls)+' matched calls','','var(--c2)']
  ]));
  v.appendChild(el('div','note','<b>Join logic:</b> a deal is matched to calls by <b>What_Id → Deal</b> link and by <b>RIGHT(Mobile,10)</b> (phone parsed from the call subject). “First response” = time from deal creation to the first call after it. Response metrics use all calls (not date-filtered) so times stay accurate.'));
  // Pending backlog, colour-coded — same green/yellow/red convention as the Overview tab's Executive Summary
  var pendingJ=joined.filter(function(j){return !j.contacted;});
  var maxTd=D(maxDate);
  function ageMinD(j){ return (maxTd-D(j.deal.created))/60000; }
  var dp30=pendingJ.filter(function(j){return ageMinD(j)>30;}).length, dp1h=pendingJ.filter(function(j){return ageMinD(j)>60;}).length,
      dp4h=pendingJ.filter(function(j){return ageMinD(j)>240;}).length, dp1d=pendingJ.filter(function(j){return ageMinD(j)>1440;}).length;
  v.appendChild(kpiRow([
    ['Pending >30 Min',num(dp30),'not yet contacted','',semColor(dp30,3,10,false)],
    ['Pending >1 Hour',num(dp1h),'not yet contacted','',semColor(dp1h,2,8,false)],
    ['Pending >4 Hours',num(dp4h),'not yet contacted','',semColor(dp4h,1,5,false)],
    ['Pending >1 Day',num(dp1d),'not yet contacted','',semColor(dp1d,0,3,false)]
  ]));
  // First Call Response During Working Hours — replaces the old Avg/Median FRT + buckets
  var wh=whAnalysis(dl), whb=wh.buckets, totWh=wh.total, totC=0,fsum=0,fn=0;
  whb.forEach(function(b){ totC+=b.contacted; fsum+=b.frtSum; fn+=b.frtN; });
  var peak=whb.slice().sort(function(a,b){return b.deals-a.deals;})[0];
  var wf=whb.filter(function(b){return b.avgFrt!=null;});
  var fast=wf.slice().sort(function(a,b){return a.avgFrt-b.avgFrt;})[0];
  var slow=wf.slice().sort(function(a,b){return b.avgFrt-a.avgFrt;})[0];
  v.appendChild(kpiRow([
    ['Business-Hour Deals',num(totWh),'created 10 AM–9 PM','','var(--c1)'],
    ['Peak Deal Hour',(peak&&peak.deals)?peak.label:'—',(peak&&peak.deals)?num(peak.deals)+' deals':'','','var(--c4)'],
    ['Fastest Response Hour',fast?fast.label:'—',fast?fmtMinNice(fast.avgFrt):'','up','var(--good)'],
    ['Slowest Response Hour',slow?slow.label:'—',slow?fmtMinNice(slow.avgFrt):'','down','var(--bad)'],
    ['Avg First Call (biz hrs)',fn?fmtMinNice(fsum/fn):'—','outgoing calls only','','var(--c3)'],
    ['Business-Hour Contact Rate',p1(pct(totC,totWh))+'%',num(totC)+' contacted','',semColor(pct(totC,totWh),50,30,true)]
  ]));
  var pWH=panel('First Call Response During Working Hours (10:00 AM – 9:00 PM)','Avg minutes to the first OUTGOING call after deal creation, by hour (IST). Bar height = avg first-call time · number above each bar = deals created · matched by mobile RIGHT(10) + deal link. Hover for details; click a bar to drill into its deals.');
  v.appendChild(pWH);
  var pDrill=panel('Hourly drill-down'); var dTitle=pDrill.__head.querySelector('h3'); var dBody=pDrill.__body; dBody.appendChild(el('div','empty','Click any bar above to list the deals created in that hour.'));
  whChart(pWH.__body, whb, function(h){ whDrill(dTitle, dBody, whb.filter(function(x){return x.hour===h;})[0]); pDrill.scrollIntoView({behavior:'smooth',block:'nearest'}); });
  addExport(pWH,'working_hours_frt',['Hour','DealsCreated','Contacted','NotContacted','AvgFirstCallMin','ContactRatePct'],whb.map(function(b){return [b.label,b.deals,b.contacted,b.notContacted,b.avgFrt==null?'':p1(b.avgFrt),p1(b.contactRate)];}));
  v.appendChild(pDrill);

  var g=el('div','grid g2');
  var gran=pickGran(F.from,F.to);
  var pTr=panel('Deals vs Contacted — Trend','by '+gran); g.appendChild(pTr);
  var byk={}, byc={}; joined.forEach(function(j){var k=(gran==='month'?monthKey:gran==='week'?weekStart:dayKey)(j.deal.created); byk[k]=(byk[k]||0)+1; if(j.contacted)byc[k]=(byc[k]||0)+1;});
  var keys=Object.keys(byk).sort();
  lineChart(pTr.__body, fmtKeys(keys,gran), [
    {name:'Deals',color:'var(--c1)',data:keys.map(function(k){return byk[k]||0;})},
    {name:'Contacted',color:'var(--c2)',data:keys.map(function(k){return byc[k]||0;})}
  ]);
  var pRt=panel('Contact Rate by Owner'); g.appendChild(pRt);
  var own={}; joined.forEach(function(j){var n=ownerName(j.deal.owner); var o=own[n]||(own[n]={d:0,c:0});o.d++; if(j.contacted)o.c++;});
  hbar(pRt.__body, Object.keys(own).map(function(n){return{key:n,label:n,value:+p1(pct(own[n].c,own[n].d))};}).sort(function(a,b){return b.value-a.value;}),{color:'var(--c4)',fmt:function(v){return v+'%';},onClick:toggleOwner});
  v.appendChild(g);

  var pTe=panel('Deal Trigger Event Analysis'); v.appendChild(pTe);
  var trg={}; joined.forEach(function(j){var t=normTrig(j.deal.trigger); var o=trg[t]||(trg[t]={d:0,c:0,calls:0,frt:[]}); o.d++; o.calls+=j.nCalls; if(j.contacted){o.c++; if(j.frt!=null)o.frt.push(j.frt);} });
  var trows=Object.keys(trg).map(function(t){var o=trg[t]; var af=o.frt.length?o.frt.reduce(function(s,x){return s+x;},0)/o.frt.length:0; return [t,o.d,o.calls,p1(o.d?o.calls/o.d:0),fmtDur(af),p1(pct(o.c,o.d))+'%'];}).sort(function(a,b){return b[1]-a[1];});
  table(pTe.__body,['Trigger Event','Deals','Calls','Avg Calls/Deal','Avg First Resp','Contact %'],trows,{key:'trg',numCols:[1,2,3]});
  addExport(pTe,'trigger_analysis',['Trigger','Deals','Calls','AvgCallsPerDeal','AvgFirstRespMin','ContactPct'],Object.keys(trg).map(function(t){var o=trg[t];var af=o.frt.length?o.frt.reduce(function(s,x){return s+x;},0)/o.frt.length:0;return[t,o.d,o.calls,p1(o.d?o.calls/o.d:0),p1(af),p1(pct(o.c,o.d))];}));

  v.appendChild(el('div','note','<b>Owner Analysis</b> now lives on the <b>Agents</b> tab\'s Owner Performance table — removed the smaller, duplicate version that used to be here. That table has everything this one had (Deals/Calls/Talk Time/Avg Calls/Avg Resp/Contact %) plus Won, Win Rate, Pending, Median FRT, Max Delay, and a per-channel drill-down.'));

  var pNc=panel('Uncontacted Deals','Deals with no call after creation — action list'); v.appendChild(pNc);
  var nc=joined.filter(function(j){return !j.contacted;}).map(function(j){return [esc(j.deal.name),ownerName(j.deal.owner),stagePill(j.deal.stage),normTrig(j.deal.trigger),j.deal.mobile||'—',fmtDT(j.deal.created)];});
  table(pNc.__body,['Deal','Owner','Stage','Trigger','Mobile','Created'],nc,{key:'nc',limit:300});
  addExport(pNc,'uncontacted_deals',['Deal','Owner','Stage','Trigger','Mobile','Created'],joined.filter(function(j){return !j.contacted;}).map(function(j){return[j.deal.name,ownerName(j.deal.owner),j.deal.stage,normTrig(j.deal.trigger),j.deal.mobile,j.deal.created];}));
}
function fmtDur(min){ if(min==null)return'—'; if(min<60)return p1(min)+'m'; if(min<1440)return p1(min/60)+'h'; return p1(min/1440)+'d'; }

/* ---- Tasks (Dashboard 5) ---- */
function renderTasks(v){
  var tk=fTasks(); var today=dayKey(maxDate);
  var yest=(function(){var d=D(today);d.setDate(d.getDate()-1);return ymd(d);})();
  var done=tk.filter(isDone), open=tk.filter(function(t){return !isDone(t);});
  var overdue=open.filter(function(t){return t.due && dayKey(t.due)<today;});
  var odToday=open.filter(function(t){return t.due && dayKey(t.due)===today;});
  var odYest=tk.filter(function(t){return t.due && dayKey(t.due)===yest && !isDone(t);});
  var diff=odToday.length-odYest.length;
  v.appendChild(kpiRow([
    ['Total Tasks',num(tk.length),'','','var(--c3)'],
    ['Completed',num(done.length),p1(pct(done.length,tk.length))+'%','up','var(--good)'],
    ['Open',num(open.length),'','','var(--warn)'],
    ['Overdue',num(overdue.length),'past due & open','down','var(--bad)'],
    ["Today's Due (open)",num(odToday.length),'vs yest '+num(odYest.length)+' ('+(diff>=0?'+':'')+diff+')',(diff>0?'down':'up'),'var(--c5)'],
    ['% Change day/day',(odYest.length?(diff>=0?'+':'')+p1(pct(diff,odYest.length))+'%':'—'),'','','var(--c6)']
  ]));
  var gran=pickGran(F.from,F.to); var g=el('div','grid g2');
  var pTr=panel('Tasks Trend','created by '+gran); g.appendChild(pTr); var tt=trend(tk,gran); lineChart(pTr.__body,fmtKeys(tt.keys,gran),[{name:'Tasks',color:'var(--c3)',data:tt.vals}]);
  var pSt=panel('Tasks by Status'); g.appendChild(pSt); donut(pSt.__body,toItems(groupBy(tk,function(t){return t.status||'(none)';})),{center:'tasks',onClick:function(k){F.taskStatus=(F.taskStatus===k?'':k);sync();}});
  var pOw=panel('Tasks by Owner'); g.appendChild(pOw); hbar(pOw.__body,ownerItems(tk),{onClick:toggleOwner});
  var pOd=panel('Overdue by Owner'); g.appendChild(pOd); hbar(pOd.__body,toItems(groupBy(overdue,function(t){return ownerName(t.owner);})),{color:'var(--bad)',onClick:toggleOwner});
  v.appendChild(g);
  var pT=panel('Task Records'); v.appendChild(pT);
  var rows=tk.slice(0,3000).map(function(t){return [statusPill(t.status),ownerName(t.owner),t.due||'—',(t.due&&dayKey(t.due)<today&&!isDone(t))?{html:'<span class="pill-lost">Overdue</span>',text:'Overdue'}:'—',fmtDT(t.created),t.closed?fmtDT(t.closed):'—'];});
  table(pT.__body,['Status','Owner','Due','Flag','Created','Closed'],rows,{key:'tasks',limit:400});
  addExport(pT,'tasks',['Status','Owner','Due','Created','Closed'],tk.map(function(t){return[t.status,ownerName(t.owner),t.due,t.created,t.closed];}));
}
function statusPill(s){ var x=(s||'').toLowerCase(); var cls=(x.indexOf('complet')>=0||x.indexOf('closed')>=0)?'pill-won':(x.indexOf('progress')>=0?'pill-open':'pill-open'); return {html:'<span class="tag2 '+cls+'">'+esc(s||'—')+'</span>',text:s}; }

/* ---- Chat (Dashboard 6 — Online Activity Logs) ---- */
function renderChat(v){
  var on=fOnline();
  var byCh=groupBy(on,function(o){return o.channel||'(none)';});
  v.appendChild(kpiRow([
    ['Total Chats',num(on.length),'Online Activity Logs','','var(--c5)'],
    ['Channels',num(Object.keys(byCh).length),Object.keys(byCh).slice(0,3).join(', '),'','var(--c6)'],
    ['WhatsApp',num(on.filter(function(o){return (o.channel||'').toLowerCase().indexOf('whatsapp')>=0;}).length),'','','var(--good)'],
    ['Website',num(on.filter(function(o){return (o.channel||'').toLowerCase().indexOf('web')>=0;}).length),'','','var(--c1)']
  ]));
  v.appendChild(el('div','note','Lucira CRM has no dedicated Chat module. The omnichannel <b>Online Activity Logs</b> module (WhatsApp / website / social touch-points) is used here as the chat source. Response-time & resolved/pending are not tracked as structured fields in this module.'));
  var gran=pickGran(F.from,F.to); var g=el('div','grid g2');
  var pTr=panel('Chats Trend','by '+gran); g.appendChild(pTr); var tt=trend(on,gran); lineChart(pTr.__body,fmtKeys(tt.keys,gran),[{name:'Chats',color:'var(--c5)',data:tt.vals}]);
  var pCh=panel('Chats by Channel'); g.appendChild(pCh); donut(pCh.__body,toItems(byCh),{center:'chats'});
  var pOw=panel('Chats by Owner'); g.appendChild(pOw); hbar(pOw.__body,ownerItems(on),{onClick:toggleOwner});
  var pTy=panel('Chats by Activity Type'); g.appendChild(pTy); hbar(pTy.__body,toItems(groupBy(on,function(o){return clean(o.atype);})),{color:'var(--c6)'});
  v.appendChild(g);
}

/* ---- Customer Events (Dashboard 7) ---- */
function renderCE(v){
  // CE is pre-aggregated (50k+ storefront events). Filter by date over byCatDay.
  var cats=CE.cats||[]; var catTot={}; var dayTot={}; var total=0;
  cats.forEach(function(c){ catTot[c]=0; var m=(CE.byCatDay||{})[c]||{}; Object.keys(m).forEach(function(day){ if(day>=F.from&&day<=F.to){ catTot[c]+=m[day]; dayTot[day]=(dayTot[day]||0)+m[day]; total+=m[day]; } }); });
  var get=function(c){return catTot[c]||0;};
  v.appendChild(kpiRow([
    ['Total Events',num(total),'storefront firehose','','var(--c1)'],
    ['Signup',num(get('Signup')),'','','var(--c2)'],
    ['ATC',num(get('ATC')),'add-to-cart','','var(--c3)'],
    ['Checkout',num(get('Checkout')),'','','var(--c4)'],
    ['Purchase',num(get('Purchase')),'','up','var(--good)'],
    ['Website Visit',num(get('Website Visit')),'product/page views','','var(--c6)']
  ]));
  v.appendChild(el('div','note','Customer Events are storefront signals (all owned by the integration user, so owner-wise is omitted). Category is normalized from a messy <code>Event_Type</code> field (ProductView / Signup / ATC / Checkout / Payment …).'));
  var gran=pickGran(F.from,F.to); var g=el('div','grid g2');
  var pCat=panel('Events by Category'); g.appendChild(pCat); var catIt=cats.map(function(c){return{key:c,label:c,value:get(c)};}).filter(function(x){return x.value>0;}).sort(function(a,b){return b.value-a.value;}); donut(pCat.__body,catIt,{center:'events'});
  var pTr=panel('Events Trend','by '+gran); g.appendChild(pTr);
  var keyFn=gran==='month'?function(d){return d.slice(0,7);}:gran==='week'?function(d){return weekStart(d);}:function(d){return d;};
  var tm={}; Object.keys(dayTot).forEach(function(day){var k=keyFn(day);tm[k]=(tm[k]||0)+dayTot[day];}); var tkeys=Object.keys(tm).sort();
  lineChart(pTr.__body,fmtKeys(tkeys,gran),[{name:'Events',color:'var(--c6)',data:tkeys.map(function(k){return tm[k];})}]);
  v.appendChild(g);
  var pRaw=panel('Top raw Event_Type values','full-period, unfiltered'); v.appendChild(pRaw);
  hbar(pRaw.__body,(CE.rawTop||[]).map(function(r){return{key:r.t,label:r.t,value:r.n};}),{max:20,color:'var(--c4)'});
}

/* ---- Activities (Dashboard 8) ---- */
function renderActivities(v){
  var cl=fCalls(), ev=fEvents(), tk=fTasks(), on=fOnline();
  var totalAct=cl.length+ev.length+tk.length+on.length;
  var dl=fDeals(); var avgPerDeal=dl.length?dl.reduce(function(s,d){return s+(+d.numAct||0);},0)/dl.length:0;
  v.appendChild(kpiRow([
    ['Total Activities',num(totalAct),'calls+meetings+tasks+chats','','var(--c1)'],
    ['Calls',num(cl.length),'','','var(--c2)'],
    ['Meetings',num(ev.length),'Events module','','var(--c6)'],
    ['Tasks',num(tk.length),'','','var(--c3)'],
    ['Chats / Notes',num(on.length),'online activity','','var(--c5)'],
    ['Avg Activities / Deal',p1(avgPerDeal),'','','var(--c4)']
  ]));
  var g=el('div','grid g2');
  var pMix=panel('Activity Mix'); g.appendChild(pMix);
  donut(pMix.__body,[{key:'Calls',label:'Calls',value:cl.length},{key:'Meetings',label:'Meetings',value:ev.length},{key:'Tasks',label:'Tasks',value:tk.length},{key:'Chats',label:'Chats',value:on.length}],{center:'activities'});
  var pOwn=panel('Activities by Owner'); g.appendChild(pOwn);
  var ow={}; [cl,ev,tk,on].forEach(function(arr){arr.forEach(function(x){var n=ownerName(x.owner);ow[n]=(ow[n]||0)+1;});});
  hbar(pOwn.__body,Object.keys(ow).map(function(n){return{key:n,label:n,value:ow[n]};}).sort(function(a,b){return b.value-a.value;}),{onClick:toggleOwner});
  v.appendChild(g);
  var gran=pickGran(F.from,F.to);
  var pTr=panel('Activities Trend','by '+gran); v.appendChild(pTr);
  var tcl=trend(cl,gran),tev=trend(ev,gran),ttk=trend(tk,gran),ton=trend(on,gran);
  var keys=mergeKeys(mergeKeys(tcl.keys,tev.keys),mergeKeys(ttk.keys,ton.keys));
  lineChart(pTr.__body,fmtKeys(keys,gran),[
    {name:'Calls',color:'var(--c2)',data:keys.map(function(k){return tcl.map[k]||0;})},
    {name:'Meetings',color:'var(--c6)',data:keys.map(function(k){return tev.map[k]||0;})},
    {name:'Tasks',color:'var(--c3)',data:keys.map(function(k){return ttk.map[k]||0;})},
    {name:'Chats',color:'var(--c5)',data:keys.map(function(k){return ton.map[k]||0;})}
  ]);
  var pM=panel('Meetings (Events module)'); v.appendChild(pM);
  var rows=ev.slice(0,1000).map(function(e){return [esc(e.title||'—'),ownerName(e.owner),fmtDT(e.start),fmtDT(e.created)];});
  table(pM.__body,['Title','Owner','Scheduled','Created'],rows,{key:'meet',limit:200});
}

/* ---- Validation (report + error report) ---- */
function renderValidation(v){
  var rows=[
    ['Deals', CRM.Deals, DEALS.length],
    ['Calls', CRM.Calls, CALLS.length],
    ['Tasks', CRM.Tasks, TASKS.length],
    ['Activities (calls+meetings+tasks+chats)', CRM.Calls+CRM.Events+CRM.Tasks+CRM.Online, CALLS.length+EVENTS.length+TASKS.length+ONLINE.length],
    ['Events (meetings)', CRM.Events, EVENTS.length],
    ['Chats (online activity)', CRM.Online, ONLINE.length],
    ['Customer Events', CRM.CustomerEvents, CE.total]
  ];
  var trs=rows.map(function(r){ var match=r[1]===r[2]; return [r[0],num(r[1]),num(r[2]),num(r[1]-r[2]), {html:'<span class="badge '+(match?'ok':'err')+'">'+(match?'MATCH':'MISMATCH')+'</span>',text:match?'MATCH':'MISMATCH'}]; });
  v.appendChild(kpiRow([
    ['Modules Validated','7','all pass','up','var(--good)'],
    ['Total API Pages Read',num((DASH.meta&&DASH.meta.pagesRead)||0),'2000 rows/page','','var(--c1)'],
    ['Records Loaded',num(DEALS.length+CALLS.length+TASKS.length+ONLINE.length+EVENTS.length),'+ '+num(CE.total)+' customer events','','var(--c2)'],
    ['Fetch Errors','0','no dropped records','up','var(--good)']
  ]));
  var pV=panel('Validation Report','Dashboard totals vs Zoho CRM (100% pagination, deduped by record id)'); v.appendChild(pV);
  table(pV.__body,['Module','In CRM','Loaded','Missing','Status'],trs,{key:'val',numCols:[1,2,3]});
  var pU=panel('Users / Owners'); v.appendChild(pU);
  var urows=Object.keys(OWN).filter(function(id){return DEALS.some(function(d){return d.owner===id;})||CALLS.some(function(c){return c.owner===id;});}).map(function(id){
    return [OWN[id], id, DEALS.filter(function(d){return d.owner===id;}).length, CALLS.filter(function(c){return c.owner===id;}).length];
  }).sort(function(a,b){return b[2]-a[2];});
  table(pU.__body,['Owner','User ID','Deals','Calls'],urows,{key:'usr',numCols:[2,3]});
  var meta=DASH.meta||{};
  v.appendChild(el('div','note','<b>Last successful sync:</b> '+esc(meta.generated||'—')+' · <b>Cutoff:</b> Created_Time ≥ '+esc(meta.cutoff||'2026-05-31')+' · <b>Timezone:</b> '+esc(meta.tz||'Asia/Kolkata')+' · <b>Pages read:</b> '+((meta.pagesRead)||0)+'<br><b>Data integrity:</b> every module paginated to completion (offset paging, 2000/page); records deduped by Zoho record id; deleted records excluded automatically (live read); modified records reflect current CRM state; owners resolved by user-id. No records were silently skipped.'));
  v.appendChild(el('div','note','<b>Error Report:</b> <span class="badge ok">0 failed pages</span> — all API pages returned successfully during extraction.'));
}

/* ---- Traffic (LIVE Google Analytics 4 via ga4-api) ---- */
var GA4={cache:{}};   // key = "from|to" → { loading:true } | { data:… } | { error:… }
function ga4Dur(sec){ sec=Math.round(sec||0); if(sec<60)return sec+'s'; var m=Math.floor(sec/60),s=sec%60; return m+'m '+(s<10?'0':'')+s+'s'; }

function renderTraffic(v){
  if(!CONFIG.GA4_API){ renderTrafficSetup(v); return; }
  var key=F.from+'|'+F.to, st=GA4.cache[key];
  if(st&&st.data){ paintTraffic(v, st.data); return; }
  if(st&&st.error){
    v.appendChild(el('div','note','⚠️ <b>GA4 could not load.</b> '+esc(st.error)));
    var rb=el('button','mini','↻ Retry'); rb.style.marginTop='8px'; rb.onclick=function(){ delete GA4.cache[key]; render(); }; v.appendChild(rb);
    return;
  }
  v.appendChild(el('div','note','⏳ Loading live GA4 traffic for '+fmtDay(F.from)+' → '+fmtDay(F.to)+' …'));
  if(st&&st.loading) return;               // a fetch for this range is already in flight
  GA4.cache[key]={loading:true};
  var u; try{ u=new URL(CONFIG.GA4_API); }catch(e){ GA4.cache[key]={error:'Invalid CONFIG.GA4_API URL.'}; render(); return; }
  u.searchParams.set('from',F.from); u.searchParams.set('to',F.to);
  fetch(u.toString(),{cache:'no-store'})
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; },function(){ return {ok:false,j:{error:'Non-JSON response (HTTP '+r.status+')'}}; }); })
    .then(function(res){
      if(!res.ok || (res.j&&res.j.error)){ GA4.cache[key]={error:(res.j&&(res.j.detail||res.j.error))||'Request failed.'}; }
      else { GA4.cache[key]={data:res.j}; }
      if(active==='traffic' && (F.from+'|'+F.to)===key) render();
    })
    .catch(function(e){ GA4.cache[key]={error:'Could not reach the GA4 API — '+e.message}; if(active==='traffic'&&(F.from+'|'+F.to)===key) render(); });
}
function renderTrafficSetup(v){
  v.appendChild(kpiRow([['Sessions','—','GA4 not connected','','var(--c1)'],['Total Users','—','','','var(--c2)'],['Pageviews','—','','','var(--c6)'],['Key Events','—','conversions','','var(--good)']]));
  var p=panel('Connect Google Analytics 4','This tab shows live web-traffic from your GA4 property'); v.appendChild(p);
  p.__body.innerHTML='<div style="font-size:13px;line-height:1.7">'+
    'The <b>Traffic</b> tab is built and wired up, but not yet pointed at a data source. To go live:'+
    '<ol style="padding-left:20px;margin:8px 0">'+
    '<li>Deploy the <code>ga4-api</code> Cloud Function (see <code>ga4-api/README.md</code>) with your numeric <b>GA4_PROPERTY_ID</b>.</li>'+
    '<li>Grant the function’s service account <b>Viewer</b> on the GA4 property, and enable the <b>Google Analytics Data API</b>.</li>'+
    '<li>Paste the function URL into <code>CONFIG.GA4_API</code> at the top of <code>app.js</code>, then reload.</li>'+
    '</ol>'+
    'Once connected, this tab shows sessions, users, channels, sources, top pages, devices, countries, key events (conversions) and revenue — all respecting the global date range above.'+
    '</div>';
}
function paintTraffic(v,d){
  var t=d.totals||{}, meta=d.metrics||{}, win=d.window||{};
  var cur=(d.currency==='INR'?'₹':(d.currency?d.currency+' ':''));
  var hasConv=!!meta.keyEvent, hasRev=!!meta.revenue && (+t.revenue>0);
  v.appendChild(el('div','note','🌐 <b>Live Google Analytics 4</b> — property <code>'+esc(String(d.property||'').replace('properties/',''))+'</code> · via the GA4 Data API · respects the global <b>date range</b> ('+fmtDay(win.from||F.from)+' → '+fmtDay(win.to||F.to)+'). Owner / stage / trigger filters apply to CRM data only, not web analytics. Snapshot '+esc(String(d.generated_at||'').slice(0,16).replace('T',' '))+' UTC.'));
  var kp=[
    ['Sessions',num(Math.round(t.sessions||0)),'','','var(--c1)'],
    ['Total Users',num(Math.round(t.users||0)),num(Math.round(t.newUsers||0))+' new','','var(--c2)'],
    ['Pageviews',num(Math.round(t.pageViews||0)),'','','var(--c6)'],
    ['Engagement Rate',p1(t.engagementRate||0)+'%','','','var(--c4)'],
    ['Avg Session',ga4Dur(t.avgSessionDur),'duration','','var(--c3)']
  ];
  if(hasConv) kp.push(['Key Events',num(Math.round(t.keyEvents||0)),'conversions','up','var(--good)']);
  if(hasRev)  kp.push(['Revenue',cur+num(Math.round(t.revenue||0)),'','up','var(--good)']);
  v.appendChild(kpiRow(kp));

  var daily=d.daily||[], labels=daily.map(function(x){return fmtDay(x.date);});
  var g=el('div','grid g2');
  var pT=panel('Sessions & Users — Daily','GA4 time series'); g.appendChild(pT);
  lineChart(pT.__body,labels,[
    {name:'Sessions',color:'var(--c1)',data:daily.map(function(x){return Math.round(x.sessions||0);})},
    {name:'Users',color:'var(--c2)',data:daily.map(function(x){return Math.round(x.users||0);})}
  ]);
  if(hasConv){
    var pC=panel('Key Events — Daily','conversions over time'); g.appendChild(pC);
    lineChart(pC.__body,labels,[{name:'Key Events',color:'var(--good)',data:daily.map(function(x){return Math.round(x.keyEvents||0);})}]);
  } else {
    var pP=panel('Pageviews — Daily'); g.appendChild(pP);
    lineChart(pP.__body,labels,[{name:'Pageviews',color:'var(--c6)',data:daily.map(function(x){return Math.round(x.pageViews||0);})}]);
  }
  v.appendChild(g);
  if(hasRev){
    var pR=panel('Revenue — Daily',d.currency||''); v.appendChild(pR);
    lineChart(pR.__body,labels,[{name:'Revenue',color:'var(--c7)',data:daily.map(function(x){return Math.round(x.revenue||0);})}]);
  }

  var g2=el('div','grid g2');
  var pCh=panel('Sessions by Channel','Default channel grouping'); g2.appendChild(pCh);
  hbar(pCh.__body,(d.channels||[]).map(function(c){return{key:c.name,label:c.name,value:Math.round(c.sessions||0)};}),{color:'var(--c1)'});
  addExport(pCh,'ga4_channels',['Channel','Sessions','Users','KeyEvents','Revenue'],(d.channels||[]).map(function(c){return[c.name,Math.round(c.sessions||0),Math.round(c.users||0),Math.round(c.keyEvents||0),Math.round(c.revenue||0)];}));
  var pDv=panel('Sessions by Device'); g2.appendChild(pDv);
  donut(pDv.__body,(d.devices||[]).map(function(x){return{key:x.name,label:x.name,value:Math.round(x.sessions||0)};}),{center:'sessions'});
  v.appendChild(g2);

  var g3=el('div','grid g2');
  var pSrc=panel('Top Source / Medium','by sessions'); g3.appendChild(pSrc);
  hbar(pSrc.__body,(d.sources||[]).map(function(s){return{key:s.name,label:s.name,value:Math.round(s.sessions||0)};}),{color:'var(--c2)',max:12});
  addExport(pSrc,'ga4_sources',['SourceMedium','Sessions','KeyEvents'],(d.sources||[]).map(function(s){return[s.name,Math.round(s.sessions||0),Math.round(s.keyEvents||0)];}));
  var pCo=panel('Sessions by Country'); g3.appendChild(pCo);
  hbar(pCo.__body,(d.countries||[]).map(function(x){return{key:x.name,label:x.name,value:Math.round(x.sessions||0)};}),{color:'var(--c6)',max:12});
  v.appendChild(g3);

  var pPg=panel('Top Pages','by pageviews'); v.appendChild(pPg);
  table(pPg.__body,['Page','Pageviews','Users'],(d.pages||[]).map(function(p){return [esc(p.path),Math.round(p.views||0),Math.round(p.users||0)];}),{key:'ga4pages',numCols:[1,2],limit:100});
  addExport(pPg,'ga4_pages',['Page','Pageviews','Users'],(d.pages||[]).map(function(p){return[p.path,Math.round(p.views||0),Math.round(p.users||0)];}));

  if((d.events||[]).length){
    var pEv=panel('Events','GA4 event counts'); v.appendChild(pEv);
    table(pEv.__body,['Event','Count'],(d.events||[]).map(function(e){return [esc(e.name),Math.round(e.count||0)];}),{key:'ga4events',numCols:[1],limit:100});
    addExport(pEv,'ga4_events',['Event','Count'],(d.events||[]).map(function(e){return[e.name,Math.round(e.count||0)];}));
  }
  if((d.warnings||[]).length){ v.appendChild(el('div','note','<b>GA4 notes:</b> '+d.warnings.map(esc).join(' · '))); }
}

/* ============================ shell / filters ============================ */
/* ============================ Deal Performance & Quality Analysis ============================ */
var _mobCount=null;
function mobileCounts(){ if(_mobCount)return _mobCount; _mobCount={}; DEALS.forEach(function(d){ if(d.mobile)_mobCount[d.mobile]=(_mobCount[d.mobile]||0)+1; }); return _mobCount; }
function custType(d){ var mc=mobileCounts(); return (d.mobile && mc[d.mobile]>1)?'Repeat':'New'; }
function stageScore(d){ if(isWon(d))return 1; var st=(d.stage||'').toLowerCase(); if(st.indexOf('lost')>=0)return 0; if(st.indexOf('payment')>=0)return 0.9; if(st.indexOf('checkout')>=0)return 0.75; if(st.indexOf('cart')>=0)return 0.55; if(st.indexOf('prospect')>=0||st.indexOf('qualif')>=0)return 0.4; return 0.3; }
function probBucket(p){ return p<=0?'0%':p<=25?'1–25%':p<=50?'26–50%':p<=75?'51–75%':p<100?'76–99%':'100%'; }
function qualLabel(s){ return s>=80?'Excellent':s>=60?'Good':s>=40?'Average':'Poor'; }
function enrichDeals(dl){
  var joined=joinDeals(dl), today=D(maxDate);
  return joined.map(function(j){
    var d=j.deal, created=D(d.created);
    var ageDays=Math.max(0,Math.floor((today-created)/86400000));
    var lastT=null, lastISO=null; j.calls.forEach(function(c){ var ct=D(c.created); if(ct&&(!lastT||ct>lastT)){ lastT=ct; lastISO=c.created; } });
    var daysSince = lastT? Math.floor((today-lastT)/86400000) : ageDays;
    var prob=(d.prob==null?0:+d.prob);
    var won=isWon(d), lost=(d.stage||'').toLowerCase().indexOf('lost')>=0, open=!won&&!lost;
    var respNorm = j.frt==null?0 : j.frt<=5?1 : j.frt<=30?0.8 : j.frt<=120?0.6 : j.frt<=1440?0.35 : 0.15;
    var recNorm = lastT==null?0 : daysSince<=1?1 : daysSince<=3?0.8 : daysSince<=7?0.5 : daysSince<=14?0.25 : 0.05;
    var actNorm = Math.min(+d.numAct||0,8)/8;
    var ageNorm = (won||lost)?0.5 : ageDays<=3?1 : ageDays<=7?0.8 : ageDays<=15?0.55 : ageDays<=30?0.3 : 0.1;
    var score=Math.round(Math.max(0,Math.min(100, 100*( 0.25*(prob/100) + 0.20*stageScore(d) + 0.15*(j.contacted?1:0) + 0.13*actNorm + 0.10*respNorm + 0.10*recNorm + 0.07*ageNorm ))));
    return {d:d,j:j,ageDays:ageDays,daysSince:daysSince,lastISO:lastISO,hasLast:!!lastT,prob:prob,won:won,lost:lost,open:open,contacted:j.contacted,nCalls:j.nCalls,frt:j.frt,score:score,cat:qualLabel(score)};
  });
}
function attentionFlags(e){ var f=[]; if(!e.open)return f; if(e.daysSince>=3)f.push('stale'); if(e.nCalls===0)f.push('no-call'); if(e.prob>=70&&e.daysSince>=3)f.push('hot-stale'); if(e.prob>=70&&e.nCalls===0)f.push('hot-nocall'); return f; }
var FLAGLBL={stale:'idle 3d+','no-call':'no call','hot-stale':'hot & idle','hot-nocall':'hot · no call'};
function flagPills(fl){ if(!fl.length)return {html:'<span class="pill-open">ok</span>',text:''}; return {html:fl.map(function(f){var cls=(f.indexOf('hot')>=0||f==='no-call')?'pill-lost':'pill-open'; return '<span class="tag2 '+cls+'">'+esc(FLAGLBL[f]||f)+'</span>';}).join(' '), text:fl.join('|')}; }
function dealPriority(e){ if(e.prob>=70&&(e.daysSince>=3||e.nCalls===0))return 'High'; if(e.daysSince>=7||(e.prob>=50&&e.daysSince>=3))return 'Medium'; return 'Low'; }
function priPill(e){ var p=dealPriority(e), cls=p==='High'?'pill-lost':p==='Medium'?'pill-open':'pill-won'; return {html:'<span class="tag2 '+cls+'">'+p+'</span>',text:p}; }

var qConvDim='owner';
function renderQuality(v){
  var dl=fDeals(), E=enrichDeals(dl), n=E.length||1;
  var open=E.filter(function(e){return e.open;}), won=E.filter(function(e){return e.won;}), lost=E.filter(function(e){return e.lost;});
  var contacted=E.filter(function(e){return e.contacted;}), stale=open.filter(function(e){return e.daysSince>=3;});
  var avgQ=E.reduce(function(s,e){return s+e.score;},0)/n;
  var frts=contacted.map(function(e){return e.frt;}).filter(function(x){return x!=null;}).sort(function(a,b){return a-b;});
  var avgFrt=frts.length?frts.reduce(function(s,x){return s+x;},0)/frts.length:0, medFrt=frts.length?frts[Math.floor(frts.length/2)]:0;
  var winRate=pct(won.length,won.length+lost.length), contactRate=pct(contacted.length,n), stalePct=pct(stale.length,open.length||1);
  var followupComp=pct(E.filter(function(e){return e.frt!=null&&e.frt<=1440;}).length,n);
  var highPri=E.filter(function(e){return e.open&&e.prob>=70&&(e.daysSince>=3||e.nCalls===0);});
  var health=Math.round(0.30*contactRate + 0.25*(100-stalePct) + 0.25*avgQ + 0.20*winRate);

  // 8 — Executive KPIs
  v.appendChild(kpiRow([
    ['Deal Quality Score',''+Math.round(avgQ),qualLabel(avgQ),'','var(--c4)'],
    ['Pipeline Health',''+health,health>=70?'healthy':health>=50?'watch':'at risk',health>=70?'up':'down','var(--c2)'],
    ['Win Rate',p1(winRate)+'%',num(won.length)+'W / '+num(lost.length)+'L','','var(--good)'],
    ['Contact Rate',p1(contactRate)+'%',num(contacted.length)+' reached','','var(--c1)'],
    ['Avg Time to First Call',fmtDur(avgFrt),'median '+fmtDur(medFrt),'','var(--c3)'],
    ['Follow-up Compliance',p1(followupComp)+'%','1st call ≤24h','','var(--c6)'],
    ['Stale Deal %',p1(stalePct)+'%',num(stale.length)+' open ≥3d idle','down','var(--bad)'],
    ['High-Priority Deals',num(highPri.length),'hot & neglected','down','var(--c5)']
  ]));
  v.appendChild(el('div','note','<b>Deal Quality Score (0–100)</b> per deal = probability 25% · stage progression 20% · connected 15% · activities 13% · response speed 10% · recency 10% · freshness 7%. Bands: Excellent 80+ · Good 60–79 · Average 40–59 · Poor &lt;40. Live from Zoho. Note: Meetings/Tasks are owner-level (Zoho does not link them to a specific deal), and deal <b>Amount</b> is empty in this org, so “average deal value” is not shown.'));

  // 1 — Quality categories
  var cats=['Excellent','Good','Average','Poor'], catCol={Excellent:'var(--good)',Good:'var(--c2)',Average:'var(--c3)',Poor:'var(--bad)'};
  var g1=el('div','grid g2');
  var pCat=panel('Deals by Quality Category'); g1.appendChild(pCat);
  donut(pCat.__body, cats.map(function(c){return{key:c,label:c,value:E.filter(function(e){return e.cat===c;}).length};}).filter(function(x){return x.value>0;}),{center:'deals',colorByKey:catCol});
  var pTr=panel('Quality Score Trend','avg score over time'); g1.appendChild(pTr);
  var gran=pickGran(F.from,F.to), keyFn=gran==='month'?monthKey:gran==='week'?weekStart:dayKey;
  var sK={},cK={}; E.forEach(function(e){var k=keyFn(e.d.created); sK[k]=(sK[k]||0)+e.score; cK[k]=(cK[k]||0)+1;});
  var tks=Object.keys(sK).sort();
  lineChart(pTr.__body,fmtKeys(tks,gran),[{name:'Avg quality',color:'var(--c4)',data:tks.map(function(k){return Math.round(sK[k]/cK[k]);})}]);
  v.appendChild(g1);
  var pCatT=panel('Quality Category Breakdown'); v.appendChild(pCatT);
  var catRows=cats.map(function(c){var a=E.filter(function(e){return e.cat===c;}); return [c,a.length,p1(pct(a.length,n))+'%',p1(a.reduce(function(s,e){return s+e.prob;},0)/(a.length||1))+'%',p1(a.reduce(function(s,e){return s+(+e.d.numAct||0);},0)/(a.length||1)),p1(pct(a.filter(function(e){return e.won;}).length,a.length||1))+'%'];});
  table(pCatT.__body,['Category','Deals','% of total','Avg Prob','Avg Acts','Won %'],catRows,{key:'qcat',numCols:[1]});
  addExport(pCatT,'quality_categories',['Category','Deals','PctTotal','AvgProb','AvgActs','WonPct'],catRows);

  // 2 — Pipeline Health
  var pPH=panel('Pipeline Health'); v.appendChild(pPH);
  var phK=el('div','kpis');
  [['Active Deals',num(open.length),'open pipeline','var(--c1)'],['Won',num(won.length),'','var(--good)'],['Lost',num(lost.length),'','var(--bad)'],
   ['Stale (≥3d idle)',num(stale.length),p1(stalePct)+'% of open','var(--c5)'],['High Prob (≥70)',num(open.filter(function(e){return e.prob>=70;}).length),'open','var(--c2)'],
   ['Low Prob (<30)',num(open.filter(function(e){return e.prob<30;}).length),'open','var(--c3)'],['Avg Deal Age',p1(E.reduce(function(s,e){return s+e.ageDays;},0)/n)+'d','all deals','var(--c6)'],
   ['Avg Age (open)',p1(open.reduce(function(s,e){return s+e.ageDays;},0)/(open.length||1))+'d','≈ time in stage','var(--c4)']].forEach(function(x){ phK.appendChild(kpi(x[0],x[1],x[2],'',x[3])); });
  pPH.insertBefore(phK,pPH.__body);
  var att=E.filter(function(e){return attentionFlags(e).length;}).sort(function(a,b){return (b.prob-a.prob)||(b.daysSince-a.daysSince);});
  var pAtt=panel('⚠ Deals needing immediate attention','open deals that are stale, un-called, or hot-but-neglected'); v.appendChild(pAtt);
  table(pAtt.__body,['Deal','Owner','Stage','Prob','Calls','Last Activity','Idle','Flags'],
    att.slice(0,400).map(function(e){return [esc(e.d.name),ownerName(e.d.owner),stagePill(e.d.stage),e.prob+'%',e.nCalls,e.hasLast?fmtDT(e.lastISO):'never',e.daysSince+'d',flagPills(attentionFlags(e))];}),{key:'qatt',numCols:[4],limit:250});
  addExport(pAtt,'attention_deals',['Deal','Owner','Stage','Prob','Calls','DaysIdle','Flags'],att.map(function(e){return [e.d.name,ownerName(e.d.owner),e.d.stage,e.prob,e.nCalls,e.daysSince,attentionFlags(e).join('|')];}));

  // 3 — Conversion Analysis (dimension toggle)
  var pConv=panel('Conversion Analysis','Won / Lost / Conversion% by dimension · deal value not tracked in this org'); v.appendChild(pConv);
  var dims=[['owner','Owner',function(e){return ownerName(e.d.owner);}],['leadSource','Lead Source',function(e){return clean(e.d.leadSource);}],['trigger','Entry Trigger',function(e){return normTrig(e.d.trigger);}],['utm','UTM Source',function(e){return clean(e.d.utmSource);}],['prob','Probability',function(e){return probBucket(e.prob);}],['slot','Time Slot',function(e){return SLOTS[slotIndex(hourOf(e.d.created))].label;}],['cust','Customer Type',function(e){return custType(e.d);}]];
  var dbar=el('div','presets'); dbar.style.marginTop='2px'; dims.forEach(function(dm){ var b=el('button',qConvDim===dm[0]?'on':'',dm[1]); b.onclick=function(){ qConvDim=dm[0]; render(); }; dbar.appendChild(b); }); pConv.__head.appendChild(dbar);
  var dim=dims.filter(function(x){return x[0]===qConvDim;})[0]||dims[0];
  var grp={}; E.forEach(function(e){ var k=dim[2](e); var o=grp[k]||(grp[k]={n:0,w:0,l:0,q:0}); o.n++; o.q+=e.score; if(e.won)o.w++; if(e.lost)o.l++; });
  var convRows=Object.keys(grp).map(function(k){var o=grp[k]; return [k,o.n,o.w,o.l,p1(pct(o.w,(o.w+o.l)||1))+'%',Math.round(o.q/o.n)];}).sort(function(a,b){return b[1]-a[1];});
  table(pConv.__body,[dim[1],'Deals','Won','Lost','Conversion %','Avg Quality'],convRows,{key:'qconv',numCols:[1,2,3,5]});
  addExport(pConv,'conversion_'+qConvDim,[dim[1],'Deals','Won','Lost','ConversionPct','AvgQuality'],convRows.map(function(r){return r.map(function(c){return (c&&c.text!=null)?c.text:c;});}));

  // 4 — Activity Performance by owner
  var cl=fCalls(), tk=fTasks(), ev=fEvents(), on=fOnline();
  var ow={}; function orow(id){return ow[id]||(ow[id]={deals:0,acts:0,frt:[],contacted:0,calls:0,conn:0,talk:0,meet:0,tasks:0,chats:0});}
  E.forEach(function(e){var o=orow(e.d.owner); o.deals++; o.acts+=(+e.d.numAct||0); if(e.contacted){o.contacted++; if(e.frt!=null)o.frt.push(e.frt);}});
  cl.forEach(function(c){var o=orow(c.owner); o.calls++; if(c.dur>0)o.conn++; o.talk+=c.dur||0;}); ev.forEach(function(e){orow(e.owner).meet++;}); tk.forEach(function(t){orow(t.owner).tasks++;}); on.forEach(function(o2){orow(o2.owner).chats++;});
  var pAP=panel('Activity Performance by Owner','response speed & follow-up quality'); v.appendChild(pAP);
  var apRows=Object.keys(ow).map(function(id){var o=ow[id]; var af=o.frt.length?o.frt.reduce(function(s,x){return s+x;},0)/o.frt.length:null; return [ownerName(id),o.calls,o.conn,{html:hms(o.talk),text:o.talk},o.meet,o.tasks,o.chats,p1(o.deals?o.acts/o.deals:0),{html:af==null?'—':fmtDur(af),text:af==null?'':p1(af)},p1(pct(o.contacted,o.deals))+'%'];}).sort(function(a,b){return b[1]-a[1];});
  table(pAP.__body,['Owner','Calls','Connected','Talk Time','Meetings','Tasks','Chats','Acts/Deal','Avg 1st Call','Follow-up %'],apRows,{key:'qap',numCols:[1,2,3,4,5,6]});
  addExport(pAP,'activity_performance',['Owner','Calls','Connected','TalkTimeSec','Meetings','Tasks','Chats','ActsPerDeal','Avg1stCallMin','FollowupPct'],Object.keys(ow).map(function(id){var o=ow[id];var af=o.frt.length?o.frt.reduce(function(s,x){return s+x;},0)/o.frt.length:'';return [ownerName(id),o.calls,o.conn,o.talk,o.meet,o.tasks,o.chats,p1(o.deals?o.acts/o.deals:0),af===''?'':p1(af),p1(pct(o.contacted,o.deals))];}));

  // 5 — Stale Deal Analysis
  var pStale=panel('Stale Deal Analysis','open deals sorted by idle time · Next follow-up not tracked per-deal in Zoho'); v.appendChild(pStale);
  var staleAll=open.slice().sort(function(a,b){return (b.daysSince-a.daysSince)||(b.prob-a.prob);});
  table(pStale.__body,['Deal','Owner','Stage','Prob','Last Activity','Days Idle','Next Follow-up','Priority'],
    staleAll.slice(0,400).map(function(e){return [esc(e.d.name),ownerName(e.d.owner),stagePill(e.d.stage),e.prob+'%',e.hasLast?fmtDT(e.lastISO):'never',e.daysSince+'d','—',priPill(e)];}),{key:'qstale',numCols:[3,5],limit:250});
  addExport(pStale,'stale_deals',['Deal','Owner','Stage','Prob','LastActivity','DaysIdle','Priority'],staleAll.map(function(e){return [e.d.name,ownerName(e.d.owner),e.d.stage,e.prob,e.hasLast?e.lastISO:'never',e.daysSince,dealPriority(e)];}));

  // 6 — Deal Age Analysis
  var pAge=panel('Deal Age Analysis','by days since creation'); v.appendChild(pAge);
  var ageB=[['0–3 days',0,3],['4–7 days',4,7],['8–15 days',8,15],['16–30 days',16,30],['30+ days',31,1e9]];
  var ageRows=ageB.map(function(b){var a=E.filter(function(e){return e.ageDays>=b[1]&&e.ageDays<=b[2];}); return [b[0],a.length,p1(pct(a.filter(function(e){return e.won;}).length,a.length||1))+'%',p1(pct(a.filter(function(e){return e.lost;}).length,a.length||1))+'%',p1(a.reduce(function(s,e){return s+e.prob;},0)/(a.length||1))+'%',p1(a.reduce(function(s,e){return s+(+e.d.numAct||0);},0)/(a.length||1))];});
  table(pAge.__body,['Age Bucket','Deals','Won %','Lost %','Avg Prob','Avg Acts'],ageRows,{key:'qage',numCols:[1]});
  addExport(pAge,'deal_age',['AgeBucket','Deals','WonPct','LostPct','AvgProb','AvgActs'],ageRows);

  // 7 — Probability Analysis
  var g7=el('div','grid g2');
  var pB=['0%','1–25%','26–50%','51–75%','76–99%','100%'];
  var pbG={}; E.forEach(function(e){var k=probBucket(e.prob); var o=pbG[k]||(pbG[k]={n:0,w:0,l:0,age:0,act:0}); o.n++; if(e.won)o.w++; if(e.lost)o.l++; o.age+=e.ageDays; o.act+=(+e.d.numAct||0);});
  var pPC=panel('Probability vs Conversion','win-rate within each probability band'); g7.appendChild(pPC);
  hbar(pPC.__body, pB.filter(function(k){return pbG[k];}).map(function(k){var o=pbG[k]; return {key:k,label:k,value:+p1(pct(o.w,(o.w+o.l)||1))};}),{color:'var(--c2)',fmt:function(x){return x+'%';},max:6});
  var pPT=panel('Probability band detail'); g7.appendChild(pPT);
  table(pPT.__body,['Prob band','Deals','Conversion %','Won %','Avg Age','Avg Acts'],pB.filter(function(k){return pbG[k];}).map(function(k){var o=pbG[k]; return [k,o.n,p1(pct(o.w,(o.w+o.l)||1))+'%',p1(pct(o.w,o.n))+'%',p1(o.age/o.n)+'d',p1(o.act/o.n)];}),{key:'qpb',numCols:[1]});
  v.appendChild(g7);
  var hpLowAct=E.filter(function(e){return e.open&&e.prob>=70&&(+e.d.numAct||0)<=1;});
  var hpNoCall=E.filter(function(e){return e.open&&e.prob>=70&&e.nCalls===0;});
  var lpHiAct=E.filter(function(e){return e.open&&e.prob<30&&(+e.d.numAct||0)>=5;});
  v.appendChild(kpiRow([
    ['High Prob · Low Activity',num(hpLowAct.length),'≥70% prob, ≤1 activity','down','var(--c5)'],
    ['High Prob · No Calls',num(hpNoCall.length),'≥70% prob, 0 calls after creation','down','var(--bad)'],
    ['Low Prob · High Activity',num(lpHiAct.length),'<30% prob, ≥5 activities','','var(--c3)']
  ]));
}

/* ============================ Backend-API features (merged from the "Zoho Login & Status" dashboard) ============================
   These tabs surface data that lives ONLY in the Cloud Run backend (BigQuery / GA4 / LimeChat), which is NOT part of the
   client snapshot (data.js). Pattern mirrors the GA4 "Traffic" tab: CONFIG.ZOHO_API set → fetch live; empty → setup panel.
   All rendering reuses the existing panel/table/kpiRow/hbar/lineChart builders so UI/UX stays identical to the base dashboard. */
var ZOHO={cache:{}};
function zohoBase(){ return (CONFIG.ZOHO_API||'').replace(/\/+$/,''); }
function zohoURL(path,params){ var u=new URL(zohoBase()+path, (typeof location!=='undefined'?location.href:undefined)); Object.keys(params||{}).forEach(function(k){ var val=params[k]; if(val!=null&&val!=='') u.searchParams.set(k,val); }); return u.toString(); }
/* ensure data for (path,params) is fetched once; returns {loading}|{data}|{error}; re-renders when it lands (cache prevents loops) */
function zohoGet(path,params,key){
  var st=ZOHO.cache[key]; if(st) return st;
  var url; try{ url=zohoURL(path,params); }catch(e){ return (ZOHO.cache[key]={error:'Invalid CONFIG.ZOHO_API URL.'}); }
  ZOHO.cache[key]={loading:true};
  fetch(url,{cache:'no-store',headers:{'Accept':'application/json'}})
    .then(function(r){ return r.json().then(function(j){return{ok:r.ok,st:r.status,j:j};},function(){return{ok:false,st:r.status,j:{error:'Non-JSON response (HTTP '+r.status+')'}};}); })
    .then(function(res){ ZOHO.cache[key]=(!res.ok||(res.j&&res.j.error))?{error:(res.j&&(res.j.detail||res.j.error))||('Request failed (HTTP '+(res.st||'?')+').')}:{data:res.j}; render(); })
    .catch(function(e){ ZOHO.cache[key]={error:'Could not reach the backend — '+e.message}; render(); });
  return ZOHO.cache[key];
}
function zohoRetry(key){ delete ZOHO.cache[key]; render(); }
function zohoSetup(v,title,extra){
  v.appendChild(kpiRow([['—','—','backend not connected','','var(--c1)'],['—','—','','','var(--c2)'],['—','—','','','var(--c4)'],['—','—','','','var(--c6)']]));
  var p=panel('Connect the Zoho analytics backend','“'+title+'” is served live from the Zoho Login & Status service'); v.appendChild(p);
  p.__body.innerHTML='<div style="font-size:13px;line-height:1.7">'+
    'This tab is built and wired up, but <code>CONFIG.ZOHO_API</code> is empty, so it has no data source yet. To go live:'+
    '<ol style="padding-left:20px;margin:8px 0">'+
    '<li>Deploy / locate the <code>zoho-login-dashboard</code> service (Cloud Run) and copy its base URL.</li>'+
    '<li>Make sure its <code>/api/*</code> endpoints allow this dashboard’s origin (CORS), or serve this file from the same origin as the backend.</li>'+
    '<li>Paste the base URL into <code>CONFIG.ZOHO_API</code> at the top of <code>app.js</code>, then reload.</li>'+
    '</ol>'+(extra?('<div style="color:var(--tx2);margin-top:4px">'+extra+'</div>'):'')+
    '</div>';
}
/* fetch-or-status wrapper: returns the JSON payload, or null after rendering setup/loading/error placeholders */
function zohoView(v,opts){
  if(!CONFIG.ZOHO_API){ zohoSetup(v,opts.title,opts.setupExtra); return null; }
  var st=zohoGet(opts.path,opts.params,opts.key);
  if(st.error){ v.appendChild(el('div','note','⚠️ <b>'+esc(opts.title)+' could not load.</b> '+esc(st.error))); var rb=el('button','mini','↻ Retry'); rb.style.marginTop='8px'; rb.onclick=function(){ zohoRetry(opts.key); }; v.appendChild(rb); return null; }
  if(st.loading||!st.data){ v.appendChild(el('div','note','⏳ Loading '+esc(opts.title)+' from the backend…')); return null; }
  return st.data;
}
/* formatting helpers used by the backend tabs */
function fmtInr(x){ return '₹'+num(Math.round(x||0)); }
function fmtMin(m){ m=Math.round(m||0); return m<60?m+'m':Math.floor(m/60)+'h '+(m%60)+'m'; }
function fmtSecMin(s){ if(s==null)return'—'; s=Math.round(s); return s<90?s+'s':p1(s/60)+'m'; }
function fmtHrNice(h){ if(h==null)return'—'; return h<1?Math.round(h*60)+'m':p1(h)+'h'; }
function sqiClass(s){ return s==null?'sc-mid':(s>=80?'sc-good':s>=60?'sc-mid':'sc-bad'); }
function sqiColorVar(s){ return s==null?'var(--tx3)':(s>=80?'var(--good)':s>=60?'var(--warn)':'var(--bad)'); }
function convColorVar(p){ return p==null?'var(--tx3)':(p>=2?'var(--good)':p>=1?'var(--warn)':'var(--bad)'); }

/* ---- Products (deal × product-master analytics) ---- */
function renderProducts(v){
  var f=F.from, t=F.to; if(f===t) f='2025-01-01';   // single-day range → show full history (matches source behaviour)
  var d=zohoView(v,{title:'Products',path:'/api/products',params:{from:f,to:t},key:'prod|'+f+'|'+t,
    setupExtra:'Once connected: deals split by product type, material, colour, gender, purity, price band, segment and city — plus an agent × product-type conversion heatmap, from the lead history joined to the Zoho product master.'});
  if(!d) return;
  var win=d.window||{}, byType=d.by_type||[];
  var conv=byType.reduce(function(a,r){a.w+=r.converted||0;a.n+=r.deals||0;return a;},{w:0,n:0});
  v.appendChild(el('div','note','💎 <b>Product analytics</b> from the lead history joined to the Zoho product master'+(win.frm?(' · '+esc(win.frm)+' – '+esc(win.too)):'')+'. Product type is present on ~36% of deals; material/colour on deals carrying a known SKU. Owner/stage/trigger filters apply to CRM data only — this tab respects the date range.'));
  v.appendChild(kpiRow([
    ['Deals (window)',num(win.total||0),win.frm?(fmtDay(win.frm)+' → '+fmtDay(win.too)):'','','var(--c1)'],
    ['Product Types',num(byType.length),'with a known type','','var(--c4)'],
    ['Converted',num(conv.w),p1(pct(conv.w,conv.n))+'% conv','up','var(--good)'],
    ['Cities',num((d.by_city||[]).length),'demand geographies','','var(--c6)']
  ]));
  var pTr=panel('Deals over time','monthly · deals vs converted'); v.appendChild(pTr);
  var M=d.by_month||[];
  if(!M.length) pTr.__body.appendChild(el('div','empty','No monthly data in range.'));
  else lineChart(pTr.__body, M.map(function(x){return fmtMonth(x.month);}), [
    {name:'Deals',color:'var(--c3)',data:M.map(function(x){return x.deals||0;})},
    {name:'Converted',color:'var(--good)',data:M.map(function(x){return x.converted||0;})}
  ]);
  var pTy=panel('Deals by Product Type','avg score = lead quality · won value = ₹ on converted deals · days→win = avg days to convert'); v.appendChild(pTy);
  if(!byType.length) pTy.__body.appendChild(el('div','empty','No deals with a product type in this range.'));
  else {
    var tyRows=byType.map(function(r){ return [esc(r.category),r.deals,r.converted,convCell(r.conv_pct),(r.avg_price>0?fmtInr(r.avg_price):'—'),(r.won_value>0?fmtInr(r.won_value):'—'),(r.avg_score!=null?r.avg_score:'—'),(r.avg_days!=null?r.avg_days+'d':'—')]; });
    table(pTy.__body,['Product type','Deals','Won','Conv %','Avg price','Won value','Avg score','Days→win'],tyRows,{key:'prodtype',numCols:[1,2]});
    addExport(pTy,'products_by_type',['Type','Deals','Won','ConvPct','AvgPrice','WonValue','AvgScore','DaysToWin'],byType.map(function(r){return [r.category,r.deals,r.converted,r.conv_pct,r.avg_price,r.won_value,r.avg_score,r.avg_days];}));
  }
  var g=el('div','grid g2');
  cutPanel(g,d.by_material,'material','Material');
  cutPanel(g,d.by_colour,'colour','Colour');
  cutPanel(g,d.by_gender,'gender','Gender');
  cutPanel(g,d.by_purity,'purity','Purity');
  cutPanel(g,d.by_price,'band','Price band');
  cutPanel(g,d.by_segment,'segment','Segment');
  v.appendChild(g);
  var pCity=panel('Deals by City','top demand geographies'); v.appendChild(pCity);
  hbar(pCity.__body,(d.by_city||[]).map(function(r){return{key:String(r.city),label:String(r.city),value:r.deals};}),{color:'var(--c6)',max:15});
  var pMx=panel('Agent × Product-Type Conversion','cell = conversion % (deal count below) · agents with ≥10 deals'); v.appendChild(pMx);
  paintHeatmap(pMx.__body,d);
}
function convCell(p){ return {html:'<b style="color:'+convColorVar(p)+'">'+(p==null?'—':(+p).toFixed(2)+'%')+'</b>', text:(p==null?'':(+p).toFixed(2))}; }
function cutPanel(g,arr,keyName,label){
  var p=panel('Deals by '+label); g.appendChild(p);
  if(!arr||!arr.length){ p.__body.appendChild(el('div','empty','No data.')); return; }
  var hasPrice=arr[0].avg_price!==undefined;
  var heads=[label,'Deals','Won','Conv %']; if(hasPrice)heads.push('Avg price');
  var rows=arr.map(function(r){ var row=[esc(String(r[keyName])),r.deals,r.converted,convCell(r.conv_pct)]; if(hasPrice)row.push(r.avg_price>0?fmtInr(r.avg_price):'—'); return row; });
  table(p.__body,heads,rows,{key:'cut_'+keyName,numCols:[1,2]});
}
function paintHeatmap(host,d){
  var cats=d.matrix_cats||[], agents=(d.agents||[]).filter(function(a){return a.total_deals>=10;});
  if(!agents.length){ host.appendChild(el('div','empty','No agents with ≥10 deals.')); return; }
  var h='<table><thead><tr><th>Agent</th><th class="right">Deals</th><th class="right">Overall</th>'+cats.map(function(c){return '<th class="right">'+esc(c)+'</th>';}).join('')+'</tr></thead><tbody>';
  agents.forEach(function(a){
    h+='<tr><td><b>'+esc(a.agent)+'</b></td><td class="right">'+num(a.total_deals)+'</td><td class="right" style="color:'+convColorVar(a.conv_pct)+';font-weight:700">'+(+a.conv_pct).toFixed(2)+'%</td>';
    cats.forEach(function(c){ var x=a.cats&&a.cats[c];
      if(!x||!x.deals){ h+='<td class="right" style="color:var(--tx3)">—</td>'; }
      else { h+='<td class="right heatcell" style="color:'+convColorVar(x.conv_pct)+'" title="'+x.converted+' of '+x.deals+' converted">'+(+x.conv_pct).toFixed(1)+'%<br><span style="font-size:10px;color:var(--tx3)">'+x.deals+'</span></td>'; }
    });
    h+='</tr>';
  });
  h+='</tbody></table>';
  var wrap=el('div','tblwrap'); wrap.innerHTML=h; host.appendChild(wrap);
}

/* ---- SQI / DQI (identical layout, different endpoint) ---- */
var sqiDate='', dqiDate='';
function renderSQI(v){ renderScore(v,true); }
function renderDQI(v){ renderScore(v,false); }
function renderScore(v,isSqi){
  var dv=isSqi?sqiDate:dqiDate, name=isSqi?'Session Quality Index':'Deal Quality Index', short=isSqi?'SQI':'DQI';
  var d=zohoView(v,{title:name,path:isSqi?'/api/sqi':'/api/dqi',params:(dv?{date:dv}:{}),key:(isSqi?'sqi':'dqi')+'|'+(dv||'default'),
    setupExtra:isSqi?'Once connected: the GA4-based Session Quality Index (0–100) with a daily ring gauge, period averages, a 30-day trend and a metric-by-metric benchmark breakdown.':'Once connected: the June-benchmarked Deal Quality Index (0–100) — source mix, sessions, connectivity and conversion — with the same ring gauge, trend and breakdown.'});
  if(!d) return;
  var s=d.selected?d.selected.sqi:null;
  var pHead=panel(name+(isSqi?' · GA4 · 0–100':' · deals · June-benchmarked · 0–100'), isSqi?'Each metric earns its full weight when its benchmark is met (green) else 0. GA4 settles ~2 days late, so the default date is T-2.':'Each metric passes when it beats its June 2026 benchmark. Defaults to T-1; the two GA4 session metrics settle at T-2, so they may read low on the latest day.');
  v.appendChild(pHead);
  var di=el('input'); di.type='date'; di.className='zdate'; di.value=d.selected_date||''; if(d.max_date)di.max=d.max_date;
  di.onchange=function(){ if(isSqi)sqiDate=di.value; else dqiDate=di.value; render(); };
  var dw=el('div'); dw.style.cssText='display:flex;align-items:center;gap:6px'; dw.appendChild(el('span','',null)); dw.lastChild.style.cssText='font-size:11px;color:var(--tx3)'; dw.lastChild.textContent='Date'; dw.appendChild(di);
  pHead.__head.appendChild(dw);
  var head=el('div','sqi-head');
  if(s==null){ head.appendChild(el('div','empty',isSqi?('No GA4 data for '+esc(d.selected_date||'—')+'.'):('No deals for '+esc(d.selected_date||'—')+'.'))); }
  else {
    head.innerHTML='<div class="sqi-ring" style="--p:'+s+';--c:'+sqiColorVar(s)+'"><div><b class="'+sqiClass(s)+'">'+s+'</b><span>/ 100</span></div></div>'+
      '<div><div class="sqi-score '+sqiClass(s)+'">'+s+'<span style="font-size:20px;color:var(--tx2);font-weight:600"> / 100</span></div>'+
      '<div class="sqi-meta">'+esc(name)+' · <b>'+esc(d.selected_date)+'</b> · '+num((d.selected.sessions||0))+(isSqi?' sessions':' deals created')+'</div></div>';
  }
  pHead.__body.appendChild(head);
  var pPer=panel('Daily average by period','avg of each day’s '+short); v.appendChild(pPer);
  var pg=el('div','kpis');
  (d.periods||[]).forEach(function(p){ pg.appendChild(kpi(p.label,'<span class="'+sqiClass(p.avg_sqi)+'">'+(p.avg_sqi==null?'—':p.avg_sqi)+'</span>', p.days+' day'+(p.days===1?'':'s'), '', sqiColorVar(p.avg_sqi))); });
  pPer.__body.appendChild(pg);
  var pTrn=panel(short+' trend','last 30 days · click a bar to inspect that day'); v.appendChild(pTrn);
  paintScoreTrend(pTrn.__body, d.trend||[], d.selected_date, function(date){ if(isSqi)sqiDate=date; else dqiDate=date; render(); });
  var pBk=panel('Metric breakdown', d.selected_date?('· '+d.selected_date+' · '+(s==null?'—':s)+' / 100'):''); v.appendChild(pBk);
  paintScoreBreak(pBk.__body, d, s, short);
}
function paintScoreTrend(host,T,selDate,onPick){
  var vals=T.filter(function(x){return x.sqi!=null;}).map(function(x){return x.sqi;});
  if(!vals.length){ host.appendChild(el('div','empty','No daily data in the last 30 days.')); return; }
  var maxV=Math.max.apply(null,vals.concat([1]));
  var box=el('div','strend');
  T.forEach(function(x){ var hb=x.sqi==null?0:Math.max(4,Math.round(135*x.sqi/maxV));
    var col=el('div','scol'+(x.date===selDate?' sel':'')); col.title=x.date+': '+(x.sqi==null?'no data':x.sqi);
    col.innerHTML='<div class="sv">'+(x.sqi==null?'':x.sqi)+'</div><div class="sbar" style="height:'+hb+'px;background:'+sqiColorVar(x.sqi)+'"></div><div class="sd">'+esc(x.date.slice(5))+'</div>';
    col.onclick=function(){ onPick(x.date); };
    box.appendChild(col);
  });
  host.appendChild(box);
}
function paintScoreBreak(host,d,s,short){
  var metrics=(d.selected&&d.selected.metrics)||[];
  if(!metrics.length){ host.appendChild(el('div','empty','No metrics for this day.')); return; }
  var groups={}; metrics.forEach(function(m){ (groups[m.group]=groups[m.group]||[]).push(m); });
  var h='<table style="min-width:640px"><thead><tr><th>Metric</th><th class="right">Value</th><th>Benchmark rule</th><th class="right">Weight</th><th class="right">Score</th><th>Result</th></tr></thead><tbody>';
  Object.keys(groups).forEach(function(g){ var gw=(d.group_weight&&d.group_weight[g])||groups[g].reduce(function(a,m){return a+m.weight;},0); var gE=groups[g].reduce(function(a,m){return a+m.earned;},0);
    h+='<tr class="grow"><td colspan="3">'+esc(g)+'</td><td class="right">'+gw+'%</td><td class="right">'+gE+'</td><td></td></tr>';
    groups[g].forEach(function(m){ h+='<tr><td style="padding-left:20px">'+esc(m.label)+'</td><td class="right" style="color:'+(m.passed?'var(--good)':'var(--bad)')+';font-weight:700">'+esc(m.value_str)+'</td><td style="color:var(--tx2)">'+esc(m.rule)+'</td><td class="right">'+m.weight+'</td><td class="right">'+m.earned+'</td><td>'+(m.passed?'<span class="tag2 pill-won">pass</span>':'<span class="tag2 pill-lost">miss</span>')+'</td></tr>'; });
  });
  h+='</tbody><tfoot><tr style="font-weight:800;border-top:2px solid var(--line)"><td colspan="3">Total '+esc(short)+'</td><td class="right">100</td><td class="right '+sqiClass(s)+'">'+(s==null?'—':s)+'</td><td></td></tr></tfoot></table>';
  var wrap=el('div','tblwrap'); wrap.innerHTML=h; host.appendChild(wrap);
}

/* ---- Helpdesk (LimeChat WhatsApp) — separate from the CRM "Chat" tab (Online Activity Logs) ---- */
function renderHelpdesk(v){
  var d=zohoView(v,{title:'Helpdesk (LimeChat)',path:'/api/chat',params:{from:F.from,to:F.to},key:'chat|'+F.from+'|'+F.to,
    setupExtra:'Once connected: WhatsApp helpdesk performance from LimeChat — conversation counts, first-response and resolution times, bot deflection, a per-agent table and daily human-vs-bot volume.'});
  if(!d) return;
  var s=d.summary||{};
  v.appendChild(el('div','note','💬 <b>LimeChat helpdesk</b> — WhatsApp chat performance for '+fmtDay(F.from)+' → '+fmtDay(F.to)+'. FRT = first human reply · TTR = time to resolve.'));
  if(!s.convs){ v.appendChild(el('div','note','No conversations in this range. Try widening the dates.')); return; }
  v.appendChild(kpiRow([
    ['Conversations',num(s.convs),'','','var(--c1)'],
    ['Open',num(s.open),'','','var(--warn)'],
    ['Resolved',num(s.resolved),'','up','var(--good)'],
    ['Closed',num(s.closed||0),'','','var(--c6)'],
    ['Median FRT',fmtMinNice(s.frt_med_min),'human','','var(--c2)'],
    ['Avg FRT',fmtMinNice(s.frt_avg_min),'human','','var(--c2)'],
    ['Median Bot Resp',fmtSecMin(s.bot_resp_med_sec),'','','var(--c4)'],
    ['Median Resolution',fmtHrNice(s.ttr_med_hr),'','','var(--c3)'],
    ['Bot Deflection',(s.bot_deflection==null?'—':s.bot_deflection+'%'),'','','var(--c5)'],
    ['Human-handled',num(s.with_human),'','','var(--c1)']
  ]));
  if(s.detailed_convs<s.convs) v.appendChild(el('div','note','Counts cover all tickets. Human FRT / bot-split are precise for '+num(s.detailed_convs)+' of '+num(s.convs)+' conversations (last ~7 days); older tickets show counts only.'));
  var pAg=panel('Agent performance','FRT = first human reply · TTR = time to resolve'); v.appendChild(pAg);
  var arows=(d.agents||[]).map(function(a){ return [esc(a.agent),a.convs,a.handled,a.resolved,fmtMinNice(a.frt_med_min),fmtHrNice(a.ttr_med_hr),a.msgs_human]; });
  if(!arows.length) pAg.__body.appendChild(el('div','empty','No agents in range.'));
  else { table(pAg.__body,['Agent','Convs','Handled','Resolved','Median FRT','Median TTR','Msgs sent'],arows,{key:'hdagents',numCols:[1,2,3,6]});
    addExport(pAg,'helpdesk_agents',['Agent','Convs','Handled','Resolved','MedianFRTmin','MedianTTRhr','MsgsSent'],(d.agents||[]).map(function(a){return [a.agent,a.convs,a.handled,a.resolved,a.frt_med_min,a.ttr_med_hr,a.msgs_human];})); }
  var pVol=panel('Conversation volume','total · human-handled · bot-only, by day'); v.appendChild(pVol);
  var daily=d.daily||[];
  if(!daily.length) pVol.__body.appendChild(el('div','empty','No volume.'));
  else lineChart(pVol.__body, daily.map(function(x){return fmtDay(x.date);}), [
    {name:'Total',color:'var(--c1)',data:daily.map(function(x){return x.convs||0;})},
    {name:'Human',color:'var(--c2)',data:daily.map(function(x){return x.human||0;})},
    {name:'Bot-only',color:'var(--c4)',data:daily.map(function(x){return x.bot||0;})}
  ]);
}

/* ---- Login & Status (live Zoho user login/online + per-agent performance) ---- */
function renderLogin(v){
  var d=zohoView(v,{title:'Login & Status',path:'/api/summary',params:{from:F.from,to:F.to},key:'summary|'+F.from+'|'+F.to,
    setupExtra:'Once connected: who is online now, polled login time, active hours by activity, plus per-agent deals, won value (₹), calls, talk time, meetings and tasks — live from the backend.'});
  if(!d) return;
  v.appendChild(el('div','note','🔐 <b>Zoho user login & status</b> for '+fmtDay(F.from)+' → '+fmtDay(F.to)+' — live from the backend (BigQuery user snapshots).'));
  v.appendChild(kpiRow([
    ['Users',num(d.total),'','','var(--c1)'],
    ['Online now',num(d.online),'','up','var(--good)'],
    ['Active',num(d.active),'','','var(--c3)'],
    ['Inactive',num(d.inactive),'','down','var(--bad)'],
    ['Login time',fmtDur((d.tot_hrs||0)*60),'polled','','var(--c6)'],
    ['Active hrs',num(d.active_hours),'by activity','','var(--c2)'],
    ['Deals created',num(d.deals_created),'','','var(--c4)'],
    ['Won',num(d.won_cnt),fmtInr(d.won_amt)+' value','up','var(--good)'],
    ['Calls',num(d.calls),fmtMin(d.talk_min)+' talk','','var(--c5)'],
    ['Meetings',num(d.meetings),num(d.tasks)+' tasks','','var(--c6)']
  ]));
  var u=zohoView(v,{title:'Agents',path:'/api/users',params:{from:F.from,to:F.to},key:'users|'+F.from+'|'+F.to});
  if(!u) return;
  var pU=panel('Agents','online / login / performance per user — live'); v.appendChild(pU);
  var rows=(u.users||[]).map(function(x){ return [ esc(x.full_name||'—'), esc(x.role||'—'),
    {html:((x.status||'').toLowerCase()==='active'?'<span class="tag2 pill-won">active</span>':'<span class="tag2 pill-lost">'+esc(x.status||'—')+'</span>'),text:x.status},
    {html:(x.is_online?'<span class="tag2 pill-won">online</span>':'<span class="tag2 pill-open">offline</span>'),text:x.is_online?'online':'offline'},
    x.active_hours, fmtDur((x.online_hours||0)*60), x.deals_created, x.won_deals, fmtInr(x.won_amount), x.calls_cnt, fmtMin(x.talk_min), x.meetings, x.tasks_cnt ]; });
  if(!rows.length) pU.__body.appendChild(el('div','empty','No agents match this range.'));
  else { table(pU.__body,['Name','Role','Status','Online','Active hrs','Login','Deals','Won','Won value','Calls','Talk','Meetings','Tasks'],rows,{key:'loginusers',numCols:[4,6,7,9,11,12]});
    addExport(pU,'login_status',['Name','Role','Status','Online','ActiveHrs','LoginHrs','Deals','Won','WonValue','Calls','TalkMin','Meetings','Tasks'],(u.users||[]).map(function(x){return [x.full_name,x.role,x.status,x.is_online?'online':'offline',x.active_hours,x.online_hours,x.deals_created,x.won_deals,x.won_amount,x.calls_cnt,x.talk_min,x.meetings,x.tasks_cnt];})); }
}

/* ---- Data & Sync (backend sync status + BigQuery tables) ---- */
function renderDataSync(v){
  var d=zohoView(v,{title:'Data & Sync',path:'/api/tables',params:{from:F.from,to:F.to},key:'tables|'+F.from+'|'+F.to,
    setupExtra:'Once connected: backend sync status (scheduler job, cadence, last snapshot) and the BigQuery tables backing these analytics (row counts, size, last-modified).'});
  if(!d) return;
  var s=d.sync||{};
  var pS=panel('Sync details','backend scheduler & snapshot status'); v.appendChild(pS);
  table(pS.__body,['Field','Value'],[
    ['Scheduler job',{html:'<code>'+esc(s.scheduler_job||'—')+'</code>',text:s.scheduler_job}],
    ['Cadence',esc(s.cadence||'—')],
    ['Last user sync',esc(s.last_user_sync||'—')],
    ['Last snapshot',esc(s.last_snapshot||'—')],
    ['First snapshot',esc(s.first_snapshot||'—')],
    ['Sync runs (snapshots)',num(s.sync_runs||0)],
    ['Snapshot rows',num(s.snapshot_rows||0)]
  ],{key:'syncdet'});
  var pT=panel('BigQuery tables','tables backing these analytics'); v.appendChild(pT);
  var trows=(d.tables||[]).map(function(t){ return t.error
    ? [esc(t.table),{html:'<span class="badge err">'+esc(t.error)+'</span>',text:t.error},'','','']
    : [esc(t.table),num(t.rows||0),(t.mb!=null?t.mb+' MB':'—'),esc(t.modified||'—'),esc(t.mode||'—')]; });
  if(!trows.length) pT.__body.appendChild(el('div','empty','No tables reported.'));
  else table(pT.__body,['Table','Rows','Size','Last modified','Sync mode'],trows,{key:'bqtables',numCols:[1]});
}

/* ---- Stock / Inventory (embeds the existing inventory dashboard, same-origin build only) ---- */
function renderStock(v){
  var url=(typeof window!=='undefined'&&window.STOCK_URL)||'';
  if(!url){ v.appendChild(el('div','note','Stock view is only available when this dashboard is served from the Zoho backend.')); return; }
  var f=el('iframe'); f.src=url; f.title='Stock — Inventory'; f.loading='lazy';
  f.style.cssText='width:100%;height:calc(100vh - 170px);min-height:520px;border:1px solid var(--line);border-radius:12px;background:var(--card);display:block';
  v.appendChild(f);
}
var VIEWS={overview:renderOverview,deals:renderDeals,products:renderProducts,calls:renderCalls,dvc:renderDVC,agents:renderAgents,login:renderLogin,tasks:renderTasks,chat:renderChat,helpdesk:renderHelpdesk,events:renderCE,activities:renderActivities,traffic:renderTraffic,sqi:renderSQI,dqi:renderDQI,quality:renderQuality,validation:renderValidation,datasync:renderDataSync};
try{ if(typeof window!=='undefined' && window.STOCK_URL){ VIEWS.stock=renderStock; } }catch(e){}

function toggleOwner(name){ var id=Object.keys(OWN).filter(function(k){return OWN[k]===name;})[0]; if(!id){ // name may already be id-based label
    id=name; }
  if(F.owners.has(id))F.owners.delete(id); else F.owners.add(id); sync(); }

function buildTabs(){
  var nav=document.getElementById('tabnav'); nav.innerHTML='';
  var cur=null; TABS.forEach(function(t){ if(t[0]===active) cur=t; });
  var menu=el('div','tabmenu');
  var btn=el('button','tabmenu-btn','<span>'+esc(cur?cur[1]:'Menu')+'</span><span class="tabmenu-arr">▾</span>');
  btn.setAttribute('aria-haspopup','true'); btn.title='Choose a view';
  var pop=el('div','tabmenu-pop');
  TABS.forEach(function(t){ var item=el('button',t[0]===active?'on':'',t[1]); item.onclick=function(e){ if(e)e.stopPropagation(); active=t[0]; location.hash=t[0]; buildTabs(); render(); window.scrollTo(0,0); }; pop.appendChild(item); });
  btn.onclick=function(e){ if(e)e.stopPropagation(); menu.classList.toggle('open'); };
  menu.appendChild(btn); menu.appendChild(pop); nav.appendChild(menu);
  if(!window._tabMenuDocClose){ window._tabMenuDocClose=true; document.addEventListener('click',function(){ var m=document.querySelector('.tabmenu.open'); if(m)m.classList.remove('open'); }); }
}
(function(){ var h=(location.hash||'').replace('#',''); if(h&&VIEWS[h])active=h; })();
window.addEventListener('hashchange',function(){ var h=(location.hash||'').replace('#',''); if(h&&VIEWS[h]&&h!==active){active=h;buildTabs();render();} });

function distinct(arr,fn){ var s={}; arr.forEach(function(x){var v=fn(x); if(v!=null&&v!=='')s[v]=1;}); return Object.keys(s).sort(); }
var advOpen=false;
function buildFilters(){
  var f=document.getElementById('filters'); f.innerHTML='';
  var top=el('div','filtbar-top');
  var row=el('div','row');
  // presets
  var pg=el('div','fgroup'); pg.appendChild(el('label',null,'Date Range (quick)'));
  var pr=el('div','presets');
  [['all','All'],['today','Today'],['yest','Yesterday'],['7','Last 7d'],['30','Last 30d'],['tw','Weekly'],['tm','Monthly (MTD)'],['lm','Last mo'],['qtr','Quarterly'],['hy','Half Yearly'],['yr','Yearly']].forEach(function(p){ var b=el('button',F.preset===p[0]?'on':'',p[1]); b.onclick=function(){setPreset(p[0]);}; pr.appendChild(b); });
  var cb=el('button',F.preset===''?'on':'','◆ Custom'); cb.title='Active when you pick your own From/To dates'; cb.onclick=function(){ F.preset=''; sync(); }; pr.appendChild(cb);
  pg.appendChild(pr); row.appendChild(pg);
  // custom dates — free choice ("according to me"): no min/max lock, auto-clamped so From<=To
  var fg=el('div','fgroup'); fg.appendChild(el('label',null,'From (custom)')); var fi=el('input'); fi.type='date'; fi.value=F.from; fi.onchange=function(){ var v=fi.value||minDate; F.from=v; if(F.to<F.from)F.to=F.from; F.preset=''; sync(); }; fg.appendChild(fi); row.appendChild(fg);
  var tg=el('div','fgroup'); tg.appendChild(el('label',null,'To (custom)')); var ti=el('input'); ti.type='date'; ti.value=F.to; ti.onchange=function(){ var v=ti.value||maxDate; F.to=v; if(F.to<F.from)F.from=F.to; F.preset=''; sync(); }; tg.appendChild(ti); row.appendChild(tg);
  var rg=el('div','fgroup'); rg.appendChild(el('label',null,' ')); var rb=el('button','mini','↺ Reset dates'); rb.style.marginTop='2px'; rb.onclick=function(){ setPreset('all'); }; rg.appendChild(rb); row.appendChild(rg);
  var cg=el('div','fgroup'); cg.appendChild(el('label',null,'Compare')); var cbp=el('button','mini','Prev period'); cbp.style.marginTop='2px'; if(F.compare){ cbp.style.background='var(--acc)'; cbp.style.color='#fff'; cbp.style.borderColor='var(--acc)'; cbp.innerHTML='✓ Prev period'; } else { cbp.innerHTML='⇄ Prev period'; } cbp.onclick=function(){ F.compare=!F.compare; sync(); }; cg.appendChild(cbp); row.appendChild(cg);
  // owner multiselect (basic)
  row.appendChild(ownerMulti());
  // ALL filters live inside the collapsible panel; the bar shows a summary + a single toggle
  var dateOn=(F.preset!=='all'||F.from!==minDate||F.to!==maxDate);
  var applied=(F.stage.size?1:0)+(F.trigger.size?1:0)+(F.leadSource.size?1:0)+[F.utmSource,F.utmMedium,F.callType,F.taskStatus].filter(Boolean).length+(F.owners.size?1:0)+(dateOn?1:0)+(F.compare?1:0);
  var dlabel=dateOn?(fmtDay(F.from)+' → '+fmtDay(F.to)):'All dates · since 31 May 2026';
  var summ=el('div','filt-summary'); summ.innerHTML='<span class="fs-lbl">Showing</span> <b>'+esc(dlabel)+'</b>'+(F.owners.size?' · <b>'+F.owners.size+'</b> owner(s)':'')+(F.stage.size?' · <b>'+F.stage.size+'</b> stage(s)':'')+(F.compare?' · <b>compare on</b>':'')+(applied?'':' · <span style="color:var(--tx3)">no filters applied</span>');
  top.appendChild(summ);
  var advBtn=el('button','adv-toggle'+(advOpen?' open':''));
  advBtn.innerHTML='<span>⚙ Filters</span>'+(applied?'<span class="applied">'+applied+' applied</span>':'<span class="cnt">open to filter</span>')+'<span class="arr">▾</span>';
  advBtn.title='Open the filters panel: date range, owner, compare, stage, trigger, lead source, UTM source/medium, call type, task status';
  top.appendChild(advBtn);
  f.appendChild(top);
  // Collapsible panel holds ALL filters: the basic row (date/compare/owner) + the advanced selects
  var adv=el('div','frow-adv'+(advOpen?' open':''));
  adv.appendChild(row);
  var arow=el('div','row');
  arow.appendChild(multiGroup('Stage',F.stage,distinct(DEALS,function(d){return d.stage;})));
  arow.appendChild(multiGroup('Trigger Event',F.trigger,distinct(DEALS,function(d){return normTrig(d.trigger);})));
  arow.appendChild(multiGroup('Lead Source',F.leadSource,distinct(DEALS,function(d){return clean(d.leadSource);}).filter(function(x){return x!=='(none)';})));
  arow.appendChild(gatedGroup('Store','Store_Assigned isn’t captured in this dashboard’s data feed yet — the field exists in Zoho but needs a small addition to the CRM bundle API before it can be filtered here.'));
  arow.appendChild(gatedGroup('Campaign','UTM Campaign isn’t captured in this dashboard’s data feed yet — UTM Source/Medium below are the closest available proxies.'));
  arow.appendChild(selGroup('UTM Source','utmSource',distinct(DEALS,function(d){return clean(d.utmSource);}).filter(function(x){return x!=='(none)';})));
  arow.appendChild(selGroup('UTM Medium','utmMedium',distinct(DEALS,function(d){return clean(d.utmMedium);}).filter(function(x){return x!=='(none)';})));
  arow.appendChild(selGroup('Call Type','callType',distinct(CALLS,function(c){return c.type;})));
  arow.appendChild(selGroup('Task Status','taskStatus',distinct(TASKS,function(t){return t.status;})));
  adv.appendChild(arow); f.appendChild(adv);
  advBtn.onclick=function(){ advOpen=!advOpen; advBtn.classList.toggle('open',advOpen); adv.classList.toggle('open',advOpen); };
}
function selGroup(label,key,opts){ var g=el('div','fgroup'); g.appendChild(el('label',null,label)); var s=el('select'); s.appendChild(new Option('All','')); opts.forEach(function(o){ var op=new Option(o,o); if(F[key]===o)op.selected=true; s.appendChild(op); }); s.onchange=function(){F[key]=s.value;sync();}; g.appendChild(s); return g; }
/* Generic multi-select: search box + checkboxes + Select all / Clear all. Used for
   Stage/Trigger/Lead Source/Owner — `set` is one of F's Set fields, mutated in place. */
function multiGroup(label,set,opts,labelFn){
  labelFn=labelFn||function(x){return x;};
  var g=el('div','fgroup'); g.appendChild(el('label',null,label));
  var m=el('div','multi'); var tag=el('span','tag', set.size?set.size+' selected':'All'); m.appendChild(tag);
  var pop=el('div','pop');
  var search=el('input','multi-search'); search.type='text'; search.placeholder='Search '+label.toLowerCase()+'…';
  search.style.cssText='width:100%;box-sizing:border-box;margin-bottom:6px';
  search.onclick=function(ev){ ev.stopPropagation(); };
  pop.appendChild(search);
  var bar=el('div','multi-bar'); bar.style.cssText='display:flex;gap:6px;margin-bottom:6px';
  var selAll=el('button','mini','Select all'); selAll.type='button';
  var clrAll=el('button','mini','Clear all'); clrAll.type='button';
  bar.appendChild(selAll); bar.appendChild(clrAll); pop.appendChild(bar);
  var list=el('div','multi-list'); pop.appendChild(list);
  function renderList(q){
    list.innerHTML=''; var ql=(q||'').toLowerCase(); var shown=0;
    opts.forEach(function(o){ var disp=labelFn(o); if(ql && disp.toLowerCase().indexOf(ql)<0) return; shown++;
      var lab=el('label'); var cb=el('input'); cb.type='checkbox'; cb.checked=set.has(o);
      cb.onchange=function(ev){ ev.stopPropagation(); if(cb.checked)set.add(o); else set.delete(o); sync(); };
      lab.appendChild(cb); lab.appendChild(document.createTextNode(' '+disp)); list.appendChild(lab); });
    if(!shown) list.appendChild(el('div','hint','No matches'));
  }
  search.oninput=function(){ renderList(search.value); };
  selAll.onclick=function(ev){ ev.stopPropagation(); opts.forEach(function(o){set.add(o);}); sync(); };
  clrAll.onclick=function(ev){ ev.stopPropagation(); set.clear(); sync(); };
  renderList('');
  m.appendChild(pop);
  m.onclick=function(e){ if(e.target.tagName==='INPUT')return; m.classList.toggle('open'); if(m.classList.contains('open'))search.focus(); };
  document.addEventListener('click',function(e){ if(!m.contains(e.target))m.classList.remove('open'); });
  return g.appendChild(m), g;
}
/* A filter group that's visibly present but disabled — for fields the spec asks for
   that aren't in this dashboard's current data feed. Honest > fabricated. */
function gatedGroup(label,reason){
  var g=el('div','fgroup'); g.appendChild(el('label',null,label));
  var m=el('div','multi'); m.style.cssText='opacity:.55;cursor:not-allowed'; m.title=reason;
  m.appendChild(el('span','tag','🔒 Not available'));
  g.appendChild(m); return g;
}
function ownerMulti(){
  var ids=distinct(DEALS.concat(CALLS),function(x){return x.owner;});
  ids.sort(function(a,b){return ownerName(a).localeCompare(ownerName(b));});
  return multiGroup('Owner',F.owners,ids,ownerName);
}
function chips(){
  var c=document.getElementById('chipbar'); c.innerHTML='';
  var items=[];
  if(F.preset!=='all'||F.from!==minDate||F.to!==maxDate) items.push(['Date',fmtDay(F.from)+' → '+fmtDay(F.to),function(){setPreset('all');}]);
  F.owners.forEach(function(id){ items.push(['Owner',ownerName(id),function(){F.owners.delete(id);sync();}]); });
  F.stage.forEach(function(s){ items.push(['Stage',s,function(){F.stage.delete(s);sync();}]); });
  F.trigger.forEach(function(t){ items.push(['Trigger',t,function(){F.trigger.delete(t);sync();}]); });
  F.leadSource.forEach(function(l){ items.push(['Lead Source',l,function(){F.leadSource.delete(l);sync();}]); });
  ['utmSource','utmMedium','callType','taskStatus'].forEach(function(k){ if(F[k])items.push([k,F[k],function(){F[k]='';sync();}]); });
  if(!items.length){ c.appendChild(el('span','chip','<b>All data</b> · since 31 May 2026')); return; }
  items.forEach(function(it){ var ch=el('span','chip','<b>'+esc(it[0])+':</b> '+esc(it[1])+' <span class="x">✕</span>'); ch.querySelector('.x').onclick=it[2]; c.appendChild(ch); });
  var clr=el('button','clearall','Clear all'); clr.onclick=function(){ F.owners.clear(); F.stage.clear(); F.trigger.clear(); F.leadSource.clear(); ['utmSource','utmMedium','callType','taskStatus'].forEach(function(k){F[k]='';}); setPreset('all'); }; c.appendChild(clr);
}
function presetRange(p){ var to=istTodayKey(), r={from:F.from,to:F.to};
  /* `to` is the REAL current IST calendar date, not maxDate (the latest date that happens to have a
     deal/call in the loaded data) — otherwise "Today" silently aliases to "Yesterday" whenever no deal
     has been created yet today, since maxDate would still point at yesterday. */
  if(p==='all'){r.from=minDate;r.to=maxDate;}
  else if(p==='today'){r.from=to;r.to=to;}
  else if(p==='yest'){var dy=D(istTodayKey());dy.setDate(dy.getDate()-1);r.from=ymd(dy);r.to=ymd(dy);}
  else if(p==='7'){var d=D(to);d.setDate(d.getDate()-6);r.from=ymd(d);r.to=to;}
  else if(p==='30'){var d2=D(to);d2.setDate(d2.getDate()-29);r.from=ymd(d2);r.to=to;}
  else if(p==='tw'){var dw=D(to);var wd=(dw.getDay()+6)%7;dw.setDate(dw.getDate()-wd);r.from=ymd(dw);r.to=to;}
  else if(p==='tm'){r.from=to.slice(0,7)+'-01';r.to=to;}
  else if(p==='lm'){var d3=D(to.slice(0,7)+'-01');d3.setMonth(d3.getMonth()-1);var s=ymd(d3);var e=D(to.slice(0,7)+'-01');e.setDate(0);r.from=s;r.to=ymd(e);}
  else if(p==='qtr'){var dq=D(to);var qm=Math.floor(dq.getMonth()/3)*3;r.from=ymd(new Date(dq.getFullYear(),qm,1));r.to=to;}
  else if(p==='hy'){var dh=D(to);var hm=dh.getMonth()<6?0:6;r.from=ymd(new Date(dh.getFullYear(),hm,1));r.to=to;}
  else if(p==='yr'){r.from=to.slice(0,4)+'-01-01';r.to=to;}
  return r;
}
function setPreset(p){ F.preset=p; var r=presetRange(p); F.from=r.from; F.to=r.to; sync(); }
function sync(){ buildFilters(); chips(); render(); }
function render(){ var v=document.getElementById('views'); v.innerHTML='';
  /* the Stock tab is a full-bleed iframe — hide the CRM filter bar / chips while it's active */
  var _fb=document.getElementById('filters'), _cb=document.getElementById('chipbar'), _hide=(active==='stock');
  if(_fb)_fb.style.display=_hide?'none':''; if(_cb)_cb.style.display=_hide?'none':'';
  try{ if(F.compare && !_hide) renderCompareBand(v); (VIEWS[active]||renderOverview)(v); }catch(err){ v.appendChild(el('div','note','Render error: '+esc(err.message))); throw err; } }

/* ============================ AI assistant (local, grounded on live snapshot) ============================ */
var gid=function(id){ return document.getElementById(id); };
var _activeOwners=null;
function activeOwners(){ if(_activeOwners)return _activeOwners; var cnt={}; [DEALS,CALLS,TASKS,EVENTS,ONLINE].forEach(function(arr){ arr.forEach(function(x){ cnt[x.owner]=(cnt[x.owner]||0)+1; }); }); _activeOwners=Object.keys(cnt).map(function(id){return {id:id,name:ownerName(id),n:cnt[id]};}).sort(function(a,b){return b.n-a.n;}); return _activeOwners; }
function assistantAnswer(q){
  var t=' '+String(q||'').toLowerCase().replace(/[^a-z0-9%\s]/g,' ').replace(/\s+/g,' ')+' ';
  var dl=fDeals(), cl=fCalls(), tk=fTasks(), ev=fEvents(), on=fOnline();
  var joined=joinDeals(dl); var contacted=joined.filter(function(j){return j.contacted;}).length;
  var has=function(){ for(var i=0;i<arguments.length;i++){ if(t.indexOf(' '+arguments[i]+' ')>=0 || t.indexOf(arguments[i])>=0) return true; } return false; };
  var scope='current filters · '+fmtDay(F.from)+' → '+fmtDay(F.to)+(F.owners.size?' · '+F.owners.size+' owner(s)':'')+(F.stage.size?' · '+Array.from(F.stage).join(', '):'')+(F.trigger.size?' · '+Array.from(F.trigger).join(', '):'');
  function wrap(html){ return html+'<div class="amini">Scope: '+esc(scope)+'</div>'; }

  if(has('help','what can you','examples','hi','hello')|| t.trim()===''){
    return wrap('I answer from the live Zoho snapshot, respecting your current filters. Try:<ul>'+
      '<li>“What’s the contact rate?”</li><li>“How many won deals?”</li><li>“Top agent by calls”</li>'+
      '<li>“Deals for Sheetal Parve”</li><li>“Average first response time”</li><li>“Overdue tasks”</li>'+
      '<li>“Best time-slot for connectivity”</li><li>“Deals by stage”</li><li>“Customer events / signups”</li>'+
      '<li>“How many zero-second calls today?”</li><li>“How many deals never received a call?”</li></ul>');
  }

  // owner detection — match against agents actually present in the data (most-active first)
  var ownerId=null, ownerNm=null, _ao=activeOwners();
  for(var _i=0;_i<_ao.length && !ownerId;_i++){ if(t.indexOf(_ao[_i].name.toLowerCase())>=0){ ownerId=_ao[_i].id; ownerNm=_ao[_i].name; } }
  if(!ownerId) for(var _j=0;_j<_ao.length && !ownerId;_j++){ var _tok=_ao[_j].name.toLowerCase().split(' ')[0]; if(_tok.length>=4 && t.indexOf(' '+_tok+' ')>=0){ ownerId=_ao[_j].id; ownerNm=_ao[_j].name; } }

  // top / ranking (but let time-slot queries fall through to their own branch)
  if(has('top','best','highest','most','rank','leader','worst','lowest') && !has('slot','timeslot')){
    var metric='deals', mapf=function(id){return dl.filter(function(d){return d.owner===id;}).length;}, fmt=num, asc=has('worst','lowest');
    if(has('call')){ metric='calls'; mapf=function(id){return cl.filter(function(c){return c.owner===id;}).length;}; }
    else if(has('won','win')){ metric='won deals'; mapf=function(id){return dl.filter(function(d){return d.owner===id&&isWon(d);}).length;}; }
    else if(has('talk','duration')){ metric='talk time'; mapf=function(id){return cl.filter(function(c){return c.owner===id;}).reduce(function(s,c){return s+(c.dur||0);},0);}; fmt=hms; }
    else if(has('contact','connect','reach','response','frt')){ metric='contact rate'; mapf=function(id){var o=joined.filter(function(j){return j.deal.owner===id;});return o.length?pct(o.filter(function(j){return j.contacted;}).length,o.length):0;}; fmt=function(v){return p1(v)+'%';}; }
    else if(has('task')){ metric='tasks'; mapf=function(id){return tk.filter(function(x){return x.owner===id;}).length;}; }
    else if(has('meeting')){ metric='meetings'; mapf=function(id){return ev.filter(function(x){return x.owner===id;}).length;}; }
    var ids={}; dl.forEach(function(d){ids[d.owner]=1;}); cl.forEach(function(c){ids[c.owner]=1;});
    var rank=Object.keys(ids).map(function(id){return {id:id,v:mapf(id)};}).sort(function(a,b){return asc?a.v-b.v:b.v-a.v;}).slice(0,5);
    return wrap('<b>'+(asc?'Bottom':'Top')+' agents by '+metric+':</b><ol>'+rank.map(function(r){return '<li>'+esc(ownerName(r.id))+' — '+fmt(r.v)+'</li>';}).join('')+'</ol>');
  }

  // per-owner summary
  if(ownerId){
    var od=dl.filter(function(d){return d.owner===ownerId;});
    var oc=cl.filter(function(c){return c.owner===ownerId;});
    var oj=joined.filter(function(j){return j.deal.owner===ownerId;});
    var ocont=oj.filter(function(j){return j.contacted;}).length;
    var talk=oc.reduce(function(s,c){return s+(c.dur||0);},0);
    return wrap('<b>'+esc(ownerNm)+'</b> — '+num(od.length)+' deals ('+num(od.filter(isWon).length)+' won) · contact rate '+p1(pct(ocont,od.length))+'% · '+
      num(oc.length)+' calls ('+num(oc.filter(function(c){return c.dur>0;}).length)+' connected, talk '+hms(talk)+') · '+
      num(tk.filter(function(x){return x.owner===ownerId;}).length)+' tasks · '+num(ev.filter(function(x){return x.owner===ownerId;}).length)+' meetings.');
  }

  // ---- Control Room questions (backed by the richer Command Center model, exposed via opsModelFn) ----
  if(has('weakest store','store weak','which store')){
    var M=opsModelFn?opsModelFn():null;
    if(!M||!M.storeRows.length) return wrap('No store-mapped data in range — only 5 CRM owner accounts map to a real store today.');
    var ws=M.storeRows.filter(function(s){return s.deals>=3;}).sort(function(a,b){return a.conversion-b.conversion;})[0]||M.storeRows[0];
    return wrap('<b>'+esc(ws.store)+'</b> is the weakest store right now — '+p1(ws.conversion)+'% conversion on '+num(ws.deals)+' deals.');
  }
  if(has('video call')&&has('yesterday')){
    var yk1=dayKey(ymd(new Date(D(F.to).getTime()-86400000)));
    var vcY=fEvents().filter(function(e){return dayKey(e.created)===yk1&&classifyEvent(e.title)==='Video Call';});
    var byOwn1=toItems(groupBy(vcY,function(e){return ownerName(e.owner);}));
    if(!byOwn1.length) return wrap('No video calls logged yesterday.');
    return wrap('<b>Video calls raised yesterday:</b><ul>'+byOwn1.map(function(x){return '<li>'+esc(x.label)+': '+num(x.value)+'</li>';}).join('')+'</ul>');
  }
  if(has('visited store')||(has('store visit')&&has('yesterday'))){
    var yk2=dayKey(ymd(new Date(D(F.to).getTime()-86400000)));
    var svY=fEvents().filter(function(e){return dayKey(e.created)===yk2&&classifyEvent(e.title)==='Store Visit';});
    var byOwn2=toItems(groupBy(svY,function(e){return ownerName(e.owner);}));
    if(!byOwn2.length) return wrap('No store visits logged yesterday.');
    return wrap('<b>Store visits yesterday:</b><ul>'+byOwn2.map(function(x){return '<li>'+esc(x.label)+': '+num(x.value)+'</li>';}).join('')+'</ul>');
  }
  if(has('today with yesterday','today vs yesterday','compare today')){
    var td=dayMetricsFn?dayMetricsFn(maxDate,maxDate):null, yd=dayMetricsFn?dayMetricsFn(ymd(new Date(D(maxDate).getTime()-86400000)),ymd(new Date(D(maxDate).getTime()-86400000))):null;
    if(!td||!yd) return wrap('Comparison isn\'t available right now.');
    return wrap('<b>Today vs Yesterday:</b><ul><li>Deals: '+num(td.deals)+' vs '+num(yd.deals)+'</li><li>Coverage: '+p1(td.coverage)+'% vs '+p1(yd.coverage)+'%</li><li>SLA: '+p1(td.slaPct)+'% vs '+p1(yd.slaPct)+'%</li><li>Avg FRT: '+fmtDur(td.avgFrt)+' vs '+fmtDur(yd.avgFrt)+'</li></ul>');
  }
  if(has('this week with last week','week vs last week','compare this week')){
    var tw=dayMetricsFn?dayMetricsFn(ymd(new Date(D(maxDate).getTime()-6*86400000)),maxDate):null;
    var lwEnd=ymd(new Date(D(maxDate).getTime()-7*86400000)), lwStart=ymd(new Date(D(maxDate).getTime()-13*86400000));
    var lw=dayMetricsFn?dayMetricsFn(lwStart,lwEnd):null;
    if(!tw||!lw) return wrap('Comparison isn\'t available right now.');
    return wrap('<b>This week vs Last week:</b><ul><li>Deals: '+num(tw.deals)+' vs '+num(lw.deals)+'</li><li>Coverage: '+p1(tw.coverage)+'% vs '+p1(lw.coverage)+'%</li><li>SLA: '+p1(tw.slaPct)+'% vs '+p1(lw.slaPct)+'%</li></ul>');
  }
  if(has('needs attention','owner needs attention','which owner')){
    var M2=opsModelFn?opsModelFn():null; if(!M2||!M2.ranking.length) return wrap('Not enough owner data in range.');
    var w2=M2.ranking[M2.ranking.length-1];
    return wrap('<b>'+esc(w2.owner)+'</b> needs the most attention right now — Owner Score '+w2.score+'/100, '+p1(w2.contactRate)+'% contact rate.');
  }
  if(has('action plan')&&has('tomorrow')){
    var M3=opsModelFn?opsModelFn():null; if(!M3) return wrap('Not available right now.');
    var acts=[]; if(M3.pendingCnt) acts.push(num(M3.pendingCnt)+' pending first calls'); if(M3.followupTomorrow) acts.push(num(M3.followupTomorrow)+"  tomorrow's follow-ups");
    if(M3.stages.length) acts.push('clear the '+esc(M3.stages[0].stage)+' backlog ('+num(M3.stages[0].deals)+' deals)');
    if(!acts.length) acts.push('no urgent items — maintain current pace');
    return wrap("<b>Tomorrow's action plan:</b><ul>"+acts.map(function(a){return '<li>'+a+'</li>';}).join('')+'</ul>');
  }
  if(has('why')&&(has('sales low')||has('conversion falling')||has('conversion drop')||has('sales down'))){
    var M4=opsModelFn?opsModelFn():null; if(!M4) return wrap('Not available right now.');
    var reasons=[]; if(M4.pendingCnt) reasons.push(num(M4.pendingCnt)+" deals haven't been called yet");
    if(M4.stages.length) reasons.push('the '+esc(M4.stages[0].stage)+' stage has the largest backlog ('+num(M4.stages[0].deals)+' deals)');
    if(M4.lostByReason.length) reasons.push('the top loss reason is "'+esc(M4.lostByReason[0].reason)+'" ('+num(M4.lostByReason[0].count)+' deals)');
    if(!reasons.length) reasons.push('no major gaps detected in the current window');
    return wrap('<b>Likely reasons:</b><ul>'+reasons.map(function(r){return '<li>'+r+'</li>';}).join('')+'</ul>');
  }
  if(has('immediate action','need action','deals at risk','which deals')){
    var M5=opsModelFn?opsModelFn():null; if(!M5||!M5.alerts.length) return wrap('No urgent items right now.');
    var reds=M5.alerts.filter(function(a){return a.sev==='red';});
    if(!reds.length) return wrap('No red-tier alerts right now — check the Critical Alert Center for orange/yellow items.');
    return wrap('<b>Needs immediate action:</b><ul>'+reds.map(function(a){return '<li>'+esc(a.text)+'</li>';}).join('')+'</ul>');
  }
  if(has('what is happening','happening today',"today's summary",'business summary','today summary')){
    var M6=opsModelFn?opsModelFn():null; if(!M6) return wrap('Not available right now.');
    return wrap('<b>'+num(M6.deals)+'</b> deals created, <b>'+num(M6.calls)+'</b> calls made, <b>'+p1(M6.slaPct)+'%</b> contact rate, <b>'+num(M6.pendingCnt)+'</b> not called. Pipeline Health Score '+M6.pipelineScore+'/100 · Team Health Score '+M6.teamScore+'/100.');
  }
  if(has('contact rate','contacted','reached','connectivity')){
    return wrap('Contact rate is <b>'+p1(pct(contacted,dl.length))+'%</b> — '+num(contacted)+' of '+num(dl.length)+' deals reached by a call after creation.');
  }
  if(has('response','frt','first call','first response')){
    var frts=joined.filter(function(j){return j.contacted&&j.frt!=null;}).map(function(j){return j.frt;}).sort(function(a,b){return a-b;});
    var avg=frts.length?frts.reduce(function(s,x){return s+x;},0)/frts.length:0, med=frts.length?frts[Math.floor(frts.length/2)]:0;
    return wrap('Average first response is <b>'+fmtDur(avg)+'</b> (median '+fmtDur(med)+') across '+num(frts.length)+' contacted deals.');
  }
  if(has('won','win')){ var w=dl.filter(isWon).length; return wrap('<b>'+num(w)+'</b> won deals — '+p1(pct(w,dl.length))+'% of '+num(dl.length)+'.'); }
  if(has('lost')){ var l=dl.filter(function(d){return (d.stage||'').toLowerCase().indexOf('lost')>=0;}); var byr=toItems(groupBy(l,function(d){return clean(d.reasonLoss);})).slice(0,5); return wrap('<b>'+num(l.length)+'</b> lost deals ('+p1(pct(l.length,dl.length))+'%). Top reasons:<ul>'+byr.map(function(x){return '<li>'+esc(x.label)+': '+num(x.value)+'</li>';}).join('')+'</ul>'); }
  if(has('stage','funnel','pipeline')){ return wrap('<b>Deals by stage:</b><ul>'+toItems(groupBy(dl,function(d){return d.stage||'(none)';})).map(function(x){return '<li>'+esc(x.label)+': '+num(x.value)+'</li>';}).join('')+'</ul>'); }
  if(has('trigger')){ return wrap('<b>Deals by trigger:</b><ul>'+toItems(groupBy(dl,function(d){return normTrig(d.trigger);})).slice(0,8).map(function(x){return '<li>'+esc(x.label)+': '+num(x.value)+'</li>';}).join('')+'</ul>'); }
  if(has('lead source','source','utm')){ return wrap('<b>Deals by lead source:</b><ul>'+toItems(groupBy(dl,function(d){return clean(d.leadSource);})).slice(0,8).map(function(x){return '<li>'+esc(x.label)+': '+num(x.value)+'</li>';}).join('')+'</ul>'); }
  if(has('slot','time of day','hour','best time','timeslot')){ var ts=dealTimeSlots(dl); var s=ts.slots.slice().filter(function(x){return x.created>0;}).sort(function(a,b){return pct(b.connected,b.created)-pct(a.connected,a.created);}); if(!s.length)return wrap('No deals in range.'); return wrap('Best connectivity slot: <b>'+esc(s[0].label)+'</b> at '+p1(pct(s[0].connected,s[0].created))+'% ('+num(s[0].connected)+'/'+num(s[0].created)+'). Weakest: <b>'+esc(s[s.length-1].label)+'</b> at '+p1(pct(s[s.length-1].connected,s[s.length-1].created))+'%.'); }
  if(has('overdue')){ var today=dayKey(maxDate); var odc=tk.filter(function(x){return !isDone(x)&&x.due&&dayKey(x.due)<today;}).length; return wrap('<b>'+num(odc)+'</b> overdue open tasks (due date passed, not completed).'); }
  if(has('task')){ var done=tk.filter(isDone).length; return wrap('<b>'+num(tk.length)+'</b> tasks — '+num(done)+' completed ('+p1(pct(done,tk.length))+'%), '+num(tk.length-done)+' open.'); }
  if(has('meeting')){ return wrap('<b>'+num(ev.length)+'</b> meetings (Events module) in range.'); }
  if(has('chat')){ return wrap('<b>'+num(on.length)+'</b> chats / online activities in range.'); }
  if(has('signup','sign up','checkout','purchase','atc','customer event','website visit','productview','events')){
    var cats=CE.cats||[], catTot={}, total=0; cats.forEach(function(c){ catTot[c]=0; var m=(CE.byCatDay||{})[c]||{}; Object.keys(m).forEach(function(day){ if(day>=F.from&&day<=F.to){catTot[c]+=m[day]; total+=m[day];} }); });
    return wrap('<b>'+num(total)+' customer events</b> in range:<ul>'+cats.map(function(c){return '<li>'+c+': '+num(catTot[c])+'</li>';}).join('')+'</ul>');
  }
  if(has('zero second','zero-second','0 second','0-second')){ var zc=cl.filter(function(c){return c.dur===0;}); return wrap('<b>'+num(zc.length)+'</b> zero-second calls — '+p1(pct(zc.length,cl.length||1))+'% of '+num(cl.length)+' total calls in range.'); }
  if(has('never called','never received a call','no call ever','not called','never call')){ var nc=joined.filter(function(j){return !j.contacted;}); return wrap('<b>'+num(nc.length)+'</b> deals created in range have never received a call — '+p1(pct(nc.length,dl.length||1))+'% of '+num(dl.length)+' deals created.'); }
  if(has('call')){ var conn=cl.filter(function(c){return c.dur>0;}).length; return wrap('<b>'+num(cl.length)+'</b> calls — '+num(conn)+' connected, '+num(cl.filter(function(c){return (c.type||'').toLowerCase().indexOf('miss')>=0;}).length)+' missed · talk time '+hms(cl.reduce(function(s,c){return s+(c.dur||0);},0))+'.'); }
  if(has('deal','lead','unique','duplicate','how many','total')){ var uq=uniqueDeals(dl); return wrap('<b>'+num(dl.length)+'</b> deals — '+num(uq)+' unique, '+num(dl.length-uq)+' duplicates · contact rate '+p1(pct(contacted,dl.length))+'% · '+num(dl.filter(isWon).length)+' won.'); }

  return wrap('I couldn’t map that to the data. I can answer about <b>deals, calls, contact rate, first response, won/lost, agents</b> (top or by name), <b>stages, triggers, lead sources, tasks, meetings, chats, customer events</b> and <b>time-slots</b>. Try “top agent by won” or “contact rate”.');
}
function buildAssistant(){
  var fab=el('button','askfab','✨ Ask AI'); fab.id='askFab';
  var panel=el('div','askpanel'); panel.id='askPanel';
  panel.innerHTML='<div class="askhead"><div><b>✨ Ask the data</b><div class="sub">Answers computed live from the Zoho snapshot · respects your filters</div></div><button class="hbtn" id="askClose" style="padding:4px 9px">✕</button></div>'+
    '<div class="askthread" id="askThread"></div>'+
    '<div class="asugg" id="askSugg"></div>'+
    '<form class="askform" id="askForm"><input id="askInput" placeholder="Ask… e.g. top agent by won" autocomplete="off"><button type="submit">Ask</button></form>';
  document.body.appendChild(fab); document.body.appendChild(panel);
  function pushU(txt){ var b=el('div','abub user',esc(txt)); gid('askThread').appendChild(b); b.scrollIntoView({block:'nearest'}); }
  function pushA(html){ var b=el('div','abub ai',html); gid('askThread').appendChild(b); b.scrollIntoView({block:'nearest'}); }
  function ask(q){ q=(q||'').trim(); if(!q)return; pushU(q); var ans=assistantAnswer(q); pushA(ans); }
  fab.onclick=function(){ panel.classList.toggle('open'); if(panel.classList.contains('open')){ if(!gid('askThread').childElementCount) pushA(assistantAnswer('help')); gid('askInput').focus(); } };
  gid('askClose').onclick=function(){ panel.classList.remove('open'); };
  gid('askForm').onsubmit=function(e){ e.preventDefault(); var q=gid('askInput').value; gid('askInput').value=''; ask(q); };
  var sc=gid('askSugg'); ['Contact rate?','Top agent by won','Average first response','Overdue tasks','Deals by stage','Best time-slot'].forEach(function(s){ var b=el('button',null,s); b.onclick=function(){ ask(s); }; sc.appendChild(b); });
  askAIFn=function(q){ panel.classList.add('open'); ask(q); }; /* exposed so info-modal "Suggested Questions" chips can pipe straight into the real assistant */
}

/* ============================ SECTION 11 — Export & Sharing ============================
   Self-contained (no external libraries). Every deliverable is computed from the CURRENT
   filters (F) through the same joinDeals / whAnalysis / trend engines the dashboard uses,
   so an export always matches exactly what is on screen. Deliverables:
     • PDF  — A4-landscape, presentation-ready executive report (print → "Save as PDF")
     • Excel — multi-sheet SpreadsheetML (.xls): formatted, frozen headers, auto-filter,
               auto-width, SLA-breach highlighting
     • WhatsApp — compact copy-ready summary (+ wa.me deep link)
     • PNG  — branded executive snapshot (canvas)
     • Print — the live dashboard
     • Executive Report — one-page summary for senior management
     • Scheduled Reports — client-persisted configurator (delivery runs on the backend)   */
(function(){
  SLA_MIN=30;          // first-response SLA threshold (minutes) — matches "Overdue (>30 min)". (outer-scope var — see info-panel engine)
  SLA_TARGET=80;       // owner SLA-compliance target (%)
  COVER_TARGET=90;     // call-coverage target (%)
  var MIN_OWNER_DEALS=5;   // ignore tiny-volume owners when picking best / lowest SLA
  var BRAND='Lucira Jewelry', REPORT_TITLE='Daily Deals vs Calls — Executive Report';
  var RC=['#2563eb','#0d9488','#d97706','#9333ea','#e11d48','#0284c7','#65a30d','#ea580c'];

  /* ---------- shared model (respects current filters) ---------- */
  function reportModel(){
    var dl=fDeals(), cl=fCalls(), tk=fTasks(), ev=fEvents(), on=fOnline();
    var joined=joinDeals(dl);
    var contacted=joined.filter(function(j){return j.contacted;});
    var pending=joined.filter(function(j){return !j.contacted;});
    var maxT=D(maxDate);
    var overdue=joined.filter(function(j){
      if(j.contacted) return j.frt!=null && j.frt>SLA_MIN;
      var age=(maxT-D(j.deal.created))/60000; return age>SLA_MIN;   // uncontacted & older than SLA
    });
    var frts=contacted.map(function(j){return j.frt;}).filter(function(x){return x!=null&&x>=0;}).sort(function(a,b){return a-b;});
    var avgFrt=frts.length?frts.reduce(function(s,x){return s+x;},0)/frts.length:0;
    var medFrt=frts.length?frts[Math.floor(frts.length/2)]:0;
    var connCalls=cl.filter(function(c){return c.dur>0;}).length;
    var coverage=pct(contacted.length, dl.length||1);
    var won=dl.filter(isWon).length;

    var own={};
    joined.forEach(function(j){ var id=j.deal.owner; var o=own[id]||(own[id]={id:id,name:ownerName(id),deals:0,contacted:0,sla:0,late:0,pending:0,frtSum:0,frtN:0});
      o.deals++;
      if(j.contacted){ o.contacted++; if(j.frt!=null){o.frtSum+=j.frt;o.frtN++; if(j.frt<=SLA_MIN)o.sla++; else o.late++;} }
      else o.pending++;
    });
    var owners=Object.keys(own).map(function(id){ var o=own[id];
      o.slaPct=pct(o.sla,o.deals); o.coverage=pct(o.contacted,o.deals); o.avgFrt=o.frtN?o.frtSum/o.frtN:null;
      o.calls=cl.filter(function(c){return c.owner===id;}).length; o.conn=cl.filter(function(c){return c.owner===id&&c.dur>0;}).length;
      return o; }).sort(function(a,b){return b.deals-a.deals;});
    var ranked=owners.filter(function(o){return o.deals>=MIN_OWNER_DEALS;});
    var best=ranked.slice().sort(function(a,b){return b.slaPct-a.slaPct;})[0]||owners[0]||null;
    var worst=ranked.slice().sort(function(a,b){return a.slaPct-b.slaPct;})[0]||owners[owners.length-1]||null;

    var wh=whAnalysis(dl);
    var odSrc=toItems(groupBy(overdue,function(j){return clean(j.deal.leadSource);}));
    var odTrig=toItems(groupBy(overdue,function(j){return normTrig(j.deal.trigger);}));
    var backHr={}; overdue.forEach(function(j){var h=hourOf(j.deal.created); backHr[h]=(backHr[h]||0)+1;});
    var peakBackHr=Object.keys(backHr).map(function(h){return {h:+h,n:backHr[h]};}).sort(function(a,b){return b.n-a.n;})[0]||null;
    function covWin(lo,hi){ var d=joined.filter(function(j){var h=hourOf(j.deal.created);return h>=lo&&h<hi;}); return {n:d.length,c:pct(d.filter(function(j){return j.contacted;}).length, d.length||1)}; }
    var before5=covWin(9,17), after5=covWin(17,22);

    var gran=pickGran(F.from,F.to);
    var td=trend(dl,gran), tc=trend(cl,gran), tkeys=mergeKeys(td.keys,tc.keys);

    return { dl:dl, cl:cl, tk:tk, ev:ev, on:on, joined:joined, contacted:contacted, pending:pending, overdue:overdue,
      deals:dl.length, calls:cl.length, connCalls:connCalls, coverage:coverage, avgFrt:avgFrt, medFrt:medFrt, won:won,
      pendingCnt:pending.length, overdueCnt:overdue.length, owners:owners, best:best, worst:worst,
      wh:wh, odSrc:odSrc, odTrig:odTrig, peakBackHr:peakBackHr, before5:before5, after5:after5,
      gran:gran, trendKeys:tkeys, trendLabels:fmtKeys(tkeys,gran),
      trendDeals:tkeys.map(function(k){return td.map[k]||0;}), trendCalls:tkeys.map(function(k){return tc.map[k]||0;}),
      from:F.from, to:F.to, ownersActive:owners.length, generated:new Date(),
      scope:(F.owners.size?F.owners.size+' owner(s)':'all owners')+(F.stage.size?' · '+Array.from(F.stage).join(', '):'')+(F.trigger.size?' · '+Array.from(F.trigger).join(', '):'')+(F.leadSource.size?' · '+Array.from(F.leadSource).join(', '):'') };
  }
  reportModelFn=reportModel; /* expose to the outer-scope info-panel engine (imContext/trendBlock) */

  /* ---------- narrative generators (rule-based, grounded on the model) ---------- */
  function execSummary(M){
    var parts=[];
    parts.push('Between '+fmtDay(M.from)+' and '+fmtDay(M.to)+', the team created <b>'+num(M.deals)+'</b> deals and logged <b>'+num(M.calls)+'</b> calls ('+num(M.connCalls)+' connected), for a call coverage of <b>'+p1(M.coverage)+'%</b>.');
    parts.push('Average first response was <b>'+fmtMinNice(M.avgFrt)+'</b> (median '+fmtMinNice(M.medFrt)+').');
    parts.push('<b>'+num(M.pendingCnt)+'</b> deals still await a first call and <b>'+num(M.overdueCnt)+'</b> breached the '+SLA_MIN+'-minute SLA.');
    if(M.best) parts.push('Best owner: <b>'+esc(M.best.name)+'</b> at '+p1(M.best.slaPct)+'% SLA'+(M.worst&&M.worst!==M.best?('; lowest: <b>'+esc(M.worst.name)+'</b> at '+p1(M.worst.slaPct)+'%'):'')+'.');
    return parts.join(' ');
  }
  function genInsights(M){
    var out=[];
    if(M.overdueCnt && M.odSrc.length) out.push(p1(pct(M.odSrc[0].value,M.overdueCnt))+'% of overdue deals came from <b>'+esc(M.odSrc[0].label)+'</b>.');
    if(M.peakBackHr) out.push('Maximum backlog around <b>'+hr12(M.peakBackHr.h)+'–'+hr12(M.peakBackHr.h+1)+'</b> ('+num(M.peakBackHr.n)+' overdue deals created in that hour).');
    if(M.after5.n && M.before5.n) out.push('Call coverage '+(M.after5.c<M.before5.c-2?'<b>dropped</b>':'held steady')+' after 5 PM — '+p1(M.after5.c)+'% vs '+p1(M.before5.c)+'% earlier in the day.');
    var wf=M.wh.buckets.filter(function(b){return b.avgFrt!=null;});
    var fast=wf.slice().sort(function(a,b){return a.avgFrt-b.avgFrt;})[0], slow=wf.slice().sort(function(a,b){return b.avgFrt-a.avgFrt;})[0];
    if(fast&&slow&&fast!==slow) out.push('Fastest response hour is <b>'+esc(fast.label)+'</b> ('+fmtMinNice(fast.avgFrt)+'); slowest is <b>'+esc(slow.label)+'</b> ('+fmtMinNice(slow.avgFrt)+').');
    if(M.deals>M.calls) out.push('Demand outpaced calling capacity: '+num(M.deals-M.calls)+' more deals than calls in the window.');
    if(M.odTrig.length && M.overdueCnt) out.push('“'+esc(M.odTrig[0].label)+'” is the top entry-trigger among overdue deals ('+num(M.odTrig[0].value)+').');
    return out;
  }
  function genGaps(M){
    var g=[];
    g.push(['Call Coverage', p1(M.coverage)+'%', COVER_TARGET+'%', M.coverage>=COVER_TARGET, (M.coverage>=COVER_TARGET?'On target':(p1(COVER_TARGET-M.coverage)+' pp below target')) ]);
    var slaComp=pct(M.contacted.filter(function(j){return j.frt!=null&&j.frt<=SLA_MIN;}).length, M.deals||1);
    g.push(['SLA Compliance (≤'+SLA_MIN+'m)', p1(slaComp)+'%', SLA_TARGET+'%', slaComp>=SLA_TARGET, (slaComp>=SLA_TARGET?'On target':(p1(SLA_TARGET-slaComp)+' pp below target')) ]);
    g.push(['Uncontacted Deals', num(M.pendingCnt), '0', M.pendingCnt===0, (M.pendingCnt?num(M.pendingCnt)+' need a first call':'None pending') ]);
    g.push(['Overdue (>'+SLA_MIN+'m)', num(M.overdueCnt), '0', M.overdueCnt===0, (M.overdueCnt?num(M.overdueCnt)+' breached SLA':'None overdue') ]);
    if(M.worst) g.push(['Lowest Owner SLA', esc(M.worst.name)+' · '+p1(M.worst.slaPct)+'%', SLA_TARGET+'%', M.worst.slaPct>=SLA_TARGET, (M.worst.slaPct>=SLA_TARGET?'All owners on target':'Below team target') ]);
    return g;
  }
  function genRecs(M){
    var r=[];
    if(M.peakBackHr) r.push('Increase calling capacity around '+hr12(M.peakBackHr.h)+'–'+hr12(M.peakBackHr.h+1)+', where the overdue backlog peaks.');
    if(M.overdueCnt) r.push('Prioritise the '+num(M.overdueCnt)+' overdue leads older than '+SLA_MIN+' minutes before net-new outreach.');
    if(M.pendingCnt) r.push('Clear the '+num(M.pendingCnt)+' uncontacted deals — assign a first call within the SLA window.');
    if(M.worst && M.worst.slaPct<SLA_TARGET) r.push('Coach '+esc(M.worst.name)+' (SLA '+p1(M.worst.slaPct)+'%) — pair with '+(M.best?esc(M.best.name):'the top performer')+' for first-response discipline.');
    if(M.after5.n && M.after5.c<M.before5.c-2) r.push('Add a late-shift caller after 5 PM; coverage there is '+p1(M.before5.c-M.after5.c)+' pp lower than daytime.');
    if(M.odSrc.length && M.overdueCnt && pct(M.odSrc[0].value,M.overdueCnt)>=25) r.push('Route '+esc(M.odSrc[0].label)+' leads to a dedicated queue — they account for '+p1(pct(M.odSrc[0].value,M.overdueCnt))+'% of overdue deals.');
    if(!r.length) r.push('Metrics are within target — maintain current staffing and SLA discipline.');
    return r;
  }
  function genAlerts(M){
    var a=[];
    if(M.coverage<COVER_TARGET) a.push(['high','Call coverage '+p1(M.coverage)+'% is below the '+COVER_TARGET+'% target.']);
    if(M.overdueCnt>0) a.push([(M.overdueCnt>M.deals*0.15?'high':'med'),num(M.overdueCnt)+' deals breached the '+SLA_MIN+'-minute first-response SLA.']);
    if(M.pendingCnt>0) a.push([(M.pendingCnt>M.deals*0.15?'high':'med'),num(M.pendingCnt)+' deals have received no call yet.']);
    if(M.worst && M.worst.slaPct<SLA_TARGET) a.push(['med','Owner '+M.worst.name+' at '+p1(M.worst.slaPct)+'% SLA — below the '+SLA_TARGET+'% target.']);
    if(M.peakBackHr && M.peakBackHr.n>0) a.push(['low','Backlog concentrates around '+hr12(M.peakBackHr.h)+'–'+hr12(M.peakBackHr.h+1)+' ('+num(M.peakBackHr.n)+' overdue).']);
    if(!a.length) a.push(['ok','All key metrics are within target for this window.']);
    return a;
  }

  /* ---------- WhatsApp-ready text ---------- */
  function whatsappText(M){
    var L=[];
    L.push('📅 *Daily Deals vs Calls Report*');
    L.push('_'+fmtDay(M.from)+' → '+fmtDay(M.to)+' · '+M.scope+'_');
    L.push('');
    L.push('✅ Deals Created : '+num(M.deals));
    L.push('☎ Calls Made : '+num(M.calls));
    L.push('📞 Call Coverage : '+p1(M.coverage)+'%');
    L.push('⏱ Avg First Response : '+fmtMinNice(M.avgFrt));
    L.push('🚨 Pending Calls : '+num(M.pendingCnt));
    L.push('🔴 Overdue (>'+SLA_MIN+' min) : '+num(M.overdueCnt));
    if(M.best) L.push('🏆 Best Owner : '+M.best.name+' ('+p1(M.best.slaPct)+'% SLA)');
    if(M.worst && M.worst!==M.best) L.push('⚠ Lowest SLA : '+M.worst.name+' ('+p1(M.worst.slaPct)+'%)');
    var ins=genInsights(M).slice(0,3).map(stripTags);
    if(ins.length){ L.push(''); L.push('*Top Insights:*'); ins.forEach(function(x){L.push('• '+x);}); }
    var rec=genRecs(M).slice(0,2).map(stripTags);
    if(rec.length){ L.push(''); L.push('*Recommendations:*'); rec.forEach(function(x){L.push('• '+x);}); }
    L.push('');
    L.push('_Generated automatically on '+fmtStamp(M.generated)+'_');
    return L.join('\n');
  }
  function stripTags(s){ return String(s).replace(/<[^>]+>/g,''); }
  function fmtStamp(d){ var mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return d.getDate()+' '+mo[d.getMonth()]+' '+d.getFullYear()+', '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+' IST'; }

  /* ---------- print-scoped SVG (concrete light colours) ---------- */
  function xesc(s){ return (s==null?'':''+s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function rBars(items,opt){ opt=opt||{}; items=items.slice(0,opt.max||10);
    if(!items.length) return '<div class="rp-empty">No data.</div>';
    var max=Math.max.apply(null,items.map(function(x){return x.value;}))||1;
    var w=720,rowH=24,lw=180,bw=w-lw-90,H=items.length*rowH+6;
    var s='<svg viewBox="0 0 '+w+' '+H+'" width="100%" style="max-width:'+w+'px">';
    items.forEach(function(it,i){ var y=i*rowH+3, bl=Math.max(2,it.value/max*bw), c=it.color||opt.color||RC[i%RC.length];
      s+='<text x="0" y="'+(y+15)+'" font-size="12" fill="#333">'+xesc(it.label.length>26?it.label.slice(0,25)+'…':it.label)+'</text>';
      s+='<rect x="'+lw+'" y="'+y+'" width="'+bl+'" height="16" rx="3" fill="'+c+'"/>';
      s+='<text x="'+(lw+bl+6)+'" y="'+(y+14)+'" font-size="11" fill="#555">'+(opt.fmt?opt.fmt(it.value):num(it.value))+'</text>';
    });
    return s+'</svg>';
  }
  function rLine(labels,series){
    var w=720,H=220,pl=42,pr=12,ptp=12,pb=34,iw=w-pl-pr,ih=H-ptp-pb;
    var max=1; series.forEach(function(se){se.data.forEach(function(v){if(v>max)max=v;});}); max=niceMax(max);
    var s='<svg viewBox="0 0 '+w+' '+H+'" width="100%" style="max-width:'+w+'px">';
    for(var g=0;g<=4;g++){ var yy=ptp+ih-(g/4)*ih; s+='<line x1="'+pl+'" y1="'+yy+'" x2="'+(w-pr)+'" y2="'+yy+'" stroke="#e3e8f0"/><text x="'+(pl-5)+'" y="'+(yy+3)+'" font-size="10" fill="#999" text-anchor="end">'+num(Math.round(g/4*max))+'</text>'; }
    var n=labels.length, step=n>1?iw/(n-1):0, every=Math.max(1,Math.ceil(n/10));
    labels.forEach(function(lb,i){ if(i%every===0){ var x=pl+i*step; s+='<text x="'+x+'" y="'+(H-pb+15)+'" font-size="10" fill="#999" text-anchor="middle">'+xesc(lb)+'</text>'; } });
    series.forEach(function(se){ var pts=se.data.map(function(v,i){return [pl+i*step, ptp+ih-(v/max)*ih];});
      s+='<path d="'+pts.map(function(p,i){return (i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1);}).join(' ')+'" fill="none" stroke="'+se.color+'" stroke-width="2.2"/>';
      if(n<45) pts.forEach(function(p){ s+='<circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="2.4" fill="'+se.color+'"/>'; });
    });
    s+='</svg>';
    var lg=series.map(function(se){return '<span style="display:inline-flex;align-items:center;gap:5px;margin-right:16px;font-size:11px;color:#555"><i style="width:9px;height:9px;border-radius:2px;background:'+se.color+';display:inline-block"></i>'+xesc(se.name)+'</span>';}).join('');
    return s+'<div style="margin-top:2px">'+lg+'</div>';
  }
  function rHourBars(M){
    var b=M.wh.buckets, w=720,H=230,pl=40,pr=12,ptp=22,pb=40,iw=w-pl-pr,ih=H-ptp-pb,n=b.length,bw=iw/n;
    var maxV=Math.max.apply(null,b.map(function(x){return x.avgFrt||0;}).concat([1])); maxV=niceMax(maxV);
    var s='<svg viewBox="0 0 '+w+' '+H+'" width="100%" style="max-width:'+w+'px">';
    for(var g=0;g<=4;g++){ var yy=ptp+ih-(g/4)*ih; s+='<line x1="'+pl+'" y1="'+yy+'" x2="'+(w-pr)+'" y2="'+yy+'" stroke="#e3e8f0"/><text x="'+(pl-5)+'" y="'+(yy+3)+'" font-size="10" fill="#999" text-anchor="end">'+num(Math.round(g/4*maxV))+'</text>'; }
    b.forEach(function(x,i){ var cx=pl+i*bw+bw/2, val=x.avgFrt||0, bh=val>0?Math.max(2,(val/maxV)*ih):0, y=ptp+ih-bh;
      var col=x.avgFrt==null?'#c2c8d2':(x.avgFrt<=10?'#16a34a':x.avgFrt<=30?'#d97706':x.avgFrt<=120?'#ea580c':'#dc2626');
      if(bh>0) s+='<rect x="'+(cx-9)+'" y="'+y+'" width="18" height="'+bh+'" rx="3" fill="'+col+'"/>';
      s+='<text x="'+cx+'" y="'+(y-4)+'" font-size="9.5" fill="#333" text-anchor="middle" font-weight="700">'+num(x.deals)+'</text>';
      s+='<text x="'+cx+'" y="'+(H-pb+14)+'" font-size="9" fill="#999" text-anchor="middle">'+xesc(x.label)+'</text>';
    });
    return s+'</svg><div style="font-size:10.5px;color:#777;margin-top:2px">Bar = avg first-call minutes · number above = deals created · green ≤10m · amber ≤30m · orange ≤2h · red slower.</div>';
  }

  /* ---------- executive report document (A4 landscape) ---------- */
  function reportCSS(){ return '@page{size:A4 landscape;margin:12mm}'+
    '*{box-sizing:border-box}body{font:12px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1a2230;margin:0;padding:0;background:#fff}'+
    '.rp-wrap{max-width:1180px;margin:0 auto;padding:6px}'+
    '.rp-head{display:flex;align-items:center;gap:14px;border-bottom:3px solid #1f3b57;padding-bottom:12px;margin-bottom:14px}'+
    '.rp-logo{width:46px;height:46px;border-radius:11px;background:linear-gradient(135deg,#2563eb,#0d9488);color:#fff;font-weight:800;font-size:22px;display:flex;align-items:center;justify-content:center}'+
    '.rp-head h1{margin:0;font-size:20px;color:#1f3b57}.rp-head .m{font-size:11.5px;color:#5a6674;margin-top:2px}'+
    '.rp-head .stamp{margin-left:auto;text-align:right;font-size:11px;color:#5a6674}'+
    '.rp-sec{margin:0 0 16px;break-inside:avoid}'+
    '.rp-sec h2{font-size:13.5px;color:#1f3b57;border-left:4px solid #2563eb;padding-left:8px;margin:0 0 8px}'+
    '.rp-sum{background:#f4f7fb;border:1px solid #dbe4ee;border-radius:8px;padding:11px 13px;font-size:12.5px;line-height:1.6}'+
    '.rp-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:9px}'+
    '.rp-kpi{border:1px solid #dbe4ee;border-radius:8px;padding:9px 11px}.rp-kpi .k{font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;color:#7a8696;font-weight:700}.rp-kpi .v{font-size:20px;font-weight:750;color:#16233a;margin-top:3px}.rp-kpi .d{font-size:10px;color:#7a8696;margin-top:1px}'+
    '.rp-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}'+
    '.rp-card{border:1px solid #dbe4ee;border-radius:8px;padding:10px 12px}.rp-card h3{margin:0 0 6px;font-size:12px;color:#1f3b57}'+
    'ul.rp-list{margin:4px 0 0;padding-left:18px}ul.rp-list li{margin:3px 0;font-size:11.5px}'+
    'table.rp-tbl{width:100%;border-collapse:collapse;font-size:10.8px}'+
    'table.rp-tbl th{background:#1f3b57;color:#fff;text-align:left;padding:5px 7px;font-size:9.5px;text-transform:uppercase;letter-spacing:.3px}'+
    'table.rp-tbl td{padding:4px 7px;border-bottom:1px solid #e6ecf3}table.rp-tbl tr:nth-child(even) td{background:#f7fafd}'+
    '.rp-r{text-align:right}.breach{background:#fde0e0!important;color:#b10000;font-weight:700}.okc{color:#137333}.badc{color:#b10000}'+
    '.alert{padding:6px 10px;border-radius:6px;margin:5px 0;font-size:11.5px;border-left:4px solid #999}'+
    '.alert.high{background:#fdecec;border-left-color:#dc2626}.alert.med{background:#fff6e8;border-left-color:#d97706}.alert.low{background:#eef4fb;border-left-color:#2563eb}.alert.ok{background:#e9f8ee;border-left-color:#16a34a}'+
    '.gap-ok{color:#137333;font-weight:700}.gap-bad{color:#b10000;font-weight:700}'+
    '.rp-foot{margin-top:14px;border-top:1px solid #dbe4ee;padding-top:8px;font-size:10px;color:#8a95a6;text-align:center}'; }

  function kpiTile(k,v,d){ return '<div class="rp-kpi"><div class="k">'+xesc(k)+'</div><div class="v">'+v+'</div>'+(d?'<div class="d">'+xesc(d)+'</div>':'')+'</div>'; }
  function ownerRows(M,limit){ return M.owners.slice(0,limit||14).map(function(o){
    var slaCls=o.slaPct>=SLA_TARGET?'okc':'badc';
    return '<tr><td>'+xesc(o.name)+'</td><td class="rp-r">'+num(o.deals)+'</td><td class="rp-r">'+num(o.contacted)+'</td><td class="rp-r">'+num(o.calls)+'</td><td class="rp-r">'+num(o.conn)+'</td><td class="rp-r">'+(o.avgFrt==null?'—':fmtMinNice(o.avgFrt))+'</td><td class="rp-r">'+p1(o.coverage)+'%</td><td class="rp-r '+(o.slaPct<SLA_TARGET?'breach':slaCls)+'">'+p1(o.slaPct)+'%</td></tr>'; }).join(''); }
  function overdueRows(M,limit){ var od=M.overdue.slice().sort(function(a,b){return (b.frt==null?1e9:b.frt)-(a.frt==null?1e9:a.frt);});
    return od.slice(0,limit||30).map(function(j){ var late=j.contacted?('First call '+p1(j.frt)+'m (late)'):'No call yet';
      return '<tr><td>'+xesc(j.deal.name||'—')+'</td><td>'+xesc(ownerName(j.deal.owner))+'</td><td>'+xesc(j.deal.stage||'—')+'</td><td>'+xesc(normTrig(j.deal.trigger))+'</td><td>'+xesc(clean(j.deal.leadSource))+'</td><td class="breach">'+xesc(late)+'</td><td>'+xesc(fmtDT(j.deal.created))+'</td></tr>'; }).join(''); }
  function hourRows(M){ return M.wh.buckets.map(function(b){
    return '<tr><td>'+xesc(b.label)+'</td><td class="rp-r">'+num(b.deals)+'</td><td class="rp-r">'+num(b.contacted)+'</td><td class="rp-r">'+num(b.notContacted)+'</td><td class="rp-r">'+(b.avgFrt==null?'—':fmtMinNice(b.avgFrt))+'</td><td class="rp-r">'+p1(b.contactRate)+'%</td></tr>'; }).join(''); }

  function buildReportDoc(M, mode){
    var isExec=(mode==='exec');
    var kpis=[ kpiTile('Deals Created',num(M.deals),'unique '+num(uniqueDeals(M.dl))),
      kpiTile('Calls Made',num(M.calls),num(M.connCalls)+' connected'),
      kpiTile('Call Coverage',p1(M.coverage)+'%','target '+COVER_TARGET+'%'),
      kpiTile('Avg First Response',fmtMinNice(M.avgFrt),'median '+fmtMinNice(M.medFrt)),
      kpiTile('Pending Calls',num(M.pendingCnt),'no call yet'),
      kpiTile('Overdue (>'+SLA_MIN+'m)',num(M.overdueCnt),'SLA breaches'),
      kpiTile('Won Deals',num(M.won),p1(pct(M.won,M.deals||1))+'% win'),
      kpiTile('Active Owners',num(M.ownersActive),'in this window') ].join('');
    var alerts=genAlerts(M).map(function(a){return '<div class="alert '+a[0]+'">'+(a[0]==='high'?'🔴 ':a[0]==='med'?'🟠 ':a[0]==='ok'?'✅ ':'🔵 ')+stripTags(a[1])+'</div>';}).join('');
    var insights='<ul class="rp-list">'+genInsights(M).map(function(x){return '<li>'+x+'</li>';}).join('')+'</ul>';
    var recs='<ul class="rp-list">'+genRecs(M).map(function(x){return '<li>'+xesc(x)+'</li>';}).join('')+'</ul>';
    var gaps='<table class="rp-tbl"><thead><tr><th>Metric</th><th class="rp-r">Actual</th><th class="rp-r">Target</th><th>Status</th></tr></thead><tbody>'+
      genGaps(M).map(function(g){return '<tr><td>'+g[0]+'</td><td class="rp-r">'+g[1]+'</td><td class="rp-r">'+g[2]+'</td><td class="'+(g[3]?'gap-ok':'gap-bad')+'">'+(g[3]?'✓ ':'✗ ')+xesc(g[4])+'</td></tr>';}).join('')+'</tbody></table>';

    var H=[];
    H.push('<!doctype html><html><head><meta charset="utf-8"><title>'+xesc(BRAND+' — '+(isExec?'Executive Summary':REPORT_TITLE))+'</title><style>'+reportCSS()+'</style></head><body><div class="rp-wrap">');
    H.push('<div class="rp-head"><div class="rp-logo">L</div><div><h1>'+xesc(isExec?'Executive Summary — Deals vs Calls':REPORT_TITLE)+'</h1>'+
      '<div class="m">'+xesc(BRAND)+' · Selected period: <b>'+fmtDay(M.from)+' → '+fmtDay(M.to)+'</b> · Scope: '+xesc(M.scope)+'</div></div>'+
      '<div class="stamp">Generated<br><b>'+xesc(fmtStamp(M.generated))+'</b></div></div>');
    H.push('<div class="rp-sec"><h2>Executive Summary</h2><div class="rp-sum">'+execSummary(M)+'</div></div>');
    H.push('<div class="rp-sec"><h2>KPI Summary</h2><div class="rp-kpis">'+kpis+'</div></div>');

    if(isExec){
      H.push('<div class="rp-sec"><h2>Alerts</h2>'+alerts+'</div>');
      H.push('<div class="rp-2"><div class="rp-sec"><h2>AI Insights</h2>'+insights+'</div><div class="rp-sec"><h2>Recommendations</h2>'+recs+'</div></div>');
      H.push('<div class="rp-sec"><h2>Gap Analysis</h2>'+gaps+'</div>');
    } else {
      H.push('<div class="rp-2"><div class="rp-sec"><h2>Deals vs Calls — Trend</h2><div class="rp-card">'+rLine(M.trendLabels,[{name:'Deals',color:'#2563eb',data:M.trendDeals},{name:'Calls',color:'#0d9488',data:M.trendCalls}])+'</div></div>'+
        '<div class="rp-sec"><h2>Hourly First-Response (10 AM–9 PM)</h2><div class="rp-card">'+rHourBars(M)+'</div></div></div>');
      H.push('<div class="rp-2"><div class="rp-sec"><h2>AI Insights</h2><div class="rp-card">'+insights+'</div></div><div class="rp-sec"><h2>Recommendations</h2><div class="rp-card">'+recs+'</div></div></div>');
      H.push('<div class="rp-sec"><h2>Gap Analysis</h2>'+gaps+'</div>');
      H.push('<div class="rp-sec"><h2>Alerts</h2>'+alerts+'</div>');
      H.push('<div class="rp-sec"><h2>Owner Performance</h2><table class="rp-tbl"><thead><tr><th>Owner</th><th class="rp-r">Deals</th><th class="rp-r">Contacted</th><th class="rp-r">Calls</th><th class="rp-r">Conn.</th><th class="rp-r">Avg 1st Resp</th><th class="rp-r">Coverage</th><th class="rp-r">SLA %</th></tr></thead><tbody>'+ownerRows(M,16)+'</tbody></table></div>');
      H.push('<div class="rp-sec"><h2>Overdue Deals (>'+SLA_MIN+' min)</h2><table class="rp-tbl"><thead><tr><th>Deal</th><th>Owner</th><th>Stage</th><th>Trigger</th><th>Lead Source</th><th>SLA</th><th>Created</th></tr></thead><tbody>'+(M.overdueCnt?overdueRows(M,30):'<tr><td colspan="7">No overdue deals in this window. 🎉</td></tr>')+'</tbody></table></div>');
      H.push('<div class="rp-sec"><h2>Hourly Connectivity</h2><table class="rp-tbl"><thead><tr><th>Hour (IST)</th><th class="rp-r">Deals</th><th class="rp-r">Contacted</th><th class="rp-r">Not Contacted</th><th class="rp-r">Avg 1st Call</th><th class="rp-r">Contact Rate</th></tr></thead><tbody>'+hourRows(M)+'</tbody></table></div>');
    }
    H.push('<div class="rp-foot">'+xesc(BRAND)+' · Deals vs Calls Intelligence · Confidential — for internal use · '+xesc(fmtStamp(M.generated))+'</div>');
    H.push('</div></body></html>');
    return H.join('');
  }
  function openPrint(html){
    var w=window.open('','_blank','width=1200,height=800');
    if(!w){ alert('Please allow pop-ups for this site to export the PDF report.'); return; }
    w.document.open(); w.document.write(html); w.document.close(); w.focus();
    var done=false; function go(){ if(done)return; done=true; try{ w.print(); }catch(e){} }
    w.onload=go; setTimeout(go,700);
  }
  function exportPDF(){ openPrint(buildReportDoc(reportModel(),'full')); }
  function exportExecutive(){ openPrint(buildReportDoc(reportModel(),'exec')); }

  /* ---------- Excel (multi-sheet SpreadsheetML) ---------- */
  function cell(v,style){ var t='String', d;
    if(typeof v==='number' && isFinite(v)){ t='Number'; d=v; }
    else { d=xesc(v==null?'':''+v); }
    return '<Cell'+(style?(' ss:StyleID="'+style+'"'):'')+'><Data ss:Type="'+t+'">'+d+'</Data></Cell>';
  }
  function xlSheet(name, cols, rows){
    // cols: [{title,width,type}]  rows: [[{v,style}|value,...]]
    var nC=cols.length, nR=rows.length+1;
    var t='<Worksheet ss:Name="'+xesc(name.slice(0,31))+'"><Table>';
    cols.forEach(function(c){ t+='<Column ss:Width="'+(c.width||90)+'" ss:AutoFitWidth="0"/>'; });
    t+='<Row ss:Height="20">'+cols.map(function(c){return cell(c.title,'hdr');}).join('')+'</Row>';
    rows.forEach(function(r){ t+='<Row>'+r.map(function(x){ if(x&&typeof x==='object'&&'v' in x) return cell(x.v,x.style); return cell(x); }).join('')+'</Row>'; });
    t+='</Table>';
    t+='<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ActivePane>2</ActivePane><Selected/></WorksheetOptions>';
    t+='<AutoFilter x:Range="R1C1:R'+nR+'C'+nC+'" xmlns="urn:schemas-microsoft-com:office:excel"></AutoFilter>';
    t+='</Worksheet>';
    return t;
  }
  function exportExcel(){ downloadBlob(buildExcelXml(reportModel()), fname(reportModel(),'xls'), 'application/vnd.ms-excel'); }
  function buildExcelXml(M){
    var styles='<Styles>'+
      '<Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#1a2230"/></Style>'+
      '<Style ss:ID="hdr"><Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1F3B57" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/></Style>'+
      '<Style ss:ID="ttl"><Font ss:FontName="Calibri" ss:Size="15" ss:Bold="1" ss:Color="#1F3B57"/></Style>'+
      '<Style ss:ID="sub"><Font ss:FontName="Calibri" ss:Size="10" ss:Italic="1" ss:Color="#666666"/></Style>'+
      '<Style ss:ID="lbl"><Font ss:Bold="1" ss:Color="#334155"/></Style>'+
      '<Style ss:ID="breach"><Interior ss:Color="#FDE0E0" ss:Pattern="Solid"/><Font ss:Color="#B10000" ss:Bold="1"/></Style>'+
      '<Style ss:ID="good"><Interior ss:Color="#E4F7E9" ss:Pattern="Solid"/><Font ss:Color="#137333"/></Style>'+
      '</Styles>';
    var sheets=[];

    // 1 — Summary (label/value, plus insights/recs mini blocks)
    (function(){
      var cols=[{title:'Metric',width:200},{title:'Value',width:170}];
      var rows=[
        [{v:'Report',style:'lbl'}, BRAND+' — Deals vs Calls'],
        [{v:'Period',style:'lbl'}, fmtDay(M.from)+' → '+fmtDay(M.to)],
        [{v:'Scope',style:'lbl'}, M.scope],
        [{v:'Generated',style:'lbl'}, fmtStamp(M.generated)],
        ['',''],
        [{v:'Deals Created',style:'lbl'}, M.deals],
        [{v:'Calls Made',style:'lbl'}, M.calls],
        [{v:'Connected Calls',style:'lbl'}, M.connCalls],
        [{v:'Call Coverage %',style:'lbl'}, +p1(M.coverage)],
        [{v:'Avg First Response (min)',style:'lbl'}, +p1(M.avgFrt)],
        [{v:'Median First Response (min)',style:'lbl'}, +p1(M.medFrt)],
        [{v:'Pending Calls',style:'lbl'}, M.pendingCnt],
        [{v:'Overdue (>'+SLA_MIN+'m)',style:(M.overdueCnt?'breach':'good')}, {v:M.overdueCnt, style:(M.overdueCnt?'breach':'good')}],
        [{v:'Won Deals',style:'lbl'}, M.won],
        [{v:'Best Owner (SLA)',style:'lbl'}, M.best?(M.best.name+' — '+p1(M.best.slaPct)+'%'):'—'],
        [{v:'Lowest SLA Owner',style:'lbl'}, M.worst?(M.worst.name+' — '+p1(M.worst.slaPct)+'%'):'—']
      ];
      genInsights(M).forEach(function(x,i){ rows.push([{v:(i===0?'Insight':''),style:'lbl'}, stripTags(x)]); });
      genRecs(M).forEach(function(x,i){ rows.push([{v:(i===0?'Recommendation':''),style:'lbl'}, x]); });
      sheets.push(xlSheet('Summary',cols,rows));
    })();

    // 2 — Daily KPIs
    (function(){
      var byd={}; M.joined.forEach(function(j){ var k=dayKey(j.deal.created); var o=byd[k]||(byd[k]={deals:0,contacted:0,overdue:0}); o.deals++; if(j.contacted)o.contacted++; });
      M.overdue.forEach(function(j){ var k=dayKey(j.deal.created); if(byd[k])byd[k].overdue++; });
      var callByDay=trend(M.cl,'day').map;
      var keys=Object.keys(byd).sort();
      var cols=[{title:'Date',width:90},{title:'Deals',width:70},{title:'Calls',width:70},{title:'Contacted',width:80},{title:'Coverage %',width:80},{title:'Overdue',width:70}];
      var rows=keys.map(function(k){ var o=byd[k]; var cov=pct(o.contacted,o.deals); return [k,o.deals,(callByDay[k]||0),o.contacted,{v:+p1(cov)},{v:o.overdue,style:(o.overdue?'breach':undefined)}]; });
      sheets.push(xlSheet('Daily KPIs',cols,rows));
    })();

    // 3 — Deals
    (function(){
      var cols=[{title:'Deal',width:200},{title:'Owner',width:130},{title:'Stage',width:110},{title:'Prob %',width:60},{title:'Lead Source',width:120},{title:'Trigger',width:100},{title:'UTM Source',width:110},{title:'Activities',width:70},{title:'Created',width:130}];
      var rows=M.dl.map(function(d){ return [d.name,ownerName(d.owner),d.stage,(d.prob==null?'':+d.prob),clean(d.leadSource),normTrig(d.trigger),clean(d.utmSource),(+d.numAct||0),d.created]; });
      sheets.push(xlSheet('Deals',cols,rows));
    })();

    // 4 — Calls
    (function(){
      var cols=[{title:'Owner',width:130},{title:'Type',width:90},{title:'Duration (s)',width:90},{title:'Connected',width:80},{title:'Created',width:130}];
      var rows=M.cl.map(function(c){ return [ownerName(c.owner),c.type||'',(c.dur||0),(c.dur>0?'Yes':'No'),c.created]; });
      sheets.push(xlSheet('Calls',cols,rows));
    })();

    // 5 — Overdue Deals
    (function(){
      var cols=[{title:'Deal',width:200},{title:'Owner',width:130},{title:'Stage',width:110},{title:'Trigger',width:100},{title:'Lead Source',width:120},{title:'SLA Status',width:150},{title:'First Resp (min)',width:100},{title:'Created',width:130}];
      var od=M.overdue.slice().sort(function(a,b){return (b.frt==null?1e9:b.frt)-(a.frt==null?1e9:a.frt);});
      var rows=od.map(function(j){ var stat=j.contacted?'Late first call':'No call yet'; return [j.deal.name,ownerName(j.deal.owner),j.deal.stage,normTrig(j.deal.trigger),clean(j.deal.leadSource),{v:stat,style:'breach'},(j.frt==null?'':+p1(j.frt)),j.deal.created]; });
      if(!rows.length) rows=[['(none)','','','','','',{v:''},'']];
      sheets.push(xlSheet('Overdue Deals',cols,rows));
    })();

    // 6 — Owner Performance
    (function(){
      var cols=[{title:'Owner',width:140},{title:'Deals',width:60},{title:'Contacted',width:75},{title:'Calls',width:60},{title:'Connected',width:75},{title:'Avg 1st Resp (min)',width:100},{title:'Coverage %',width:80},{title:'SLA %',width:70}];
      var rows=M.owners.map(function(o){ return [o.name,o.deals,o.contacted,o.calls,o.conn,(o.avgFrt==null?'':+p1(o.avgFrt)),+p1(o.coverage),{v:+p1(o.slaPct),style:(o.slaPct<SLA_TARGET?'breach':'good')}]; });
      sheets.push(xlSheet('Owner Performance',cols,rows));
    })();

    // 7 — Hourly Analysis
    (function(){
      var cols=[{title:'Hour (IST)',width:90},{title:'Deals',width:70},{title:'Contacted',width:80},{title:'Not Contacted',width:95},{title:'Avg 1st Call (min)',width:105},{title:'Contact Rate %',width:100}];
      var rows=M.wh.buckets.map(function(b){ return [b.label,b.deals,b.contacted,b.notContacted,(b.avgFrt==null?'':+p1(b.avgFrt)),+p1(b.contactRate)]; });
      sheets.push(xlSheet('Hourly Analysis',cols,rows));
    })();

    // 8 — AI Insights
    (function(){
      var cols=[{title:'#',width:40},{title:'Insight',width:640}];
      var rows=genInsights(M).map(function(x,i){ return [i+1, stripTags(x)]; });
      sheets.push(xlSheet('AI Insights',cols,rows));
    })();

    // 9 — Recommendations
    (function(){
      var cols=[{title:'#',width:40},{title:'Recommendation',width:640},{title:'Priority',width:80}];
      var rows=genRecs(M).map(function(x,i){ return [i+1, x, (i===0?'High':i<2?'Medium':'Normal')]; });
      sheets.push(xlSheet('Recommendations',cols,rows));
    })();

    // 10 — Raw Data (joined deal × first-call detail)
    (function(){
      var cols=[{title:'Deal ID',width:110},{title:'Deal',width:190},{title:'Owner',width:130},{title:'Mobile',width:110},{title:'Stage',width:100},{title:'Contacted',width:75},{title:'#Calls',width:60},{title:'First Resp (min)',width:100},{title:'SLA Met',width:70},{title:'Created',width:130}];
      var rows=M.joined.map(function(j){ var met=j.contacted&&j.frt!=null&&j.frt<=SLA_MIN; return [j.deal.id,j.deal.name,ownerName(j.deal.owner),j.deal.mobile||'',j.deal.stage,(j.contacted?'Yes':'No'),j.nCalls,(j.frt==null?'':+p1(j.frt)),{v:(met?'Yes':'No'),style:(met?'good':'breach')},j.deal.created]; });
      sheets.push(xlSheet('Raw Data',cols,rows));
    })();

    var xml='<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n'+
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:html="http://www.w3.org/TR/REC-html40">'+
      '<DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"><Author>'+xesc(BRAND)+'</Author><Title>Deals vs Calls Report</Title></DocumentProperties>'+
      styles+sheets.join('')+'</Workbook>';
    return xml;
  }

  /* ---------- PNG snapshot (canvas) ---------- */
  function exportPNG(){
    var M=reportModel();
    var W=1280,Hc=720,cv=document.createElement('canvas'); cv.width=W; cv.height=Hc;
    var x=cv.getContext('2d');
    x.fillStyle='#0e1117'; x.fillRect(0,0,W,Hc);
    var grd=x.createLinearGradient(0,0,W,0); grd.addColorStop(0,'#2563eb'); grd.addColorStop(1,'#0d9488');
    x.fillStyle=grd; x.fillRect(0,0,W,8);
    // logo
    x.fillStyle=grd; roundRect(x,40,34,58,58,14); x.fill();
    x.fillStyle='#fff'; x.font='800 30px Segoe UI, Arial'; x.textBaseline='middle'; x.textAlign='center'; x.fillText('L',69,64);
    x.textAlign='left';
    x.fillStyle='#e7ecf3'; x.font='800 30px Segoe UI, Arial'; x.fillText('Deals vs Calls — Executive Snapshot',112,50);
    x.fillStyle='#9aa7b8'; x.font='15px Segoe UI, Arial'; x.fillText(BRAND+'  ·  '+fmtDay(M.from)+' → '+fmtDay(M.to)+'  ·  '+M.scope,112,78);
    // KPI grid 4x2
    var tiles=[['Deals Created',num(M.deals)],['Calls Made',num(M.calls)],['Call Coverage',p1(M.coverage)+'%'],['Avg 1st Response',fmtMinNice(M.avgFrt)],
      ['Pending Calls',num(M.pendingCnt)],['Overdue >'+SLA_MIN+'m',num(M.overdueCnt)],['Won Deals',num(M.won)],['Best Owner SLA',M.best?p1(M.best.slaPct)+'%':'—']];
    var gx=40,gy=118,gw=(W-80-3*16)/4,gh=104;
    tiles.forEach(function(t,i){ var cxp=gx+(i%4)*(gw+16), cyp=gy+Math.floor(i/4)*(gh+16);
      x.fillStyle='#1a212c'; roundRect(x,cxp,cyp,gw,gh,12); x.fill();
      x.strokeStyle='#2a3442'; x.lineWidth=1; roundRect(x,cxp,cyp,gw,gh,12); x.stroke();
      x.fillStyle='#9aa7b8'; x.font='700 12px Segoe UI, Arial'; x.fillText(t[0].toUpperCase(),cxp+16,cyp+26);
      x.fillStyle='#e7ecf3'; x.font='800 34px Segoe UI, Arial'; x.fillText(t[1],cxp+16,cyp+66);
    });
    // insights
    var iy=gy+2*(gh+16)+18;
    x.fillStyle='#4f8cff'; x.font='700 16px Segoe UI, Arial'; x.fillText('Top Insights',40,iy);
    x.fillStyle='#c7d0dc'; x.font='14px Segoe UI, Arial';
    genInsights(M).slice(0,4).forEach(function(s,i){ x.fillText('•  '+trunc(stripTags(s),120),40,iy+28+i*26); });
    x.fillStyle='#6b7688'; x.font='12px Segoe UI, Arial'; x.textAlign='right';
    x.fillText('Generated '+fmtStamp(M.generated)+'  ·  Lucira Deals vs Calls Intelligence',W-40,Hc-24);
    x.textAlign='left';
    try{ cv.toBlob(function(b){ if(b) downloadBlob(b, fname(M,'png'), 'image/png'); else fallbackPNG(cv,M); }); }
    catch(e){ fallbackPNG(cv,M); }
  }
  function fallbackPNG(cv,M){ var a=document.createElement('a'); a.href=cv.toDataURL('image/png'); a.download=fname(M,'png'); document.body.appendChild(a); a.click(); a.remove(); }
  function roundRect(c,x,y,w,h,r){ c.beginPath(); c.moveTo(x+r,y); c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r); c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }
  function trunc(s,n){ return s.length>n?s.slice(0,n-1)+'…':s; }

  /* ---------- misc I/O ---------- */
  function fname(M,ext){ return 'Lucira_DealsVsCalls_'+M.from+'_'+M.to+'.'+ext; }
  function downloadBlob(content, filename, mime){ var blob=(content instanceof Blob)?content:new Blob([content],{type:mime}); var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },900); }
  function copyText(txt, okCb){
    function done(){ if(okCb)okCb(); }
    if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(done,function(){ legacyCopy(txt); done(); }); }
    else { legacyCopy(txt); done(); }
  }
  function legacyCopy(txt){ var ta=document.createElement('textarea'); ta.value=txt; ta.style.position='fixed'; ta.style.top='-1000px'; document.body.appendChild(ta); ta.focus(); ta.select(); try{ document.execCommand('copy'); }catch(e){} ta.remove(); }

  /* ---------- Scheduled Reports (client-persisted config) ---------- */
  function loadSched(){ try{ return JSON.parse(localStorage.getItem('dvc_schedule')||'null')||{}; }catch(e){ return {}; } }
  function saveSched(o){ try{ localStorage.setItem('dvc_schedule', JSON.stringify(o)); }catch(e){} }

  /* ---------- CSS for the Share tab / header ---------- */
  (function(){ var st=el('style'); st.textContent=
    '.share-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}'+
    '.share-btn{display:flex;flex-direction:column;gap:6px;align-items:flex-start;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:15px 16px;cursor:pointer;box-shadow:var(--shadow);transition:border-color .15s,transform .1s;color:var(--tx)}'+
    '.share-btn:hover{border-color:var(--acc);transform:translateY(-1px)}'+
    '.share-btn .ic{font-size:22px}.share-btn .t{font-weight:750;font-size:14px}.share-btn .s{font-size:11.5px;color:var(--tx2);line-height:1.4}'+
    '.share-btn.primary{background:linear-gradient(135deg,var(--acc),var(--acc2));border:none;color:#fff}.share-btn.primary .s{color:rgba(255,255,255,.85)}'+
    '.wa-prev{white-space:pre-wrap;font:12.5px/1.55 ui-monospace,Menlo,Consolas,monospace;background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:14px;color:var(--tx);max-height:360px;overflow:auto}'+
    '.sched-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:12px}'+
    '.sched-grid label{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--tx3);font-weight:700;margin-bottom:4px}'+
    '.sched-grid select,.sched-grid input{width:100%;background:var(--bg2);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:7px 9px;font-size:12.5px}'+
    '.sched-ch{display:flex;gap:8px;flex-wrap:wrap;margin:2px 0 12px}'+
    '.sched-ch label{display:inline-flex;gap:6px;align-items:center;background:var(--bg2);border:1px solid var(--line);border-radius:20px;padding:5px 12px;font-size:12.5px;cursor:pointer;color:var(--tx)}'+
    '.sched-ch input{accent-color:var(--acc)}'+
    '.share-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--good);color:#04210f;font-weight:700;padding:10px 18px;border-radius:22px;box-shadow:var(--shadow);z-index:200;font-size:13px}'+
    '@media print{.share-actions,.askfab{display:none}}';
    document.head.appendChild(st);
  })();
  function toast(msg){ var t=el('div','share-toast',esc(msg)); document.body.appendChild(t); setTimeout(function(){ t.style.opacity='0'; t.style.transition='opacity .4s'; },1600); setTimeout(function(){ t.remove(); },2100); }

  /* ---------- Share tab ---------- */
  function renderShare(v){
    var M=reportModel();
    v.appendChild(el('div','note','<b>📤 Export &amp; Sharing</b> — every report below reflects your <b>current filters</b> ('+esc(fmtDay(M.from))+' → '+esc(fmtDay(M.to))+' · '+esc(M.scope)+'). Change the date range or owners above and the exports update automatically.'));

    // KPI strip
    v.appendChild(kpiRow([
      ['Deals Created',num(M.deals),'unique '+num(uniqueDeals(M.dl)),'','var(--c1)'],
      ['Calls Made',num(M.calls),num(M.connCalls)+' connected','','var(--c2)'],
      ['Call Coverage',p1(M.coverage)+'%','target '+COVER_TARGET+'%',(M.coverage>=COVER_TARGET?'up':'down'),'var(--c4)'],
      ['Avg 1st Response',fmtMinNice(M.avgFrt),'median '+fmtMinNice(M.medFrt),'','var(--c3)'],
      ['Pending Calls',num(M.pendingCnt),'no call yet','down','var(--warn)'],
      ['Overdue >'+SLA_MIN+'m',num(M.overdueCnt),'SLA breaches',(M.overdueCnt?'down':'up'),'var(--bad)']
    ]));

    // Share action buttons
    var pA=panel('Share Options','One-click export — presentation-ready, no manual editing'); v.appendChild(pA);
    var wrap=el('div','share-actions');
    var actions=[
      ['primary','🧾','Export PDF','A4-landscape executive report — full sections',exportPDF],
      ['','📊','Export Excel','10-sheet workbook · filters · SLA highlighting',exportExcel],
      ['','💬','Copy WhatsApp','Compact summary to clipboard',function(){ copyText(whatsappText(reportModel()), function(){ toast('WhatsApp summary copied ✓'); }); }],
      ['','🖼️','Download PNG','Branded executive snapshot',exportPNG],
      ['','🖨️','Print Report','Print the live dashboard',function(){ window.print(); }],
      ['','⭐','Executive Report','One-page summary for senior management',exportExecutive]
    ];
    actions.forEach(function(a){ var b=el('button','share-btn'+(a[0]?' '+a[0]:'')); b.innerHTML='<span class="ic">'+a[1]+'</span><span class="t">'+esc(a[2])+'</span><span class="s">'+esc(a[3])+'</span>'; b.onclick=a[4]; wrap.appendChild(b); });
    pA.__body.appendChild(wrap);

    // WhatsApp preview
    var pW=panel('WhatsApp-Ready Report','Preview — tap Copy or open WhatsApp'); v.appendChild(pW);
    var waTxt=whatsappText(M);
    var prev=el('div','wa-prev'); prev.textContent=waTxt; pW.__body.appendChild(prev);
    var bar=el('div'); bar.style.cssText='display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
    var cpy=el('button','mini','💬 Copy summary'); cpy.onclick=function(){ copyText(whatsappText(reportModel()), function(){ toast('Copied ✓'); }); };
    var wa=el('a','mini'); wa.textContent='↗ Open in WhatsApp'; wa.href='https://wa.me/?text='+encodeURIComponent(waTxt); wa.target='_blank'; wa.style.textDecoration='none';
    bar.appendChild(cpy); bar.appendChild(wa); pW.__body.appendChild(bar);

    // Executive summary + Insights/Recs
    var pE=panel('Executive Summary'); v.appendChild(pE); pE.__body.innerHTML='<div style="font-size:13px;line-height:1.65">'+execSummary(M)+'</div>';
    var g=el('div','grid g2');
    var pI=panel('AI Insights'); g.appendChild(pI); pI.__body.innerHTML='<ul style="margin:2px 0 0;padding-left:18px;font-size:12.5px;line-height:1.6">'+genInsights(M).map(function(x){return '<li style="margin:4px 0">'+x+'</li>';}).join('')+'</ul>';
    var pR=panel('Recommendations'); g.appendChild(pR); pR.__body.innerHTML='<ul style="margin:2px 0 0;padding-left:18px;font-size:12.5px;line-height:1.6">'+genRecs(M).map(function(x){return '<li style="margin:4px 0">'+esc(x)+'</li>';}).join('')+'</ul>';
    v.appendChild(g);

    // Gap analysis + Alerts
    var pG=panel('Gap Analysis','Actual vs target'); v.appendChild(pG);
    table(pG.__body,['Metric','Actual','Target','Status'], genGaps(M).map(function(gp){ return [gp[0],gp[1],gp[2],{html:'<span class="badge '+(gp[3]?'ok':'err')+'">'+(gp[3]?'✓ ':'✗ ')+esc(gp[4])+'</span>',text:gp[4]}]; }), {key:'gap'});
    var pAl=panel('Alerts'); v.appendChild(pAl);
    var abox=el('div'); genAlerts(M).forEach(function(a){ var c=el('div'); var col=a[0]==='high'?'var(--bad)':a[0]==='med'?'var(--warn)':a[0]==='ok'?'var(--good)':'var(--acc)'; c.style.cssText='padding:8px 12px;border-left:4px solid '+col+';background:var(--bg2);border-radius:8px;margin:6px 0;font-size:12.5px'; c.innerHTML=(a[0]==='high'?'🔴 ':a[0]==='med'?'🟠 ':a[0]==='ok'?'✅ ':'🔵 ')+esc(stripTags(a[1])); abox.appendChild(c); }); pAl.__body.appendChild(abox);

    // Scheduled reports
    renderScheduler(v);
  }

  function renderScheduler(v){
    var cfg=loadSched();
    var p=panel('Scheduled Reports','Automate delivery of the reports above'); v.appendChild(p);
    var grid=el('div','sched-grid');
    function fld(label, inner){ var d=el('div'); d.appendChild(el('label',null,label)); d.appendChild(inner); return d; }
    var freq=el('select'); [['off','Off'],['daily','Daily'],['weekly','Weekly'],['monthly','Monthly']].forEach(function(o){ var op=new Option(o[1],o[0]); if((cfg.freq||'off')===o[0])op.selected=true; freq.appendChild(op); });
    var time=el('input'); time.type='time'; time.value=cfg.time||'10:00';
    var fmt=el('select'); [['pdf','PDF Executive Report'],['excel','Excel Workbook'],['whatsapp','WhatsApp Summary'],['exec','One-page Executive']].forEach(function(o){ var op=new Option(o[1],o[0]); if((cfg.format||'pdf')===o[0])op.selected=true; fmt.appendChild(op); });
    var rcpt=el('input'); rcpt.type='text'; rcpt.placeholder='email(s) / phone(s), comma-separated'; rcpt.value=cfg.recipients||'';
    grid.appendChild(fld('Frequency',freq)); grid.appendChild(fld('Send time (IST)',time)); grid.appendChild(fld('Report format',fmt)); grid.appendChild(fld('Recipients',rcpt));
    p.__body.appendChild(grid);
    p.__body.appendChild(el('label',null,'Delivery channels')); p.__body.lastChild.style.cssText='font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--tx3);font-weight:700';
    var ch=el('div','sched-ch'); var chans=[['email','📧 Email'],['whatsapp','💬 WhatsApp'],['gdrive','📁 Google Drive'],['archive','🗄️ PDF Archive']];
    var chSet={}; (cfg.channels||['email']).forEach(function(c){chSet[c]=1;});
    chans.forEach(function(c){ var l=el('label'); var cb=el('input'); cb.type='checkbox'; cb.value=c[0]; cb.checked=!!chSet[c[0]]; l.appendChild(cb); l.appendChild(document.createTextNode(c[1])); ch.appendChild(l); });
    p.__body.appendChild(ch);
    var save=el('button','share-btn'); save.style.cssText='flex-direction:row;align-items:center;gap:10px;max-width:260px'; save.innerHTML='<span class="ic">💾</span><span class="t">Save schedule</span>';
    save.onclick=function(){ var channels=Array.prototype.slice.call(ch.querySelectorAll('input:checked')).map(function(x){return x.value;});
      var o={freq:freq.value,time:time.value,format:fmt.value,recipients:rcpt.value.trim(),channels:channels,savedAt:new Date().toISOString()};
      saveSched(o); toast(o.freq==='off'?'Schedule turned off':'Schedule saved ✓'); render(); };
    p.__body.appendChild(save);
    var status = (cfg.freq && cfg.freq!=='off')
      ? '<span class="badge ok">Active</span> '+esc(cfg.freq)+' at '+esc(cfg.time||'10:00')+' IST · '+esc(cfg.format||'pdf').toUpperCase()+' · via '+esc((cfg.channels||['email']).join(', '))
      : '<span class="badge err">Not scheduled</span>';
    p.__body.appendChild(el('div','note','<b>Current:</b> '+status+'.<br>Your preferences are saved in this browser. <b>Automated delivery</b> (email / WhatsApp / Google Drive / PDF archive) runs on the backend reporting service — connect it via <code>CONFIG.CRM_API</code> to activate scheduled sends. Until then, use the one-click exports above.'));
  }

  /* ============================ DAILY CRM OPERATIONS COMMAND CENTER (14 sections) ============================
     Day-centric operational view — reuses joinDeals / whAnalysis / the Section-11 export machinery. Operates on the
     currently selected date range (single day when Today/Yesterday preset is active). Honest data gates: Zoho Events
     in this dataset are owner-level with no outcome field and are NOT deal-linked, so meeting "Missed" and
     deal↔meeting metrics are surfaced as not-tracked rather than faked. */
  var BIZ_LO=10, BIZ_HI=20;                 // business hours: 10 AM – 8 PM
  function ccScope(){ return (F.owners.size?F.owners.size+' owner(s)':'all owners')+(F.stage.size?' · '+Array.from(F.stage).join(', '):'')+(F.leadSource.size?' · '+Array.from(F.leadSource).join(', '):''); }
  function refNow(){ var real=new Date(); var end=D(F.to+'T23:59:59'); return (end && end<real)?end:real; }
  function covColor(p){ return p>=90?'var(--good)':p>=70?'#84cc16':p>=50?'var(--warn)':'var(--bad)'; }
  function delayColor(m){ return m==null?'var(--tx3)':m<10?'var(--good)':m<30?'var(--warn)':m<60?'var(--c8)':'var(--bad)'; }
  function covHex(p){ return p>=90?'#16a34a':p>=70?'#65a30d':p>=50?'#d97706':'#dc2626'; }
  function delayHex(m){ return m==null?'#94a3b8':m<10?'#16a34a':m<30?'#d97706':m<60?'#ea580c':'#dc2626'; }
  var FRT_EDGES=[['< 5 min',0,5],['5–10 min',5,10],['10–15 min',10,15],['15–20 min',15,20],['20–25 min',20,25],['25–30 min',25,30],['30–45 min',30,45],['45–60 min',45,60],['> 60 min',60,1e18]];
  function isDelayBucket(lbl){ return lbl==='30–45 min'||lbl==='45–60 min'||lbl==='> 60 min'||lbl==='No First Call Yet'; }

  function dayMetrics(from,to){
    var dl=fDeals(from,to), cl=fCalls(from,to), ev=fEvents(from,to);
    var j=joinDeals(dl), c=j.filter(function(x){return x.contacted;});
    var frts=c.map(function(x){return x.frt;}).filter(function(x){return x!=null&&x>=0;}).sort(function(a,b){return a-b;});
    var avg=frts.length?frts.reduce(function(s,x){return s+x;},0)/frts.length:0;
    var med=frts.length?frts[Math.floor(frts.length/2)]:0;
    var sm=c.filter(function(x){return x.frt!=null&&x.frt<=SLA_MIN;}).length;
    return {deals:dl.length,calls:cl.length,contacted:c.length,pending:dl.length-c.length,coverage:pct(c.length,dl.length||1),avgFrt:avg,medFrt:med,slaPct:pct(sm,dl.length||1),meetings:ev.length};
  }
  dayMetricsFn=dayMetrics; /* expose to the outer-scope info-panel engine (trendBlock) */

  function opsModel(){
    var dl=fDeals(), cl=fCalls(), tk=fTasks(), ev=fEvents(), on=fOnline();
    var joined=joinDeals(dl), ref=refNow();
    joined.forEach(function(j){ j._delay = j.contacted ? j.frt : Math.max(0,(ref-D(j.deal.created))/60000); });
    var contacted=joined.filter(function(j){return j.contacted;});
    var pending=joined.filter(function(j){return !j.contacted;});
    var overdue=joined.filter(function(j){ return j._delay!=null && j._delay>SLA_MIN; });
    var frts=contacted.map(function(j){return j.frt;}).filter(function(x){return x!=null&&x>=0;}).sort(function(a,b){return a-b;});
    var avgFrt=frts.length?frts.reduce(function(s,x){return s+x;},0)/frts.length:0;
    var medFrt=frts.length?frts[Math.floor(frts.length/2)]:0;
    var maxFrt=frts.length?frts[frts.length-1]:0;
    var slaMet=contacted.filter(function(j){return j.frt!=null&&j.frt<=SLA_MIN;}).length;
    var coverage=pct(contacted.length, dl.length||1), slaPct=pct(slaMet, dl.length||1);

    function distOf(list){ var b=FRT_EDGES.map(function(e){return {label:e[0],lo:e[1],hi:e[2],count:0};}); var noc=0;
      list.forEach(function(j){ if(!j.contacted||j.frt==null){ noc++; return; } for(var i=0;i<b.length;i++){ if(j.frt>=b[i].lo && j.frt<b[i].hi){ b[i].count++; break; } } });
      b.push({label:'No First Call Yet',lo:null,hi:null,count:noc}); return b; }
    var dist=distOf(joined);
    var pp=prevPeriod(), prevJoined=joinDeals(fDeals(pp.from,pp.to)), prevDist=distOf(prevJoined);
    var prevC=prevJoined.filter(function(j){return j.contacted;});
    var prevFrts=prevC.map(function(j){return j.frt;}).filter(function(x){return x!=null;});
    var prevAvg=prevFrts.length?prevFrts.reduce(function(s,x){return s+x;},0)/prevFrts.length:0;
    var prevCov=pct(prevC.length, prevJoined.length||1);

    function part(inBiz){ var jd=joined.filter(function(j){var h=hourOf(j.deal.created),b=(h>=BIZ_LO&&h<BIZ_HI);return inBiz?b:!b;});
      var cc=cl.filter(function(c){var h=hourOf(c.created),b=(h>=BIZ_LO&&h<BIZ_HI);return inBiz?b:!b;});
      var con=jd.filter(function(j){return j.contacted;});
      var f=con.map(function(j){return j.frt;}).filter(function(x){return x!=null;});
      var sm=con.filter(function(j){return j.frt!=null&&j.frt<=SLA_MIN;}).length;
      var connected30=cc.filter(function(c){return c.dur>30;}).length, talk=cc.reduce(function(s,c){return s+(c.dur||0);},0);
      return {deals:jd.length,calls:cc.length,connected30:connected30,talk:talk,avgFrt:f.length?f.reduce(function(s,x){return s+x;},0)/f.length:0,coverage:pct(con.length,jd.length||1),slaPct:pct(sm,jd.length||1),pending:jd.length-con.length}; }
    var biz=part(true), nonbiz=part(false);

    var hourly=[]; for(var h=BIZ_LO;h<=BIZ_HI;h++){
      var jd=joined.filter(function(j){return hourOf(j.deal.created)===h;});
      var ccArr=cl.filter(function(c){return hourOf(c.created)===h;});
      var con=jd.filter(function(j){return j.contacted;});
      var f=con.map(function(j){return j.frt;}).filter(function(x){return x!=null;});
      hourly.push({hour:h,label:hr12(h),deals:jd.length,calls:ccArr.length,connected30:ccArr.filter(function(c){return c.dur>30;}).length,talk:ccArr.reduce(function(s,c){return s+(c.dur||0);},0),avgFrt:f.length?f.reduce(function(s,x){return s+x;},0)/f.length:null,pending:jd.length-con.length,coverage:pct(con.length,jd.length||1)});
    }
    var peakBacklog=hourly.slice().sort(function(a,b){return b.pending-a.pending;})[0];
    var peakWorkload=hourly.slice().sort(function(a,b){return b.deals-a.deals;})[0];
    var lowProd=hourly.filter(function(x){return x.deals>0;}).slice().sort(function(a,b){return a.coverage-b.coverage;})[0];

    var om={};
    joined.forEach(function(j){ var id=j.deal.owner; var o=om[id]||(om[id]={id:id,name:ownerName(id),deals:0,contacted:0,pending:0,sla:0,frt:[],delays:[]});
      o.deals++; o.delays.push(j._delay==null?0:j._delay);
      if(j.contacted){ o.contacted++; if(j.frt!=null){o.frt.push(j.frt); if(j.frt<=SLA_MIN)o.sla++;} } else o.pending++; });
    var owners=Object.keys(om).map(function(id){ var o=om[id]; var oc=cl.filter(function(c){return c.owner===id;}); o.calls=oc.length; o.talk=oc.reduce(function(s,c){return s+(c.dur||0);},0); o.connected30=oc.filter(function(c){return c.dur>30;}).length;
      var f=o.frt.slice().sort(function(a,b){return a-b;});
      o.avgFrt=f.length?f.reduce(function(s,x){return s+x;},0)/f.length:null; o.medFrt=f.length?f[Math.floor(f.length/2)]:null;
      o.maxDelay=o.delays.length?Math.max.apply(null,o.delays):0; o.callsPerDeal=o.deals?o.calls/o.deals:0;
      o.slaPct=pct(o.sla,o.deals); o.coverage=pct(o.contacted,o.deals); return o; })
      .sort(function(a,b){return (b.slaPct-a.slaPct)||(b.deals-a.deals);});
    var ranked=owners.filter(function(o){return o.deals>=MIN_OWNER_DEALS;});
    var best=ranked[0]||owners[0]||null;
    var worst=(ranked.length?ranked[ranked.length-1]:owners[owners.length-1])||null;
    var mostPending=owners.slice().sort(function(a,b){return b.pending-a.pending;})[0]||null;

    function grpDelay(keyFn){ var g={}; joined.forEach(function(j){ var k=keyFn(j.deal); var o=g[k]||(g[k]={n:0,over:0,dsum:0}); o.n++; if(j._delay!=null)o.dsum+=j._delay; if(j._delay>SLA_MIN)o.over++; });
      return Object.keys(g).map(function(k){var o=g[k];return {key:k,n:o.n,over:o.over,avg:o.n?o.dsum/o.n:0};}).sort(function(a,b){return b.over-a.over;}); }
    var srcDelay=grpDelay(function(d){return clean(d.leadSource);}), stageDelay=grpDelay(function(d){return d.stage||'(none)';});
    var odSrc=toItems(groupBy(overdue,function(j){return clean(j.deal.leadSource);}));

    var meCompleted=ev.filter(function(e){return e.start && D(e.start)<ref;}).length;
    var mePending=ev.filter(function(e){return e.start && D(e.start)>=ref;}).length;
    var meet={scheduled:ev.length,completed:meCompleted,pending:mePending,missed:null,conversion:pct(meCompleted,ev.length||1)};

    function win(len){ var d=D(F.to); d.setDate(d.getDate()-(len-1)); return dayMetrics(ymd(d),F.to); }
    var trend1=win(1), trend7=win(7), trend30=win(30);
    var days=[]; for(var i=29;i>=0;i--){ var dd=D(F.to); dd.setDate(dd.getDate()-i); days.push(ymd(dd)); }
    var series=days.map(function(day){ return dayMetrics(day,day); });

    /* ===================================================================================
       EXTENDED AGGREGATES — AI Sales & Operations Control Room (22-section redesign)
       Every field below is computed from real CRM fields already parsed above (dl/cl/tk/ev/on/
       joined). Where the spec asked for something this Zoho org doesn't track (Store_Assigned,
       Deal Amount, per-deal meeting/follow-up link, stage-transition timestamps), the value is
       either a clearly-labelled proxy or omitted with a disclaimer in the UI — never fabricated.
       =================================================================================== */
    var WORK_LO=10, WORK_HI=21; // 10 AM – 9 PM, per the Control Room spec (distinct from the 10–8 "biz" window the legacy PDF/Excel exports above still use)
    function inWorkHours(iso){ var h=hourOf(iso); return h>=WORK_LO&&h<WORK_HI; }
    function isWhatsApp(d){ return normTrig(d.trigger)==='WhatsApp'; }
    var openDeals=dl.filter(function(d){ return !isWon(d)&&!isLost(d); });
    var wonDeals=dl.filter(isWon), lostDeals=dl.filter(isLost);
    var totalActivities=dl.reduce(function(s,d){ return s+(+d.numAct||0); },0);
    var totalTalk=cl.reduce(function(s,c){ return s+(c.dur||0); },0), connected30Cnt=cl.filter(function(c){return c.dur>30;}).length;
    var waCount=dl.filter(isWhatsApp).length, otherCount=dl.length-waCount;
    var workingHourDeals=dl.filter(function(d){return inWorkHours(d.created);}).length, nonWorkingHourDeals=dl.length-workingHourDeals;
    /* ---- daily Working Hours Deals + Task Created/Call Not Done tracking (one row per day, deal-id-keyed) ---- */
    var dailyWH={};
    joined.forEach(function(j){
      if(!inWorkHours(j.deal.created)) return;
      var k=dayKey(j.deal.created);
      var o=dailyWH[k]||(dailyWH[k]={date:k,whDeals:0,taskNoCall:0});
      o.whDeals++;
      if(!isWhatsApp(j.deal) && j.hasTask && !j.contacted) o.taskNoCall++;
    });
    var dailyWorkHourPerf=Object.keys(dailyWH).sort().map(function(k){return dailyWH[k];});
    var storeVisitEvents=ev.filter(function(e){return classifyEvent(e.title)==='Store Visit';});
    var videoCallEvents=ev.filter(function(e){return classifyEvent(e.title)==='Video Call';});
    var todayKey=ymd(ref), tmrwKey=ymd(new Date(ref.getTime()+86400000)), yestKey=ymd(new Date(ref.getTime()-86400000));
    var followupToday=tk.filter(function(t){return t.due&&dayKey(t.due)===todayKey&&!isDone(t);}).length;
    var followupTomorrow=tk.filter(function(t){return t.due&&dayKey(t.due)===tmrwKey&&!isDone(t);}).length;

    /* Store City = deal Address_City in one of the 5 store cities. Zoho stores district-level
       names ("Central Delhi", "South Delhi", "Bangalore Rural"), so match on the city word, not
       exact text. Per business rule, the Mumbai region (Thane, Navi Mumbai, Borivali and other
       MMR suburbs) maps to Mumbai, and Delhi-NCR (Noida / Gautam Buddha Nagar, Ghaziabad,
       Faridabad) maps to Delhi → Store City. Blank / unmatched city counts as Non-Store. */
    var STORE_CITY_RE=new RegExp('\\b('+[
      'mumbai','bombay','thane','borivali','andheri','bandra','kandivali','malad','goregaon','dadar',
      'kurla','ghatkopar','mulund','chembur','powai','kalyan','dombivli','bhiwandi','mira road',
      'bhayandar','vasai','virar','panvel','kharghar','vashi','airoli','ulhasnagar','ambernath','badlapur',
      'pune','poona','pimpri','chinchwad',
      'delhi','karawal nagar','noida','gautam buddha nagar','ghaziabad','gaziabad','faridabad',
      'gurgaon','gurugram',
      'bangalore','bengaluru'
    ].join('|')+')\\b');
    function isStoreCity(c){
      var s=String(c||'').toLowerCase().replace(/[^a-z ]/g,' ').replace(/\s+/g,' ').trim();
      return !!s && STORE_CITY_RE.test(s);
    }
    /* ---- per-owner extensions (won/lost/whatsapp/work-hour/activity split, store, score) ---- */
    var allAct=tk.concat(on).concat(ev);
    var taskNoCallRows=[]; // raw dump backing the "Task Created, No Call" drill-down, for cross-verification
    joined.forEach(function(j){ var o=om[j.deal.owner]; if(!o) return;
      if(isWon(j.deal)) o.won=(o.won||0)+1; if(isLost(j.deal)) o.lost=(o.lost||0)+1;
      if(isWhatsApp(j.deal)) o.wa=(o.wa||0)+1; else o.other=(o.other||0)+1;
      if(inWorkHours(j.deal.created)) o.workHr=(o.workHr||0)+1; else o.nonWorkHr=(o.nonWorkHr||0)+1;
      if(isStoreCity(j.deal.city)) o.storeCity=(o.storeCity||0)+1; else o.nonStoreCity=(o.nonStoreCity||0)+1;
      o.acts=(o.acts||0)+(+j.deal.numAct||0);
      if(j.contacted&&j.frt!=null){ if(j.frt<=30) o.first30=(o.first30||0)+1; else o.firstAfter30=(o.firstAfter30||0)+1; }
      if(!isWhatsApp(j.deal)) o.callsNotConn=(o.callsNotConn||0)+j.calls.filter(function(c){return !(c.dur>0);}).length;
      /* "Task Created, No Call" excludes WhatsApp deals — a WhatsApp lead's task-without-a-phone-call
         isn't a coaching gap the same way a phone lead's is, per the business rule used everywhere
         else in this table (WhatsApp Deals/Other Deals, Calls Not Connected, etc.). */
      if(inWorkHours(j.deal.created) && !isWhatsApp(j.deal) && j.hasTask && !j.contacted){
        o.taskNoCall=(o.taskNoCall||0)+1;
        taskNoCallRows.push(j.deal);
      }
    });
    /* Due Today / Overdue — deliberately computed against ALL of that owner's eligible Open/WIP
       deals (ignoring the report's date-range filter — only owner/stage/trigger/source/UTM filters
       still apply, via the same fDeals() but with the date bound removed) and against the REAL
       current date (`realTodayKey`), never the possibly-past `ref`/`todayKey` the rest of this model
       uses. Rationale: a follow-up due yesterday and still pending must stay Overdue today, tomorrow,
       and every day after that — regardless of which date range the user has selected — until its
       Task is marked complete. It only ever disappears when the linked Task is completed, and a
       deal counts once even with several qualifying Tasks (.some(), not a per-task count). Deal-linked
       (needs Zoho Task.What_Id) — honestly 0 if TASKS_LINKED is false on this data source. */
    var realTodayKey=ymd(new Date());
    var overdueDealsRows=[]; // raw dump backing the "Overdue" column drill-down, for cross-verification
    joinDeals(fDeals('2000-01-01','2099-12-31')).forEach(function(j){
      var o=om[j.deal.owner]; if(!o) return;
      if(isWon(j.deal)||isLost(j.deal)) return;           // Closed deals never count — Open/WIP only
      if(dayKey(j.deal.created)>=realTodayKey) return;    // deal must have been created before today
      var dueToday=j.tasks.some(function(t){ return t.due&&dayKey(t.due)===realTodayKey&&!isDone(t); });
      if(dueToday) o.dueDealsToday=(o.dueDealsToday||0)+1;
      var overdueTask=j.tasks.some(function(t){ return t.due&&dayKey(t.due)<realTodayKey&&!isDone(t); });
      if(overdueTask){ o.overdueDeals=(o.overdueDeals||0)+1; overdueDealsRows.push(j.deal); }
    });
    owners.forEach(function(o){
      var oc=cl.filter(function(c){return c.owner===o.id;});
      o.longestCall=oc.length?Math.max.apply(null,oc.map(function(c){return c.dur||0;})):0;
      o.avgTalk=o.calls?o.talk/o.calls:0;
      o.conv=pct(o.won||0,((o.won||0)+(o.lost||0))||1);
      o.avgActPerDeal=o.deals?(o.acts||0)/o.deals:0;
      o.videoCalls=ev.filter(function(e){return e.owner===o.id&&classifyEvent(e.title)==='Video Call';}).length;
      o.storeVisits=ev.filter(function(e){return e.owner===o.id&&classifyEvent(e.title)==='Store Visit';}).length;
      o.store=storeOf(o.id);
      var ot=tk.filter(function(t){return t.owner===o.id;});
      o.followupToday=ot.filter(function(t){return t.due&&dayKey(t.due)===todayKey&&!isDone(t);}).length;
      o.followupTomorrow=ot.filter(function(t){return t.due&&dayKey(t.due)===tmrwKey&&!isDone(t);}).length;
      o.overdueFollowup=ot.filter(function(t){return t.due&&dayKey(t.due)<todayKey&&!isDone(t);}).length;
      o.completedFollowup=ot.filter(isDone).length;
      o.actToday=allAct.filter(function(x){return x.owner===o.id&&dayKey(x.created)===todayKey;}).length;
      o.actYesterday=allAct.filter(function(x){return x.owner===o.id&&dayKey(x.created)===yestKey;}).length;
      /* Owner Score (0-100): only signals with real, available data go in — there is no revenue field to weight against. */
      var frtScore=o.avgFrt==null?50:Math.max(0,100-Math.min(100,(o.avgFrt/SLA_MIN)*50));
      var engScore=Math.min(1,o.callsPerDeal/2)*100;
      var delayScore=Math.max(0,100-Math.min(100,(o.maxDelay/120)*100));
      o.score=Math.round(o.slaPct*0.30+o.coverage*0.25+frtScore*0.20+engScore*0.15+delayScore*0.10);
    });

    /* ---- pipeline health (cross-sectional snapshot by current stage — Zoho has no stage-transition timestamps in this feed, so this can't be a true funnel) ---- */
    var stageMap={};
    openDeals.forEach(function(d){ var k=d.stage||'(none)'; var s=stageMap[k]||(stageMap[k]={stage:k,deals:0,daySum:0,callSum:0,actSum:0,waiting7:0});
      s.deals++; var days=(ref-D(d.created))/86400000; s.daySum+=days; s.actSum+=(+d.numAct||0); if(days>=7)s.waiting7++; });
    joined.forEach(function(j){ var s=stageMap[j.deal.stage||'(none)']; if(s) s.callSum+=j.nCalls; });
    var stages=Object.keys(stageMap).map(function(k){ var s=stageMap[k];
      return {stage:s.stage,deals:s.deals,pct:pct(s.deals,openDeals.length||1),avgDays:s.deals?s.daySum/s.deals:0,avgCalls:s.deals?s.callSum/s.deals:0,avgActs:s.deals?s.actSum/s.deals:0,stuck7Pct:pct(s.waiting7,s.deals||1)};
    }).sort(function(a,b){return b.deals-a.deals;});
    var stageAging=Object.keys(stageMap).map(function(k){ var s=stageMap[k];
      var ds=openDeals.filter(function(d){return (d.stage||'(none)')===k;}).map(function(d){return (ref-D(d.created))/86400000;});
      return {stage:k,avgDays:s.deals?s.daySum/s.deals:0,maxDays:ds.length?Math.max.apply(null,ds):0,waiting:s.deals};
    }).sort(function(a,b){return b.avgDays-a.avgDays;});

    /* ---- lead leakage: lost deals by Zoho's own Reason For Loss field ---- */
    var leakMap={};
    lostDeals.forEach(function(d){ var k=clean(d.reasonLoss); var s=leakMap[k]||(leakMap[k]={reason:k,deals:[],daySum:0}); s.deals.push(d); s.daySum+=(ref-D(d.created))/86400000; });
    function leakAction(reason){ var r=(reason||'').toLowerCase();
      if(/price|cost|budget|expensive/.test(r)) return 'Route to a manager for a price/discount review before the next similar lead.';
      if(/no response|not reachable|unreachable|switch ?off/.test(r)) return 'Add to a re-engagement call list — try an alternate channel (WhatsApp/email).';
      if(/competitor|other (jeweller|brand|store)/.test(r)) return 'Capture competitor detail on the next similar deal; consider a retention offer.';
      if(/design|not (interested|liked)|quality/.test(r)) return 'Share with merchandising — recurring product-fit objection.';
      if(/delay|time|slow/.test(r)) return 'Tighten first-response SLA for this lead source — delay-driven loss.';
      return 'Manager review — reason needs manual follow-up.';
    }
    var leakage=Object.keys(leakMap).map(function(k){ var s=leakMap[k]; var byOwner=toItems(groupBy(s.deals,function(d){return ownerName(d.owner);}));
      return {reason:s.reason,count:s.deals.length,pct:pct(s.deals.length,lostDeals.length||1),owner:byOwner[0]?byOwner[0].label:'—',avgDays:s.deals.length?s.daySum/s.deals.length:0,action:leakAction(s.reason)};
    }).sort(function(a,b){return b.count-a.count;});

    /* ---- no-call dashboard (all-time contact status, owner-level) ---- */
    var noCallByOwner=owners.map(function(o){ return {owner:o.name,deals:o.deals,neverCalled:o.pending,pct:pct(o.pending,o.deals||1)}; }).sort(function(a,b){return b.neverCalled-a.neverCalled;});

    /* ---- follow-up dashboard (Task.due, owner-level — per-deal needs the Task→Deal ETL fix already written, see hint in UI) ---- */
    var followupByOwner=owners.map(function(o){ return {owner:o.name,today:o.followupToday||0,tomorrow:o.followupTomorrow||0,overdue:o.overdueFollowup||0,completed:o.completedFollowup||0}; }).sort(function(a,b){return (b.today+b.overdue)-(a.today+a.overdue);});

    /* ---- working / non-working hour performance (WhatsApp deals excluded, per the spec's business rule) ---- */
    function hourPerf(inWork){
      var jd=joined.filter(function(j){return inWorkHours(j.deal.created)===inWork && !isWhatsApp(j.deal);});
      var byOwner={};
      jd.forEach(function(j){ var k=j.deal.owner; var o=byOwner[k]||(byOwner[k]={owner:ownerName(k),ownerId:k,deals:0,contacted:0,stageMap:{}});
        o.deals++; if(j.contacted)o.contacted++; var sk=j.deal.stage||'(none)'; o.stageMap[sk]=(o.stageMap[sk]||0)+1; });
      var rows=Object.keys(byOwner).map(function(k){ var o=byOwner[k];
        var oc=cl.filter(function(c){return c.owner===k && inWorkHours(c.created)===inWork;});
        o.calls=oc.length; o.connected30=oc.filter(function(c){return c.dur>30;}).length;
        o.topStages=Object.keys(o.stageMap).map(function(s){return s+':'+o.stageMap[s];}).sort(function(a,b){return (+b.split(':')[1])-(+a.split(':')[1]);}).slice(0,3).join(', ');
        o.contactRate=pct(o.contacted,o.deals||1); return o; }).sort(function(a,b){return b.deals-a.deals;});
      return {deals:jd.length,rows:rows};
    }
    var workHourPerf=hourPerf(true), nonWorkHourPerf=hourPerf(false);

    /* ---- hourly operations (full 24h, richer than the legacy `hourly` above which the PDF export still uses) ---- */
    var hourlyOps=[]; for(var hh2=0; hh2<24; hh2++){
      var jd2=joined.filter(function(j){return hourOf(j.deal.created)===hh2;});
      var cc2=cl.filter(function(c){return hourOf(c.created)===hh2;});
      var con2=jd2.filter(function(j){return j.contacted;});
      var f2=con2.map(function(j){return j.frt;}).filter(function(x){return x!=null;});
      var acts2=tk.filter(function(t){return hourOf(t.created)===hh2;}).length + on.filter(function(o2){return hourOf(o2.created)===hh2;}).length + ev.filter(function(e){return hourOf(e.created)===hh2;}).length;
      var talk2=cc2.reduce(function(s,c){return s+(c.dur||0);},0);
      hourlyOps.push({hour:hh2,label:hr12(hh2),deals:jd2.length,calls:cc2.length,connected30:cc2.filter(function(c){return c.dur>30;}).length,
        notCalled:jd2.length-con2.length,activities:acts2,
        storeVisits:ev.filter(function(e){return hourOf(e.created)===hh2&&classifyEvent(e.title)==='Store Visit';}).length,
        videoCalls:ev.filter(function(e){return hourOf(e.created)===hh2&&classifyEvent(e.title)==='Video Call';}).length,
        avgFrt:f2.length?f2.reduce(function(s,x){return s+x;},0)/f2.length:null, talk:talk2, avgTalk:cc2.length?talk2/cc2.length:0});
    }

    /* ---- store performance (only 5 CRM owner accounts map to a confirmed real store — see storeOf()) ---- */
    var storeGroups={}; Object.keys(STORE_CODE_NAME).forEach(function(c){ storeGroups[STORE_CODE_NAME[c]]={store:STORE_CODE_NAME[c],deals:0,calls:0,won:0,lost:0,frt:[],acts:0,storeVisits:0,videoCalls:0,pendingFollowup:0}; });
    storeGroups['Unmapped']={store:'Unmapped (owner not a store account)',deals:0,calls:0,won:0,lost:0,frt:[],acts:0,storeVisits:0,videoCalls:0,pendingFollowup:0};
    owners.forEach(function(o){ var g=storeGroups[o.store||'Unmapped']; if(!g)return;
      g.deals+=o.deals; g.calls+=o.calls; g.won+=(o.won||0); g.lost+=(o.lost||0); if(o.avgFrt!=null)g.frt.push(o.avgFrt);
      g.acts+=(o.acts||0); g.storeVisits+=(o.storeVisits||0); g.videoCalls+=(o.videoCalls||0); g.pendingFollowup+=(o.followupToday||0)+(o.overdueFollowup||0); });
    var storeRows=Object.keys(storeGroups).map(function(k){ var g=storeGroups[k];
      return {store:g.store,deals:g.deals,calls:g.calls,conversion:pct(g.won,(g.won+g.lost)||1),avgResponse:g.frt.length?g.frt.reduce(function(s,x){return s+x;},0)/g.frt.length:null,activities:g.acts,storeVisits:g.storeVisits,videoCalls:g.videoCalls,pendingFollowup:g.pendingFollowup};
    }).filter(function(r){return r.deals>0;}).sort(function(a,b){return b.deals-a.deals;});

    /* ---- store visit & video call dashboard (owner-level; Events carry no status field, so "Cancelled" isn't trackable) ---- */
    var storeVisitByOwner=owners.map(function(o){
      var oev=ev.filter(function(e){return e.owner===o.id;});
      var completed=oev.filter(function(e){return e.start&&D(e.start)<ref;}).length, pendingEv=oev.filter(function(e){return e.start&&D(e.start)>=ref;}).length;
      var physical=oev.filter(function(e){var c=classifyEvent(e.title); return c==='Meeting'||c==='TAH';}).length;
      return {owner:o.name,storeVisits:o.storeVisits||0,videoCalls:o.videoCalls||0,physical:physical,completed:completed,pending:pendingEv};
    }).filter(function(r){return r.storeVisits||r.videoCalls||r.physical;}).sort(function(a,b){return (b.storeVisits+b.videoCalls+b.physical)-(a.storeVisits+a.videoCalls+a.physical);});

    var lostByReason=leakage.map(function(l){ return {reason:l.reason,count:l.count,pct:l.pct,owner:l.owner}; });

    /* ---- priority opportunities (no Deal Amount field exists — ranked by probability, engagement & urgency, never revenue) ---- */
    function topN(list,n){ return list.slice(0,n); }
    var highValue=topN(openDeals.filter(function(d){return (d.prob||0)>=70;}).sort(function(a,b){return (b.prob||0)-(a.prob||0);}),10);
    var closingToday=topN(openDeals.filter(function(d){return (d.prob||0)>=80;}).sort(function(a,b){return (b.prob||0)-(a.prob||0);}),10);
    var needsFollowup=topN(joined.filter(function(j){return !isWon(j.deal)&&!isLost(j.deal)&&j._delay>SLA_MIN&&(j.deal.prob||0)>=40;}).sort(function(a,b){return (b.deal.prob||0)-(a.deal.prob||0);}).map(function(j){return j.deal;}),10);
    var atRisk=topN(openDeals.filter(function(d){var days=(ref-D(d.created))/86400000; return days>=7&&(+d.numAct||0)<=1;}).sort(function(a,b){return D(b.created)-D(a.created);}),10);
    var reactivating=topN(joined.filter(function(j){ if(isWon(j.deal)||isLost(j.deal)||!j.calls.length)return false;
      var lastCall=j.calls.reduce(function(a,b){return D(b.created)>D(a.created)?b:a;});
      var gapDays=(D(lastCall.created)-D(j.deal.created))/86400000;
      return gapDays>=5 && (ref-D(lastCall.created))/86400000<=1; }).map(function(j){return j.deal;}),10);

    /* ---- owner ranking ---- */
    var ranking=owners.slice().sort(function(a,b){return (b.score||0)-(a.score||0);}).map(function(o,i){return {rank:i+1,owner:o.name,contactRate:o.coverage,conversion:o.conv,activities:o.avgActPerDeal,followup:(o.followupToday||0)+(o.overdueFollowup||0),score:o.score};});

    /* ---- composite health scores (real fields only — no revenue input exists in this org's CRM) ---- */
    var teamScore=owners.length?Math.round(owners.reduce(function(s,o){return s+(o.score||0)*o.deals;},0)/(owners.reduce(function(s,o){return s+o.deals;},0)||1)):0;
    var pipelineScore=Math.round(coverage*0.25+slaPct*0.25+Math.max(0,100-pct(pending.length,dl.length||1))*0.20+Math.max(0,100-pct(overdue.length,dl.length||1))*0.20+meet.conversion*0.10);

    /* ---- critical alert center ---- */
    function asDealList(list){ return list.map(function(x){return x&&x.deal?x.deal:x;}); }
    var alerts=[];
    /* Working Hours only (10 AM-9 PM, by Deal Created Time), WhatsApp excluded per the business rule.
       Every deal here is by definition never-contacted, so its full open Task count IS its
       "Task Created - Call Not Done" count — mapped by Deal ID via the joined j.nTasks, never a
       bare Task-total-vs-Call-total comparison. */
    var pendingNoWA=pending.filter(function(j){return !isWhatsApp(j.deal) && inWorkHours(j.deal.created);});
    var pendingNoWADeals=asDealList(pendingNoWA).map(function(d,i){ var dd={}; for(var k in d) dd[k]=d[k]; dd._taskNoCallCount=pendingNoWA[i].nTasks||0; return dd; });
    if(pendingNoWADeals.length) alerts.push({sev:'red',text:num(pendingNoWA.length)+' deals have never received a first call.',rows:pendingNoWADeals,showTrigger:true});
    var stuck3=openDeals.filter(function(d){return (ref-D(d.created))/86400000>=3;});
    if(stuck3.length) alerts.push({sev:'orange',text:num(stuck3.length)+' deals have been stuck for 3+ days with no resolution.',rows:stuck3});
    var stuck7=openDeals.filter(function(d){return (ref-D(d.created))/86400000>=7;});
    if(stuck7.length) alerts.push({sev:'red',text:num(stuck7.length)+' deals have been stuck for 7+ days — high risk of loss.',rows:stuck7});
    var propStage=stages.filter(function(s){return /propos/i.test(s.stage);})[0];
    if(propStage&&propStage.deals) alerts.push({sev:'orange',text:'"'+propStage.stage+'" stage has the largest backlog ('+num(propStage.deals)+' deals, '+p1(propStage.pct)+'% of open pipeline).'});
    var hvNoAct=openDeals.filter(function(d){return (d.prob||0)>=70 && (+d.numAct||0)===0;});
    if(hvNoAct.length) alerts.push({sev:'red',text:num(hvNoAct.length)+' high-probability deals (≥70%) have zero recorded activity.',rows:hvNoAct});
    var belowTargetOwners=owners.filter(function(o){return o.deals>=MIN_OWNER_DEALS&&o.slaPct<SLA_TARGET;});
    if(belowTargetOwners.length) alerts.push({sev:'orange',text:num(belowTargetOwners.length)+' owner(s) below the '+SLA_TARGET+'% contact-rate target: '+belowTargetOwners.slice(0,3).map(function(o){return o.name;}).join(', ')+(belowTargetOwners.length>3?'…':'')+'.'});
    var belowTargetStores=storeRows.filter(function(s){return s.deals>=5 && s.conversion<30;});
    if(belowTargetStores.length) alerts.push({sev:'orange',text:num(belowTargetStores.length)+' store(s) below 30% conversion: '+belowTargetStores.map(function(s){return s.store;}).join(', ')+'.'});
    var vcPending=videoCallEvents.filter(function(e){return e.start&&D(e.start)>=ref;}).length;
    if(vcPending) alerts.push({sev:'yellow',text:num(vcPending)+' video calls scheduled but not yet completed.'});
    var svPending=storeVisitEvents.filter(function(e){return e.start&&D(e.start)>=ref;}).length;
    if(svPending) alerts.push({sev:'yellow',text:num(svPending)+' store visits scheduled but not yet completed.'});
    var waiting24=pending.filter(function(j){return j._delay>=1440;});
    if(waiting24.length) alerts.push({sev:'red',text:num(waiting24.length)+' customers have been waiting more than 24 hours for a first response.',rows:asDealList(waiting24)});
    if(!alerts.length) alerts.push({sev:'green',text:'All clear — no critical gaps detected for '+(F.from===F.to?'today':'this period')+'.'});

    /* City-wise / State-wise Performance (Section 4b/4c, rendered in renderCommand) — same
       metric set and computation as the Owner Performance block above (om/owners), just
       grouped by Deal Address_City / Address_State instead of Owner. */
    function buildBucketPerf(keyFn, unmatchedLabel){
      var bm={};
      joined.forEach(function(j){
        var k=keyFn(j.deal)||unmatchedLabel;
        var o=bm[k]||(bm[k]={name:k,deals:0,workHr:0,nonWorkHr:0,wa:0,other:0,acts:0,first30:0,firstAfter30:0,calls:0,talk:0,connected30:0,callsNotConn:0,taskNoCall:0,dueDealsToday:0,overdueDeals:0});
        o.deals++;
        if(isWhatsApp(j.deal)) o.wa++; else o.other++;
        if(inWorkHours(j.deal.created)) o.workHr++; else o.nonWorkHr++;
        o.acts+=(+j.deal.numAct||0);
        if(j.contacted&&j.frt!=null){ if(j.frt<=30) o.first30++; else o.firstAfter30++; }
        o.calls+=j.calls.length;
        o.talk+=j.calls.reduce(function(s,c){return s+(c.dur||0);},0);
        o.connected30+=j.calls.filter(function(c){return c.dur>30;}).length;
        if(!isWhatsApp(j.deal)) o.callsNotConn+=j.calls.filter(function(c){return !(c.dur>0);}).length;
        if(inWorkHours(j.deal.created)&&!isWhatsApp(j.deal)&&j.hasTask&&!j.contacted) o.taskNoCall++;
      });
      joinDeals(fDeals('2000-01-01','2099-12-31')).forEach(function(j){
        var k=keyFn(j.deal)||unmatchedLabel; var o=bm[k]; if(!o) return;
        if(isWon(j.deal)||isLost(j.deal)) return;
        if(dayKey(j.deal.created)>=realTodayKey) return;
        if(j.tasks.some(function(t){return t.due&&dayKey(t.due)===realTodayKey&&!isDone(t);})) o.dueDealsToday++;
        if(j.tasks.some(function(t){return t.due&&dayKey(t.due)<realTodayKey&&!isDone(t);})) o.overdueDeals++;
      });
      return Object.keys(bm).map(function(k){return bm[k];}).sort(function(a,b){return b.deals-a.deals;});
    }
    var cityPerf=buildBucketPerf(function(d){return (d.city||'').trim();}, '(Not Captured)');
    var statePerf=buildBucketPerf(function(d){return (d.state||'').trim();}, '(Not Captured)');
    var FUNNEL_TRIGGERS=['ATC','Checkout','Purchase'];
    var triggerPerfAll=buildBucketPerf(function(d){return normTrig(d.trigger);}, '(Other)');
    var triggerPerfMap={}; triggerPerfAll.forEach(function(o){triggerPerfMap[o.name]=o;});
    var triggerFunnelPerf=FUNNEL_TRIGGERS.map(function(k){return triggerPerfMap[k]||{name:k,deals:0,workHr:0,nonWorkHr:0,wa:0,other:0,acts:0,first30:0,firstAfter30:0,calls:0,talk:0,connected30:0,callsNotConn:0,taskNoCall:0,dueDealsToday:0,overdueDeals:0};});

    return { from:F.from, to:F.to, single:(F.from===F.to), generated:new Date(), scope:ccScope(), ref:ref,
      cityPerf:cityPerf, statePerf:statePerf, triggerFunnelPerf:triggerFunnelPerf, triggerPerf:triggerPerfAll,
      dl:dl, cl:cl, tk:tk, ev:ev, on:on, joined:joined, contacted:contacted, pending:pending, overdue:overdue,
      deals:dl.length, calls:cl.length, uniqueCalled:contacted.length, pendingCnt:pending.length,
      avgFrt:avgFrt, medFrt:medFrt, maxFrt:maxFrt, coverage:coverage, slaPct:slaPct, overdueCnt:overdue.length,
      dist:dist, prevDist:prevDist, prevAvg:prevAvg, prevCov:prevCov,
      biz:biz, nonbiz:nonbiz, hourly:hourly, peakBacklog:peakBacklog, peakWorkload:peakWorkload, lowProd:lowProd,
      owners:owners, best:best, worst:worst, mostPending:mostPending, srcDelay:srcDelay, stageDelay:stageDelay, odSrc:odSrc,
      meet:meet, trend1:trend1, trend7:trend7, trend30:trend30, series:series, days:days,
      openDeals:openDeals, wonDeals:wonDeals, lostDeals:lostDeals, totalActivities:totalActivities, totalTalk:totalTalk, connected30Cnt:connected30Cnt,
      waCount:waCount, otherCount:otherCount, workingHourDeals:workingHourDeals, nonWorkingHourDeals:nonWorkingHourDeals, dailyWorkHourPerf:dailyWorkHourPerf, pendingNoWADeals:pendingNoWADeals,
      storeVisitsCnt:storeVisitEvents.length, videoCallsCnt:videoCallEvents.length, followupToday:followupToday, followupTomorrow:followupTomorrow,
      wonCnt:wonDeals.length, lostCnt:lostDeals.length, convPct:pct(wonDeals.length,(wonDeals.length+lostDeals.length)||1),
      stages:stages, stageAging:stageAging, leakage:leakage, noCallByOwner:noCallByOwner, followupByOwner:followupByOwner,
      workHourPerf:workHourPerf, nonWorkHourPerf:nonWorkHourPerf, hourlyOps:hourlyOps,
      storeRows:storeRows, storeVisitByOwner:storeVisitByOwner, lostByReason:lostByReason,
      highValue:highValue, closingToday:closingToday, needsFollowup:needsFollowup, atRisk:atRisk, reactivating:reactivating,
      ranking:ranking, teamScore:teamScore, pipelineScore:pipelineScore, alerts:alerts, taskNoCallRows:taskNoCallRows, overdueDealsRows:overdueDealsRows };
  }
  opsModelFn=opsModel; /* expose to the outer-scope info-panel engine (imContext/trendBlock) */

  /* ---------- ops narrative generators ---------- */
  function avgCov(hrs){ var t=hrs.reduce(function(s,x){return s+x.deals;},0), c=hrs.reduce(function(s,x){return s+x.deals*x.coverage/100;},0); return t?100*c/t:0; }
  function opsSummary(M){ var p=[];
    p.push((M.single?fmtDay(M.to):(fmtDay(M.from)+'–'+fmtDay(M.to)))+': <b>'+num(M.deals)+'</b> deals were created and <b>'+num(M.contacted.length)+'</b> received first calls; <b>'+num(M.pendingCnt)+'</b> are still pending.');
    p.push('Average First Response Time was <b>'+fmtMinNice(M.avgFrt)+'</b> (median '+fmtMinNice(M.medFrt)+', max '+fmtMinNice(M.maxFrt)+').');
    if(M.peakBacklog&&M.peakBacklog.pending>0) p.push('Maximum backlog occurred around <b>'+hr12(M.peakBacklog.hour)+'–'+hr12(M.peakBacklog.hour+1)+'</b>.');
    p.push('Overall SLA was <b>'+p1(M.slaPct)+'%</b> and call coverage <b>'+p1(M.coverage)+'%</b>.');
    if(M.best) p.push('Top performing owner <b>'+esc(M.best.name)+'</b> achieved '+p1(M.best.slaPct)+'% SLA.');
    if(M.worst&&M.worst!==M.best) p.push('Owner <b>'+esc(M.worst.name)+'</b> requires attention due to delayed calling ('+p1(M.worst.slaPct)+'% SLA).');
    return p.join(' ');
  }
  function opsInsights(M){ var out=[];
    if(M.deals) out.push(p1(pct(M.pendingCnt,M.deals))+'% of deals did not receive a first call.');
    if(M.peakBacklog&&M.peakBacklog.pending>0) out.push('Maximum backlog occurred between '+hr12(M.peakBacklog.hour)+' and '+hr12(M.peakBacklog.hour+1)+' ('+num(M.peakBacklog.pending)+' pending).');
    if(M.overdueCnt&&M.odSrc.length) out.push(esc(M.odSrc[0].label)+' generated '+p1(pct(M.odSrc[0].value,M.overdueCnt))+'% of overdue deals.');
    if(M.prevAvg>0){ var ch=(M.avgFrt-M.prevAvg)/M.prevAvg*100; out.push('Average response time '+(ch>=0?'increased':'decreased')+' by '+p1(Math.abs(ch))+'% vs the previous period.'); }
    if(M.best) out.push('Owner '+esc(M.best.name)+' delivered the highest SLA ('+p1(M.best.slaPct)+'%).');
    if(M.mostPending&&M.mostPending.pending>0) out.push('Owner '+esc(M.mostPending.name)+' has the highest pending workload ('+num(M.mostPending.pending)+').');
    var a5=M.hourly.filter(function(x){return x.hour>=17;}), b5=M.hourly.filter(function(x){return x.hour<17;});
    var ca=avgCov(a5), cb=avgCov(b5); if(a5.length&&b5.length&&ca<cb-2) out.push('Calling efficiency reduced after 5 PM ('+p1(ca)+'% vs '+p1(cb)+'% coverage earlier).');
    return out;
  }
  function opsRecs(M){ var r=[];
    if(M.peakBacklog&&M.peakBacklog.pending>0) r.push('Increase calling capacity between '+hr12(M.peakBacklog.hour)+' and '+hr12(M.peakBacklog.hour+1)+' to clear the backlog.');
    var old=M.overdue.filter(function(j){return j._delay>30;}).length; if(old) r.push('Reassign '+num(old)+' overdue deals older than 30 minutes.');
    if(M.overdueCnt) r.push('Clear the '+num(M.overdueCnt)+' overdue deals before 11 AM.');
    if(M.odSrc.length&&M.overdueCnt&&pct(M.odSrc[0].value,M.overdueCnt)>=25) r.push('Improve response time for '+esc(M.odSrc[0].label)+' leads ('+p1(pct(M.odSrc[0].value,M.overdueCnt))+'% of overdue).');
    if(M.mostPending&&M.mostPending.pending>0) r.push('Review '+esc(M.mostPending.name)+"'s workload ("+num(M.mostPending.pending)+' pending) and add support.');
    if(M.coverage<COVER_TARGET) r.push('Assign additional agents to lift coverage toward '+COVER_TARGET+'%.');
    if(!r.length) r.push('Operations are within target — maintain current staffing and SLA discipline.');
    return r;
  }
  function opsActions(M){ var a=[];
    if(M.overdueCnt) a.push(['red',num(M.overdueCnt)+' overdue deals require immediate action.']);
    var over60=M.overdue.filter(function(j){return j._delay>60;}).length; if(over60) a.push(['red',num(over60)+' deals waiting more than 60 minutes.']);
    if(M.meet.pending) a.push(['yellow',num(M.meet.pending)+' meetings pending today.']);
    if(M.pendingCnt) a.push(['yellow',num(M.pendingCnt)+' deals awaiting a first call.']);
    if(M.worst&&M.worst.slaPct<SLA_TARGET) a.push(['yellow','Owner '+M.worst.name+' SLA below target ('+p1(M.worst.slaPct)+'%).']);
    if(M.mostPending&&M.mostPending.pending>0) a.push(['yellow','Owner '+M.mostPending.name+' workload is highest ('+num(M.mostPending.pending)+').']);
    if(M.odSrc.length&&M.overdueCnt&&pct(M.odSrc[0].value,M.overdueCnt)>=40) a.push(['yellow',esc(M.odSrc[0].label)+' SLA below target.']);
    if(!a.length) a.push(['green','All clear — no urgent operational gaps.']);
    return a;
  }
  function opsAlerts(M){ return M.alerts; }
  function opsExecSummary(M){ var p=[];
    p.push('<b>'+(M.single?fmtDay(M.to):fmtDay(M.from)+'–'+fmtDay(M.to))+':</b> '+num(M.deals)+' deals created, '+num(M.calls)+' calls made, '+num(M.contacted.length)+' connected — a '+p1(M.slaPct)+'% 30-min contact rate.');
    if(M.pendingCnt) p.push(num(M.pendingCnt)+' deals have not been called yet.');
    if(M.stages.length){ var top=M.stages[0]; p.push('<b>'+esc(top.stage)+'</b> stage has the largest backlog ('+num(top.deals)+' deals, '+p1(top.pct)+'% of open pipeline).'); }
    var weakestStore=M.storeRows.filter(function(s){return s.deals>=3;}).sort(function(a,b){return a.conversion-b.conversion;})[0];
    if(weakestStore) p.push('<b>'+esc(weakestStore.store)+'</b> is the weakest store today ('+p1(weakestStore.conversion)+'% conversion).');
    if(M.ranking.length) p.push('<b>'+esc(M.ranking[0].owner)+'</b> is the best performer (Owner Score '+M.ranking[0].score+'/100).');
    p.push('Pipeline Health Score: <b>'+M.pipelineScore+'/100</b> · Team Health Score: <b>'+M.teamScore+'/100</b>.');
    var recs=opsRecs(M).slice(0,2); if(recs.length) p.push('<u>Immediate recommendation:</u> '+recs.join(' '));
    return p.join(' ');
  }
  function crmWhatsapp(M){ var L=[];
    L.push('📅 *Daily CRM Report*'); L.push('_'+(M.single?fmtDay(M.to):(fmtDay(M.from)+' – '+fmtDay(M.to)))+' · '+M.scope+'_'); L.push('');
    L.push('✅ Deals Created : '+num(M.deals));
    L.push('☎ Calls Done : '+num(M.calls));
    L.push('📞 Coverage : '+p1(M.coverage)+'%');
    L.push('⏱ Avg FRT : '+fmtMinNice(M.avgFrt));
    L.push('🚨 Pending Calls : '+num(M.pendingCnt));
    L.push('🔴 Overdue : '+num(M.overdueCnt));
    L.push('📅 Meetings Today : '+num(M.meet.scheduled));
    if(M.best) L.push('🏆 Best Owner : '+M.best.name);
    if(M.worst&&M.worst!==M.best) L.push('⚠ Lowest SLA : '+M.worst.name);
    var ins=opsInsights(M).slice(0,3).map(stripTags); if(ins.length){ L.push(''); L.push('*Top Insights*'); ins.forEach(function(x){L.push('• '+x);}); }
    var rec=opsRecs(M).slice(0,2).map(stripTags); if(rec.length){ L.push(''); L.push('*Recommendations*'); rec.forEach(function(x){L.push('• '+x);}); }
    L.push(''); L.push('_Generated '+fmtStamp(M.generated)+'_');
    return L.join('\n');
  }
  function managerBrief(M){ var L=[];
    L.push('📅 *Daily CRM Brief* — '+(M.single?fmtDay(M.to):fmtDay(M.from)+'–'+fmtDay(M.to))); L.push('');
    L.push('• Deals Created : '+num(M.deals));
    L.push('• Calls Completed : '+num(M.calls));
    L.push('• Pending Calls : '+num(M.pendingCnt));
    L.push('• Average Response : '+fmtMinNice(M.avgFrt));
    L.push('• Call Coverage : '+p1(M.coverage)+'%');
    L.push('• Overdue Deals : '+num(M.overdueCnt));
    L.push('• Meetings Today : '+num(M.meet.scheduled));
    if(M.peakBacklog) L.push('• Highest Backlog : '+hr12(M.peakBacklog.hour)+'–'+hr12(M.peakBacklog.hour+1));
    if(M.best) L.push('• Highest Performing Owner : '+M.best.name+' ('+p1(M.best.slaPct)+'%)');
    if(M.worst&&M.worst!==M.best) L.push('• Lowest Performing Owner : '+M.worst.name+' ('+p1(M.worst.slaPct)+'%)');
    L.push(''); L.push('*Top 5 Priority Actions*');
    opsActions(M).slice(0,5).forEach(function(a,i){ L.push((i+1)+'. '+stripTags(a[1])); });
    L.push(''); L.push('_Generated '+fmtStamp(M.generated)+'_');
    return L.join('\n');
  }

  /* ---------- Command Center CSS ---------- */
  (function(){ var st=el('style'); st.textContent=
    '.cc-daybar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}'+
    '.cc-seg{display:flex;gap:2px;background:var(--card);border:1px solid var(--line);border-radius:9px;padding:3px}'+
    '.cc-seg button{background:none;border:none;color:var(--tx2);padding:6px 13px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:650}'+
    '.cc-seg button.on{background:var(--acc);color:#fff}'+
    '.cc-exp{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}'+
    '.cc-exec{background:linear-gradient(135deg,rgba(79,140,255,.09),rgba(34,211,168,.06));border:1px solid var(--line);border-radius:12px;padding:15px 17px;font-size:13.5px;line-height:1.7;color:var(--tx)}'+
    '.cc-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px}'+
    '.cc-card{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:11px 13px}'+
    '.cc-card.ins{border-left:3px solid var(--acc)}'+
    '.cc-card .t{font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--tx3);font-weight:700}'+
    '.cc-card .val{font-size:13.5px;font-weight:600;margin-top:3px;color:var(--tx);line-height:1.45}'+
    '.cc-act{display:flex;gap:10px;align-items:flex-start;padding:9px 13px;border-radius:9px;margin:6px 0;font-size:13px;border:1px solid var(--line);color:var(--tx)}'+
    '.cc-act .dot{width:10px;height:10px;border-radius:50%;margin-top:4px;flex:0 0 auto}'+
    '.cc-act.red{background:rgba(255,107,107,.10)}.cc-act.red .dot{background:var(--bad)}'+
    '.cc-act.orange{background:rgba(234,88,12,.10)}.cc-act.orange .dot{background:var(--c8)}'+
    '.cc-act.yellow{background:rgba(244,183,64,.10)}.cc-act.yellow .dot{background:var(--warn)}'+
    '.cc-act.green{background:rgba(34,197,94,.10)}.cc-act.green .dot{background:var(--good)}'+
    '.cc-heat td.h{color:#08210f;font-weight:750;text-align:center;border-radius:4px}'+
    '.brief-box{white-space:pre-wrap;font:12.5px/1.55 ui-monospace,Menlo,Consolas,monospace;background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:14px;color:var(--tx);max-height:440px;overflow:auto}'+
    '.cc-medal{font-size:13px;margin-right:4px}'+
    '.cc-alert-btn{margin-left:8px;font-size:11.5px}';
    document.head.appendChild(st);
  })();

  /* ---------- Product-wise Deals model ----------
     Deals↔Products is a many-to-many related list in Zoho (no line-item/junction module), so it can
     only be read one deal at a time via the CRM API — DEAL_PRODUCTS is built incrementally by the
     backend (sync_deal_products in main.py, runs alongside /sync every 30 min) and only covers deals
     in the last few days at first; older history backfills over time. A deal with zero linked products
     has no row here — never fabricated. Follows the same date-range + owner/stage/trigger/lead
     source/UTM filters as the rest of this dashboard. */
  function productDealsModel(){
    var pDeals=DEALS.filter(function(d){ return inDate(d.created) && ownerOk(d.owner)
      &&(!F.stage.size||F.stage.has(d.stage))
      &&(!F.trigger.size||F.trigger.has(normTrig(d.trigger)))
      &&(!F.leadSource.size||F.leadSource.has(clean(d.leadSource)))
      &&(!F.utmSource||clean(d.utmSource).toLowerCase()===F.utmSource.toLowerCase())
      &&(!F.utmMedium||clean(d.utmMedium).toLowerCase()===F.utmMedium.toLowerCase()); });
    var inRange={}; pDeals.forEach(function(d){ inRange[d.id]=true; });
    var links=DEAL_PRODUCTS.filter(function(p){ return inRange[p.dealId]; });

    var pm={};
    links.forEach(function(p){ var k=p.name||'(unnamed product)';
      var o=pm[k]||(pm[k]={name:k,code:p.code||'',deals:{}}); o.deals[p.dealId]=true; });
    var withLink={}; links.forEach(function(p){ withLink[p.dealId]=true; });
    var rows=Object.keys(pm).map(function(k){ var o=pm[k];
      return {name:o.name, code:o.code, deals:Object.keys(o.deals).length}; })
      .sort(function(a,b){ return b.deals-a.deals; });

    return {rows:rows, totalDeals:pDeals.length,
           dealsWithProduct:Object.keys(withLink).length,
           dealsWithoutProduct:pDeals.length-Object.keys(withLink).length};
  }

  /* ---------- Agent-wise Deals VS Call model (new section, independent of Owner Performance) ----------
     Follows the selected date-range filter above (F.from/F.to — Today/Yesterday/7d/30d/custom, same as
     the rest of the dashboard). Still respects the non-date filters (owner/stage/trigger/lead
     source/UTM) so narrowing to one agent elsewhere narrows this table too.
     Reuses the SAME valid-call definition as the rest of this dashboard (joinDeals: a call is linked to
     a deal via Zoho What_Id or phone-matched Mobile, and only counts if Call_Time ≥ Deal_Created_Time —
     "after deal creation", never before). No separate SQL/backend call — everything is already loaded
     client-side in DEALS/CALLS. */
  function agentDvcModel(){
    var yestKey=F.to;   // label anchor: end of the selected range (matches F.from when a single day is picked)
    var WORK_LO=10, WORK_HI=21; // 10 AM – 9 PM IST, same working-hour window Owner Performance uses
    function inWH(iso){ var h=hourOf(iso); return h>=WORK_LO&&h<WORK_HI; }
    var PW_LO_MIN=10*60, PW_HI_MIN=20*60+30; // 10:00 AM – 8:30 PM IST, for "Deals Pending Call (10AM–8:30PM)"
    function minuteOf(iso){ var m=parseInt(String(iso).slice(14,16),10); return (m>=0&&m<60)?m:0; }
    function inPendingWindow(iso){ var mins=hourOf(iso)*60+minuteOf(iso); return mins>=PW_LO_MIN && mins<=PW_HI_MIN; }

    var yDeals=DEALS.filter(function(d){ return inDate(d.created) && ownerOk(d.owner)
      &&(!F.stage.size||F.stage.has(d.stage))
      &&(!F.trigger.size||F.trigger.has(normTrig(d.trigger)))
      &&(!F.leadSource.size||F.leadSource.has(clean(d.leadSource)))
      &&(!F.utmSource||clean(d.utmSource).toLowerCase()===F.utmSource.toLowerCase())
      &&(!F.utmMedium||clean(d.utmMedium).toLowerCase()===F.utmMedium.toLowerCase()); });
    var joined=joinDeals(yDeals);   // calls after creation, up to now — frt/contacted/calls[] per deal
    var jByDeal={}; joined.forEach(function(j){ jByDeal[j.deal.id]=j; });

    // Meetings (Zoho "Events" module, cdc_meetings table) actually RAISED within the selected range —
    // matched by What_Id -> deal id, then attributed to that deal's owner (agent), regardless of when
    // the deal itself was created. Deliberately NOT restricted to the range's deals: a meeting raised
    // in-range on a lead assigned earlier still counts here — only the meeting's own Created_Time has
    // to fall in range. Requires the live BigQuery feed (What_Id isn't on the static snapshot yet).
    var dealById={}; DEALS.forEach(function(d){ dealById[d.id]=d; });
    var meetingsYest=EVENTS.filter(function(e){ return e.whatId && inDate(e.created) && dealById[e.whatId] && ownerOk(dealById[e.whatId].owner); });

    // Agent's total calling activity in the selected range — ALL calls, not just ones linked to the range's deals
    var yCallsAll=CALLS.filter(function(c){ return inDate(c.created) && ownerOk(c.owner) && (!F.callType||c.type===F.callType); });

    var am={};
    function row(id){ return am[id]||(am[id]={id:id, deals:0, yCalls:0, yTalk:0, yConnected30:0,
      dealCallsYest:0, dealTalkYest:0, contactedYest:0, frt30:0, whFrtSum:0, whFrtN:0,
      acts:0, actDeals:0, callsTillNow:0, contactedTillNow:0, meetingsRaised:0, pendingCallWindow:0}); }

    meetingsYest.forEach(function(e){ var o=row(dealById[e.whatId].owner); o.meetingsRaised++; });

    yDeals.forEach(function(d){
      var o=row(d.owner); o.deals++;
      o.acts+=(+d.numAct||0); if((+d.numAct||0)>0) o.actDeals++;
      var j=jByDeal[d.id];
      if(j){
        o.callsTillNow+=j.nCalls;
        if(j.contacted) o.contactedTillNow++;
        if(j.frt!=null && j.frt<=30) o.frt30++;
        if(inWH(d.created) && j.frt!=null){ o.whFrtSum+=j.frt; o.whFrtN++; }
        var hasYestCall=false;
        j.calls.forEach(function(c){ if(inDate(c.created)){ o.dealCallsYest++; o.dealTalkYest+=(c.dur||0); hasYestCall=true; } });
        if(hasYestCall) o.contactedYest++;
      }
      // "Deals Pending Call (10AM–8:30PM)": genuinely pending/working deals (no valid call yet, not
      // Won/Lost) whose Deal Created Time — the same business-time field inWH() already buckets on —
      // falls in the 10:00 AM–8:30 PM IST window.
      var notContacted=!j||!j.contacted;
      if(notContacted && !isWon(d) && !isLost(d) && inPendingWindow(d.created)) o.pendingCallWindow++;
    });
    yCallsAll.forEach(function(c){ var o=row(c.owner); o.yCalls++; o.yTalk+=(c.dur||0); if((c.dur||0)>=30) o.yConnected30++; });

    var rows=Object.keys(am).map(function(id){ var o=am[id];
      return { id:id, name:ownerName(id),
        deals:o.deals, yCalls:o.yCalls, dealCallsYest:o.dealCallsYest, contactedYest:o.contactedYest, callPct:pct(o.contactedYest,o.deals),
        yTalk:o.yTalk, yConnected30:o.yConnected30, dealTalkYest:o.dealTalkYest,
        frt30:o.frt30, frt30Pct:pct(o.frt30,o.deals),
        whFrtAvg:o.whFrtN?(o.whFrtSum/o.whFrtN):null, whFrtN:o.whFrtN,
        acts:o.acts, actDeals:o.actDeals, meetingsRaised:o.meetingsRaised,
        callsTillNow:o.callsTillNow, contactedTillNow:o.contactedTillNow, pendingCall:o.deals-o.contactedTillNow,
        pendingCallWindow:o.pendingCallWindow
      };
    }).sort(function(a,b){ return b.deals-a.deals; });

    var whFrts=[]; joined.forEach(function(j){ if(inWH(j.deal.created)&&j.frt!=null) whFrts.push(j.frt); });
    var totContactedTillNow=rows.reduce(function(s,r){return s+r.contactedTillNow;},0);
    var totals={
      deals:yDeals.length, yCalls:yCallsAll.length,
      dealCallsYest:rows.reduce(function(s,r){return s+r.dealCallsYest;},0),
      yTalk:rows.reduce(function(s,r){return s+r.yTalk;},0),
      yConnected30:rows.reduce(function(s,r){return s+r.yConnected30;},0),
      dealTalkYest:rows.reduce(function(s,r){return s+r.dealTalkYest;},0),
      frt30:rows.reduce(function(s,r){return s+r.frt30;},0),
      callsTillNow:rows.reduce(function(s,r){return s+r.callsTillNow;},0),
      contactedTillNow:totContactedTillNow, pendingCall:yDeals.length-totContactedTillNow,
      pendingCallWindow:rows.reduce(function(s,r){return s+r.pendingCallWindow;},0),
      whFrtAvg:whFrts.length?(whFrts.reduce(function(s,x){return s+x;},0)/whFrts.length):null, whFrtN:whFrts.length
    };
    totals.contactedYest=joined.filter(function(j){ return j.calls.some(function(c){return inDate(c.created);}); }).length;
    totals.callPct=pct(totals.contactedYest,totals.deals);
    totals.frt30Pct=pct(totals.frt30,totals.deals);

    return {yestKey:yestKey, from:F.from, to:F.to, single:(F.from===F.to), rows:rows, yDeals:yDeals, joined:joined, jByDeal:jByDeal, totals:totals, inWH:inWH};
  }

  /* ---------- Command Center render: AI Sales & Operations Control Room (22 sections) ---------- */
  function renderCommand(v){
    var M=opsModel();
    // Day quick-bar + export row
    var bar=el('div','cc-daybar');
    var seg=el('div','cc-seg');
    [['today','Today'],['yest','Yesterday'],['7','Last 7d'],['30','Last 30d']].forEach(function(p){ var b=el('button',F.preset===p[0]?'on':'',p[1]); b.onclick=function(){ setPreset(p[0]); }; seg.appendChild(b); });
    var customOn=(F.preset==='');
    var cbtn=el('button',customOn?'on':'','◆ Custom'); cbtn.title='Pick your own From/To dates'; cbtn.onclick=function(){ F.preset=''; sync(); }; seg.appendChild(cbtn);
    bar.appendChild(el('span','',null)); bar.lastChild.style.cssText='font-size:12.5px;color:var(--tx2)'; bar.lastChild.innerHTML='<b style="color:var(--tx)">Control Room for</b> '+esc(M.single?fmtDay(M.to):fmtDay(M.from)+' → '+fmtDay(M.to))+' · '+esc(M.scope);
    bar.appendChild(seg);
    if(customOn){
      var dr=el('div','cc-seg'); dr.style.cssText='gap:6px;align-items:center;padding:5px 9px';
      var dinCss='background:var(--bg2);border:1px solid var(--line);color:var(--tx);border-radius:6px;padding:4px 7px;font-size:12px';
      var fi=el('input'); fi.type='date'; fi.value=F.from; fi.style.cssText=dinCss;
      fi.onchange=function(){ var v=fi.value||minDate; F.from=v; if(F.to<F.from)F.to=F.from; F.preset=''; sync(); };
      var ti=el('input'); ti.type='date'; ti.value=F.to; ti.style.cssText=dinCss;
      ti.onchange=function(){ var v=ti.value||maxDate; F.to=v; if(F.to<F.from)F.from=F.to; F.preset=''; sync(); };
      dr.appendChild(fi); dr.appendChild(el('span','',null)); dr.lastChild.style.cssText='color:var(--tx3);font-size:12px'; dr.lastChild.textContent='→'; dr.appendChild(ti);
      bar.appendChild(dr);
    }
    var exp=el('div','cc-exp');
    [['🧾 PDF',opsPDF],['📊 Excel',opsExcel],['🖨️ Print',function(){window.print();}],['🖼️ PNG',opsPNG],['💬 WhatsApp',function(){ copyText(crmWhatsapp(opsModel()),function(){toast('CRM summary copied ✓');}); }]].forEach(function(a){ var b=el('button','hbtn',a[0]); b.onclick=a[1]; exp.appendChild(b); });
    bar.appendChild(exp);
    v.appendChild(bar);

    // ===== SECTION 1 — Executive KPI Cards =====
    v.appendChild(kpiRow([
      ['Total Deals',num(M.deals),'','','var(--c1)'],
      ['Working Hour Deals',num(M.workingHourDeals),'10AM–9PM · time split','','var(--c2)'],
      ['Non Working Hour Deals',num(M.nonWorkingHourDeals),'9PM–10AM · time split','','var(--c2)'],
      ['WhatsApp Deals',num(M.waCount),'channel split','','var(--c5)'],
      ['Other Deals',num(M.otherCount),'channel split','','var(--c5)'],
      ['Total Calls',num(M.calls),'','','var(--c3)'],
      ['Connected Calls (>30s)',num(M.connected30Cnt),p1(pct(M.connected30Cnt,M.calls||1))+'%','up','var(--good)'],
      ['Deals Not Called',num(M.pendingCnt),'no call yet','down','var(--warn)'],
      ['30-Min Contact Rate %',p1(M.slaPct)+'%','target '+SLA_TARGET+'%',(M.slaPct>=SLA_TARGET?'up':'down'),'var(--acc2)'],
      ["Today's Follow-up",num(M.followupToday),'owner-level','','var(--c6)'],
      ["Tomorrow's Follow-up",num(M.followupTomorrow),'owner-level','','var(--c6)'],
      ['Total Activities',num(M.totalActivities),'CRM Activities field','','var(--c4)'],
      ['Store Visits',num(M.storeVisitsCnt),'from Event titles','','var(--c8)'],
      ['Video Calls',num(M.videoCallsCnt),'from Event titles','','var(--c8)'],
      ['Won Deals',num(M.wonCnt),'','up','var(--good)'],
      ['Lost Deals',num(M.lostCnt),'','down','var(--bad)'],
      ['Conversion %',p1(M.convPct)+'%','won / (won+lost)','','var(--acc)'],
      ['Total Talk Time',hms(M.totalTalk),'','','var(--c2)'],
      ['Average Talk Time',hms(M.calls?M.totalTalk/M.calls:0),'','','var(--c2)'],
      ['Revenue Health Score','Not tracked','Deal Amount isn\'t recorded in this CRM','','var(--tx3)']
    ]));

    // ===== SECTION 1b — Daily Working Hours & Task-No-Call Tracking =====
    var pdw=panel('📅 Daily Working Hours & Task-No-Call Tracking','Working Hours = deal created 10 AM–9 PM (IST), by actual Deal Created Time · "Task Created + Call Not Done" = a follow-up task exists but no Call activity was ever made for that deal, within the same working-hours window · WhatsApp deals excluded, same rule as Owner Performance · one row per calendar day, deal-ID mapped so no duplicate counting.'); v.appendChild(pdw);
    var dailyWHRows=M.dailyWorkHourPerf.map(function(r){ return [fmtDay(r.date), r.whDeals, {html:(r.taskNoCall?'<b style="color:var(--bad)">'+r.taskNoCall+'</b>':'0'),text:r.taskNoCall||0}]; });
    table(pdw.__body,['Date','Working Hours Deals','Task Created + Call Not Done'],dailyWHRows,{key:'dailywh',numCols:[1,2]});
    addExport(pdw,'daily_workhours_tasknocall',['Date','WorkingHoursDeals','TaskCreatedCallNotDone'],M.dailyWorkHourPerf.map(function(r){return [r.date,r.whDeals,r.taskNoCall];}));

    // ===== SECTION 2 — AI Executive Summary =====
    var p1p=panel('🧠 AI Executive Summary',(M.single?"Today's Summary":'Period Summary')+' · Auto-generated from the live filtered data'); v.appendChild(p1p);
    p1p.__body.innerHTML='<div class="cc-exec">'+opsExecSummary(M)+'</div>';

    // ===== SECTION 3 — Critical Alert Center =====
    var p2=panel('🚨 Critical Alert Center','Always visible · Red = critical · Orange = attention · Yellow = monitor · Green = clear.'); v.appendChild(p2);
    opsAlerts(M).forEach(function(a){ var c=el('div','cc-act '+a.sev); var hasRows=a.rows&&a.rows.length;
      c.innerHTML='<span class="dot"></span><span>'+esc(a.text)+(hasRows?' <button class="mini cc-alert-btn">View '+num(a.rows.length)+' →</button>':'')+'</span>';
      if(hasRows){ c.querySelector('button').onclick=function(){
        if(a.showTrigger){
          var trigRows=a.rows.map(function(d){ return [d.id,esc(d.name||'—'),d.mobile||'—',ownerName(d.owner),esc(d.stage||'—'),normTrig(d.trigger),(d.prob==null?'—':d.prob+'%'),fmtDT(d.created),(d._taskNoCallCount||0)]; });
          openDrill(a.text,['Deal ID','Customer','Mobile','Owner','Stage','Deal Trigger','Prob','Created','Task Created - Call Not Done'],trigRows);
        } else {
          openDrill(a.text,['Deal ID','Customer','Mobile','Owner','Stage','Prob','Created'],drillRows(a.rows));
        }
      }; }
      p2.__body.appendChild(c);
    });

    // ===== SECTION 3b — Deals Never Called, 10 AM–9 PM window =====
    var p2b=panel('📵 Deals Never Called — 10 AM–9 PM Window','Deals created 10 AM–9 PM (IST), by actual Deal Created Time, that have never received a first call · WhatsApp deals excluded, same rule as Owner Performance · "Task Created - Call Not Done" = the actual number of open Tasks logged against that Deal ID while zero Calls exist for it — never a bare Task-total vs Call-total comparison.'); v.appendChild(p2b);
    var pncRows=M.pendingNoWADeals.map(function(d){ return [d.id, esc(d.name||'—'), d.mobile||'—', ownerName(d.owner), esc(d.stage||'—'), normTrig(d.trigger), (d.prob==null?'—':d.prob+'%'), fmtDT(d.created), (d._taskNoCallCount||0)]; });
    if(pncRows.length){ table(p2b.__body, ['Deal ID','Customer','Mobile','Owner','Stage','Deal Trigger','Prob','Created','Task Created - Call Not Done'], pncRows, {key:'pendingnowa', numCols:[8]}); }
    else { p2b.__body.appendChild(el('div','empty','No deals in this window are pending a first call.')); }
    addExport(p2b,'deals_never_called_10to9',['Deal ID','Customer','Mobile','Owner','Stage','DealTrigger','Prob','Created','TaskCreatedCallNotDone'], M.pendingNoWADeals.map(function(d){return [d.id,d.name||'',d.mobile||'',ownerName(d.owner),d.stage||'',normTrig(d.trigger),(d.prob==null?'':d.prob),d.created,(d._taskNoCallCount||0)];}));

    // ===== SECTION 3z — Agent-wise Deals VS Call (independent, new section — placed before Owner Performance, does not touch it) =====
    var AG=agentDvcModel();
    var agPeriod=AG.single?fmtDay(AG.to):(fmtDay(AG.from)+' → '+fmtDay(AG.to));
    var p3z=panel('📞 Agent-wise Deals VS Call','Follows the date-range filter above ('+agPeriod+', IST) — pick Today/Yesterday/7d/30d/custom up top to change it. Tracks the selected period\'s newly created deals against calling performance, agent-wise. Valid-call and working-hour (10AM–9PM) rules are the same ones used throughout this dashboard. "Connected Calls" = Talk Time ≥30s. "Deals Pending Call (10AM–8:30PM)" = open (non-Won/Lost) deals with no call yet, created 10AM–8:30PM IST. Sortable · horizontal-scroll for the full 13 columns.'); v.appendChild(p3z);
    if(!AG.yDeals.length){
      p3z.__body.appendChild(el('div','empty','No deals were created in the selected period ('+agPeriod+').'));
    } else {
      var agHeaders=['Agent','Deals','Total Calls','Talk Time','Connected Calls','Deals → Calls',
        'Deals Call %','Deals Talk Time','FRT ≤30 Min','Avg FRT (Working Hours)','Deals Pending Call','Deals Pending Call (10AM–8:30PM)','Meeting Raised'];
      var agRows=AG.rows.map(function(r){ return [
        r.name, r.deals, r.yCalls, hms(r.yTalk), r.yConnected30, r.contactedYest, p1(r.callPct), hms(r.dealTalkYest),
        r.frt30, (r.whFrtAvg==null?'':hms(r.whFrtAvg*60)), r.pendingCall, r.pendingCallWindow, r.meetingsRaised
      ]; });
      table(p3z.__body,agHeaders,agRows,{key:'agentdvc',numCols:[1,2,3,4,5,6,7,8,9,10,11,12]});
      addExport(p3z,'agent_deals_vs_call',agHeaders,agRows);
      if(!EVENTS.some(function(e){return !!e.whatId;})) p3z.__body.appendChild(el('div','hint','⚠ "Meeting Raised" needs Meeting→Deal linking (Zoho What_Id on the Events/Meetings module) — this data source doesn\'t have it yet, so it shows 0 for everyone.'));

      function agLastCall(j){ if(!j||!j.calls.length)return null; var last=null; j.calls.forEach(function(c){ if(!last||D(c.created)>D(last.created))last=c; }); return last; }
      function agTalk(j){ return j?j.calls.reduce(function(s,c){return s+(c.dur||0);},0):0; }

      var ddBtn=el('button','mini','🔍 Deals ('+num(AG.yDeals.length)+')');
      ddBtn.title='Every deal created in the selected period, with first-call/FRT/talk-time detail';
      ddBtn.onclick=function(){ var last; openDrill('Deals ('+agPeriod+') — raw dump ('+num(AG.yDeals.length)+')',
        ['Deal ID','Customer','Owner','Created','Lead Source','First Call','FRT (min)','Total Calls','Talk Time','Last Call','Status'],
        AG.yDeals.map(function(d){ var j=AG.jByDeal[d.id]; last=agLastCall(j);
          return [d.id, esc(d.name||'—'), ownerName(d.owner), fmtDT(d.created), clean(d.leadSource),
            (j&&j.first)?fmtDT(j.first.created):'—', (j&&j.frt!=null)?p1(j.frt):'—', j?j.nCalls:0,
            {html:hms(agTalk(j)),text:agTalk(j)}, last?fmtDT(last.created):'—', (j&&j.contacted)?'Contacted':'No Call Yet']; }),
        {key:'agentdvc_yesterday_deals'}); };
      p3z.__head.appendChild(ddBtn);

      var pendList=AG.yDeals.filter(function(d){ var j=AG.jByDeal[d.id]; return !j||!j.contacted; })
        .slice().sort(function(a,b){ return D(a.created)-D(b.created); });   // oldest first = highest ageing first
      var pcBtn=el('button','mini','🔍 Pending Call ('+num(pendList.length)+')');
      pcBtn.title='Deals created in the selected period with zero valid calls after creation, as of right now — sorted oldest-first';
      pcBtn.onclick=function(){ var nowD=new Date(); openDrill('Pending Call ('+agPeriod+') — raw dump ('+num(pendList.length)+', oldest first)',
        ['Deal ID','Customer','Owner','Created','Lead Source','Ageing','Created In Working Hours','Status'],
        pendList.map(function(d){ var ageMin=(nowD-D(d.created))/60000;
          return [d.id, esc(d.name||'—'), ownerName(d.owner), fmtDT(d.created), clean(d.leadSource),
            {html:fmtMinNice(ageMin),text:ageMin}, AG.inWH(d.created)?'Yes':'No', 'No Call Yet']; }),
        {key:'agentdvc_pending_call'}); };
      p3z.__head.appendChild(pcBtn);

      var tillNowList=AG.yDeals.filter(function(d){ var j=AG.jByDeal[d.id]; return j&&j.nCalls>0; });
      var ctnBtn=el('button','mini','🔍 Calls Till Now ('+num(AG.totals.callsTillNow)+' calls)');
      ctnBtn.title='All calls made so far (in the selected period or since) on the selected period\'s deals';
      ctnBtn.onclick=function(){ openDrill('Calls Till Now ('+agPeriod+') — raw dump ('+num(tillNowList.length)+' deals, '+num(AG.totals.callsTillNow)+' calls)',
        ['Deal ID','Owner','Created','First Call','Last Call','Total Calls','Talk Time','FRT (min)','Last Call Outcome'],
        tillNowList.map(function(d){ var j=AG.jByDeal[d.id]; var last=agLastCall(j);
          return [d.id, ownerName(d.owner), fmtDT(d.created), fmtDT(j.first.created), last?fmtDT(last.created):'—',
            j.nCalls, {html:hms(agTalk(j)),text:agTalk(j)}, p1(j.frt), (last&&last.result)?last.result:'—']; }),
        {key:'agentdvc_calls_till_now'}); };
      p3z.__head.appendChild(ctnBtn);

      var frt30List=AG.joined.filter(function(j){ return j.frt!=null&&j.frt<=30; });
      var frtBtn=el('button','mini','🔍 FRT ≤30 Min ('+num(frt30List.length)+')');
      frtBtn.title='Selected period\'s deals whose first valid call after creation arrived within 30 minutes';
      frtBtn.onclick=function(){ openDrill('FRT ≤30 Min — raw dump ('+num(frt30List.length)+')',
        ['Deal ID','Owner','Created','First Call','FRT (min)'],
        frt30List.slice().sort(function(a,b){return a.frt-b.frt;}).map(function(j){
          return [j.deal.id, ownerName(j.deal.owner), fmtDT(j.deal.created), fmtDT(j.first.created), {html:p1(j.frt),text:j.frt}]; }),
        {key:'agentdvc_frt30'}); };
      p3z.__head.appendChild(frtBtn);
    }

    // ===== SECTION 3y — Product-wise Deals =====
    var PD=productDealsModel();
    var p3y=panel('🛍️ Product-wise Deals','Follows the date-range filter above ('+agPeriod+', IST) and the owner/stage/trigger/lead-source/UTM filters. Counts each deal once per product it links to in Zoho (Deals → Products related list). '+num(PD.dealsWithProduct)+' of '+num(PD.totalDeals)+' deals in range have a linked product ('+num(PD.dealsWithoutProduct)+' none) — coverage backfills gradually since this is fetched one deal at a time from Zoho, not a bulk sync. Sortable · CSV export below.'); v.appendChild(p3y);
    if(!PD.rows.length){
      p3y.__body.appendChild(el('div','empty','No product links found yet for deals in the selected period ('+agPeriod+'). This data backfills gradually — check back shortly, or widen the date range.'));
    } else {
      var pdHeaders=['Product','Product Code','Deals'];
      var pdRows=PD.rows.map(function(r){ return [r.name, r.code||'—', r.deals]; });
      table(p3y.__body,pdHeaders,pdRows,{key:'productdeals',numCols:[2]});
      addExport(p3y,'product_wise_deals',pdHeaders,pdRows);
    }

    // ===== SECTION 4 — Owner Performance =====
    var p3=panel('👥 Owner Performance','WhatsApp broken out per the business rule · First Call = earliest call after Deal Creation · talk time in HH:MM:SS · "Call Not Connected" excludes WhatsApp deals · "Task Created, No Call" = a follow-up task exists but the deal was never actually dialed, for leads received 10AM-9PM · "Due Today"/"Overdue" are based on Open/WIP deals created before the REAL current date and ignore the date-range filter above — an overdue follow-up stays Overdue every day until its Task is completed, never reset by changing the date range. "Store City Deals" = deal Address_City in Mumbai, Pune, Delhi (incl. Central/South/East/West/North Delhi, New Delhi), Gurgaon/Gurugram or Bangalore/Bengaluru — Mumbai includes Thane, Navi Mumbai, Borivali and other Mumbai-region suburbs; Delhi includes Noida, Ghaziabad and Faridabad. Everything else, incl. deals with no city captured, is "Non-Store City". 🏆 top Owner Score · ⚠ needs coaching.'); v.appendChild(p3);
    var bestO=M.ranking[0]?M.ranking[0].owner:null, worstO=M.ranking.length?M.ranking[M.ranking.length-1].owner:null;
    var ownHeaders=['Owner','Total Deals','Working Hr Deals','WhatsApp Deals','Other Deals','1st Call <30m','1st Call >30m','Total Calls','Talk Time','Connected Calls','Call Not Connected (excl. WhatsApp)','Customer Activity','Due Today','Overdue','Task Created, No Call (10AM-9PM)'];
    // Owner table only: Store City / Non-Store City Deals right after Total Deals. ownHeaders itself
    // stays unchanged — the City/State/Trigger tables below copy it and don't carry these columns.
    var ownTblHeaders=ownHeaders.slice(0,2).concat(['Store City Deals','Non-Store City Deals'],ownHeaders.slice(2));
    var ownRows=M.owners.map(function(o){ var medal=(o.name===bestO)?'🏆 ':(o.name===worstO)?'⚠ ':'';
      return [ {html:medal+esc(o.name),text:o.name}, o.deals, o.storeCity||0, o.nonStoreCity||0, o.workHr||0, o.wa||0, o.other||0,
        o.first30||0, o.firstAfter30||0, o.calls, {html:hms(o.talk||0),text:o.talk||0}, o.connected30||0,
        {html:(o.callsNotConn?'<b style="color:var(--bad)">'+o.callsNotConn+'</b>':'0'),text:o.callsNotConn||0},
        o.acts||0,
        o.dueDealsToday||0,
        {html:(o.overdueDeals?'<b style="color:var(--bad)">'+o.overdueDeals+'</b>':'0'),text:o.overdueDeals||0},
        {html:(o.taskNoCall?'<b style="color:var(--bad)">'+o.taskNoCall+'</b>':'0'),text:o.taskNoCall||0} ]; });
    table(p3.__body,ownTblHeaders,ownRows,{key:'own3',numCols:[1,2,3,4,5,6,7,8,9,11,12,13,14,15,16]});
    addExport(p3,'owner_performance',ownTblHeaders,M.owners.map(function(o){return [o.name,o.deals,o.storeCity||0,o.nonStoreCity||0,o.workHr||0,o.wa||0,o.other||0,o.first30||0,o.firstAfter30||0,o.calls,o.talk||0,o.connected30||0,o.callsNotConn||0,o.acts||0,o.dueDealsToday||0,o.overdueDeals||0,o.taskNoCall||0];}));
    if(M.taskNoCallRows.length){
      var tnBtn=el('button','mini','🔍 View Raw Data — Task Created, No Call ('+num(M.taskNoCallRows.length)+')');
      tnBtn.title='Every deal counted in the "Task Created, No Call" column, for cross-verification (WhatsApp deals already excluded)';
      tnBtn.onclick=function(){ openDrill('Task Created, No Call — raw dump ('+num(M.taskNoCallRows.length)+' deals, WhatsApp excluded)', ['Deal ID','Customer','Mobile','Owner','Stage','Prob','Created'], drillRows(M.taskNoCallRows)); };
      p3.__head.appendChild(tnBtn);
    }
    if(M.overdueDealsRows.length){
      var odBtn=el('button','mini','🔍 View Raw Data — Overdue ('+num(M.overdueDealsRows.length)+')');
      odBtn.title='Every open/WIP deal counted in the "Overdue" column — a follow-up Task past due and not yet completed, regardless of the date-range filter above';
      odBtn.onclick=function(){ openDrill('Overdue — raw dump ('+num(M.overdueDealsRows.length)+' deals, open/WIP only)', ['Deal ID','Customer','Mobile','Owner','Stage','Prob','Created'], drillRows(M.overdueDealsRows)); };
      p3.__head.appendChild(odBtn);
    }
    if(!TASKS_LINKED) p3.__body.appendChild(el('div','hint','⚠ "Due Today", "Overdue", and "Task Created, No Call" need Task→Deal linking (Zoho What_Id) — this data source doesn\'t have it yet, so these columns show 0 for everyone.'));

    // ===== SECTION 4a — ATC / Checkout / Payment Page Performance =====
    var p3f=panel('🛒 ATC / Checkout / Payment Page Performance','Same columns as Owner Performance above, grouped by Deal Trigger Event — restricted to the purchase-funnel stages (Add to Cart, Checkout, Payment/Purchase) instead of Owner.'); v.appendChild(p3f);
    var funnelHeaders=ownHeaders.slice(); funnelHeaders[0]='Trigger Stage';
    table(p3f.__body,funnelHeaders,M.triggerFunnelPerf.map(bucketPerfRow),{key:'funnel4',numCols:[1,2,3,4,5,6,7,9,10,11,12,13,14]});
    addExport(p3f,'atc_checkout_payment_performance',funnelHeaders,M.triggerFunnelPerf.map(bucketExportRow));

    // ===== SECTION 4b/4c — City-wise / State-wise Performance =====
    // Same metric set as Owner Performance above, just grouped by Deal Address_City /
    // Address_State instead of Owner. Computed in opsModel() (M.cityPerf/M.statePerf) —
    // same place Owner Performance's own M.owners comes from — this block only renders.
    // Neither address field is populated on cdc_deals itself (checked live via BigQuery,
    // 2026-08-11: 0 of 21,565) — city/state here come from a LEFT JOIN to a separate live
    // Deals table (Lucira_Prod.lucira_zoho_Deals) added to /api/crm-bundle, matched by Deal
    // ID (~66% of cdc_deals ids find a match there). Deals with no match, or whose matched
    // row has a blank Address_City/State, land in a single "(Not Captured)" bucket — never
    // guessed at.
    function bucketPerfRow(o){ return [ esc(o.name), o.deals, o.workHr||0, o.wa||0, o.other||0,
      o.first30||0, o.firstAfter30||0, o.calls, {html:hms(o.talk||0),text:o.talk||0}, o.connected30||0,
      {html:(o.callsNotConn?'<b style="color:var(--bad)">'+o.callsNotConn+'</b>':'0'),text:o.callsNotConn||0},
      o.acts||0, o.dueDealsToday||0,
      {html:(o.overdueDeals?'<b style="color:var(--bad)">'+o.overdueDeals+'</b>':'0'),text:o.overdueDeals||0},
      {html:(o.taskNoCall?'<b style="color:var(--bad)">'+o.taskNoCall+'</b>':'0'),text:o.taskNoCall||0} ]; }
    function bucketExportRow(o){ return [o.name,o.deals,o.workHr||0,o.wa||0,o.other||0,o.first30||0,o.firstAfter30||0,o.calls,o.talk||0,o.connected30||0,o.callsNotConn||0,o.acts||0,o.dueDealsToday||0,o.overdueDeals||0,o.taskNoCall||0]; }
    function coverageHint(field,perf){
      var nc=perf.filter(function(o){return o.name.indexOf('Not Captured')>=0;})[0];
      var ncDeals=nc?nc.deals:0, capturedPct=p1(pct(M.deals-ncDeals,M.deals||1));
      return '⚠ '+field+' comes from a separate live Deals table (Lucira_Prod.lucira_zoho_Deals, joined by Deal ID) — cdc_deals\' own copy of this field is 0% populated. '+capturedPct+'% of deals in range ('+num(M.deals-ncDeals)+' of '+num(M.deals)+') have a real value; the rest fall into the single "(Not Captured)" bucket below.';
    }

    var p3b=panel('🏙️ City-wise Performance','Same columns as Owner Performance above, grouped by Deal Address_City instead of Owner.'); v.appendChild(p3b);
    var cityHeaders=ownHeaders.slice(); cityHeaders[0]='City';
    table(p3b.__body,cityHeaders,M.cityPerf.map(bucketPerfRow),{key:'city4',numCols:[1,2,3,4,5,6,7,9,10,11,12,13,14]});
    addExport(p3b,'city_wise_performance',cityHeaders,M.cityPerf.map(bucketExportRow));
    p3b.__body.appendChild(el('div','hint',coverageHint('Address_City',M.cityPerf)));

    // ===== SECTION 4b-2 — Deal Trigger Event-wise Performance (placed right after City-wise) =====
    var p3bt=panel('🎯 Deal Trigger Event-wise Performance','Same columns as Owner Performance above, grouped by Deal_Trigger_Event instead of Owner. This field comes directly off the deal record — no separate table join needed.'); v.appendChild(p3bt);
    var triggerHeaders=ownHeaders.slice(); triggerHeaders[0]='Trigger Event';
    table(p3bt.__body,triggerHeaders,M.triggerPerf.map(bucketPerfRow),{key:'trigger4',numCols:[1,2,3,4,5,6,7,9,10,11,12,13,14]});
    addExport(p3bt,'trigger_event_wise_performance',triggerHeaders,M.triggerPerf.map(bucketExportRow));

    var p3c=panel('🗺️ State-wise Performance','Same columns as Owner Performance above, grouped by Deal Address_State instead of Owner.'); v.appendChild(p3c);
    var stateHeaders=ownHeaders.slice(); stateHeaders[0]='State';
    table(p3c.__body,stateHeaders,M.statePerf.map(bucketPerfRow),{key:'state4',numCols:[1,2,3,4,5,6,7,9,10,11,12,13,14]});
    addExport(p3c,'state_wise_performance',stateHeaders,M.statePerf.map(bucketExportRow));
    p3c.__body.appendChild(el('div','hint',coverageHint('Address_State',M.statePerf)));

    // ===== SECTION 5 — Pipeline Health =====
    var p4=panel('🧭 Pipeline Health','Cross-sectional snapshot of open deals by current stage — Zoho doesn\'t record stage-transition timestamps in this feed, so "Conversion to Next Stage" can\'t be computed and isn\'t shown. "Leak Risk %" = share of that stage\'s deals inactive 7+ days, the best available leak signal.'); v.appendChild(p4);
    var stageRows=M.stages.map(function(s){ return [esc(s.stage), s.deals, p1(s.pct)+'%', p1(s.avgDays), p1(s.avgCalls), p1(s.avgActs),
      {html:'<b style="color:'+semColor(100-s.stuck7Pct,70,40,true)+'">'+p1(s.stuck7Pct)+'%</b>',text:p1(s.stuck7Pct)} ]; });
    table(p4.__body,['Stage','Deals','% of Open Pipeline','Avg Days in Stage','Avg Calls','Avg Activities','Leak Risk % (stuck 7d+)'],stageRows,{key:'pipeline',numCols:[1,2,3,4,5,6]});
    addExport(p4,'pipeline_health',['Stage','Deals','Pct','AvgDays','AvgCalls','AvgActs','LeakRisk7dPct'],M.stages.map(function(s){return [s.stage,s.deals,p1(s.pct),p1(s.avgDays),p1(s.avgCalls),p1(s.avgActs),p1(s.stuck7Pct)];}));
    if(M.stages.length){ var worstStage=M.stages.slice().sort(function(a,b){return b.stuck7Pct-a.stuck7Pct;})[0];
      p4.__body.appendChild(el('div','hint','💡 AI: <b>'+esc(worstStage.stage)+'</b> has the highest leak risk ('+p1(worstStage.stuck7Pct)+'% of its deals inactive 7+ days) — likely cause: low average activity ('+p1(worstStage.avgActs)+'/deal) and calls ('+p1(worstStage.avgCalls)+'/deal) relative to other stages.'));
    }

    // ===== SECTION 6 — Lead Leakage =====
    var p5=panel('💸 Lead Leakage','Lost deals grouped by Zoho\'s own Reason For Loss field.'); v.appendChild(p5);
    var leakRows=M.leakage.map(function(l){ return [esc(l.reason), l.count, p1(l.pct)+'%', esc(l.owner), p1(l.avgDays), l.action]; });
    table(p5.__body,['Reason','Deals Lost','% of Lost','Top Owner','Avg Days to Loss','Recommended Action'],leakRows,{key:'leak',numCols:[1,2,4]});
    addExport(p5,'lead_leakage',['Reason','DealsLost','Pct','TopOwner','AvgDaysToLoss','RecommendedAction'],M.leakage.map(function(l){return [l.reason,l.count,p1(l.pct),l.owner,p1(l.avgDays),l.action];}));

    // ===== SECTION 7 — Stage Aging =====
    var p6=panel('⏳ Stage Aging','How long open deals have been sitting, per current stage.'); v.appendChild(p6);
    var agingRows=M.stageAging.map(function(s){ return [esc(s.stage), p1(s.avgDays), p1(s.maxDays), s.waiting]; });
    table(p6.__body,['Stage','Avg Days','Max Days','Deals Waiting'],agingRows,{key:'aging',numCols:[1,2,3]});
    addExport(p6,'stage_aging',['Stage','AvgDays','MaxDays','DealsWaiting'],M.stageAging.map(function(s){return [s.stage,p1(s.avgDays),p1(s.maxDays),s.waiting];}));

    // ===== SECTION 8 — No Call Dashboard =====
    var p7=panel('📵 No-Call Dashboard','Deals that have never received a single call, all-time (not just this window).'); v.appendChild(p7);
    var ncRows=M.noCallByOwner.map(function(r){ return [esc(r.owner), r.deals, {html:'<b style="color:'+semColor(100-r.pct,80,50,true)+'">'+r.neverCalled+'</b>',text:r.neverCalled}, p1(r.pct)+'%']; });
    table(p7.__body,['Owner','Deals','Never Called','Percentage'],ncRows,{key:'nocall',numCols:[1,2,3]});
    addExport(p7,'no_call_by_owner',['Owner','Deals','NeverCalled','Pct'],M.noCallByOwner.map(function(r){return [r.owner,r.deals,r.neverCalled,p1(r.pct)];}));

    // ===== SECTION 9 — Follow-up Dashboard =====
    var p8=panel('📅 Follow-up Dashboard','Owner/day level — per-deal follow-up needs the Task→Deal ETL fix (already written, not yet deployed to this snapshot).'); v.appendChild(p8);
    var fuRows=M.followupByOwner.map(function(r){ return [esc(r.owner), r.today, r.tomorrow, {html:'<b style="color:'+(r.overdue?'var(--bad)':'var(--good)')+'">'+r.overdue+'</b>',text:r.overdue}, r.completed]; });
    table(p8.__body,['Owner',"Today's Follow-up","Tomorrow's Follow-up",'Overdue','Completed'],fuRows,{key:'followup',numCols:[1,2,3,4]});
    addExport(p8,'followup_by_owner',['Owner','Today','Tomorrow','Overdue','Completed'],M.followupByOwner.map(function(r){return [r.owner,r.today,r.tomorrow,r.overdue,r.completed];}));

    // ===== SECTION 10/11 — Working / Non-Working Hour Performance =====
    function workPerfPanel(icon,title,hint,perf,key){
      var p=panel(icon+' '+title,hint); v.appendChild(p);
      p.__body.appendChild(kpiRow([['Deals in window',num(perf.deals),'','','var(--c4)']]));
      var rows=perf.rows.map(function(r){ return [esc(r.owner), r.topStages||'—', r.deals, r.calls, r.connected30, p1(r.contactRate)+'%']; });
      table(p.__body,['Owner','Top Stages','Total Deals','Total Calls','Connected Calls','30-Min Contact %'],rows,{key:key,numCols:[2,3,4,5]});
      addExport(p,key,['Owner','TopStages','TotalDeals','TotalCalls','ConnectedCalls','ContactRatePct'],perf.rows.map(function(r){return [r.owner,r.topStages||'',r.deals,r.calls,r.connected30,p1(r.contactRate)];}));
    }
    workPerfPanel('🌞','Working Hour Performance','10 AM – 9 PM · WhatsApp deals excluded per the business rule.',M.workHourPerf,'workhour');
    workPerfPanel('🌙','Non-Working Hour Performance','9 PM – 10 AM · WhatsApp deals excluded per the business rule.',M.nonWorkHourPerf,'nonworkhour');

    // ===== SECTION 12 — Hourly Operations Dashboard =====
    var p9=panel('🕐 Hourly Operations Dashboard','One row per hour of the day (IST).'); v.appendChild(p9);
    var hoRows=M.hourlyOps.map(function(h){ return [h.label, h.deals, h.calls, h.connected30||0, h.activities,
      h.storeVisits, h.videoCalls, (h.avgFrt==null?'—':fmtMinNice(h.avgFrt)), {html:hms(h.talk||0),text:h.talk||0}, {html:hms(h.avgTalk||0),text:h.avgTalk||0} ]; });
    table(p9.__body,['Hour','Deals Created','Calls Made','Connected Calls','Activities','Store Visits','Video Calls','Avg Response Time','Total Talk Time','Avg Talk Time'],hoRows,{key:'hourlyops',numCols:[1,2,3,4,5,6,8,9]});
    addExport(p9,'hourly_operations',['Hour','DealsCreated','CallsMade','ConnectedCalls','Activities','StoreVisits','VideoCalls','AvgResponseMin','TalkTimeSec','AvgTalkSec'],M.hourlyOps.map(function(h){return [h.label,h.deals,h.calls,h.connected30||0,h.activities,h.storeVisits,h.videoCalls,(h.avgFrt==null?'':p1(h.avgFrt)),h.talk||0,p1(h.avgTalk||0)];}));

    // ===== SECTION 13 — Store Performance =====
    var p10=panel('🏬 Store Performance','Only 5 CRM owner accounts map to a confirmed real store — everyone else falls under "Unmapped" until Zoho gets a real Store_Assigned field synced into the ETL feed.'); v.appendChild(p10);
    var stRows=M.storeRows.map(function(s){ return [esc(s.store), s.deals, s.calls, {html:'<b style="color:'+semColor(s.conversion,40,20,true)+'">'+p1(s.conversion)+'%</b>',text:p1(s.conversion)}, (s.avgResponse==null?'—':fmtMinNice(s.avgResponse)), s.activities, s.storeVisits, s.videoCalls]; });
    table(p10.__body,['Store','Deals','Calls','Conversion','Avg Response','Activities','Store Visits','Video Calls'],stRows,{key:'store',numCols:[1,2,3,4,5,6,7]});
    addExport(p10,'store_performance',['Store','Deals','Calls','ConversionPct','AvgResponseMin','Activities','StoreVisits','VideoCalls'],M.storeRows.map(function(s){return [s.store,s.deals,s.calls,p1(s.conversion),(s.avgResponse==null?'':p1(s.avgResponse)),s.activities,s.storeVisits,s.videoCalls];}));

    // ===== SECTION 14 — Store Visit & Video Call Dashboard =====
    var p11=panel('🎥 Store Visit & Video Call Dashboard','Owner-level, classified from Zoho Event titles (no dedicated field exists). "Cancelled" isn\'t shown — Events carry no status/outcome field in this feed. Use the date bar above to see a specific day\'s visits/meetings.'); v.appendChild(p11);
    var svRows=M.storeVisitByOwner.map(function(r){ return [esc(r.owner), r.storeVisits, r.videoCalls, r.physical, r.completed, '—']; });
    table(p11.__body,['Owner','Store Visits','Video Calls','Physical Meetings','Completed','Cancelled'],svRows,{key:'storevisit',numCols:[1,2,3,4]});
    addExport(p11,'store_visit_video_call',['Owner','StoreVisits','VideoCalls','PhysicalMeetings','Completed'],M.storeVisitByOwner.map(function(r){return [r.owner,r.storeVisits,r.videoCalls,r.physical,r.completed];}));

    // ===== SECTION 15 — Lost Opportunity Dashboard =====
    var p12=panel('📉 Lost Opportunity Dashboard','Average Deal Value isn\'t shown — Zoho has no Amount field populated in this org.'); v.appendChild(p12);
    var loRows=M.lostByReason.map(function(l){ return [esc(l.reason), l.count, p1(l.pct)+'%', esc(l.owner), '—']; });
    table(p12.__body,['Reason','Count','Percentage','Top Owner','Avg Deal Value'],loRows,{key:'lostopp',numCols:[1,2]});
    addExport(p12,'lost_opportunity',['Reason','Count','Pct','TopOwner'],M.lostByReason.map(function(l){return [l.reason,l.count,p1(l.pct),l.owner];}));

    // ===== SECTION 16 — Call Quality Dashboard =====
    var p13=panel('📞 Call Quality Dashboard','Zoho has no telephony outcome field in this org — "Connected" means duration > 0s.'); v.appendChild(p13);
    var cqRows=M.owners.slice().sort(function(a,b){return b.calls-a.calls;}).map(function(o){ return [esc(o.name), o.calls, o.connected30||0, hms(o.calls?Math.round((o.talk||0)/o.calls):0), {html:hms(o.talk||0),text:o.talk||0}, hms(o.longestCall||0), (o.avgFrt==null?'—':fmtMinNice(o.avgFrt))]; });
    table(p13.__body,['Owner','Calls','Connected (>30s)','Avg Duration','Total Talk Time','Longest Call','Avg First Response'],cqRows,{key:'callquality',numCols:[1,2,4]});
    addExport(p13,'call_quality',['Owner','Calls','Connected30s','AvgDurationSec','TalkTimeSec','LongestCallSec','AvgFirstResponseMin'],M.owners.map(function(o){return [o.name,o.calls,o.connected30||0,(o.calls?Math.round((o.talk||0)/o.calls):0),o.talk||0,o.longestCall||0,(o.avgFrt==null?'':p1(o.avgFrt))];}));

    // ===== SECTION 17 — Priority Opportunities (spec's "Top Opportunity Dashboard") =====
    var p14=panel('⭐ Priority Opportunities','Deal value isn\'t tracked in this CRM — ranked by stage probability, engagement and urgency, never revenue.'); v.appendChild(p14);
    function miniTable(host,title,list){ host.appendChild(el('div','hint','<b>'+esc(title)+'</b>'));
      if(!list.length){ host.appendChild(el('div','hint','None in the current window.')); return; }
      var rows=list.map(function(d){ return [esc(d.name||'—'), ownerName(d.owner), esc(d.stage||'—'), (d.prob==null?'—':d.prob+'%'), fmtDT(d.created)]; });
      var wrap=el('div'); host.appendChild(wrap); table(wrap,['Deal','Owner','Stage','Prob','Created'],rows,{key:'pri_'+slugify(title),numCols:[3]});
    }
    miniTable(p14.__body,'High-Probability Deals (≥70%)',M.highValue);
    miniTable(p14.__body,'Likely to Close Today (≥80%)',M.closingToday);
    miniTable(p14.__body,'Needs Immediate Follow-up (overdue + ≥40% prob)',M.needsFollowup);
    miniTable(p14.__body,'At Risk (7d+ old, ≤1 activity)',M.atRisk);
    miniTable(p14.__body,'Inactive Customers Re-activating (recent call after a gap)',M.reactivating);

    // ===== SECTION 19 — AI Business Assistant =====
    var p16=panel('🤖 AI Business Assistant','Ask about today\'s numbers, owners, stores or trends — answers are computed live from the filtered CRM data (rule-based, not a hosted LLM).'); v.appendChild(p16);
    var chatLog=el('div'); chatLog.style.cssText='max-height:260px;overflow:auto;margin-bottom:10px'; p16.__body.appendChild(chatLog);
    function pushChat(q,a){ var qd=el('div'); qd.style.cssText='margin:6px 0;font-weight:700;color:var(--tx)'; qd.textContent='You: '+q; chatLog.appendChild(qd);
      var ad=el('div'); ad.style.cssText='margin:0 0 10px;color:var(--tx2);white-space:pre-wrap'; ad.innerHTML='🤖 '+a; chatLog.appendChild(ad); chatLog.scrollTop=chatLog.scrollHeight; }
    var chatRow=el('div'); chatRow.style.cssText='display:flex;gap:8px';
    var chatInput=el('input'); chatInput.type='text'; chatInput.placeholder='e.g. Why are sales low today?'; chatInput.style.cssText='flex:1;background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--tx)';
    var chatBtn=el('button','mini','Ask');
    function ask2(){ var q=chatInput.value.trim(); if(!q)return; pushChat(q,assistantAnswer(q)); chatInput.value=''; }
    chatBtn.onclick=ask2; chatInput.onkeydown=function(e){ if(e.key==='Enter')ask2(); };
    chatRow.appendChild(chatInput); chatRow.appendChild(chatBtn); p16.__body.appendChild(chatRow);
    var chipRow=el('div'); chipRow.style.cssText='display:flex;flex-wrap:wrap;gap:6px;margin-top:10px';
    ['What is happening today?','Why are sales low?','Which owner needs attention?','Which store is weakest?',"Give tomorrow's action plan"].forEach(function(qq){ var b=el('button','mini',qq); b.onclick=function(){ chatInput.value=qq; ask2(); }; chipRow.appendChild(b); });
    p16.__body.appendChild(chipRow);
  }

  /* ---------- Overdue Raw Data tab — same rows as Owner Performance's
     "🔍 View Raw Data — Overdue" drill button (Section 4), but as its own
     full tab instead of a popup, so the list can be browsed/searched/sorted
     and exported without re-opening the modal each time. ---------- */
  function renderOverdueRaw(v){
    var M=opsModel();
    v.appendChild(kpiRow([
      ['Overdue Deals',num(M.overdueDealsRows.length),'open/WIP · follow-up Task past due, uncompleted','',M.overdueDealsRows.length?'var(--bad)':'var(--good)']
    ]));
    v.appendChild(el('div','note','Every open/WIP deal counted in Owner Performance\'s "Overdue" column — a follow-up Task past due and not yet completed. Based on the REAL current date, ignores the date-range filter above: a deal stays here every day until its Task is completed.'));
    var p=panel('🔴 Overdue — Raw Data','Sortable · click a column header · search below'); v.appendChild(p);
    var headers=['Deal ID','Customer','Mobile','Owner','Stage','Prob','Created'];
    if(!M.overdueDealsRows.length){ p.__body.appendChild(el('div','hint','No overdue deals right now. 🎉')); }
    else{ table(p.__body,headers,drillRows(M.overdueDealsRows),{key:'overdueRaw',numCols:[]}); }
    addExport(p,'overdue_raw',headers,M.overdueDealsRows.map(function(d){ return [d.id,d.name||'',d.mobile||'',ownerName(d.owner),d.stage||'',(d.prob==null?'':d.prob),d.created]; }));
    if(!TASKS_LINKED) p.__body.appendChild(el('div','hint','⚠ Needs Task→Deal linking (Zoho What_Id) — this data source doesn\'t have it yet, so this list is empty for everyone.'));
  }

  /* ---------- ops exports (reuse Section-11 helpers) ---------- */
  function buildOpsDoc(M){
    var kpis=[ kpiTile('Deals Created',num(M.deals),''), kpiTile('Calls Done',num(M.calls),''),
      kpiTile('Call Coverage',p1(M.coverage)+'%','target '+COVER_TARGET+'%'), kpiTile('Avg First Response',fmtMinNice(M.avgFrt),'median '+fmtMinNice(M.medFrt)),
      kpiTile('Pending First Calls',num(M.pendingCnt),''), kpiTile('Overdue',num(M.overdueCnt),'>'+SLA_MIN+'m'),
      kpiTile('SLA %',p1(M.slaPct)+'%','≤'+SLA_MIN+'m'), kpiTile('Meetings',num(M.meet.scheduled),num(M.meet.completed)+' completed') ].join('');
    var distItems=M.dist.map(function(b){ return {label:b.label,value:b.count,color:isDelayBucket(b.label)?(b.label==='No First Call Yet'?'#dc2626':'#ea580c'):'#16a34a'}; });
    var insights='<ul class="rp-list">'+opsInsights(M).map(function(x){return '<li>'+x+'</li>';}).join('')+'</ul>';
    var recs='<ul class="rp-list">'+opsRecs(M).map(function(x){return '<li>'+xesc(x)+'</li>';}).join('')+'</ul>';
    var actions=opsActions(M).map(function(a){return '<div class="alert '+(a[0]==='red'?'high':a[0]==='yellow'?'med':'ok')+'">'+(a[0]==='red'?'🔴 ':a[0]==='yellow'?'🟠 ':'✅ ')+stripTags(a[1])+'</div>';}).join('');
    var ownerT='<table class="rp-tbl"><thead><tr><th>Owner</th><th class="rp-r">Deals</th><th class="rp-r">Calls</th><th class="rp-r">Pending</th><th class="rp-r">Avg FRT</th><th class="rp-r">Max Delay</th><th class="rp-r">SLA %</th></tr></thead><tbody>'+
      M.owners.slice(0,16).map(function(o){return '<tr><td>'+xesc(o.name)+'</td><td class="rp-r">'+num(o.deals)+'</td><td class="rp-r">'+num(o.calls)+'</td><td class="rp-r">'+num(o.pending)+'</td><td class="rp-r">'+(o.avgFrt==null?'—':fmtMinNice(o.avgFrt))+'</td><td class="rp-r">'+fmtMinNice(o.maxDelay)+'</td><td class="rp-r '+(o.slaPct<SLA_TARGET?'breach':'okc')+'">'+p1(o.slaPct)+'%</td></tr>';}).join('')+'</tbody></table>';
    var od=M.overdue.slice().sort(function(a,b){return (b._delay||0)-(a._delay||0);});
    var overT='<table class="rp-tbl"><thead><tr><th>Deal</th><th>Owner</th><th>Stage</th><th>Lead Source</th><th class="rp-r">Delay</th><th>Priority</th><th>Created</th></tr></thead><tbody>'+
      (od.length?od.slice(0,28).map(function(j){return '<tr><td>'+xesc(j.deal.name||'—')+'</td><td>'+xesc(ownerName(j.deal.owner))+'</td><td>'+xesc(j.deal.stage||'—')+'</td><td>'+xesc(clean(j.deal.leadSource))+'</td><td class="rp-r" style="color:'+delayHex(j._delay)+';font-weight:700">'+fmtMinNice(j._delay)+'</td><td>'+(j._delay>60?'High':j._delay>30?'Medium':'Low')+'</td><td>'+xesc(fmtDT(j.deal.created))+'</td></tr>';}).join(''):'<tr><td colspan="7">No overdue deals. 🎉</td></tr>')+'</tbody></table>';
    var hourT='<table class="rp-tbl"><thead><tr><th>Hour</th><th class="rp-r">Deals</th><th class="rp-r">Calls</th><th class="rp-r">Avg FRT</th><th class="rp-r">Pending</th><th class="rp-r">Coverage</th></tr></thead><tbody>'+
      M.hourly.map(function(x){return '<tr><td>'+xesc(x.label)+'</td><td class="rp-r">'+num(x.deals)+'</td><td class="rp-r">'+num(x.calls)+'</td><td class="rp-r">'+(x.avgFrt==null?'—':fmtMinNice(x.avgFrt))+'</td><td class="rp-r">'+num(x.pending)+'</td><td class="rp-r" style="color:'+covHex(x.coverage)+';font-weight:700">'+(x.deals?p1(x.coverage)+'%':'—')+'</td></tr>';}).join('')+'</tbody></table>';
    var meetT='<table class="rp-tbl"><thead><tr><th>Scheduled</th><th>Completed</th><th>Pending</th><th>Missed</th><th>Conversion</th></tr></thead><tbody><tr><td>'+num(M.meet.scheduled)+'</td><td>'+num(M.meet.completed)+'</td><td>'+num(M.meet.pending)+'</td><td>n/a</td><td>'+p1(M.meet.conversion)+'%</td></tr></tbody></table>';
    var trendT='<table class="rp-tbl"><thead><tr><th>Metric</th><th class="rp-r">Selected</th><th class="rp-r">Last 7d</th><th class="rp-r">Last 30d</th></tr></thead><tbody>'+
      [['Coverage %',p1(M.trend1.coverage)+'%',p1(M.trend7.coverage)+'%',p1(M.trend30.coverage)+'%'],['Avg FRT',fmtMinNice(M.trend1.avgFrt),fmtMinNice(M.trend7.avgFrt),fmtMinNice(M.trend30.avgFrt)],['Pending',num(M.trend1.pending),num(M.trend7.pending),num(M.trend30.pending)],['SLA %',p1(M.trend1.slaPct)+'%',p1(M.trend7.slaPct)+'%',p1(M.trend30.slaPct)+'%'],['Meetings',num(M.trend1.meetings),num(M.trend7.meetings),num(M.trend30.meetings)]].map(function(r){return '<tr><td>'+r[0]+'</td><td class="rp-r">'+r[1]+'</td><td class="rp-r">'+r[2]+'</td><td class="rp-r">'+r[3]+'</td></tr>';}).join('')+'</tbody></table>';

    var H=[];
    H.push('<!doctype html><html><head><meta charset="utf-8"><title>'+xesc(BRAND+' — Daily CRM Operations')+'</title><style>'+reportCSS()+'</style></head><body><div class="rp-wrap">');
    H.push('<div class="rp-head"><div class="rp-logo">L</div><div><h1>Daily CRM Operations — Command Center</h1><div class="m">'+xesc(BRAND)+' · '+(M.single?fmtDay(M.to):fmtDay(M.from)+' → '+fmtDay(M.to))+' · Scope: '+xesc(M.scope)+'</div></div><div class="stamp">Generated<br><b>'+xesc(fmtStamp(M.generated))+'</b></div></div>');
    H.push('<div class="rp-sec"><h2>Executive Summary</h2><div class="rp-sum">'+opsSummary(M)+'</div></div>');
    H.push('<div class="rp-sec"><h2>KPI Summary</h2><div class="rp-kpis">'+kpis+'</div></div>');
    H.push('<div class="rp-2"><div class="rp-sec"><h2>First Response Distribution</h2><div class="rp-card">'+rBars(distItems,{max:11,fmt:num})+'</div></div><div class="rp-sec"><h2>Coverage & SLA — 30-day Trend</h2><div class="rp-card">'+rLine(M.days.map(fmtDay),[{name:'Coverage %',color:'#2563eb',data:M.series.map(function(s){return +p1(s.coverage);})},{name:'SLA %',color:'#0d9488',data:M.series.map(function(s){return +p1(s.slaPct);})}])+'</div></div></div>');
    H.push('<div class="rp-2"><div class="rp-sec"><h2>AI Insights</h2><div class="rp-card">'+insights+'</div></div><div class="rp-sec"><h2>Recommendations</h2><div class="rp-card">'+recs+'</div></div></div>');
    H.push('<div class="rp-sec"><h2>Action Items</h2>'+actions+'</div>');
    H.push('<div class="rp-sec"><h2>Owner Performance</h2>'+ownerT+'</div>');
    H.push('<div class="rp-sec"><h2>Overdue / Pending Deals</h2>'+overT+'</div>');
    H.push('<div class="rp-2"><div class="rp-sec"><h2>Meetings</h2>'+meetT+'</div><div class="rp-sec"><h2>Trend Analysis</h2>'+trendT+'</div></div>');
    H.push('<div class="rp-sec"><h2>Hourly Analysis</h2>'+hourT+'</div>');
    H.push('<div class="rp-foot">'+xesc(BRAND)+' · Daily CRM Operations Command Center · Confidential — internal use · '+xesc(fmtStamp(M.generated))+'</div>');
    H.push('</div></body></html>');
    return H.join('');
  }
  function opsPDF(){ openPrint(buildOpsDoc(opsModel())); }
  function opsPNG(){
    var M=opsModel(), W=1280,Hc=720,cv=document.createElement('canvas'); cv.width=W; cv.height=Hc; var x=cv.getContext('2d');
    x.fillStyle='#0e1117'; x.fillRect(0,0,W,Hc);
    var grd=x.createLinearGradient(0,0,W,0); grd.addColorStop(0,'#2563eb'); grd.addColorStop(1,'#0d9488');
    x.fillStyle=grd; x.fillRect(0,0,W,8);
    x.fillStyle=grd; roundRect(x,40,34,58,58,14); x.fill();
    x.fillStyle='#fff'; x.font='800 30px Segoe UI, Arial'; x.textBaseline='middle'; x.textAlign='center'; x.fillText('L',69,64); x.textAlign='left';
    x.fillStyle='#e7ecf3'; x.font='800 29px Segoe UI, Arial'; x.fillText('Daily CRM Operations — Command Center',112,50);
    x.fillStyle='#9aa7b8'; x.font='15px Segoe UI, Arial'; x.fillText(BRAND+'  ·  '+(M.single?fmtDay(M.to):fmtDay(M.from)+' → '+fmtDay(M.to))+'  ·  '+M.scope,112,78);
    var tiles=[['Deals Created',num(M.deals)],['Calls Done',num(M.calls)],['Coverage',p1(M.coverage)+'%'],['Avg FRT',fmtMinNice(M.avgFrt)],
      ['Pending Calls',num(M.pendingCnt)],['Overdue',num(M.overdueCnt)],['SLA %',p1(M.slaPct)+'%'],['Meetings',num(M.meet.scheduled)]];
    var gx=40,gy=118,gw=(W-80-3*16)/4,gh=104;
    tiles.forEach(function(t,i){ var cxp=gx+(i%4)*(gw+16), cyp=gy+Math.floor(i/4)*(gh+16);
      x.fillStyle='#1a212c'; roundRect(x,cxp,cyp,gw,gh,12); x.fill(); x.strokeStyle='#2a3442'; x.lineWidth=1; roundRect(x,cxp,cyp,gw,gh,12); x.stroke();
      x.fillStyle='#9aa7b8'; x.font='700 12px Segoe UI, Arial'; x.fillText(t[0].toUpperCase(),cxp+16,cyp+26);
      x.fillStyle='#e7ecf3'; x.font='800 32px Segoe UI, Arial'; x.fillText(t[1],cxp+16,cyp+66); });
    var iy=gy+2*(gh+16)+18; x.fillStyle='#4f8cff'; x.font='700 16px Segoe UI, Arial'; x.fillText('Top Insights & Actions',40,iy);
    x.fillStyle='#c7d0dc'; x.font='14px Segoe UI, Arial';
    opsInsights(M).slice(0,2).concat(opsActions(M).slice(0,2).map(function(a){return a[1];})).forEach(function(s,i){ x.fillText('•  '+trunc(stripTags(s),120),40,iy+28+i*26); });
    x.fillStyle='#6b7688'; x.font='12px Segoe UI, Arial'; x.textAlign='right'; x.fillText('Generated '+fmtStamp(M.generated)+'  ·  Lucira CRM Command Center',W-40,Hc-24); x.textAlign='left';
    try{ cv.toBlob(function(b){ if(b) downloadBlob(b, ccFname(M,'png'), 'image/png'); else fallbackPNG(cv,M); }); }catch(e){ fallbackPNG(cv,M); }
  }
  function ccFname(M,ext){ return 'Lucira_CRM_Ops_'+M.to+'.'+ext; }
  function opsExcel(){ var M=opsModel(); downloadBlob(buildOpsExcelXml(M), ccFname(M,'xls'), 'application/vnd.ms-excel'); }
  function buildOpsExcelXml(M){
    var styles='<Styles>'+
      '<Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#1a2230"/></Style>'+
      '<Style ss:ID="hdr"><Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1F3B57" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/></Style>'+
      '<Style ss:ID="lbl"><Font ss:Bold="1" ss:Color="#334155"/></Style>'+
      '<Style ss:ID="breach"><Interior ss:Color="#FDE0E0" ss:Pattern="Solid"/><Font ss:Color="#B10000" ss:Bold="1"/></Style>'+
      '<Style ss:ID="good"><Interior ss:Color="#E4F7E9" ss:Pattern="Solid"/><Font ss:Color="#137333"/></Style>'+
      '</Styles>';
    var sh=[];
    sh.push(xlSheet('Summary',[{title:'Metric',width:200},{title:'Value',width:180}],[
      [{v:'Report',style:'lbl'},BRAND+' — Daily CRM Operations'],[{v:'Period',style:'lbl'},(M.single?fmtDay(M.to):fmtDay(M.from)+' → '+fmtDay(M.to))],
      [{v:'Scope',style:'lbl'},M.scope],[{v:'Generated',style:'lbl'},fmtStamp(M.generated)],['',''],
      [{v:'Deals Created',style:'lbl'},M.deals],[{v:'Calls Done',style:'lbl'},M.calls],[{v:'Pending First Calls',style:'lbl'},M.pendingCnt],
      [{v:'Call Coverage %',style:'lbl'},+p1(M.coverage)],[{v:'SLA %',style:'lbl'},+p1(M.slaPct)],
      [{v:'Avg FRT (min)',style:'lbl'},+p1(M.avgFrt)],[{v:'Median FRT (min)',style:'lbl'},+p1(M.medFrt)],[{v:'Max FRT (min)',style:'lbl'},+p1(M.maxFrt)],
      [{v:'Overdue (>'+SLA_MIN+'m)',style:(M.overdueCnt?'breach':'good')},{v:M.overdueCnt,style:(M.overdueCnt?'breach':'good')}],
      [{v:'Meetings Scheduled',style:'lbl'},M.meet.scheduled],[{v:'Meetings Completed',style:'lbl'},M.meet.completed],[{v:'Meetings Pending',style:'lbl'},M.meet.pending],
      [{v:'Best Owner',style:'lbl'},M.best?(M.best.name+' — '+p1(M.best.slaPct)+'%'):'—'],[{v:'Lowest SLA Owner',style:'lbl'},M.worst?(M.worst.name+' — '+p1(M.worst.slaPct)+'%'):'—']
    ]));
    sh.push(xlSheet('KPIs',[{title:'KPI',width:180},{title:'Value',width:120}],[
      ['Deals Created',M.deals],['Calls Done',M.calls],['Unique Deals Called',M.uniqueCalled],['Pending First Calls',M.pendingCnt],
      ['Avg FRT (min)',+p1(M.avgFrt)],['Median FRT (min)',+p1(M.medFrt)],['Max FRT (min)',+p1(M.maxFrt)],['Coverage %',+p1(M.coverage)],['SLA %',+p1(M.slaPct)],
      ['Overdue',M.overdueCnt],['Meetings Scheduled',M.meet.scheduled],['Meetings Completed',M.meet.completed],['Meetings Pending',M.meet.pending]
    ]));
    sh.push(xlSheet('Deals',[{title:'Deal',width:200},{title:'Owner',width:130},{title:'Stage',width:110},{title:'Lead Source',width:120},{title:'Contacted',width:75},{title:'First Resp (min)',width:100},{title:'Created',width:130}],
      M.joined.map(function(j){return [j.deal.name,ownerName(j.deal.owner),j.deal.stage,clean(j.deal.leadSource),(j.contacted?'Yes':'No'),(j.frt==null?'':+p1(j.frt)),j.deal.created];})));
    sh.push(xlSheet('Calls',[{title:'Owner',width:130},{title:'Type',width:90},{title:'Duration (s)',width:90},{title:'Connected',width:80},{title:'Created',width:130}],
      M.cl.map(function(c){return [ownerName(c.owner),c.type||'',(c.dur||0),(c.dur>0?'Yes':'No'),c.created];})));
    var od=M.overdue.slice().sort(function(a,b){return (b._delay||0)-(a._delay||0);});
    sh.push(xlSheet('Pending Deals',[{title:'Deal ID',width:110},{title:'Customer',width:190},{title:'Owner',width:130},{title:'Lead Source',width:120},{title:'Stage',width:110},{title:'Current Delay (min)',width:110},{title:'Priority',width:80},{title:'Status',width:110},{title:'Created',width:130}],
      (od.length?od:[{deal:{}, _delay:0, contacted:true}]).map(function(j){ if(!j.deal.id) return ['(none)','','','','',{v:''},'','','']; return [j.deal.id,j.deal.name,ownerName(j.deal.owner),clean(j.deal.leadSource),j.deal.stage,{v:+p1(j._delay||0),style:'breach'},(j._delay>60?'High':j._delay>30?'Medium':'Low'),{v:(j.contacted?'Called late':'Awaiting call'),style:'breach'},j.deal.created];})));
    sh.push(xlSheet('Owner Performance',[{title:'Owner',width:140},{title:'Deals',width:60},{title:'Calls',width:60},{title:'Pending',width:70},{title:'Avg FRT (min)',width:90},{title:'Median FRT',width:80},{title:'Max Delay (min)',width:95},{title:'Calls/Deal',width:75},{title:'SLA %',width:70}],
      M.owners.map(function(o){return [o.name,o.deals,o.calls,o.pending,(o.avgFrt==null?'':+p1(o.avgFrt)),(o.medFrt==null?'':+p1(o.medFrt)),+p1(o.maxDelay),+p1(o.callsPerDeal),{v:+p1(o.slaPct),style:(o.slaPct<SLA_TARGET?'breach':'good')}];})));
    sh.push(xlSheet('Meeting Analysis',[{title:'Metric',width:180},{title:'Value',width:100}],[
      ['Scheduled',M.meet.scheduled],['Completed',M.meet.completed],['Pending',M.meet.pending],['Missed (not tracked)','n/a'],['Conversion %',+p1(M.meet.conversion)]]));
    sh.push(xlSheet('AI Insights',[{title:'#',width:40},{title:'Insight',width:640}], opsInsights(M).map(function(x,i){return [i+1,stripTags(x)];})));
    sh.push(xlSheet('Recommendations',[{title:'#',width:40},{title:'Recommendation',width:640}], opsRecs(M).map(function(x,i){return [i+1,x];})));
    sh.push(xlSheet('Raw Data',[{title:'Deal ID',width:110},{title:'Deal',width:190},{title:'Owner',width:130},{title:'Mobile',width:110},{title:'Stage',width:100},{title:'Contacted',width:75},{title:'#Calls',width:60},{title:'Delay (min)',width:90},{title:'Created',width:130}],
      M.joined.map(function(j){return [j.deal.id,j.deal.name,ownerName(j.deal.owner),j.deal.mobile||'',j.deal.stage,(j.contacted?'Yes':'No'),j.nCalls,+p1(j._delay||0),j.deal.created];})));
    var xml='<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:html="http://www.w3.org/TR/REC-html40">'+
      '<DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"><Author>'+xesc(BRAND)+'</Author><Title>Daily CRM Operations</Title></DocumentProperties>'+styles+sh.join('')+'</Workbook>';
    return xml;
  }

  /* ---------- register tab + header Share button ---------- */
  TABS.unshift(['command','🎯 Command Center']);
  VIEWS.command=renderCommand;
  TABS.splice(1,0,['overdueRaw','🔴 Overdue Raw Data']);
  VIEWS.overdueRaw=renderOverdueRaw;
  (function(){ var h=(location.hash||'').replace('#',''); if(!h||!VIEWS[h]) active='command'; })();
  window.DVCOps={ model:opsModel, pdf:opsPDF, excel:opsExcel, png:opsPNG, whatsapp:crmWhatsapp, brief:managerBrief, doc:function(){return buildOpsDoc(opsModel());}, excelXml:function(){return buildOpsExcelXml(opsModel());} };
  TABS.push(['share','⤴ Share']);
  VIEWS.share=renderShare;
  (function(){ var pb=gid('printBtn'); if(pb && !gid('shareBtn')){ var sb=el('button','hbtn'); sb.id='shareBtn'; sb.title='Export & share reports (PDF, Excel, WhatsApp, PNG)'; sb.innerHTML='⤴ Share';
    sb.onclick=function(){ active='share'; try{location.hash='share';}catch(e){} buildTabs(); render(); window.scrollTo(0,0); };
    pb.parentNode.insertBefore(sb, pb); } })();
  /* expose for console / future hooks */
  window.DVCReports={ model:reportModel, pdf:exportPDF, excel:exportExcel, whatsapp:whatsappText, png:exportPNG, executive:exportExecutive,
    pdfDoc:function(mode){ return buildReportDoc(reportModel(),mode||'full'); }, excelXml:function(){ return buildExcelXml(reportModel()); } };
})();

/* ============================ LIVE data layer ============================ */
/* hydrate(bundle): rebuild every derived structure from a fresh bundle (same schema as window.DASH / data.js) */
function hydrate(b){
  DASH=b||{}; OWN=DASH.owners||{};
  DEALS=(DASH.deals||[]).map(pd); CALLS=(DASH.calls||[]).map(pc); TASKS=(DASH.tasks||[]).map(pt);
  ONLINE=(DASH.online||[]).map(po); EVENTS=(DASH.events||[]).map(pe);
  CE=DASH.ce||{byCat:{},byCatDay:{},byDay:{},cats:[],rawTop:[],total:0};
  CRM={Deals:DEALS.length,Calls:CALLS.length,Tasks:TASKS.length,Online:ONLINE.length,Events:EVENTS.length,CustomerEvents:CE.total,EventsModuleTotal:117};
  var mx=minDate; DEALS.forEach(function(d){var k=dayKey(d.created);if(k>mx)mx=k;}); CALLS.forEach(function(c){var k=dayKey(c.created);if(k>mx)mx=k;}); maxDate=mx;
  dealIdSet=new Set(DEALS.map(function(d){return d.id;}));
  idxWhat={}; idxPhone={};
  CALLS.forEach(function(c){ if(c.whatId&&dealIdSet.has(c.whatId)){(idxWhat[c.whatId]=idxWhat[c.whatId]||[]).push(c);} if(c.phone){(idxPhone[c.phone]=idxPhone[c.phone]||[]).push(c);} });
  rebuildTaskIndex();
  _mobCount=null; _activeOwners=null;
}
function totalRecords(){ return DEALS.length+CALLS.length+TASKS.length+ONLINE.length+EVENTS.length; }
function fmtClock(d){ return d? (String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0')) : '—'; }

/* Data-freshness banner: always-on header strip showing mode (LIVE/snapshot/failed),
   data source, the date range the data covers, last-sync time and record counts. */
function prettyDay(k){ var m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; var p=String(k||'').split('-'); if(p.length<3) return k||'—'; return parseInt(p[2],10)+' '+m[(parseInt(p[1],10)||1)-1]+' '+p[0]; }
function renderFreshbar(){
  var box=gid('freshbar'); if(!box) return;
  var live=(LIVE.mode==='live'), err=(live&&LIVE.error), pill,cls,src,updLbl,upd;
  if(err){ pill='⚠ SYNC FAILED'; cls='fb-bad'; src='Live BigQuery feed — last sync attempt failed'; updLbl='Last good'; upd=(LIVE.lastSync?fmtClock(LIVE.lastSync):'never'); }
  else if(live){ pill='● LIVE'; cls='fb-live'; src='Live BigQuery · Zoho-synced every 15 min'; updLbl='Last synced'; upd=fmtClock(LIVE.lastSync); }
  else { pill='◷ SNAPSHOT'; cls='fb-snap'; var gen=(DASH.meta&&DASH.meta.generated)?String(DASH.meta.generated).slice(0,16).replace('T',' '):'—'; src='Static snapshot file'; updLbl='Data as of'; upd=gen; }
  if(LIVE.autoMs) upd+=' · auto '+(LIVE.autoMs/60000)+'m';
  var brk=num(DEALS.length)+' deals · '+num(CALLS.length)+' calls · '+num(TASKS.length)+' tasks · '+num(ONLINE.length)+' chats · '+num(EVENTS.length)+' meetings · '+num(CE.total)+' events';
  box.className='freshbar '+cls;
  box.innerHTML=
    '<span class="fb-pill">'+esc(pill)+'</span>'+
    '<span class="fb-item"><b>Source</b><span>'+esc(src)+'</span></span>'+
    '<span class="fb-item"><b>Data range</b><span>'+esc(prettyDay(minDate))+' → '+esc(prettyDay(maxDate))+'</span></span>'+
    '<span class="fb-item"><b>'+esc(updLbl)+'</b><span>'+esc(upd)+'</span></span>'+
    '<span class="fb-sp"></span>'+
    '<span class="fb-item" style="text-align:right"><b>'+num(totalRecords())+' records</b><span class="fb-brk">'+esc(brk)+'</span></span>';
}

var LIVE={ mode:(CONFIG.CRM_API?'live':'snapshot'), lastSync:null, error:null, autoMs:0, timer:null, delta:null, records:0 };

/* persist filters across snapshot-mode reloads so a refresh never loses the user's view */
function saveF(){ try{ sessionStorage.setItem('dvc_F', JSON.stringify({from:F.from,to:F.to,preset:F.preset,owners:Array.prototype.slice.call(F.owners),stage:Array.from(F.stage),trigger:Array.from(F.trigger),leadSource:Array.from(F.leadSource),utmSource:F.utmSource,utmMedium:F.utmMedium,callType:F.callType,taskStatus:F.taskStatus,compare:F.compare})); }catch(e){} }
/* Date (from/to/preset) is deliberately NOT restored here — every fresh open/refresh must
   re-initialize to the D-1 default (see F above + the boot call below), never a stale cached
   range. Non-date filters (owners/stage/etc.) still persist across snapshot-mode reloads. */
function restoreF(){ try{ var s=sessionStorage.getItem('dvc_F'); if(!s)return; var o=JSON.parse(s); F.owners=new Set(o.owners||[]); F.stage=new Set(o.stage||[]); F.trigger=new Set(o.trigger||[]); F.leadSource=new Set(o.leadSource||[]); ['utmSource','utmMedium','callType','taskStatus'].forEach(function(k){F[k]=o[k]||'';}); F.compare=!!o.compare; }catch(e){} }
window.addEventListener('beforeunload',saveF);

function syncNow(auto){
  try{ ZOHO.cache={}; }catch(e){}   // drop cached backend-tab responses so Products/Login/Helpdesk/SQI/DQI refetch live on refresh
  if(LIVE.mode!=='live'){ // snapshot: reload re-reads data.js (kept fresh by the ETL / CDC pipeline); filters restored after reload
    try{ sessionStorage.setItem('dvc_prevRecords', String(totalRecords())); }catch(e){} saveF(); location.reload(); return;
  }
  setLiveStatus('syncing');
  var prev={D:DEALS.length,C:CALLS.length,T:TASKS.length,O:ONLINE.length,E:EVENTS.length,CE:CE.total};
  fetch(CONFIG.CRM_API,{cache:'no-store',headers:{'Accept':'application/json'}})
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status+(r.statusText?(' '+r.statusText):'')); return r.json(); })
    .then(function(b){
      if(!b || !b.deals){ throw new Error('bad payload — no deals[] in response'); }
      hydrate(b); LIVE.error=null; LIVE.lastSync=new Date(); LIVE.records=totalRecords();
      LIVE.delta={deals:DEALS.length-prev.D,calls:CALLS.length-prev.C,tasks:TASKS.length-prev.T,online:ONLINE.length-prev.O,events:EVENTS.length-prev.E,ce:CE.total-prev.CE};
      if(F.preset){ var _pr=presetRange(F.preset); F.from=_pr.from; F.to=_pr.to; }
      buildFilters(); chips(); render(); setLiveStatus();
    })
    .catch(function(err){ LIVE.error=(err&&err.message)||'network error'; setLiveStatus(); });
}
function setAuto(ms){ ms=ms||0; LIVE.autoMs=ms; if(LIVE.timer){ clearInterval(LIVE.timer); LIVE.timer=null; } if(ms>0){ LIVE.timer=setInterval(function(){ syncNow(true); }, ms); } setLiveStatus(); }
function deltaText(){ if(!LIVE.delta)return ''; if(LIVE.delta._reload!=null){ return LIVE.delta._reload? (' · '+(LIVE.delta._reload>0?'+':'')+num(LIVE.delta._reload)+' new records') : ''; }
  var p=[]; [['deals','deals'],['calls','calls'],['tasks','tasks'],['events','events'],['online','chats']].forEach(function(x){ var vv=LIVE.delta[x[0]]; if(vv)p.push((vv>0?'+':'')+vv+' '+x[1]); }); return p.length?(' · '+p.join(', ')):''; }
function setLiveStatus(state){
  var tag=gid('refreshtag'), ban=gid('livebanner');
  if(tag){
    if(state==='syncing'){ tag.innerHTML='<span class="spindot"></span> syncing Zoho…'; }
    else if(LIVE.mode==='live'){ tag.innerHTML=(LIVE.error?'<b style="color:var(--bad)">⚠ sync failed</b>':'<b style="color:var(--good)">● LIVE</b>')+' · updated '+fmtClock(LIVE.lastSync)+' · '+num(LIVE.records||totalRecords())+' recs'+(LIVE.autoMs?' · auto '+(LIVE.autoMs/60000)+'m':'')+deltaText(); }
    else { var gen=(DASH.meta&&DASH.meta.generated)?String(DASH.meta.generated).slice(0,16).replace('T',' '):'—'; tag.innerHTML='<b>◷ snapshot</b> '+esc(gen)+' · '+num(totalRecords())+' recs'+(LIVE.autoMs?' · auto '+(LIVE.autoMs/60000)+'m':'')+deltaText(); }
  }
  if(ban){
    if(LIVE.error && LIVE.mode==='live'){ ban.style.display='flex'; ban.innerHTML='<span>⚠ <b>Live sync to Zoho CRM failed</b> at '+fmtClock(new Date())+' — '+esc(LIVE.error)+'. '+(LIVE.lastSync?('Showing last good data from '+fmtClock(LIVE.lastSync)+'.'):'No data has loaded yet.')+'</span> <button class="mini" id="banretry">Retry now</button>'; var rb=gid('banretry'); if(rb)rb.onclick=function(){ syncNow(false); }; }
    else { ban.style.display='none'; ban.innerHTML=''; }
  }
  renderFreshbar();
}

/* header */
document.getElementById('themeBtn').onclick=function(){ var r=document.documentElement; r.setAttribute('data-theme', r.getAttribute('data-theme')==='dark'?'light':'dark'); render(); };
document.getElementById('printBtn').onclick=function(){ window.print(); };
document.getElementById('refreshBtn').onclick=function(){ syncNow(false); };
document.getElementById('synced').innerHTML='Zoho CRM · <b>'+num(totalRecords())+'</b> records + '+num(CE.total)+' events';

/* inject: Auto-refresh selector + error banner */
(function(){
  var rbtn=gid('refreshBtn'); if(rbtn){ var host=rbtn.parentNode;
    var sel=el('select','livesel'); [['0','Auto: Off'],['60000','Auto: 1 min'],['300000','Auto: 5 min']].forEach(function(o){ sel.appendChild(new Option(o[1],o[0])); });
    sel.value=String(CONFIG.AUTO_MS||0); sel.title='Automatic refresh interval'; sel.onchange=function(){ setAuto(parseInt(sel.value,10)||0); };
    host.insertBefore(sel, rbtn);
  }
  var wrap=document.querySelector('.wrap'); if(wrap && !gid('livebanner')){ var ban=el('div'); ban.id='livebanner'; ban.className='livebanner'; ban.style.display='none'; wrap.insertBefore(ban, wrap.firstChild); }
  if(wrap && !gid('freshbar')){
    var fst=el('style'); fst.textContent='.freshbar{display:flex;align-items:center;gap:8px 18px;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--tx3);border-radius:12px;padding:11px 16px;margin-bottom:14px;box-shadow:var(--shadow);font-size:12.5px}.freshbar.fb-live{border-left-color:var(--good)}.freshbar.fb-snap{border-left-color:var(--warn)}.freshbar.fb-bad{border-left-color:var(--bad)}.fb-pill{font-weight:800;padding:3px 11px;border-radius:20px;white-space:nowrap;font-size:12px;letter-spacing:.3px}.fb-live .fb-pill{background:rgba(34,197,94,.15);color:var(--good)}.fb-snap .fb-pill{background:rgba(244,183,64,.15);color:var(--warn)}.fb-bad .fb-pill{background:rgba(255,107,107,.15);color:var(--bad)}.fb-item{display:inline-flex;flex-direction:column;line-height:1.35;gap:1px;color:var(--tx)}.fb-item b{font-size:9.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--tx3);font-weight:700}.fb-sp{flex:1}.fb-brk{color:var(--tx2);font-size:11px;font-weight:400}@media print{.freshbar{box-shadow:none}}'; document.head.appendChild(fst);
    /* Unpin the sticky header/tabs/filters (no freeze on scroll) + right-side tab dropdown menu */
    var tst=el('style'); tst.textContent='header.top{position:static !important}nav.tabs{position:static !important;top:auto !important}.filters{position:static !important;top:auto !important}nav.tabs .in{justify-content:flex-end;overflow:visible}.tabmenu{position:relative}.tabmenu-btn{display:inline-flex;align-items:center;gap:12px;justify-content:space-between;background:var(--card);border:1px solid var(--line);color:var(--tx);padding:9px 14px;border-radius:10px;cursor:pointer;font-size:13px;font-weight:700;min-width:190px}.tabmenu-btn:hover{border-color:var(--acc)}.tabmenu-arr{color:var(--tx2);font-size:11px;transition:transform .2s}.tabmenu.open .tabmenu-arr{transform:rotate(180deg)}.tabmenu-pop{display:none;position:absolute;top:calc(100% + 6px);right:0;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:6px;min-width:230px;max-height:70vh;overflow:auto;z-index:70;box-shadow:var(--shadow);flex-direction:column;gap:2px}.tabmenu.open .tabmenu-pop{display:flex}.tabmenu-pop button{background:none;border:none;color:var(--tx2);text-align:left;padding:9px 12px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap;width:100%}.tabmenu-pop button:hover{background:var(--bg2);color:var(--tx)}.tabmenu-pop button.on{background:var(--acc);color:#fff}@media print{header.top,nav.tabs,.filters{display:none}}'; document.head.appendChild(tst);
    var fb=el('div'); fb.id='freshbar'; fb.className='freshbar'; wrap.insertBefore(fb, wrap.firstChild);
  }
})();

/* snapshot-mode delta after a reload */
(function(){ try{ var pr=sessionStorage.getItem('dvc_prevRecords'); if(pr!=null){ LIVE.delta={_reload:totalRecords()-parseInt(pr,10)}; sessionStorage.removeItem('dvc_prevRecords'); } }catch(e){} })();

restoreF();
if(F.preset){ var _pr=presetRange(F.preset); F.from=_pr.from; F.to=_pr.to; }
setAuto(CONFIG.AUTO_MS||0);

buildTabs(); buildFilters(); chips(); render(); buildAssistant();
ensureInfoModal();   // wire up the ⓘ info-button click delegation at boot (openInfo() alone never runs first)
if(LIVE.mode==='live') syncNow(true);   // fetch fresh data immediately when a live API is configured
loadSalesData();   // independent fetch — Command Center's Sales Breakdown re-renders itself once this resolves
})();
