/* Store Visit Campaign Intelligence — engine
   Data: window.STORE_VISIT_DATA (dashboard/store_visit_data.js), a static snapshot pulled straight
   from lucirajewelry-prod.Lucira_Prod.Webengage_Final (campaign metrics) joined by mobile number to
   lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals (deal attribution). Everything below is computed
   client-side; nothing is fabricated — known data gaps (see DATA.meta.notes / the Data Sources &
   Honesty Notes card) are stated explicitly, never guessed around. */
(function(){
'use strict';

/* ---------- generic utils (same conventions as dashboard/sei.js) ---------- */
function esc(s){ return (s==null?'':''+s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function fmtInt(n){ return (n==null||isNaN(n))?'N/A':Math.round(n).toLocaleString('en-IN'); }
function fmtPct(n,d){ if(n==null||isNaN(n))return 'N/A'; return n.toFixed(d==null?1:d)+'%'; }
function pct(a,b){ return b?(100*a/b):null; }
function downloadBlob(content,filename,mime){ if(mime==='text/csv' && typeof content==='string' && content.charCodeAt(0)!==0xFEFF) content='﻿'+content; var blob=new Blob([content],{type:mime+';charset=utf-8'}); var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},800); }
function csvOf(rows){ return rows.map(function(r){return r.map(function(v){ v=(v==null?'':''+v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }).join(',');}).join('\n'); }
function tableToCsv(id){ var t=document.getElementById(id); if(!t)return ''; var rows=[]; t.querySelectorAll('tr').forEach(function(tr){ var r=[]; tr.querySelectorAll('th,td').forEach(function(td){ r.push(td.textContent.trim()); }); rows.push(r); }); return csvOf(rows); }
function monthLabel(ym){ var parts=ym.split('-'); var names=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return names[parseInt(parts[1],10)-1]+' '+parts[0]; }

function fmtMoney(n){ if(n==null||isNaN(n))return 'N/A'; var a=Math.abs(n),s=n<0?'-':''; if(a>=1e7) return s+'₹'+(a/1e7).toFixed(2)+'Cr'; if(a>=1e5) return s+'₹'+(a/1e5).toFixed(2)+'L'; return s+'₹'+Math.round(a).toLocaleString('en-IN'); }

/* ---------- date-range filter utils (Today/Yesterday/Week/Month/Quarter/Custom) ----------
   All comparisons work on plain 'YYYY-MM-DD' strings (lexicographic order == chronological
   order for ISO dates), so no Date parsing is needed for the filter predicates themselves —
   only for RESOLVING a preset into a {start,end} pair off the visitor's local clock. */
function pad2(n){ return (n<10?'0':'')+n; }
function toISO(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function daysAgo(n){ var d=new Date(); d.setDate(d.getDate()-n); return d; }
function startOfWeek(d){ var x=new Date(d); var day=(x.getDay()+6)%7; x.setDate(x.getDate()-day); return x; } // Monday-start
function startOfMonth(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfQuarter(d){ var q=Math.floor(d.getMonth()/3); return new Date(d.getFullYear(), q*3, 1); }
function lastDayOfMonthISO(ym){ var parts=ym.split('-'); var y=+parts[0], m=+parts[1]; return ym+'-'+pad2(new Date(y,m,0).getDate()); }
function fmtDateHuman(iso){ if(!iso) return ''; var p=iso.split('-'); var names=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return names[+p[1]-1]+' '+(+p[2])+', '+p[0]; }
function resolvePreset(preset){
  var today=new Date(), todayISO=toISO(today);
  if(preset==='today') return {start:todayISO, end:todayISO};
  if(preset==='yesterday'){ var y=daysAgo(1); return {start:toISO(y), end:toISO(y)}; }
  if(preset==='week') return {start:toISO(startOfWeek(today)), end:todayISO};
  if(preset==='month') return {start:toISO(startOfMonth(today)), end:todayISO};
  if(preset==='quarter') return {start:toISO(startOfQuarter(today)), end:todayISO};
  return {start:null, end:null}; // 'all'
}
function inRange(dateStr, start, end){
  if(!start && !end) return true;
  if(!dateStr) return false;
  if(start && dateStr<start) return false;
  if(end && dateStr>end) return false;
  return true;
}
function overlaps(rStart, rEnd, start, end){
  if(!start && !end) return true;
  if(start && rEnd && rEnd<start) return false;
  if(end && rStart && rStart>end) return false;
  return true;
}
var FILTER = {preset:'all', start:null, end:null};
function periodLabelText(){
  if(FILTER.preset==='all') return 'All Time';
  if(FILTER.start===FILTER.end) return fmtDateHuman(FILTER.start);
  return fmtDateHuman(FILTER.start)+' – '+fmtDateHuman(FILTER.end);
}
function denomNote(){ return FILTER.preset==='all' ? '' : ' of all-time targeted cohort'; }

var CONFIG = { SNAPSHOT_URL: "https://storage.googleapis.com/lucira-dashboards/store-visit/latest.json" };
var DATA=null, CAMP=[], DEALS=[], SALES=[], SOURCE='embedded';

function normalize(raw){
  raw = raw || window.STORE_VISIT_DATA || {meta:{},campaigns:[],monthly:[],dealsRegister:[],salesRegister:[]};
  return raw;
}

/* live snapshot fetch -> embedded window.STORE_VISIT_DATA fallback, same pattern as
   dashboard/walkin-source-intelligence.html's loadData()/ingest() */
function loadData(){
  var url = CONFIG.SNAPSHOT_URL;
  if(!url) return Promise.resolve({data: window.STORE_VISIT_DATA, source:'embedded'});
  return fetch(url, {cache:'no-store'}).then(function(res){
    if(!res.ok) throw new Error('HTTP '+res.status);
    return res.json();
  }).then(function(j){
    if(!j || !j.campaigns) throw new Error('malformed snapshot');
    return {data: j, source:'live'};
  }).catch(function(e){
    console.warn('Snapshot load failed, using embedded data:', e.message);
    return {data: window.STORE_VISIT_DATA, source:'embedded'};
  });
}

/* ================= AGGREGATIONS ================= */

function buildKpis(camp, deals, sales, meta){
  var campaignCount = camp.length;
  var totalSent = camp.reduce(function(a,c){return a+(c.sent||0);},0);
  var totalDelivered = camp.reduce(function(a,c){return a+(c.delivered||0);},0);
  var totalOpened = camp.reduce(function(a,c){return a+(c.opened||0);},0);
  var totalClicked = camp.reduce(function(a,c){return a+(c.clicked||0);},0);
  var deliveryRate = pct(totalDelivered, totalSent);
  var distinctDealMobiles = new Set(deals.map(function(d){return d.mobile_masked;})).size;
  var dealsWon = deals.filter(function(d){return d.stage==='Closed Won';}).length;
  var dealsLost = deals.filter(function(d){return d.stage==='Closed Lost';}).length;
  var dealsOpen = deals.length - dealsWon - dealsLost;
  var distinctSaleMobiles = new Set(sales.map(function(s){return s.mobile_masked;})).size;
  var totalLtv = sales.reduce(function(a,s){return a+(s.ltv||0);},0);
  var totalOrders = sales.reduce(function(a,s){return a+(s.total_orders||0);},0);
  var ordersAfterTouch = sales.filter(function(s){return s.days_touch_to_first_order>=0;}).length;
  var flaggedSales = sales.filter(function(s){return s.flagged;}).length;
  return {
    campaignCount: campaignCount, totalSent: totalSent, totalDelivered: totalDelivered,
    totalOpened: totalOpened, totalClicked: totalClicked, deliveryRate: deliveryRate,
    totalTargeted: meta.total_targeted_valid_mobile,
    distinctDealMobiles: distinctDealMobiles, totalDeals: deals.length,
    dealsWon: dealsWon, dealsLost: dealsLost, dealsOpen: dealsOpen,
    touchToDealRate: pct(distinctDealMobiles, meta.total_targeted_valid_mobile),
    distinctSaleMobiles: distinctSaleMobiles, totalLtv: totalLtv, totalOrders: totalOrders,
    ordersAfterTouch: ordersAfterTouch, flaggedSales: flaggedSales,
    touchToSaleRate: pct(distinctSaleMobiles, meta.total_targeted_valid_mobile),
    hasBoth: meta.has_both, hasEither: meta.has_either,
    touchToEitherRate: pct(meta.has_either, meta.total_targeted_valid_mobile)
  };
}

function buildChannelBreakdown(camp){
  var byCh={};
  camp.forEach(function(c){
    if(!byCh[c.channel]) byCh[c.channel]={channel:c.channel,sent:0,delivered:0,opened:0,openedLabel:c.opened_label,clicked:0,hasOpen:false};
    var b=byCh[c.channel];
    b.sent+=c.sent||0; b.delivered+=c.delivered||0; b.clicked+=c.clicked||0;
    if(c.opened!=null){ b.opened+=c.opened; b.hasOpen=true; b.openedLabel=c.opened_label; }
  });
  return Object.keys(byCh).map(function(k){return byCh[k];}).sort(function(a,b){return b.sent-a.sent;});
}

/* ================= CHART HELPERS (hand-rolled SVG, no CDN) ================= */
function svg(w,h,inner){ return '<svg viewBox="0 0 '+w+' '+h+'" width="100%" height="'+h+'" style="overflow:visible">'+inner+'</svg>'; }
function hbar(items,opts){
  opts=opts||{}; var max=Math.max.apply(null,items.map(function(i){return i.value||0;}).concat([1]));
  var rowH=opts.rowH||26, w=560, labelW=opts.labelW||150;
  var h=items.length*rowH+6, inner='';
  items.forEach(function(it,i){
    var bw=Math.max(2,(w-labelW-70)*((it.value||0)/max));
    var y=i*rowH;
    inner+='<text x="0" y="'+(y+rowH/2+4)+'" font-size="11" fill="var(--tx2)">'+esc(it.label)+'</text>';
    inner+='<rect x="'+labelW+'" y="'+(y+5)+'" width="'+bw+'" height="'+(rowH-12)+'" rx="4" fill="'+(it.color||'var(--acc)')+'"><title>'+esc(it.label)+': '+esc(it.valueLabel!=null?it.valueLabel:it.value)+'</title></rect>';
    inner+='<text x="'+(labelW+bw+8)+'" y="'+(y+rowH/2+4)+'" font-size="11" fill="var(--tx)" font-family=\'JetBrains Mono\'>'+esc(it.valueLabel!=null?it.valueLabel:it.value)+'</text>';
  });
  return '<div style="overflow-x:auto"><svg viewBox="0 0 '+w+' '+h+'" width="100%" height="'+h+'">'+inner+'</svg></div>';
}
function lineChart(series,opts){
  opts=opts||{}; var w=600,h=210,pad=32;
  var ys=series.map(function(p){return p.y;});
  var maxY=Math.max.apply(null,ys.concat([1]))*1.15, minY=0;
  var n=series.length||1;
  function xy(i,v){ var x=pad+(w-pad*2)*(i/(n-1||1)); var y=h-pad-(h-pad*1.55)*((v-minY)/(maxY-minY||1)); return [x,y]; }
  function path(color){ var d=''; series.forEach(function(p,i){ var xy_=xy(i,p.y); d+=(i===0?'M':'L')+xy_[0].toFixed(1)+' '+xy_[1].toFixed(1)+' '; }); return '<path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="2.2" stroke-linecap="round"></path>'; }
  var grid=''; for(var g=0;g<=3;g++){ var gy=pad+(h-pad*1.55)*g/3; grid+='<line x1="'+pad+'" y1="'+gy+'" x2="'+(w-pad)+'" y2="'+gy+'" stroke="var(--line)" stroke-width="1"></line>'; }
  var pts='', dlabels='';
  series.forEach(function(p,i){
    var xy_=xy(i,p.y);
    var labelTxt = p.label!=null ? p.label : p.y;
    pts+='<circle cx="'+xy_[0].toFixed(1)+'" cy="'+xy_[1].toFixed(1)+'" r="4" fill="'+(opts.color||'var(--c1)')+'"><title>'+esc(p.x)+': '+esc(labelTxt)+'</title></circle>';
    dlabels+='<text x="'+xy_[0].toFixed(1)+'" y="'+(xy_[1]-10).toFixed(1)+'" font-size="10.5" font-weight="700" fill="var(--tx)" text-anchor="middle" font-family=\'JetBrains Mono\'>'+esc(labelTxt)+'</text>';
  });
  var xlabels=''; series.forEach(function(p,i){ var xy_=xy(i,0); xlabels+='<text x="'+xy_[0]+'" y="'+(h-8)+'" font-size="10" fill="var(--tx3)" text-anchor="middle">'+esc(p.x)+'</text>'; });
  var inner=grid+path(opts.color||'var(--c1)')+pts+dlabels+xlabels;
  return '<div style="overflow-x:auto">'+svg(w,h,inner)+'</div>'+(opts.legend?('<div style="font-size:11px;color:var(--tx2);margin-top:4px">'+opts.legend+'</div>'):'');
}

/* ================= INFO REGISTRY ================= */
var INFO={
 datasources:{title:'Data Sources & Honesty Notes',what:'This dashboard joins three BigQuery tables: <code>lucirajewelry-prod.Lucira_Prod.Webengage_Final</code> (WebEngage campaign-engagement mart) filtered to the 8 campaigns whose name/journey identifies them as "Store Visit" activity, <code>lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals</code> (CRM pipeline), and <code>lucirajewelry-prod.Lucira_Prod.sales_oneview_data</code> (real Shopify + POS order history/LTV) — all joined by normalized mobile number (WebEngage <code>cuid</code> is the customer\'s +91-prefixed mobile).',why:'A CEO-facing report must never silently mix a marketing metric with a sales outcome as if they were proven to be causally linked — every figure here traces to a real field or is explicitly marked as a correlation/gap.',formula:'Campaign match: <code>campaign_name LIKE \'%store_visit%\'</code> OR <code>journey_title LIKE \'%store visit%\'</code>. Deal/Sale match: <code>RIGHT(REGEXP_REPLACE(cuid,...),10) = RIGHT(REGEXP_REPLACE(Mobile/Cus_mobile,...),10)</code>.',impact:'See the full gap list below the KPI cards (Data Sources & Honesty Notes card) — it is generated directly from this data pull, not hardcoded here, so it always reflects the current snapshot.',action:'Treat "Deals Created" and "Made a Purchase" as directional signals to investigate, not certified attribution numbers. If a real store-visit conversion metric is needed, it should be built by joining this cohort against Walkin_marge, not against Deals/Sales alone.',practice:'This is a static snapshot (see the freshness pill) — re-run the BigQuery pull to refresh it.',benchmark:'n/a'},
 sec1:{title:'Section 1 — Executive KPI Cards',what:'One-glance summary of how many store-visit campaigns ran, how many people were reached, and how many of those people later got a Zoho Deal or made a real purchase.',why:'Designed to be read in under 30 seconds.',formula:'See each card\'s own info icon.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 sec2:{title:'Section 2 — Campaign Detail',what:'Every one of the 8 store-visit campaigns/journey legs, with per-channel send/delivery/engagement metrics exactly as recorded by WebEngage.',why:'Each WebEngage_Final row is already single-channel, so these numbers are never summed across channels within a row.',formula:'GROUP BY (campaign_name, journey_title, channel).',impact:'SMS has no "opened" concept in WebEngage\'s schema (only delivery + click) — shown as "—", not a fabricated zero.',action:'—',practice:'—',benchmark:'—'},
 sec3:{title:'Section 3 — Channel Performance',what:'Sent/delivered/engaged rolled up by channel across all 8 campaigns.',why:'Shows which channel WebEngage actually used to run this activity, and how it performed.',formula:'SUM per channel across the 8 campaign rows.',impact:'WhatsApp carried the large one-off blast (726 users, Nov 2025); the "Store visit journey" automation runs mostly on SMS.',action:'—',practice:'—',benchmark:'—'},
 sec4:{title:'Section 4 — Monthly Activity',what:'Total messages sent and distinct users reached per calendar month, across all 8 campaigns combined.',why:'Shows when this activity actually ran — it is not continuous.',formula:'SUM(sent), COUNT(DISTINCT cuid) GROUP BY month of event_date.',impact:'Two big one-off spikes (Oct 2025, Nov 2025) then a quieter recurring "Store visit journey" from Apr 2026 onward.',action:'—',practice:'—',benchmark:'—'},
 sec5:{title:'Section 5 — Targeted → Deal/Sale Funnel',what:'How many of the 1,262 valid-mobile targeted users have ANY commercial outcome (a Zoho Deal or a real sales_oneview_data purchase), broken out by which system captured it.',why:'The only outcome signal available without a footfall join — see Data Sources note for why this is correlation, not proof of store visits. Combining Deals and Sales matters because only 5 of 38 customers with an outcome appear in both systems.',formula:'COUNT(DISTINCT mobile) at each stage; "Any Deal or Sale" = COUNT(DISTINCT mobile WHERE has_deal OR has_sale).',impact:'—',action:'—',practice:'—',benchmark:'—'},
 sec6:{title:'Section 6 — Marketing → Sales Outcomes',what:'Every one of the 23 sales_oneview_data purchase records matched to a store-visit-campaign-targeted mobile number, with real lifetime value, order count, and order dates from Shopify + POS.',why:'This is the real "marketing → sale" tie-in: unlike Zoho Deal Amount (near-empty), sales_oneview_data has genuine revenue figures.',formula:'JOIN on normalized mobile = Cus_mobile.',impact:'ltv/aov are LIFETIME figures for that customer, not revenue generated since the campaign — do not read "Revenue From Targeted Customers" as incremental campaign-attributed revenue. 7 of 23 rows are flagged as a likely data-quality artifact (see honesty notes) and are visually marked, not excluded.',action:'—',practice:'Use the search box to filter by mobile, campaign, or city.',benchmark:'—'},
 sec7:{title:'Section 7 — Deal Attribution Register',what:'Every one of the 36 Zoho Deal records matched to a store-visit-campaign-targeted mobile number (20 distinct customers), one row per deal.',why:'Full drill-down / audit trail behind the funnel above.',formula:'—',impact:'Duplicate deal rows for the same mobile (see honesty notes) are intentionally NOT collapsed — collapsing them would hide a real Zoho data-quality signal.',action:'—',practice:'Use the search box to filter by mobile or campaign.',benchmark:'—'},
 sec8:{title:'Section 8 — AI Insights',what:'Rule-based narrative generated from the exact same computed model as the tables/charts above — nothing here is a separate/independent AI call.',why:'Turns tables into 1-line takeaways.',formula:'Threshold rules over the model.',impact:'—',action:'—',practice:'Insights only ever reference fields that are real for this data pull.',benchmark:'—'},
 k_campaigns:{title:'Store Visit Campaigns Run',what:'Distinct (campaign, channel) combinations whose name/journey identifies them as store-visit activity.',formula:'COUNT of rows in Section 2.',why:'Spans 2 automated journeys ("Store visit journey" and "Store Visit journey - Features") plus 2 one-off blasts.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_targeted:{title:'Users Targeted',what:'Distinct customers (by normalized mobile/cuid) who received at least one store-visit campaign message.',formula:'COUNT(DISTINCT cuid) with a valid 10-digit Indian mobile format.',why:'1 of 1,263 raw cuid values did not match a valid mobile pattern and is excluded.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_sent:{title:'Total Messages Sent',what:'Sum of the sent metric across all 8 campaigns/channels.',formula:'SUM(sent).',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_delivered:{title:'Delivery Rate',what:'Share of sent messages that WebEngage recorded as delivered.',formula:'SUM(delivered) / SUM(sent).',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_engaged:{title:'Opened/Read + Clicked',what:'Sum of each channel\'s own "opened/read" signal (email open, WhatsApp/RCS read, push impression) plus each channel\'s click signal. SMS contributes only clicks (it has no open/read concept).',formula:'SUM(opened) + SUM(clicked) across all campaign rows.',why:'Engagement is genuinely low for this cohort — shown as the real small number, not inflated.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_dealtouch:{title:'Targeted Users With Any Deal',what:'Distinct targeted mobiles that also appear in Zoho Deals.',formula:'COUNT(DISTINCT mobile) matched, from Section 6.',why:'This is a mobile-number correlation, NOT proof the campaign caused the deal — see Data Sources & Honesty Notes.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_dealswon:{title:'Deals Closed Won',what:'Of the 36 matched deal records, how many reached Stage = Closed Won.',formula:'COUNT(Stage = \'Closed Won\').',why:'Only 1 of 36 matched deal records — a very small base; do not over-read this as a proven conversion rate.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_salestouch:{title:'Targeted Users Who Purchased',what:'Distinct targeted mobiles that also appear in sales_oneview_data (real Shopify + POS order history).',formula:'COUNT(DISTINCT mobile) matched, from Section 6.',why:'This is a mobile-number correlation, NOT proof the campaign caused the purchase — see Data Sources & Honesty Notes. sales_oneview_data covers only 1,057 customers company-wide, so this is a lower bound.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_revenue:{title:'Revenue From Targeted Customers',what:'Sum of lifetime value (ltv) across the 23 matched sales_oneview_data records.',formula:'SUM(ltv) for matched customers.',why:'This is LIFETIME value for that customer, not revenue generated since the campaign touch — do not read this as incremental campaign-attributed revenue. Includes 7 flagged ₹0 rows (net effect: zero inflation from them).',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_ordersafter:{title:'Orders On/After Campaign Touch',what:'Of the purchasing customers, how many placed their first order on or after their first store-visit campaign touch date (days_touch_to_first_order >= 0).',formula:'COUNT(days_touch_to_first_order >= 0).',why:'A directional (not proven-causal) signal for whether the campaign preceded the purchase.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_either:{title:'Any Commercial Outcome (Deal or Sale)',what:'Distinct targeted customers who have EITHER a Zoho Deal or a sales_oneview_data purchase (or both).',formula:'COUNT(DISTINCT mobile WHERE has_deal OR has_sale).',why:'Only a small overlap exists between the two systems (5 of 38) — using either alone would understate total commercial reach of this cohort.',impact:'—',action:'—',practice:'—',benchmark:'—'}
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

/* ================= RENDER HELPERS ================= */
function table(id,headers,rows,fmt){
  var t=document.getElementById(id);
  var thead='<thead><tr>'+headers.map(function(h){return '<th>'+esc(h)+'</th>';}).join('')+'</tr></thead>';
  var body='<tbody>'+rows.map(function(r){ return '<tr>'+r.map(function(v,i){ var cls=(fmt&&fmt[i]==='num')?' class="num"':''; return '<td'+cls+'>'+(v==null?'N/A':v)+'</td>'; }).join('')+'</tr>'; }).join('')+'</tbody>';
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

/* ================= FILTERED VIEWS ================= */
function getFilteredCampaigns(){ return FILTER.preset==='all' ? CAMP : CAMP.filter(function(c){ return overlaps(c.first_run, c.last_run, FILTER.start, FILTER.end); }); }
function getFilteredMonthly(){ var m=DATA.monthly||[]; return FILTER.preset==='all' ? m : m.filter(function(r){ return overlaps(r.ym+'-01', lastDayOfMonthISO(r.ym), FILTER.start, FILTER.end); }); }
function getFilteredDeals(){ return FILTER.preset==='all' ? DEALS : DEALS.filter(function(d){ return inRange(d.deal_created, FILTER.start, FILTER.end); }); }
function getFilteredSales(){ return FILTER.preset==='all' ? SALES : SALES.filter(function(s){ return inRange(s.first_order_date, FILTER.start, FILTER.end); }); }

/* ================= MAIN RENDER ================= */
var REG_ROWS=[], SALES_ROWS=[];

function renderAll(){
  var meta=DATA.meta||{};

  var pill=document.getElementById('freshPill');
  pill.className = 'pill ' + (SOURCE==='live' ? 'live' : 'snap');
  pill.innerHTML='<span class="dot"></span> '+(SOURCE==='live'?'Live snapshot':'Embedded snapshot')+' as of '+(meta.generated_at||'unknown');

  document.getElementById('dataNoteBody').innerHTML =
    'Sources: <code>'+esc(meta.source_campaigns||'')+'</code> (campaigns) joined to <code>'+esc(meta.source_deals||'')+'</code> (deals) on <code>'+esc(meta.join_key||'')+'</code>. Campaign match: <code>'+esc(meta.campaign_match||'')+'</code>.<br><b>Known gaps (shown as explicit notes, never guessed):</b><ul style="margin:6px 0 0 18px;padding:0">'+
    (meta.notes||[]).map(function(n){return '<li style="margin-bottom:4px">'+n+'</li>';}).join('')+'</ul>'+
    (FILTER.preset!=='all' ? '<div class="note" style="margin-top:8px"><b>Period filter active: '+esc(periodLabelText())+'.</b> Campaign rows are included if their run window overlaps this period (each row still shows its own full totals, not a per-day slice). Deal/Sale registers are filtered exactly by their own date field. "Users Targeted" and percentage denominators stay all-time — WebEngage campaign-level data has no per-day breakdown to slice against.</div>' : '');

  var fCamp = getFilteredCampaigns(), fDeals = getFilteredDeals(), fSales = getFilteredSales(), fMonthly = getFilteredMonthly();

  var k = buildKpis(fCamp, fDeals, fSales, meta);
  var dn = denomNote();
  document.getElementById('kpiGrid').innerHTML=[
    kpiCard('Store Visit Campaigns Run', fmtInt(k.campaignCount), FILTER.preset==='all' ? '2 journeys + 2 one-off blasts, Oct 2025 – Jul 2026' : 'active during '+periodLabelText(), 'k_campaigns'),
    kpiCard('Users Targeted', fmtInt(meta.total_targeted_valid_mobile), 'distinct valid-mobile cuid, all-time', 'k_targeted'),
    kpiCard('Total Messages Sent', fmtInt(k.totalSent), 'across Push/WhatsApp/SMS/Email/RCS', 'k_sent'),
    kpiCard('Delivery Rate', fmtPct(k.deliveryRate), fmtInt(k.totalDelivered)+' of '+fmtInt(k.totalSent)+' delivered', 'k_delivered'),
    kpiCard('Opened/Read + Clicked', fmtInt(k.totalOpened+k.totalClicked), fmtInt(k.totalOpened)+' opened/read, '+fmtInt(k.totalClicked)+' clicked', 'k_engaged', (k.totalOpened+k.totalClicked) < k.totalDelivered*0.1 ? 'warn' : ''),
    kpiCard('Targeted Users With Any Deal', fmtInt(k.distinctDealMobiles), fmtPct(k.touchToDealRate)+dn, 'k_dealtouch'),
    kpiCard('Deals Closed Won', fmtInt(k.dealsWon), 'of '+fmtInt(k.totalDeals)+' matched deal records', 'k_dealswon', k.dealsWon===0?'warn':''),
    kpiCard('Targeted Users Who Purchased', fmtInt(k.distinctSaleMobiles), fmtPct(k.touchToSaleRate)+dn+' — real Shopify/POS orders', 'k_salestouch'),
    kpiCard('Revenue From Targeted Customers', fmtMoney(k.totalLtv), fmtInt(k.totalOrders)+' orders, lifetime value (not incremental)', 'k_revenue'),
    kpiCard('Orders On/After Campaign Touch', fmtInt(k.ordersAfterTouch), 'of '+fmtInt(k.distinctSaleMobiles)+' purchasing customers', 'k_ordersafter'),
    kpiCard('Any Commercial Outcome (Deal or Sale)', fmtInt(k.hasEither), fmtPct(k.touchToEitherRate)+dn+' — only '+fmtInt(k.hasBoth)+' have both', 'k_either')
  ].join('');

  // Section 2: Campaign detail
  document.getElementById('sec2sub').textContent = fCamp.length+' of '+CAMP.length+' campaign/channel rows'+(FILTER.preset==='all'?'':' active in '+periodLabelText());
  table('tblCampaigns',['Campaign','Journey','Channel','First Run','Last Run','Users','Sent','Delivered','Delivery %','Opened/Read','Clicked'],
    fCamp.map(function(c){
      return [esc(c.campaign_name), esc(c.journey_title), esc(c.channel), esc(c.first_run), esc(c.last_run), fmtInt(c.users),
        fmtInt(c.sent), fmtInt(c.delivered), fmtPct(pct(c.delivered,c.sent)),
        c.opened==null?'<span class="gap">—</span>':fmtInt(c.opened)+(c.opened_label?' <span style="color:var(--tx3);font-size:10.5px">('+esc(c.opened_label)+')</span>':''),
        fmtInt(c.clicked)];
    }),
    [0,0,0,0,0,1,1,1,1,1,1]);

  // Section 3: Channel performance
  var ch = buildChannelBreakdown(fCamp);
  var colors=['var(--c1)','var(--c2)','var(--c3)','var(--c4)','var(--c5)'];
  document.getElementById('chChannelSent').innerHTML = ch.length ? hbar(ch.map(function(c,i){return {label:c.channel,value:c.sent,valueLabel:fmtInt(c.sent),color:colors[i%5]};})) : '<div class="note">No campaigns active in '+esc(periodLabelText())+'.</div>';
  table('tblChannel',['Channel','Sent','Delivered','Delivery %','Opened/Read','Clicked'],
    ch.map(function(c){ return [esc(c.channel), fmtInt(c.sent), fmtInt(c.delivered), fmtPct(pct(c.delivered,c.sent)), c.hasOpen?fmtInt(c.opened)+(c.openedLabel?' ('+esc(c.openedLabel)+')':''):'<span class="gap">—</span>', fmtInt(c.clicked)]; }),
    [0,1,1,1,1,1]);

  // Section 4: Monthly trend
  document.getElementById('sec4sub').textContent = fMonthly.length? (monthLabel(fMonthly[0].ym)+' → '+monthLabel(fMonthly[fMonthly.length-1].ym)) : 'no months in '+periodLabelText();
  document.getElementById('chMonthlySent').innerHTML = fMonthly.length ? lineChart(fMonthly.map(function(m){return {x:monthLabel(m.ym),y:m.sent,label:fmtInt(m.sent)};}),{color:'var(--c1)',legend:'Messages sent/month'}) : '<div class="note">No activity in '+esc(periodLabelText())+'.</div>';
  document.getElementById('chMonthlyUsers').innerHTML = fMonthly.length ? lineChart(fMonthly.map(function(m){return {x:monthLabel(m.ym),y:m.users,label:fmtInt(m.users)};}),{color:'var(--c2)',legend:'Distinct users reached/month'}) : '';

  // Section 5: Funnel (now spans both commercial systems — Deals AND real sales)
  var funnel=[
    {label:'Users Targeted (all-time)', value:meta.total_targeted_valid_mobile, valueLabel:fmtInt(meta.total_targeted_valid_mobile), color:'var(--c1)'},
    {label:'Any Deal or Sale', value:k.hasEither, valueLabel:fmtInt(k.hasEither)+' ('+fmtPct(k.touchToEitherRate)+')', color:'var(--c3)'},
    {label:'Any Deal Created', value:k.distinctDealMobiles, valueLabel:fmtInt(k.distinctDealMobiles)+' ('+fmtPct(k.touchToDealRate)+')', color:'var(--c6)'},
    {label:'Made a Purchase', value:k.distinctSaleMobiles, valueLabel:fmtInt(k.distinctSaleMobiles)+' ('+fmtPct(k.touchToSaleRate)+')', color:'var(--c2)'},
    {label:'Deal Closed Won', value:k.dealsWon, valueLabel:fmtInt(k.dealsWon), color:'var(--good)'}
  ];
  document.getElementById('chFunnel').innerHTML = hbar(funnel);
  document.getElementById('funnelNote').innerHTML = (FILTER.preset!=='all' ? '<b>Showing '+esc(periodLabelText())+'.</b> ' : '')+'Of <b>'+fmtInt(meta.total_targeted_valid_mobile)+'</b> all-time targeted users: <b>'+fmtInt(k.hasEither)+'</b> ('+fmtPct(k.touchToEitherRate)+') show ANY commercial outcome'+(FILTER.preset==='all'?'':' in this period')+' — a Zoho Deal or a real purchase — but only <b>'+fmtInt(k.hasBoth)+'</b> show both, meaning Deals and Sales mostly capture different customers. <b>'+fmtInt(k.distinctSaleMobiles)+'</b> made a real purchase (₹'+fmtMoney(k.totalLtv).replace('₹','')+' lifetime value, '+fmtInt(k.ordersAfterTouch)+' orders on/after their campaign touch). This is a mobile-number correlation — see the Data Sources note for why it is not proof of causation.';

  // Section 6: Sales outcomes
  document.getElementById('sec6sub').textContent = fSales.length+' of '+SALES.length+' matched purchase records · '+k.distinctSaleMobiles+' distinct customers'+(FILTER.preset==='all'?'':' in '+periodLabelText());
  SALES_ROWS = fSales.slice().sort(function(a,b){ return (b.ltv||0)-(a.ltv||0); });
  renderSalesRegister('');

  // Section 7: Deal register
  document.getElementById('sec7sub').textContent = fDeals.length+' of '+DEALS.length+' matched deal records'+(FILTER.preset==='all'?'':' in '+periodLabelText());
  REG_ROWS = fDeals.slice().sort(function(a,b){ return (a.deal_created||'')<(b.deal_created||'')?1:-1; });
  renderRegister('');

  // Section 8: Insights
  var stageBreak = {won:k.dealsWon, lost:fDeals.filter(function(d){return d.stage==='Closed Lost';}).length, prospect:fDeals.filter(function(d){return d.stage==='Prospect';}).length, payment:fDeals.filter(function(d){return d.stage==='Payment';}).length};
  var negTouch = fDeals.filter(function(d){return d.days_touch_to_deal<0;}).length;
  var periodPrefix = FILTER.preset==='all' ? '' : '['+periodLabelText()+'] ';
  var insights=[];
  if(FILTER.preset==='all'){
    insights.push({t:'📊',c:'',h:fmtInt(k.campaignCount)+' store-visit campaigns ran between Oct 2025 and Jul 2026, reaching '+fmtInt(meta.total_targeted_valid_mobile)+' distinct customers with '+fmtInt(k.totalSent)+' total messages ('+fmtPct(k.deliveryRate)+' delivered).'});
  } else {
    insights.push({t:'📊',c:'',h:periodPrefix+fmtInt(k.campaignCount)+' of '+CAMP.length+' campaigns were active, sending '+fmtInt(k.totalSent)+' messages ('+fmtPct(k.deliveryRate)+' delivered).'});
  }
  var topCh = buildChannelBreakdown(fCamp)[0];
  if(topCh) insights.push({t:'📣',c:'',h:periodPrefix+topCh.channel+' carried the largest volume ('+fmtInt(topCh.sent)+' sent).'});
  if(k.totalDelivered>0 && (k.totalOpened+k.totalClicked) < k.totalDelivered*0.1) insights.push({t:'⚠',c:'warn',h:periodPrefix+'Engagement is very low: only '+fmtInt(k.totalOpened+k.totalClicked)+' opens/reads/clicks across '+fmtInt(k.totalDelivered)+' delivered messages ('+fmtPct(pct(k.totalOpened+k.totalClicked,k.totalDelivered))+').'});
  if(k.distinctSaleMobiles>0) insights.push({t:'💰',c:'pos',h:periodPrefix+fmtInt(k.distinctSaleMobiles)+' targeted customers made a real purchase, totaling '+fmtMoney(k.totalLtv)+' lifetime value across '+fmtInt(k.totalOrders)+' orders — '+fmtInt(k.ordersAfterTouch)+' of those orders fall on/after the campaign touch date.'});
  if(k.flaggedSales>0) insights.push({t:'⚠',c:'warn',h:periodPrefix+k.flaggedSales+' of the '+fmtInt(fSales.length)+' matched sales records share an identical same-day ₹0 order across multiple customers — flagged as a likely data-quality artifact, not counted as real incremental revenue.'});
  insights.push({t:'🔗',c:'warn',h:periodPrefix+fmtInt(k.hasEither)+' of '+fmtInt(meta.total_targeted_valid_mobile)+' all-time targeted users ('+fmtPct(k.touchToEitherRate)+') show any commercial outcome (Deal or Sale) — stated as a correlation, not a proven campaign-driven conversion (see honesty notes). Only '+fmtInt(k.hasBoth)+' show both.'});
  if(negTouch>0) insights.push({t:'ℹ',c:'warn',h:periodPrefix+negTouch+' of the '+fmtInt(fDeals.length)+' matched deal records were created BEFORE the customer\'s first store-visit campaign touch — for those, the deal did not follow the message.'});
  if(stageBreak.lost>0) insights.push({t:'⚠',c:'neg',h:periodPrefix+stageBreak.lost+' of the '+fmtInt(fDeals.length)+' matched deal records are Closed Lost, versus just '+stageBreak.won+' Closed Won.'});
  if(FILTER.preset!=='all' && fDeals.length===0 && fSales.length===0) insights.push({t:'ℹ',c:'',h:'No deal or sale records fall in '+periodLabelText()+' — try All Time or a wider range.'});
  insights.push({t:'ℹ',c:'',h:'This dashboard cannot confirm actual store footfall — WebEngage has no store-visit event, and this data has not yet been cross-checked against the Walkin_marge table used by Walk-in Source Intelligence.'});
  document.getElementById('insightsList').innerHTML = insights.map(function(i){return '<div class="itm '+i.c+'"><span class="tag">'+i.t+'</span><span>'+i.h+'</span></div>';}).join('');
}

function renderSalesRegister(q){
  q=(q||'').toLowerCase().trim();
  var rows = !q ? SALES_ROWS : SALES_ROWS.filter(function(r){
    return (r.mobile_masked||'').toLowerCase().indexOf(q)>=0 ||
           (r.campaigns||'').toLowerCase().indexOf(q)>=0 ||
           (r.city||'').toLowerCase().indexOf(q)>=0;
  });
  document.getElementById('salesRegCount').textContent = rows.length+' of '+SALES_ROWS.length+' purchase records';
  table('tblSales',['Mobile','First Touch','Campaigns','Orders','Lifetime Value','Avg Order Value','First Order','Latest Order','Days Touch→Order','City'],
    rows.map(function(r){
      var flag = r.flagged ? ' <span class="badge ylw" title="Identical ₹0 same-day order across multiple customers — likely data artifact">⚠ flagged</span>' : '';
      var days = r.days_touch_to_first_order<0 ? ('<span style="color:var(--bad)">'+r.days_touch_to_first_order+'</span>') : fmtInt(r.days_touch_to_first_order);
      return [esc(r.mobile_masked)+flag, esc(r.first_touch), esc(r.campaigns), fmtInt(r.total_orders), fmtMoney(r.ltv), fmtMoney(r.aov), esc(r.first_order_date), esc(r.latest_order_date), days, esc(r.city||'N/A')];
    }),
    [0,0,0,1,1,1,0,0,1,0]);
}

function renderRegister(q){
  q=(q||'').toLowerCase().trim();
  var rows = !q ? REG_ROWS : REG_ROWS.filter(function(r){
    return (r.mobile_masked||'').toLowerCase().indexOf(q)>=0 ||
           (r.campaigns||'').toLowerCase().indexOf(q)>=0 ||
           (r.stage||'').toLowerCase().indexOf(q)>=0 ||
           (r.city||'').toLowerCase().indexOf(q)>=0;
  });
  document.getElementById('regCount').textContent = rows.length+' of '+REG_ROWS.length+' deal records';
  table('tblRegister',['Mobile','First Touch','Campaigns','Channels Used','Deal Created','Days Touch→Deal','Stage','City','Lead Source'],
    rows.map(function(r){
      var badge = r.stage==='Closed Won' ? '<span class="badge grn">Closed Won</span>' : r.stage==='Closed Lost' ? '<span class="badge red">Closed Lost</span>' : r.stage==='Payment' ? '<span class="badge ylw">Payment</span>' : '<span class="badge ylw">'+esc(r.stage)+'</span>';
      var days = r.days_touch_to_deal<0 ? ('<span style="color:var(--bad)">'+r.days_touch_to_deal+'</span>') : fmtInt(r.days_touch_to_deal);
      return [esc(r.mobile_masked), esc(r.first_touch), esc(r.campaigns), esc(r.channels), esc(r.deal_created), days, badge, esc(r.city||'N/A'), esc(r.lead_source||'N/A')];
    }),
    [0,0,0,0,0,1,0,0,0]);
}

/* ================= WIRING ================= */
function wireHeader(){
  document.getElementById('themeBtn').onclick=function(){ var html=document.documentElement; html.setAttribute('data-theme', html.getAttribute('data-theme')==='dark'?'light':'dark'); };
  document.getElementById('printBtn').onclick=function(){ window.print(); };
  document.addEventListener('click',function(e){ var b=e.target.closest('[data-csv]'); if(b){ var csv=tableToCsv(b.getAttribute('data-csv')); downloadBlob(csv,b.getAttribute('data-name')+'.csv','text/csv'); } });
  var nav=document.getElementById('secnavIn');
  var secs=[['sec1','① KPIs'],['sec2','② Campaigns'],['sec3','③ Channels'],['sec4','④ Monthly'],['sec5','⑤ Funnel'],['sec6','⑥ Sales'],['sec7','⑦ Deal Register'],['sec8','⑧ Insights']];
  nav.innerHTML=secs.map(function(s){return '<a href="#'+s[0]+'">'+s[1]+'</a>';}).join('');
  document.getElementById('regSearch').addEventListener('input',function(e){ renderRegister(e.target.value); });
  document.getElementById('salesRegSearch').addEventListener('input',function(e){ renderSalesRegister(e.target.value); });
  wireFilterBar();
}

function applyFilter(preset, start, end){
  FILTER.preset = preset;
  if(preset==='custom'){ FILTER.start = start; FILTER.end = end; }
  else { var r = resolvePreset(preset); FILTER.start = r.start; FILTER.end = r.end; }
  document.getElementById('periodLabel').textContent = periodLabelText();
  renderAll();
}
function wireFilterBar(){
  var sel = document.getElementById('periodSelect');
  var wrap = document.getElementById('customRangeWrap');
  var startInp = document.getElementById('periodStart');
  var endInp = document.getElementById('periodEnd');
  sel.addEventListener('change', function(){
    var v = sel.value;
    if(v==='custom'){
      wrap.style.display='flex';
      var today=toISO(new Date());
      if(!startInp.value) startInp.value = toISO(daysAgo(6));
      if(!endInp.value) endInp.value = today;
      return; // wait for Apply
    }
    wrap.style.display='none';
    applyFilter(v);
  });
  document.getElementById('periodApply').addEventListener('click', function(){
    var s=startInp.value, e=endInp.value;
    if(!s || !e){ alert('Pick both a start and end date.'); return; }
    if(s>e){ alert('Start date must be on or before end date.'); return; }
    applyFilter('custom', s, e);
  });
}

/* ================= BOOT ================= */
function boot(){
  loadData().then(function(res){
    DATA = normalize(res.data);
    SOURCE = res.source;
    CAMP = DATA.campaigns||[];
    DEALS = DATA.dealsRegister||[];
    SALES = DATA.salesRegister||[];
    wireHeader();
    renderAll();
    document.getElementById('boot').classList.add('hide');
  });
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();

})();
