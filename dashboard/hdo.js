/* Hourly Deals vs Orders Dashboard — all aggregation done client-side.
   Deals + Orders both come from one fast BigQuery-backed endpoint
   (hourly-deals-orders-api): Deals from zoho_crm.cdc_deals (the same
   CDC table the old 20MB zoho-crm-bundle-public reads from, but filtered
   to a rolling window server-side -- a couple hundred KB instead of ~20MB,
   ~1-2s instead of 30-40s), Orders from ds_imputed_reporting.marketing_sale. */
'use strict';

var CONFIG = {
  DATA_API: 'https://hourly-deals-orders-api-3mvv5mdr2q-el.a.run.app',
  DATA_DAYS: 60 // rolling window pulled from the API, covers all quick filters + range comparison
};

var STATE = {
  deals: [],      // [{id, owner, created}]
  orders: [],     // [{id, created, channel}]
  owners: {},
  dates: [],      // ["YYYY-MM-DD", ...] DESCENDING -- most recent date (Today, if in range) first
  hourView: 'all',
  ownerFilter: '',
  agg: {},        // agg[date][hour] = {deals:Set, orders:Set, store:Set, online:Set, other:Set}
  autoMs: 3600000 // auto-refresh interval, default 1 hour
};
var _autoTimer=null;

/* marketing_sale.Channel values seen: Store, Online, Amazon, TAH -- fold anything
   that isn't Store/Online into "Other" so Store+Online+Other always foots to Orders. */
function normChannel(ch){
  var c=(ch||'').trim().toLowerCase();
  if(c==='store') return 'store';
  if(c==='online') return 'online';
  return 'other';
}

/* ---------- date/time helpers (Asia/Kolkata) ---------- */
function istTodayStr(){ return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date()); }
function istNowHour(){ // current IST hour, 0-23, computed dynamically -- never hardcoded
  var parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  var h = parts.find(function(p){return p.type==='hour';});
  return h ? (parseInt(h.value,10)%24) : new Date().getUTCHours();
}
function addDaysStr(s,delta){ var d=new Date(s+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+delta); return d.toISOString().slice(0,10); }
function fmtDateLabel(s){ var d=new Date(s+'T00:00:00Z'); return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'}); }
function splitCreated(iso){ // "YYYY-MM-DDTHH:MM:SS" -> {date, hour}
  if(!iso || iso.length<13) return null;
  var date=iso.slice(0,10), hour=parseInt(iso.slice(11,13),10);
  if(isNaN(hour)) return null;
  return {date:date, hour:hour};
}
function hh12(h){ var period=h<12?'AM':'PM'; var v=h%12; if(v===0) v=12; return {v:v,period:period}; }
function hourLabel(h){
  var s=hh12(h), e=hh12((h+1)%24);
  return s.v+'–'+e.v+' '+e.period;
}
// Business-day order: starts at store-open 10 AM, runs forward through the full
// 24 hours, ending at 9-10 AM the next morning (10,11,...,23,0,1,...,9).
var BIZ_HOURS=[10,11,12,13,14,15,16,17,18,19,20,21];
var ALL_HOURS=[10,11,12,13,14,15,16,17,18,19,20,21,22,23,0,1,2,3,4,5,6,7,8,9];
function activeHours(){ return STATE.hourView==='all'?ALL_HOURS:BIZ_HOURS; }

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function fmtInt(n){ return (n||0).toLocaleString('en-IN'); }
function fmtPct1(n){ return (isFinite(n)?n:0).toFixed(1)+'%'; }
function fmtLakh(n){ return (Math.abs(n||0)<0.005?'0.00':((n||0)/1e5).toFixed(2))+' L'; }
function fmtMoney(n){
  n = n||0;
  var sign = n<0 ? '-' : ''; n = Math.abs(n);
  if(n>=1e7) return sign+'₹'+(n/1e7).toFixed(2)+' Cr';
  if(n>=1e5) return sign+'₹'+(n/1e5).toFixed(2)+' L';
  if(n>=1e3) return sign+'₹'+(n/1e3).toFixed(1)+'K';
  return sign+'₹'+Math.round(n).toLocaleString('en-IN');
}

/* ---------- fetch ---------- */
function fetchJson(url){ return fetch(url,{cache:'no-store'}).then(function(r){ if(!r.ok) throw new Error('http '+r.status); return r.json(); }); }

function loadAll(){
  document.getElementById('freshPill').innerHTML='<span class="dot"></span> loading…';
  var t0=performance.now();
  var url=CONFIG.DATA_API ? (CONFIG.DATA_API+'?days='+CONFIG.DATA_DAYS) : null;
  var p = url ? fetchJson(url) : Promise.resolve(null);
  p.then(function(data){
    STATE.deals = [];
    if(data && data.deals){
      var fi = (data.dealFields||[]).reduce(function(m,f,i){m[f]=i;return m;},{});
      var iId=fi.id!=null?fi.id:0, iCreated=fi.created!=null?fi.created:1, iOwnerId=fi.ownerId!=null?fi.ownerId:2, iOwnerName=fi.ownerName!=null?fi.ownerName:3;
      data.deals.forEach(function(row){
        var id=row[iId], created=row[iCreated], ownerName=row[iOwnerName];
        var sp=splitCreated((created||'').replace(' ','T'));
        if(id!=null && sp) STATE.deals.push({id:id, ownerName:ownerName||'(unassigned)', date:sp.date, hour:sp.hour});
      });
    }
    STATE.orders=[];
    if(data && data.orders){
      data.orders.forEach(function(row){
        var id=row[0], created=row[1], channel=row[2], netSale=row[3];
        var sp=splitCreated(created);
        if(id!=null && sp) STATE.orders.push({id:id, date:sp.date, hour:sp.hour, channel:normChannel(channel), netSale:Number(netSale)||0});
      });
    }
    var pill=document.getElementById('freshPill');
    var tookS=((performance.now()-t0)/1000).toFixed(1);
    if(data){ pill.className='pill live'; pill.innerHTML='<span class="dot"></span> Live · Deals+Orders as of '+new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'})+' IST · loaded in '+tookS+'s'; }
    else { pill.className='pill snap'; pill.innerHTML='<span class="dot"></span> Could not load data (set CONFIG.DATA_API)'; }

    populateOwnerFilter();
    if(!STATE.dates.length) resetToLatestWindow();
    else render();
    renderRangeCompare();
    document.getElementById('boot').classList.add('hide');
  }).catch(function(e){
    var pill=document.getElementById('freshPill'); pill.className='pill snap'; pill.innerHTML='<span class="dot"></span> Error: '+esc(e.message);
    document.getElementById('boot').classList.add('hide');
  });
}

function populateOwnerFilter(){
  var names={}; STATE.deals.forEach(function(d){ names[d.ownerName]=1; });
  var sel=document.getElementById('fOwner'); var cur=sel.value;
  sel.innerHTML='<option value="">All Agents</option>'+Object.keys(names).sort().map(function(n){return '<option value="'+esc(n)+'">'+esc(n)+'</option>';}).join('');
  sel.value = names[cur]?cur:'';
}

function setDatesFromRange(from,to,capDays){
  var asc=[]; var cur=to;
  var cap=capDays||14;
  while(asc.length<cap && cur>=from){ asc.unshift(cur); cur=addDaysStr(cur,-1); }
  if(!asc.length) return;
  STATE.dates=asc.slice().reverse(); // descending -- most recent first
  document.getElementById('fFrom').value=from;
  document.getElementById('fTo').value=to;
  render();
}

function resetToLatestWindow(){ // Quick filter: Today only
  var today=istTodayStr();
  setDatesFromRange(today,today,1);
}
function quickYesterday(){
  var y=addDaysStr(istTodayStr(),-1);
  setDatesFromRange(y,y,1);
}
function quickWeekly(){ // last 7 days including today
  var today=istTodayStr();
  setDatesFromRange(addDaysStr(today,-6),today,7);
}

function applyDateRange(){
  var from=document.getElementById('fFrom').value, to=document.getElementById('fTo').value;
  if(!from||!to||from>to) return;
  setDatesFromRange(from,to,14);
}

/* ---------- aggregation ---------- */
function buildAgg(){
  var agg={}; STATE.dates.forEach(function(d){ agg[d]={}; ALL_HOURS.forEach(function(h){ agg[d][h]={deals:new Set(),orders:new Set(),store:new Set(),online:new Set(),other:new Set(),revenue:0}; }); });
  var dateSet={}; STATE.dates.forEach(function(d){dateSet[d]=1;});
  STATE.deals.forEach(function(d){
    if(!dateSet[d.date]) return;
    if(STATE.ownerFilter && d.ownerName!==STATE.ownerFilter) return;
    agg[d.date][d.hour].deals.add(d.id);
  });
  STATE.orders.forEach(function(o){
    if(!dateSet[o.date]) return;
    var c=agg[o.date][o.hour];
    c.orders.add(o.id);
    c[o.channel].add(o.id);
    // Revenue sums EVERY line item's net_sale (not deduped by order id) --
    // a multi-item order has one marketing_sale row per item, each with its
    // own net_sale, and all of them belong in the total.
    c.revenue += o.netSale||0;
  });
  STATE.agg=agg;
  return agg;
}

function cellStats(date,hour){
  var c=STATE.agg[date] && STATE.agg[date][hour];
  var deals=c?c.deals.size:0, orders=c?c.orders.size:0;
  var store=c?c.store.size:0, online=c?c.online.size:0, other=c?c.other.size:0;
  var revenue=c?c.revenue:0;
  var conv=deals>0?(orders/deals*100):0;
  return {deals:deals,orders:orders,conv:conv,store:store,online:online,other:other,revenue:revenue};
}

// Same-hour stats for an arbitrary date, computed directly from the raw loaded
// arrays -- unlike cellStats() this doesn't require the date to be part of the
// currently displayed STATE.dates window (used for "previous day" comparisons
// on the latest date column, whose previous day may not itself be on screen).
function hourStatsRaw(date,hour){
  var deals=new Set(), orders=new Set();
  STATE.deals.forEach(function(d){
    if(d.date!==date || d.hour!==hour) return;
    if(STATE.ownerFilter && d.ownerName!==STATE.ownerFilter) return;
    deals.add(d.id);
  });
  STATE.orders.forEach(function(o){ if(o.date===date && o.hour===hour) orders.add(o.id); });
  var dn=deals.size, on=orders.size;
  return {deals:dn, orders:on, conv:dn>0?(on/dn*100):0};
}

// "18 ↑ 20%" / "12 ↓ 14%" / "15 → 0%" / "18 ↑ New" -- day-over-day change for one
// metric value. valFmt formats the raw value (int or 1-decimal percent).
function arrowDelta(cur,prev){
  if(prev<=0) return cur>0 ? ' <span class="arrow-up">↑ New</span>' : ' <span class="arrow-flat">→ 0%</span>';
  var pct=Math.abs((cur-prev)/prev*100), pctTxt=Math.round(pct)+'%';
  if(cur>prev) return ' <span class="arrow-up">↑ '+pctTxt+'</span>';
  if(cur<prev) return ' <span class="arrow-down">↓ '+pctTxt+'</span>';
  return ' <span class="arrow-flat">→ 0%</span>';
}

/* ---------- render: KPIs ---------- */
function render(){
  buildAgg();
  document.getElementById('chipMeta').textContent = STATE.dates.map(fmtDateLabel).join('  ·  ') + (STATE.ownerFilter?'  ·  Agent: '+STATE.ownerFilter:'');
  document.getElementById('kpiSub').textContent = 'Across '+STATE.dates.map(fmtDateLabel).join(', ')+(STATE.dates.indexOf(istTodayStr())>=0?' (today is still in progress)':'');
  document.getElementById('tblSub').textContent = STATE.hourView==='all' ? 'All 24 hours' : 'Business hours 10 AM – 10 PM';
  renderKpis();
  renderMainTable();
}

function renderKpis(){
  var hours=activeHours();
  var totalDeals=0, totalOrders=0, totalRevenue=0;
  var byHourDeals={}, byHourOrders={}, byHourConv={}, byHourRevenue={};
  STATE.dates.forEach(function(date){
    hours.forEach(function(h){
      var s=cellStats(date,h);
      totalDeals+=s.deals; totalOrders+=s.orders; totalRevenue+=s.revenue;
      byHourDeals[h]=(byHourDeals[h]||0)+s.deals;
      byHourOrders[h]=(byHourOrders[h]||0)+s.orders;
      byHourRevenue[h]=(byHourRevenue[h]||0)+s.revenue;
    });
  });
  hours.forEach(function(h){ byHourConv[h]= byHourDeals[h]>0 ? (byHourOrders[h]/byHourDeals[h]*100) : 0; });
  var overallConv = totalDeals>0 ? (totalOrders/totalDeals*100) : 0;
  function bestHour(map){ var bh=null,bv=-1; hours.forEach(function(h){ if((map[h]||0)>bv){bv=map[h];bh=h;} }); return {h:bh,v:bv}; }
  var bd=bestHour(byHourDeals), bo=bestHour(byHourOrders), bc=bestHour(byHourConv), br=bestHour(byHourRevenue);

  var nDays=STATE.dates.length;
  var cards=[
    {lbl:'Total Deals — '+nDays+' Days', val:fmtInt(totalDeals), sub:STATE.dates.map(fmtDateLabel).join(' → ')},
    {lbl:'Total Orders — '+nDays+' Days', val:fmtInt(totalOrders), sub:'unique Order ID'},
    {lbl:'Total Revenue — '+nDays+' Days', val:fmtMoney(totalRevenue), sub:'SUM(net_sale), marketing_sale'},
    {lbl:'Overall Conversion %', val:fmtPct1(overallConv), sub:'Orders ÷ Deals × 100'},
    {lbl:'Highest Deal Hour', val:bd.h!=null?hourLabel(bd.h):'—', sub:bd.h!=null?fmtInt(bd.v)+' deals (summed)':''},
    {lbl:'Highest Order Hour', val:bo.h!=null?hourLabel(bo.h):'—', sub:bo.h!=null?fmtInt(bo.v)+' orders (summed)':''},
    {lbl:'Highest Conversion Hour', val:bc.h!=null?hourLabel(bc.h):'—', sub:bc.h!=null?fmtPct1(bc.v):''},
    {lbl:'Highest Revenue Hour', val:br.h!=null?hourLabel(br.h):'—', sub:br.h!=null?fmtMoney(br.v)+' (summed)':''}
  ];
  document.getElementById('kpiGrid').innerHTML = cards.map(function(c){
    return '<div class="kpi"><div class="lbl">'+esc(c.lbl)+'</div><div class="val">'+c.val+'</div><div class="sub">'+esc(c.sub)+'</div></div>';
  }).join('');
}

/* ---------- render: main multi-level table ---------- */
function renderMainTable(){
  var hours=activeHours(), dates=STATE.dates;
  var today=istTodayStr(), nowHour=istNowHour();
  var latestDate=dates.length?dates[0]:null; // dates run newest-first (section 1)

  function isFutureCell(date,hour){ return date===today && hour>nowHour; }

  // find column maxima for highlighting -- future (not-yet-happened) hours of
  // today are excluded so they can never appear as a "best" hour
  var maxDeals={}, maxOrders={}, maxConv={}, maxStore={}, maxOnline={}, maxRevenue={};
  dates.forEach(function(date){
    var md=-1,mo=-1,mc=-1,ms=-1,mn=-1,mr=-1;
    hours.forEach(function(h){
      if(isFutureCell(date,h)) return;
      var s=cellStats(date,h);
      if(s.deals>md)md=s.deals; if(s.orders>mo)mo=s.orders; if(s.conv>mc)mc=s.conv; if(s.store>ms)ms=s.store; if(s.online>mn)mn=s.online; if(s.revenue>mr)mr=s.revenue;
    });
    maxDeals[date]=md; maxOrders[date]=mo; maxConv[date]=mc; maxStore[date]=ms; maxOnline[date]=mn; maxRevenue[date]=mr;
  });

  var thead='<thead><tr><th class="hourcol" rowspan="2">Hour</th>'+
    dates.map(function(d){ return '<th class="datehead" colspan="6">'+esc(fmtDateLabel(d))+(d===today?' <span class="todaybadge">TODAY · LIVE</span>':'')+'</th>'; }).join('')+
    '</tr><tr>'+
    dates.map(function(){ return '<th>Deals</th><th>Orders</th><th>Conv. %</th><th>Store</th><th>Online</th><th>Revenue (L)</th>'; }).join('')+
    '</tr></thead>';

  var totals={}; dates.forEach(function(d){ totals[d]={deals:0,orders:0,store:0,online:0,other:0,revenue:0}; });
  var rows = hours.map(function(h){
    var tds = dates.map(function(date){
      if(isFutureCell(date,h)){
        // Hour hasn't happened yet today -- don't render it as a real "0".
        return '<td class="future">—</td><td class="future">—</td><td class="future">—</td><td class="future">—</td><td class="future">—</td><td class="future">—</td>';
      }
      var s=cellStats(date,h);
      totals[date].deals+=s.deals; totals[date].orders+=s.orders; totals[date].store+=s.store; totals[date].online+=s.online; totals[date].other+=s.other; totals[date].revenue+=s.revenue;
      var dCls=(s.deals>0 && s.deals===maxDeals[date])?'best':(s.deals===0?'zero':'');
      var oCls=(s.orders>0 && s.orders===maxOrders[date])?'best':(s.orders===0?'zero':'');
      var cCls=(s.conv>0 && s.conv===maxConv[date])?'best':(s.conv===0?'zero':'');
      var sCls=(s.store>0 && s.store===maxStore[date])?'best':(s.store===0?'zero':'');
      var nCls=(s.online>0 && s.online===maxOnline[date])?'best':(s.online===0?'zero':'');
      var rCls=(s.revenue>0 && s.revenue===maxRevenue[date])?'best':(s.revenue===0?'zero':'');

      var dealsTxt=fmtInt(s.deals), ordersTxt=fmtInt(s.orders), convTxt=fmtPct1(s.conv);
      if(date===latestDate){
        // Day-over-day arrows vs the same hour, previous calendar day -- only on
        // the latest/current date column, per same-hour-vs-same-hour comparison.
        var prevDate=addDaysStr(date,-1);
        var p=hourStatsRaw(prevDate,h);
        dealsTxt+=arrowDelta(s.deals,p.deals);
        ordersTxt+=arrowDelta(s.orders,p.orders);
        convTxt+=arrowDelta(s.conv,p.conv);
      }
      return '<td class="'+dCls+'">'+dealsTxt+'</td><td class="'+oCls+'">'+ordersTxt+'</td><td class="'+cCls+'">'+convTxt+'</td>'+
        '<td class="'+sCls+'">'+fmtInt(s.store)+'</td><td class="'+nCls+'">'+fmtInt(s.online)+'</td><td class="'+rCls+'">'+fmtLakh(s.revenue)+'</td>';
    }).join('');
    return '<tr><td class="hourcol">'+hourLabel(h)+'</td>'+tds+'</tr>';
  }).join('');

  var tfoot = '<tfoot><tr><td class="hourcol">Total</td>'+dates.map(function(d){
    var t=totals[d]; var c=t.deals>0?(t.orders/t.deals*100):0;
    return '<td>'+fmtInt(t.deals)+'</td><td>'+fmtInt(t.orders)+'</td><td>'+fmtPct1(c)+'</td><td>'+fmtInt(t.store)+'</td><td>'+fmtInt(t.online)+'</td><td>'+fmtLakh(t.revenue)+'</td>';
  }).join('')+'</tr></tfoot>';

  document.getElementById('mainTable').innerHTML = thead+'<tbody>'+rows+'</tbody>'+tfoot;
  window.__hdoTotals = totals;
}

function exportCsv(){
  var hours=activeHours(), dates=STATE.dates;
  var today=istTodayStr(), nowHour=istNowHour();
  var header1=['Hour']; dates.forEach(function(d){ header1.push(fmtDateLabel(d),'','','','','' ); });
  var header2=['']; dates.forEach(function(){ header2.push('Deals','Orders','Conv. %','Store','Online','Revenue (L)'); });
  var lines=[header1.join(','), header2.join(',')];
  hours.forEach(function(h){
    var row=[hourLabel(h)];
    dates.forEach(function(date){
      if(date===today && h>nowHour){ row.push('','','','','',''); return; }
      var s=cellStats(date,h); row.push(s.deals,s.orders,s.conv.toFixed(1),s.store,s.online,(s.revenue/1e5).toFixed(2));
    });
    lines.push(row.join(','));
  });
  var blob=new Blob([lines.join('\n')],{type:'text/csv'});
  var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='hourly_deals_orders.csv'; a.click();
}

/* ---------- date-range comparison (independent of the main table's window) ---------- */
function rangeStats(from,to){
  var deals=new Set(), orders=new Set(), store=new Set(), online=new Set();
  STATE.deals.forEach(function(d){
    if(d.date<from || d.date>to) return;
    if(STATE.ownerFilter && d.ownerName!==STATE.ownerFilter) return;
    deals.add(d.id);
  });
  STATE.orders.forEach(function(o){
    if(o.date<from || o.date>to) return;
    orders.add(o.id);
    if(o.channel==='store') store.add(o.id);
    if(o.channel==='online') online.add(o.id);
  });
  var dn=deals.size, on=orders.size;
  return {deals:dn, orders:on, store:store.size, online:online.size, conv: dn>0?(on/dn*100):0};
}

function setRangeCompare(fromA,toA,fromB,toB){
  document.getElementById('rcAFrom').value=fromA; document.getElementById('rcATo').value=toA;
  document.getElementById('rcBFrom').value=fromB; document.getElementById('rcBTo').value=toB;
  renderRangeCompare();
}
function rcTodayVsYesterday(){ var t=istTodayStr(), y=addDaysStr(t,-1); setRangeCompare(y,y,t,t); }
function rcWeekVsLastWeek(){
  var t=istTodayStr();
  var thisWkFrom=addDaysStr(t,-6), thisWkTo=t;
  var lastWkFrom=addDaysStr(t,-13), lastWkTo=addDaysStr(t,-7);
  setRangeCompare(lastWkFrom,lastWkTo,thisWkFrom,thisWkTo);
}

function renderRangeCompare(){
  var fromA=document.getElementById('rcAFrom').value, toA=document.getElementById('rcATo').value;
  var fromB=document.getElementById('rcBFrom').value, toB=document.getElementById('rcBTo').value;
  if(!fromA||!toA||!fromB||!toB){ return; }
  var a=rangeStats(fromA,toA), b=rangeStats(fromB,toB);
  function delta(x,y){
    if(x<=0) return y>0?'<span class="arrow-up">▲ new</span>':'';
    var pct=((y-x)/x*100);
    if(Math.abs(pct)<0.05) return ' <span class="arrow-flat">— 0.0%</span>';
    return pct>0 ? ' <span class="arrow-up">▲ +'+pct.toFixed(1)+'%</span>' : ' <span class="arrow-down">▼ '+pct.toFixed(1)+'%</span>';
  }
  var rangeLabel=function(f,t){ return f===t ? fmtDateLabel(f) : (fmtDateLabel(f)+' → '+fmtDateLabel(t)); };
  var rows=[
    ['Deals', fmtInt(a.deals), fmtInt(b.deals), delta(a.deals,b.deals)],
    ['Orders', fmtInt(a.orders), fmtInt(b.orders), delta(a.orders,b.orders)],
    ['Conv. %', fmtPct1(a.conv), fmtPct1(b.conv), delta(a.conv,b.conv)],
    ['Store Orders', fmtInt(a.store), fmtInt(b.store), delta(a.store,b.store)],
    ['Online Orders', fmtInt(a.online), fmtInt(b.online), delta(a.online,b.online)]
  ];
  var html='<table class="hdo"><thead><tr><th class="hourcol">Metric</th><th>Range A<br><span style="font-weight:400;font-size:10.5px">'+esc(rangeLabel(fromA,toA))+'</span></th>'+
    '<th>Range B<br><span style="font-weight:400;font-size:10.5px">'+esc(rangeLabel(fromB,toB))+'</span></th><th>B vs A</th></tr></thead><tbody>'+
    rows.map(function(r){ return '<tr><td class="hourcol">'+r[0]+'</td><td>'+r[1]+'</td><td>'+r[2]+'</td><td>'+r[3]+'</td></tr>'; }).join('')+
    '</tbody></table>';
  document.getElementById('rangeCompareTable').innerHTML=html;
}

/* ---------- auto-refresh ---------- */
function scheduleAutoRefresh(){
  if(_autoTimer){ clearInterval(_autoTimer); _autoTimer=null; }
  if(STATE.autoMs>0) _autoTimer=setInterval(loadAll, STATE.autoMs);
}

/* ---------- wiring ---------- */
document.addEventListener('DOMContentLoaded', function(){
  document.getElementById('fLatestBtn').onclick = resetToLatestWindow;
  document.getElementById('fYesterdayBtn').onclick = quickYesterday;
  document.getElementById('fWeeklyBtn').onclick = quickWeekly;
  document.getElementById('fFrom').onchange = applyDateRange;
  document.getElementById('fTo').onchange = applyDateRange;
  document.getElementById('fHourView').onchange = function(e){ STATE.hourView=e.target.value; render(); };
  document.getElementById('fOwner').onchange = function(e){ STATE.ownerFilter=e.target.value; render(); renderRangeCompare(); };
  document.getElementById('refreshBtn').onclick = loadAll;
  document.getElementById('csvBtn').onclick = exportCsv;
  document.getElementById('printBtn').onclick = function(){ window.print(); };
  document.getElementById('themeBtn').onclick = function(){
    var html=document.documentElement;
    html.setAttribute('data-theme', html.getAttribute('data-theme')==='light'?'dark':'light');
  };
  var autoSel=document.getElementById('fAutoRefresh');
  if(autoSel){ autoSel.value=String(STATE.autoMs); autoSel.onchange=function(e){ STATE.autoMs=parseInt(e.target.value,10)||0; scheduleAutoRefresh(); }; }

  ['rcAFrom','rcATo','rcBFrom','rcBTo'].forEach(function(id){ document.getElementById(id).onchange=renderRangeCompare; });
  document.getElementById('rcTodayYestBtn').onclick = rcTodayVsYesterday;
  document.getElementById('rcWeekBtn').onclick = rcWeekVsLastWeek;
  rcTodayVsYesterday(); // seed default comparison before first load completes

  scheduleAutoRefresh();
  loadAll();
});
