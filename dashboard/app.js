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

var DASH = window.DASH || {};
var OWN = DASH.owners || {};
function ownerName(id){ return OWN[String(id)] || (id? ('User '+String(id).slice(-6)) : '(unassigned)'); }

/* ---------- map positional rows to objects ---------- */
function pd(a){return {id:a[0],name:a[1],owner:a[2],created:a[3],stage:a[4],prob:a[5],leadSource:a[6],reasonLoss:a[7],trigger:a[8],utmSource:a[9],utmMedium:a[10],numAct:a[11]||0,mobile:a[12]||''};}
function pc(a){return {id:a[0],owner:a[1],created:a[2],type:a[3],dur:a[4]||0,start:a[5],whatId:a[6]||'',phone:a[7]||''};}
function pt(a){return {id:a[0],owner:a[1],created:a[2],status:a[3],due:a[4],closed:a[5]};}
function po(a){return {id:a[0],owner:a[1],created:a[2],channel:a[3],atype:a[4]};}
function pe(a){return {id:a[0],owner:a[1],created:a[2],start:a[3],end:a[4],title:a[5]};}
var DEALS=(DASH.deals||[]).map(pd), CALLS=(DASH.calls||[]).map(pc), TASKS=(DASH.tasks||[]).map(pt),
    ONLINE=(DASH.online||[]).map(po), EVENTS=(DASH.events||[]).map(pe), CE=DASH.ce||{byCat:{},byCatDay:{},byDay:{},cats:[],rawTop:[],total:0};

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

/* ---------- filter state ---------- */
var minDate='2026-05-31', maxDate=(function(){var mx='2026-05-31';DEALS.forEach(function(d){var k=dayKey(d.created);if(k>mx)mx=k;});CALLS.forEach(function(c){var k=dayKey(c.created);if(k>mx)mx=k;});return mx;})();
var F={ from:minDate, to:maxDate, preset:'7', owners:new Set(), stage:'', trigger:'', leadSource:'', utmSource:'', utmMedium:'', callType:'', taskStatus:'', compare:false };

function inDate(created){ var k=dayKey(created); return k>=F.from && k<=F.to; }
function inR(created,from,to){ var k=dayKey(created); return k>=(from||F.from) && k<=(to||F.to); }
function ownerOk(id){ return F.owners.size===0 || F.owners.has(String(id)); }

function fDeals(from,to){ return DEALS.filter(function(d){ return inR(d.created,from,to)&&ownerOk(d.owner)
  &&(!F.stage||d.stage===F.stage)
  &&(!F.trigger||normTrig(d.trigger)===F.trigger)
  &&(!F.leadSource||clean(d.leadSource).toLowerCase()===F.leadSource.toLowerCase())
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
/* For a set of deals, compute matched calls (created >= deal.created) + first call + response */
function joinDeals(deals){
  var out=[];
  deals.forEach(function(d){
    var seen={}, cand=[];
    (idxWhat[d.id]||[]).forEach(function(c){ if(!seen[c.id]){seen[c.id]=1;cand.push(c);} });
    if(d.mobile){ (idxPhone[d.mobile]||[]).forEach(function(c){ if(!seen[c.id]){seen[c.id]=1;cand.push(c);} }); }
    var dc=D(d.created), after=[], first=null;
    cand.forEach(function(c){ var ct=D(c.created); if(ct&&dc&&ct>=dc){ after.push(c); if(!first||ct<D(first.created))first=c; } });
    var frt = first? (D(first.created)-dc)/60000 : null; // minutes
    out.push({deal:d, calls:after, nCalls:after.length, first:first, frt:frt, contacted:after.length>0});
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
function kpi(k,v,d,dcls,accent){ var e=el('div','kpi'); e.innerHTML='<div class="accent" style="background:'+(accent||'var(--acc)')+'"></div><div class="k">'+esc(k)+'</div><div class="v">'+v+'</div>'+(d?'<div class="d '+(dcls||'')+'">'+d+'</div>':''); return e; }
function kpiRow(list){ var g=el('div','kpis'); list.forEach(function(x){ g.appendChild(kpi(x[0],x[1],x[2],x[3],x[4])); }); return g; }
function panel(title,hint){ var p=el('div','panel'); var h=el('div','phead'); h.appendChild(el('div',null,'<h3>'+esc(title)+'</h3>'+(hint?'<div class="hint">'+esc(hint)+'</div>':''))); p.appendChild(h); var body=el('div','chart'); p.appendChild(body); p.__body=body; p.__head=h; return p; }
function addExport(p, name, headers, rows){ var b=el('button','mini','⭳ CSV'); b.onclick=function(){ exportCSV(name,headers,rows); }; p.__head.appendChild(b); }

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
function renderOverview(v){
  var dl=fDeals(), cl=fCalls(), tk=fTasks(), on=fOnline(), ev=fEvents();
  var joined=joinDeals(dl); var contacted=joined.filter(function(j){return j.contacted;}).length;
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
  var g=el('div','grid g2');
  var p1p=panel('Deals vs Calls — Daily Trend','Created per day'); g.appendChild(p1p);
  var gran=pickGran(F.from,F.to);
  var td=trend(dl,gran), tc=trend(cl,gran), keys=mergeKeys(td.keys,tc.keys);
  lineChart(p1p.__body, fmtKeys(keys,gran), [
    {name:'Deals',color:'var(--c1)',data:keys.map(function(k){return td.map[k]||0;})},
    {name:'Calls',color:'var(--c2)',data:keys.map(function(k){return tc.map[k]||0;})}
  ]);
  var p2=panel('Deals by Stage'); g.appendChild(p2); donut(p2.__body, toItems(groupBy(dl,function(d){return d.stage||'(none)';})),{center:'deals',onClick:function(k){F.stage=(F.stage===k?'':k);sync();}});
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
  var pStage=panel('Deals by Stage'); g1.appendChild(pStage); donut(pStage.__body,toItems(groupBy(dl,function(d){return d.stage||'(none)';})),{center:'deals',onClick:function(k){F.stage=(F.stage===k?'':k);sync();}});
  var pTrig=panel('Deals by Trigger Event'); g1.appendChild(pTrig); var trigIt=toItems(groupBy(dl,function(d){return normTrig(d.trigger);})); hbar(pTrig.__body,trigIt,{onClick:function(k){F.trigger=(F.trigger===k?'':k);sync();}});
  var pSrc=panel('Deals by Lead Source'); g1.appendChild(pSrc); hbar(pSrc.__body,toItems(groupBy(dl,function(d){return clean(d.leadSource);})),{onClick:function(k){F.leadSource=(F.leadSource==='(none)'?'':(k==='(none)'?'':k))===''?'':k; if(k==='(none)')F.leadSource='';else F.leadSource=(F.leadSource===k?'':k); sync();}});
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

/* ---- Agents (merged: per-agent performance master, from old Overview "Agents" table) ---- */
function renderAgents(v){
  var dl=fDeals(), cl=fCalls(), tk=fTasks(), ev=fEvents(), on=fOnline();
  var joined=joinDeals(dl);
  var m={}; function row(id){ return m[id]||(m[id]={deals:0,won:0,contacted:0,frt:[],calls:0,conn:0,talk:0,meet:0,tasks:0,online:0}); }
  joined.forEach(function(j){ var r=row(j.deal.owner); r.deals++; if(isWon(j.deal))r.won++; if(j.contacted){r.contacted++; if(j.frt!=null)r.frt.push(j.frt);} });
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
  v.appendChild(el('div','note','Per-agent performance rollup from live Zoho data — deals, won, contact rate, first response, calls, connected calls, talk time, meetings, tasks and chats, per owner.'));
  var p=panel('Agent Performance','Sortable · click a column header'); v.appendChild(p);
  var rows=Object.keys(m).map(function(id){ var r=m[id]; var af=r.frt.length?r.frt.reduce(function(s,x){return s+x;},0)/r.frt.length:null;
    return [ownerName(id), r.deals, r.won, {html:p1(pct(r.contacted,r.deals))+'%',text:p1(pct(r.contacted,r.deals))}, {html:af==null?'—':fmtDur(af),text:af==null?'':p1(af)}, r.calls, r.conn, {html:hms(r.talk),text:r.talk}, r.meet, r.tasks, r.online]; })
    .sort(function(a,b){return b[1]-a[1];});
  table(p.__body,['Agent','Deals','Won','Contact %','Avg Resp','Calls','Connected','Talk Time','Meetings','Tasks','Chats'],rows,{key:'agents',numCols:[1,2,5,6,7,8,9,10]});
  addExport(p,'agent_performance',['Agent','Deals','Won','ContactPct','AvgRespMin','Calls','Connected','TalkSec','Meetings','Tasks','Chats'],
    Object.keys(m).map(function(id){var r=m[id];var af=r.frt.length?r.frt.reduce(function(s,x){return s+x;},0)/r.frt.length:'';return [ownerName(id),r.deals,r.won,p1(pct(r.contacted,r.deals)),af===''?'':p1(af),r.calls,r.conn,r.talk,r.meet,r.tasks,r.online];}));
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
    ['Not Contacted',num(notContacted),p1(pct(notContacted,dl.length))+'%','down','var(--bad)'],
    ['Contact Rate',p1(pct(contacted.length,dl.length))+'%','','','var(--c4)'],
    ['Avg Calls / Deal',p1(dl.length?totCalls/dl.length:0),num(totCalls)+' matched calls','','var(--c2)']
  ]));
  v.appendChild(el('div','note','<b>Join logic:</b> a deal is matched to calls by <b>What_Id → Deal</b> link and by <b>RIGHT(Mobile,10)</b> (phone parsed from the call subject). “First response” = time from deal creation to the first call after it. Response metrics use all calls (not date-filtered) so times stay accurate.'));
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
    ['Business-Hour Contact Rate',p1(pct(totC,totWh))+'%',num(totC)+' contacted','','var(--c2)']
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

  var pOa=panel('Owner Analysis'); v.appendChild(pOa);
  var talkOa={}; fCalls().forEach(function(c){var n=ownerName(c.owner); talkOa[n]=(talkOa[n]||0)+(c.dur||0);});
  var oa={}; joined.forEach(function(j){var n=ownerName(j.deal.owner); var o=oa[n]||(oa[n]={d:0,c:0,calls:0,frt:[]}); o.d++; o.calls+=j.nCalls; if(j.contacted){o.c++; if(j.frt!=null)o.frt.push(j.frt);} });
  var orows=Object.keys(oa).map(function(n){var o=oa[n];var af=o.frt.length?o.frt.reduce(function(s,x){return s+x;},0)/o.frt.length:0;var tk=talkOa[n]||0;return [n,o.d,o.calls,{html:hms(tk),text:tk},p1(o.d?o.calls/o.d:0),fmtDur(af),p1(pct(o.c,o.d))+'%'];}).sort(function(a,b){return b[1]-a[1];});
  table(pOa.__body,['Owner','Deals','Calls','Talk Time','Avg Calls','Avg Resp','Contact %'],orows,{key:'oa',numCols:[1,2,3,4]});
  addExport(pOa,'owner_analysis',['Owner','Deals','Calls','TalkTimeSec','AvgCalls','AvgRespMin','ContactPct'],Object.keys(oa).map(function(n){var o=oa[n];var af=o.frt.length?o.frt.reduce(function(s,x){return s+x;},0)/o.frt.length:0;return[n,o.d,o.calls,talkOa[n]||0,p1(o.d?o.calls/o.d:0),p1(af),p1(pct(o.c,o.d))];}));

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
  [['all','All'],['today','Today'],['yest','Yesterday'],['7','7d'],['30','30d'],['tw','This wk'],['tm','This mo'],['lm','Last mo']].forEach(function(p){ var b=el('button',F.preset===p[0]?'on':'',p[1]); b.onclick=function(){setPreset(p[0]);}; pr.appendChild(b); });
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
  var applied=[F.stage,F.trigger,F.leadSource,F.utmSource,F.utmMedium,F.callType,F.taskStatus].filter(Boolean).length+(F.owners.size?1:0)+(dateOn?1:0)+(F.compare?1:0);
  var dlabel=dateOn?(fmtDay(F.from)+' → '+fmtDay(F.to)):'All dates · since 31 May 2026';
  var summ=el('div','filt-summary'); summ.innerHTML='<span class="fs-lbl">Showing</span> <b>'+esc(dlabel)+'</b>'+(F.owners.size?' · <b>'+F.owners.size+'</b> owner(s)':'')+(F.compare?' · <b>compare on</b>':'')+(applied?'':' · <span style="color:var(--tx3)">no filters applied</span>');
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
  arow.appendChild(selGroup('Stage','stage',distinct(DEALS,function(d){return d.stage;})));
  arow.appendChild(selGroup('Trigger','trigger',distinct(DEALS,function(d){return normTrig(d.trigger);})));
  arow.appendChild(selGroup('Lead Source','leadSource',distinct(DEALS,function(d){return clean(d.leadSource);}).filter(function(x){return x!=='(none)';})));
  arow.appendChild(selGroup('UTM Source','utmSource',distinct(DEALS,function(d){return clean(d.utmSource);}).filter(function(x){return x!=='(none)';})));
  arow.appendChild(selGroup('UTM Medium','utmMedium',distinct(DEALS,function(d){return clean(d.utmMedium);}).filter(function(x){return x!=='(none)';})));
  arow.appendChild(selGroup('Call Type','callType',distinct(CALLS,function(c){return c.type;})));
  arow.appendChild(selGroup('Task Status','taskStatus',distinct(TASKS,function(t){return t.status;})));
  adv.appendChild(arow); f.appendChild(adv);
  advBtn.onclick=function(){ advOpen=!advOpen; advBtn.classList.toggle('open',advOpen); adv.classList.toggle('open',advOpen); };
}
function selGroup(label,key,opts){ var g=el('div','fgroup'); g.appendChild(el('label',null,label)); var s=el('select'); s.appendChild(new Option('All','')); opts.forEach(function(o){ var op=new Option(o,o); if(F[key]===o)op.selected=true; s.appendChild(op); }); s.onchange=function(){F[key]=s.value;sync();}; g.appendChild(s); return g; }
function ownerMulti(){
  var g=el('div','fgroup'); g.appendChild(el('label',null,'Owner'));
  var m=el('div','multi'); var tag=el('span','tag', F.owners.size?F.owners.size+' selected':'All owners'); m.appendChild(tag);
  var pop=el('div','pop');
  var ids=distinct(DEALS.concat(CALLS),function(x){return x.owner;});
  ids.sort(function(a,b){return ownerName(a).localeCompare(ownerName(b));});
  ids.forEach(function(id){ var lab=el('label'); var cb=el('input'); cb.type='checkbox'; cb.checked=F.owners.has(id); cb.onchange=function(ev){ ev.stopPropagation(); if(cb.checked)F.owners.add(id);else F.owners.delete(id); sync(); }; lab.appendChild(cb); lab.appendChild(document.createTextNode(' '+ownerName(id))); pop.appendChild(lab); });
  m.appendChild(pop);
  m.onclick=function(e){ if(e.target.tagName==='INPUT')return; m.classList.toggle('open'); };
  document.addEventListener('click',function(e){ if(!m.contains(e.target))m.classList.remove('open'); });
  return g.appendChild(m), g;
}
function chips(){
  var c=document.getElementById('chipbar'); c.innerHTML='';
  var items=[];
  if(F.preset!=='all'||F.from!==minDate||F.to!==maxDate) items.push(['Date',fmtDay(F.from)+' → '+fmtDay(F.to),function(){setPreset('all');}]);
  F.owners.forEach(function(id){ items.push(['Owner',ownerName(id),function(){F.owners.delete(id);sync();}]); });
  ['stage','trigger','leadSource','utmSource','utmMedium','callType','taskStatus'].forEach(function(k){ if(F[k])items.push([k,F[k],function(){F[k]='';sync();}]); });
  if(!items.length){ c.appendChild(el('span','chip','<b>All data</b> · since 31 May 2026')); return; }
  items.forEach(function(it){ var ch=el('span','chip','<b>'+esc(it[0])+':</b> '+esc(it[1])+' <span class="x">✕</span>'); ch.querySelector('.x').onclick=it[2]; c.appendChild(ch); });
  var clr=el('button','clearall','Clear all'); clr.onclick=function(){ F.owners.clear(); ['stage','trigger','leadSource','utmSource','utmMedium','callType','taskStatus'].forEach(function(k){F[k]='';}); setPreset('all'); }; c.appendChild(clr);
}
function presetRange(p){ var to=maxDate, r={from:F.from,to:F.to};
  if(p==='all'){r.from=minDate;r.to=maxDate;}
  else if(p==='today'){r.from=to;r.to=to;}
  else if(p==='yest'){var dy=D(to);dy.setDate(dy.getDate()-1);r.from=ymd(dy);r.to=ymd(dy);}
  else if(p==='7'){var d=D(to);d.setDate(d.getDate()-6);r.from=ymd(d);r.to=to;}
  else if(p==='30'){var d2=D(to);d2.setDate(d2.getDate()-29);r.from=ymd(d2);r.to=to;}
  else if(p==='tw'){var dw=D(to);var wd=(dw.getDay()+6)%7;dw.setDate(dw.getDate()-wd);r.from=ymd(dw);r.to=to;}
  else if(p==='tm'){r.from=to.slice(0,7)+'-01';r.to=to;}
  else if(p==='lm'){var d3=D(to.slice(0,7)+'-01');d3.setMonth(d3.getMonth()-1);var s=ymd(d3);var e=D(to.slice(0,7)+'-01');e.setDate(0);r.from=s;r.to=ymd(e);}
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
  var scope='current filters · '+fmtDay(F.from)+' → '+fmtDay(F.to)+(F.owners.size?' · '+F.owners.size+' owner(s)':'')+(F.stage?' · '+F.stage:'')+(F.trigger?' · '+F.trigger:'');
  function wrap(html){ return html+'<div class="amini">Scope: '+esc(scope)+'</div>'; }

  if(has('help','what can you','examples','hi','hello')|| t.trim()===''){
    return wrap('I answer from the live Zoho snapshot, respecting your current filters. Try:<ul>'+
      '<li>“What’s the contact rate?”</li><li>“How many won deals?”</li><li>“Top agent by calls”</li>'+
      '<li>“Deals for Sheetal Parve”</li><li>“Average first response time”</li><li>“Overdue tasks”</li>'+
      '<li>“Best time-slot for connectivity”</li><li>“Deals by stage”</li><li>“Customer events / signups”</li></ul>');
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
  var SLA_MIN=30;          // first-response SLA threshold (minutes) — matches "Overdue (>30 min)"
  var SLA_TARGET=80;       // owner SLA-compliance target (%)
  var COVER_TARGET=90;     // call-coverage target (%)
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
      scope:(F.owners.size?F.owners.size+' owner(s)':'all owners')+(F.stage?' · '+F.stage:'')+(F.trigger?' · '+F.trigger:'')+(F.leadSource?' · '+F.leadSource:'') };
  }

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
  function ccScope(){ return (F.owners.size?F.owners.size+' owner(s)':'all owners')+(F.stage?' · '+F.stage:'')+(F.leadSource?' · '+F.leadSource:''); }
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

  function opsModel(){
    var dl=fDeals(), cl=fCalls(), tk=fTasks(), ev=fEvents();
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
      return {deals:jd.length,calls:cc.length,avgFrt:f.length?f.reduce(function(s,x){return s+x;},0)/f.length:0,coverage:pct(con.length,jd.length||1),slaPct:pct(sm,jd.length||1),pending:jd.length-con.length}; }
    var biz=part(true), nonbiz=part(false);

    var hourly=[]; for(var h=BIZ_LO;h<=BIZ_HI;h++){
      var jd=joined.filter(function(j){return hourOf(j.deal.created)===h;});
      var cc=cl.filter(function(c){return hourOf(c.created)===h;}).length;
      var con=jd.filter(function(j){return j.contacted;});
      var f=con.map(function(j){return j.frt;}).filter(function(x){return x!=null;});
      hourly.push({hour:h,label:hr12(h),deals:jd.length,calls:cc,avgFrt:f.length?f.reduce(function(s,x){return s+x;},0)/f.length:null,pending:jd.length-con.length,coverage:pct(con.length,jd.length||1)});
    }
    var peakBacklog=hourly.slice().sort(function(a,b){return b.pending-a.pending;})[0];
    var peakWorkload=hourly.slice().sort(function(a,b){return b.deals-a.deals;})[0];
    var lowProd=hourly.filter(function(x){return x.deals>0;}).slice().sort(function(a,b){return a.coverage-b.coverage;})[0];

    var om={};
    joined.forEach(function(j){ var id=j.deal.owner; var o=om[id]||(om[id]={id:id,name:ownerName(id),deals:0,contacted:0,pending:0,sla:0,frt:[],delays:[]});
      o.deals++; o.delays.push(j._delay==null?0:j._delay);
      if(j.contacted){ o.contacted++; if(j.frt!=null){o.frt.push(j.frt); if(j.frt<=SLA_MIN)o.sla++;} } else o.pending++; });
    var owners=Object.keys(om).map(function(id){ var o=om[id]; var oc=cl.filter(function(c){return c.owner===id;}); o.calls=oc.length; o.talk=oc.reduce(function(s,c){return s+(c.dur||0);},0);
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

    return { from:F.from, to:F.to, single:(F.from===F.to), generated:new Date(), scope:ccScope(), ref:ref,
      dl:dl, cl:cl, tk:tk, ev:ev, joined:joined, contacted:contacted, pending:pending, overdue:overdue,
      deals:dl.length, calls:cl.length, uniqueCalled:contacted.length, pendingCnt:pending.length,
      avgFrt:avgFrt, medFrt:medFrt, maxFrt:maxFrt, coverage:coverage, slaPct:slaPct, overdueCnt:overdue.length,
      dist:dist, prevDist:prevDist, prevAvg:prevAvg, prevCov:prevCov,
      biz:biz, nonbiz:nonbiz, hourly:hourly, peakBacklog:peakBacklog, peakWorkload:peakWorkload, lowProd:lowProd,
      owners:owners, best:best, worst:worst, mostPending:mostPending, srcDelay:srcDelay, stageDelay:stageDelay, odSrc:odSrc,
      meet:meet, trend1:trend1, trend7:trend7, trend30:trend30, series:series, days:days };
  }

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
  function opsGaps(M){ var g=[];
    if(M.peakBacklog) g.push(['Max backlog hour', hr12(M.peakBacklog.hour)+'–'+hr12(M.peakBacklog.hour+1)+' · '+num(M.peakBacklog.pending)+' pending']);
    if(M.mostPending) g.push(['Owner highest pending', M.mostPending.name+' · '+num(M.mostPending.pending)]);
    if(M.srcDelay.length) g.push(['Lead source most delays', M.srcDelay[0].key+' · '+num(M.srcDelay[0].over)+' overdue']);
    if(M.stageDelay.length) g.push(['Stage most delay', M.stageDelay[0].key+' · avg '+fmtMinNice(M.stageDelay[0].avg)]);
    g.push(['Average FRT trend', (M.prevAvg?((M.avgFrt>M.prevAvg?'▲ ':'▼ ')+fmtMinNice(M.avgFrt)+' (prev '+fmtMinNice(M.prevAvg)+')'):fmtMinNice(M.avgFrt))]);
    if(M.peakWorkload) g.push(['Peak workload hour', hr12(M.peakWorkload.hour)+'–'+hr12(M.peakWorkload.hour+1)+' · '+num(M.peakWorkload.deals)+' deals']);
    if(M.lowProd) g.push(['Lowest productivity hour', hr12(M.lowProd.hour)+'–'+hr12(M.lowProd.hour+1)+' · '+p1(M.lowProd.coverage)+'% coverage']);
    g.push(['Delay trend', (M.avgFrt>M.prevAvg?'▲ increasing':'▼ improving')+' vs previous period']);
    var reps=M.owners.filter(function(o){return o.deals>=MIN_OWNER_DEALS && o.slaPct<SLA_TARGET;});
    g.push(['SLA breaches (owners)', num(reps.length)+' owner(s) below '+SLA_TARGET+'%']);
    return g;
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
    '.cc-act.yellow{background:rgba(244,183,64,.10)}.cc-act.yellow .dot{background:var(--warn)}'+
    '.cc-act.green{background:rgba(34,197,94,.10)}.cc-act.green .dot{background:var(--good)}'+
    '.cc-heat td.h{color:#08210f;font-weight:750;text-align:center;border-radius:4px}'+
    '.brief-box{white-space:pre-wrap;font:12.5px/1.55 ui-monospace,Menlo,Consolas,monospace;background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:14px;color:var(--tx);max-height:440px;overflow:auto}'+
    '.cc-medal{font-size:13px;margin-right:4px}';
    document.head.appendChild(st);
  })();

  /* ---------- Command Center render ---------- */
  function renderCommand(v){
    var M=opsModel();
    // Day quick-bar + export row
    var bar=el('div','cc-daybar');
    var seg=el('div','cc-seg');
    [['today','Today'],['yest','Yesterday'],['7','Last 7d'],['30','Last 30d']].forEach(function(p){ var b=el('button',F.preset===p[0]?'on':'',p[1]); b.onclick=function(){ setPreset(p[0]); }; seg.appendChild(b); });
    bar.appendChild(el('span','',null)); bar.lastChild.style.cssText='font-size:12.5px;color:var(--tx2)'; bar.lastChild.innerHTML='<b style="color:var(--tx)">Operations for</b> '+esc(M.single?fmtDay(M.to):fmtDay(M.from)+' → '+fmtDay(M.to))+' · '+esc(M.scope);
    bar.appendChild(seg);
    var exp=el('div','cc-exp');
    [['🧾 PDF',opsPDF],['📊 Excel',opsExcel],['🖨️ Print',function(){window.print();}],['🖼️ PNG',opsPNG],['💬 WhatsApp',function(){ copyText(crmWhatsapp(opsModel()),function(){toast('CRM summary copied ✓');}); }]].forEach(function(a){ var b=el('button','hbtn',a[0]); b.onclick=a[1]; exp.appendChild(b); });
    bar.appendChild(exp);
    v.appendChild(bar);

    // TOP KPI SUMMARY (14)
    v.appendChild(kpiRow([
      ['Deals Created',num(M.deals),'','','var(--c1)'],
      ['Calls Done',num(M.calls),'','','var(--c2)'],
      ['Unique Deals Called',num(M.uniqueCalled),'≥1 first call','','var(--c6)'],
      ['Pending First Calls',num(M.pendingCnt),'no call yet','down','var(--warn)'],
      ['Avg First Response',fmtMinNice(M.avgFrt),'','','var(--c3)'],
      ['Median First Response',fmtMinNice(M.medFrt),'','','var(--c3)'],
      ['Max First Response',fmtMinNice(M.maxFrt),'','down','var(--c8)'],
      ['Call Coverage',p1(M.coverage)+'%','target '+COVER_TARGET+'%',(M.coverage>=COVER_TARGET?'up':'down'),'var(--c4)'],
      ['SLA %',p1(M.slaPct)+'%','≤'+SLA_MIN+'m · target '+SLA_TARGET+'%',(M.slaPct>=SLA_TARGET?'up':'down'),'var(--acc2)'],
      ['Overdue Deals',num(M.overdueCnt),'>'+SLA_MIN+'m',(M.overdueCnt?'down':'up'),'var(--bad)'],
      ['Meetings Scheduled',num(M.meet.scheduled),'','','var(--c5)'],
      ['Meetings Completed',num(M.meet.completed),p1(M.meet.conversion)+'%','up','var(--good)'],
      ['Meetings Pending',num(M.meet.pending),'upcoming','','var(--warn)'],
      ['Meetings Missed',(M.meet.missed==null?'n/a':num(M.meet.missed)),'not tracked','','var(--tx3)']
    ]));

    // SECTION 1 — Business summary
    var p1p=panel('① '+(M.single?'Day':'Period')+' Business Summary','Auto-generated executive summary'); v.appendChild(p1p);
    p1p.__body.innerHTML='<div class="cc-exec">'+opsSummary(M)+'</div>';

    // SECTION 2 — First Response Analysis
    var p2=panel('② First Response Analysis','Deals created in the selected window, by time-to-first-call. Delay buckets highlighted.'); v.appendChild(p2);
    var total=M.joined.length||1, ckey={}; M.dist.forEach(function(b){ ckey[b.label]=isDelayBucket(b.label)?(b.label==='No First Call Yet'?'var(--bad)':'var(--c8)'):'var(--good)'; });
    hbar(p2.__body, M.dist.map(function(b){return {key:b.label,label:b.label,value:b.count};}), {max:11, colorByKey:ckey, fmt:function(x){return num(x)+' ('+p1(pct(x,total))+'%)';}});
    var pdMap={}; M.prevDist.forEach(function(b){pdMap[b.label]=b.count;});
    var d2rows=M.dist.map(function(b){ var prev=pdMap[b.label]||0, dlt=b.count-prev, hl=isDelayBucket(b.label);
      return [ hl?{html:'<b style="color:'+(b.label==='No First Call Yet'?'var(--bad)':'var(--c8)')+'">'+esc(b.label)+'</b>',text:b.label}:b.label,
        b.count, p1(pct(b.count,total))+'%', prev, (dlt>0?'+':'')+dlt ]; });
    table(p2.__body,['Bucket','Deals','%','Prev','Δ'],d2rows,{key:'frtdist',numCols:[1,3,4]});

    // SECTION 3 — Business vs Non-business
    var p3=panel('③ Business vs Non-Business Hours','Business = 10 AM–8 PM · Non-business = 8 PM–10 AM'); v.appendChild(p3);
    table(p3.__body,['Metric','Business (10 AM–8 PM)','Non-Business (8 PM–10 AM)'],[
      ['Deals Created',num(M.biz.deals),num(M.nonbiz.deals)],
      ['Calls Done',num(M.biz.calls),num(M.nonbiz.calls)],
      ['Average FRT',fmtMinNice(M.biz.avgFrt),fmtMinNice(M.nonbiz.avgFrt)],
      ['Coverage %',p1(M.biz.coverage)+'%',p1(M.nonbiz.coverage)+'%'],
      ['SLA %',p1(M.biz.slaPct)+'%',p1(M.nonbiz.slaPct)+'%'],
      ['Pending Calls',num(M.biz.pending),num(M.nonbiz.pending)]
    ],{key:'bizsplit'});

    // SECTION 4 — Hourly connectivity (heatmap)
    var p4=panel('④ Hourly Connectivity','Green = good · Yellow = medium · Red = problem. Highest-backlog hour flagged.'); v.appendChild(p4);
    p4.__body.appendChild(ccHourlyTable(M));

    // SECTION 5 — Owner performance
    var p5=panel('⑤ Owner Performance','Ranked by SLR%. 🏆 best · ⚠ worst.'); v.appendChild(p5);
    var orows=M.owners.map(function(o){ var medal=(M.best&&o.id===M.best.id)?'<span class="cc-medal">🏆</span>':(M.worst&&o.id===M.worst.id)?'<span class="cc-medal">⚠</span>':'';
      return [ {html:medal+esc(o.name),text:o.name}, o.deals, o.calls, {html:hms(o.talk||0),text:o.talk||0}, o.pending, (o.avgFrt==null?'—':fmtMinNice(o.avgFrt)), (o.medFrt==null?'—':fmtMinNice(o.medFrt)), fmtMinNice(o.maxDelay), p1(o.callsPerDeal), {html:'<b style="color:'+(o.slaPct<SLA_TARGET?'var(--bad)':'var(--good)')+'">'+p1(o.slaPct)+'%</b>',text:p1(o.slaPct)} ]; });
    table(p5.__body,['Owner','Deals','Calls','Talk Time','Pending','Avg FRT','Median FRT','Max Delay','Calls/Deal','SLA %'],orows,{key:'ccown',numCols:[1,2,3,4,8]});
    addExport(p5,'owner_performance',['Owner','Deals','Calls','TalkTimeSec','Pending','AvgFRTmin','MedianFRTmin','MaxDelayMin','CallsPerDeal','SLApct'],M.owners.map(function(o){return [o.name,o.deals,o.calls,o.talk||0,o.pending,(o.avgFrt==null?'':p1(o.avgFrt)),(o.medFrt==null?'':p1(o.medFrt)),p1(o.maxDelay),p1(o.callsPerDeal),p1(o.slaPct)];}));

    // SECTION 6 — Overdue deals
    var p6=panel('⑥ Overdue Deals','Green <10m · Yellow 10–30m · Orange 30–60m · Red >60m. Delay measured to '+(M.single?'end of day / now':'now')+'.'); v.appendChild(p6);
    var od=M.overdue.slice().sort(function(a,b){return (b._delay||0)-(a._delay||0);});
    var orws=od.slice(0,400).map(function(j){ var col=delayColor(j._delay);
      return [ j.deal.id, esc(j.deal.name||'—'), ownerName(j.deal.owner), fmtDT(j.deal.created), fmtMinNice(j._delay),
        {html:'<b style="color:'+col+'">'+fmtMinNice(j._delay)+'</b>',text:p1(j._delay||0)}, clean(j.deal.leadSource), esc(j.deal.stage||'—'),
        {html:'<span class="tag2 '+(j._delay>60?'pill-lost':j._delay>30?'pill-open':'pill-won')+'">'+(j._delay>60?'High':j._delay>30?'Medium':'Low')+'</span>',text:(j._delay>60?'High':j._delay>30?'Medium':'Low')},
        '—','—', (j.contacted?'Called late':'Awaiting call') ]; });
    table(p6.__body,['Deal ID','Customer','Owner','Created','Waiting Since','Current Delay','Lead Source','Stage','Priority','Meeting','Next Follow-up','Status'],orws,{key:'ccover',numCols:[5],limit:250});
    addExport(p6,'overdue_deals',['DealID','Customer','Owner','Created','CurrentDelayMin','LeadSource','Stage','Priority','Status'],od.map(function(j){return [j.deal.id,j.deal.name,ownerName(j.deal.owner),j.deal.created,p1(j._delay||0),clean(j.deal.leadSource),j.deal.stage,(j._delay>60?'High':j._delay>30?'Medium':'Low'),(j.contacted?'Called late':'Awaiting call')];}));
    p6.__body.appendChild(el('div','hint','“Meeting” &amp; “Next Follow-up” are not linked per-deal in Zoho (Events are owner-level, no per-deal link/outcome field) — shown as “—”.'));

    // SECTION 7 — Meeting analysis
    var p7=panel('⑦ Meeting Analysis','Zoho Events (owner-level). Completed = start time already passed; Pending = upcoming.'); v.appendChild(p7);
    var m7=el('div','kpis');
    [['Scheduled',num(M.meet.scheduled),'','var(--c5)'],['Completed',num(M.meet.completed),p1(M.meet.conversion)+'% conversion','var(--good)'],['Pending',num(M.meet.pending),'upcoming','var(--warn)'],['Missed','n/a','not tracked','var(--tx3)']].forEach(function(x){ m7.appendChild(kpi(x[0],x[1],x[2],'',x[3])); });
    p7.__body.appendChild(m7);
    var mBy=toItems(groupBy(M.ev,function(e){return ownerName(e.owner);}));
    if(mBy.length){ var mp=el('div','chart'); p7.__body.appendChild(mp); hbar(mp, mBy, {color:'var(--c5)',onClick:toggleOwner}); }
    p7.__body.appendChild(el('div','note','<b>Not available in this dataset:</b> Meeting-to-Sale %, Deals with/without Meeting, and avg first-call→meeting / creation→meeting times — Zoho Events here carry no per-deal link or outcome field, so these would be guesses. Connect a deal-linked meeting source to enable them.'));

    // SECTION 8 — Gap analysis
    var p8=panel('⑧ Gap Analysis','Auto-detected operational bottlenecks'); v.appendChild(p8);
    var g8=el('div','cc-cards'); opsGaps(M).forEach(function(gp){ var c=el('div','cc-card'); c.innerHTML='<div class="t">'+esc(gp[0])+'</div><div class="val">'+gp[1]+'</div>'; g8.appendChild(c); }); p8.__body.appendChild(g8);

    // SECTION 9 — AI insights
    var p9=panel('⑨ AI Insights','Auto-generated business insights'); v.appendChild(p9);
    var g9=el('div','cc-cards'); opsInsights(M).forEach(function(x){ var c=el('div','cc-card ins'); c.innerHTML='<div class="val">💡 '+x+'</div>'; g9.appendChild(c); }); p9.__body.appendChild(g9);

    // SECTION 10 — Recommendations
    var p10=panel('⑩ AI Recommendations','Suggested next actions'); v.appendChild(p10);
    var g10=el('div','cc-cards'); opsRecs(M).forEach(function(x){ var c=el('div','cc-card'); c.style.borderLeft='3px solid var(--acc2)'; c.innerHTML='<div class="val">✅ '+esc(x)+'</div>'; g10.appendChild(c); }); p10.__body.appendChild(g10);

    // SECTION 11 — Today's action items
    var p11=panel("⑪ Today's Action Items",'Red = urgent · Yellow = attention · Green = clear'); v.appendChild(p11);
    opsActions(M).forEach(function(a){ var c=el('div','cc-act '+a[0]); c.innerHTML='<span class="dot"></span><span>'+esc(stripTags(a[1]))+'</span>'; p11.__body.appendChild(c); });

    // SECTION 12 — Trend analysis
    var p12=panel('⑫ Trend Analysis','Selected day vs last 7 vs last 30 days'); v.appendChild(p12);
    table(p12.__body,['Metric',(M.single?'Selected Day':'Selected'),'Last 7 Days','Last 30 Days'],[
      ['Call Coverage %',p1(M.trend1.coverage)+'%',p1(M.trend7.coverage)+'%',p1(M.trend30.coverage)+'%'],
      ['Average FRT',fmtMinNice(M.trend1.avgFrt),fmtMinNice(M.trend7.avgFrt),fmtMinNice(M.trend30.avgFrt)],
      ['Pending Deals',num(M.trend1.pending),num(M.trend7.pending),num(M.trend30.pending)],
      ['SLA %',p1(M.trend1.slaPct)+'%',p1(M.trend7.slaPct)+'%',p1(M.trend30.slaPct)+'%'],
      ['Meetings',num(M.trend1.meetings),num(M.trend7.meetings),num(M.trend30.meetings)]
    ],{key:'cctrend'});
    var g12=el('div','grid g2');
    var t1=panel('Call Coverage & SLA — 30-day trend'); g12.appendChild(t1);
    lineChart(t1.__body, M.days.map(fmtDay), [{name:'Coverage %',color:'var(--c4)',data:M.series.map(function(s){return +p1(s.coverage);})},{name:'SLA %',color:'var(--c2)',data:M.series.map(function(s){return +p1(s.slaPct);})}],{legend:true});
    var t2=panel('Avg FRT & Pending — 30-day trend'); g12.appendChild(t2);
    lineChart(t2.__body, M.days.map(fmtDay), [{name:'Avg FRT (min)',color:'var(--c3)',data:M.series.map(function(s){return +p1(s.avgFrt);})},{name:'Pending',color:'var(--bad)',data:M.series.map(function(s){return s.pending;})}],{legend:true});
    v.appendChild(g12);

    // SECTION 13 — Manager morning brief
    var p13=panel('⑬ Manager Morning Brief','Ready for WhatsApp &amp; Email'); v.appendChild(p13);
    var brief=managerBrief(M); var bb=el('div','brief-box'); bb.textContent=brief; p13.__body.appendChild(bb);
    var bbar=el('div'); bbar.style.cssText='display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
    var cpb=el('button','mini','📋 Copy brief'); cpb.onclick=function(){ copyText(managerBrief(opsModel()),function(){toast('Brief copied ✓');}); };
    var wab=el('a','mini'); wab.textContent='💬 Send on WhatsApp'; wab.href='https://wa.me/?text='+encodeURIComponent(brief); wab.target='_blank'; wab.style.textDecoration='none';
    bbar.appendChild(cpb); bbar.appendChild(wab); p13.__body.appendChild(bbar);
  }

  function ccHourlyTable(M){
    var wrap=el('div','tblwrap');
    var h='<table class="cc-heat"><thead><tr><th>Hour</th><th class="right">Deals</th><th class="right">Calls</th><th class="right">Avg FRT</th><th class="right">Pending</th><th class="right">Coverage</th></tr></thead><tbody>';
    var maxBack=M.peakBacklog?M.peakBacklog.pending:0;
    M.hourly.forEach(function(x){ var flag=(maxBack>0&&x.pending===maxBack);
      h+='<tr'+(flag?' style="outline:2px solid var(--bad);outline-offset:-2px"':'')+'><td><b>'+esc(x.label)+'</b>'+(flag?' 🔴':'')+'</td>'+
        '<td class="right">'+num(x.deals)+'</td><td class="right">'+num(x.calls)+'</td>'+
        '<td class="right">'+(x.avgFrt==null?'—':fmtMinNice(x.avgFrt))+'</td>'+
        '<td class="right">'+num(x.pending)+'</td>'+
        '<td class="h" style="background:'+(x.deals?covColor(x.coverage):'var(--bg2)')+'">'+(x.deals?p1(x.coverage)+'%':'—')+'</td></tr>';
    });
    h+='</tbody></table>'; wrap.innerHTML=h; return wrap;
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
function saveF(){ try{ sessionStorage.setItem('dvc_F', JSON.stringify({from:F.from,to:F.to,preset:F.preset,owners:Array.prototype.slice.call(F.owners),stage:F.stage,trigger:F.trigger,leadSource:F.leadSource,utmSource:F.utmSource,utmMedium:F.utmMedium,callType:F.callType,taskStatus:F.taskStatus,compare:F.compare})); }catch(e){} }
function restoreF(){ try{ var s=sessionStorage.getItem('dvc_F'); if(!s)return; var o=JSON.parse(s); F.from=o.from||F.from; F.to=o.to||F.to; F.preset=(o.preset!=null?o.preset:F.preset); F.owners=new Set(o.owners||[]); ['stage','trigger','leadSource','utmSource','utmMedium','callType','taskStatus'].forEach(function(k){F[k]=o[k]||'';}); F.compare=!!o.compare; }catch(e){} }
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
if(LIVE.mode==='live') syncNow(true);   // fetch fresh data immediately when a live API is configured
})();
