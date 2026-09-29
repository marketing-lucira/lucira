/* City Geo Funnel & Sales Intelligence — engine
   Data: window.CITY_GEO_FUNNEL_DATA (dashboard/city_geo_funnel_data.js), built by joining:
     - GA4 city-level funnel (sessions/PDP/ATC/checkout) from geo_intel_data.js cityTotals
     - Zoho CRM city rollups (deals created) from geo_intel_data.js zohoCity
     - Zoho CRM pincode rollups (pincode/area coverage) from geo_intel_data.js zohoPincode
     - A live BigQuery pull against lucirajewelry-prod.sales_dashboard.sales_reporting (orders, total sale)
   Requested grain was Pin Code; Session/PDP/ATC/Checkout only exist at CITY grain in GA4, so this
   dashboard is honestly built at city grain with pincode COUNT as a real proxy column — see the
   Data Sources & Honesty Notes card for exactly what is and isn't matched. Nothing is fabricated. */
(function(){
'use strict';

function esc(s){ return (s==null?'':''+s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function fmtInt(n){ return (n==null||isNaN(n))?'N/A':Math.round(n).toLocaleString('en-IN'); }
function fmtPct(n,d){ if(n==null||isNaN(n))return 'N/A'; return n.toFixed(d==null?1:d)+'%'; }
function fmtMoney(n){ if(n==null||isNaN(n))return 'N/A'; var a=Math.abs(n),s=n<0?'-':''; if(a>=1e7) return s+'₹'+(a/1e7).toFixed(2)+'Cr'; if(a>=1e5) return s+'₹'+(a/1e5).toFixed(2)+'L'; return s+'₹'+Math.round(a).toLocaleString('en-IN'); }
function downloadBlob(content,filename,mime){ if(mime==='text/csv' && typeof content==='string' && content.charCodeAt(0)!==0xFEFF) content='﻿'+content; var blob=new Blob([content],{type:mime+';charset=utf-8'}); var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},800); }
function csvOf(rows){ return rows.map(function(r){return r.map(function(v){ v=(v==null?'':''+v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }).join(',');}).join('\n'); }
function tableToCsv(id){ var t=document.getElementById(id); if(!t)return ''; var rows=[]; t.querySelectorAll('tr').forEach(function(tr){ var r=[]; tr.querySelectorAll('th,td').forEach(function(td){ r.push(td.textContent.trim()); }); rows.push(r); }); return csvOf(rows); }

var DATA=null, ROWS=[], PIN_ROWS=[], PIN_VISIBLE=[];

/* ---------- date-range filter utils (Today/Yesterday/Week/Month/Quarter/Custom) ----------
   Only Sessions (city), Orders/Total Sale (city) and Deals/Amount/Won (pincode) have a real
   daily breakdown (DATA.daily.*) — everything else (PDP/ATC/Checkout/ATC-Session, WebEngage,
   CaratLane/Tanishq) is only ever available as a single all-time total and never moves with
   this filter. See the Data Sources & Honesty Notes card. */
function pad2(n){ return (n<10?'0':'')+n; }
function toISO(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function daysAgo(n){ var d=new Date(); d.setDate(d.getDate()-n); return d; }
function startOfWeek(d){ var x=new Date(d); var day=(x.getDay()+6)%7; x.setDate(x.getDate()-day); return x; }
function startOfMonth(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfQuarter(d){ var q=Math.floor(d.getMonth()/3); return new Date(d.getFullYear(), q*3, 1); }
function fmtDateHuman(iso){ if(!iso) return ''; var p=iso.split('-'); var names=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return names[+p[1]-1]+' '+(+p[2])+', '+p[0]; }
function resolvePreset(preset){
  var today=new Date(), todayISO=toISO(today);
  if(preset==='today') return {start:todayISO, end:todayISO};
  if(preset==='yesterday'){ var y=daysAgo(1); return {start:toISO(y), end:toISO(y)}; }
  if(preset==='week') return {start:toISO(startOfWeek(today)), end:todayISO};
  if(preset==='month') return {start:toISO(startOfMonth(today)), end:todayISO};
  if(preset==='quarter') return {start:toISO(startOfQuarter(today)), end:todayISO};
  return {start:null, end:null};
}
function inRange(d,start,end){ if(!start&&!end) return true; if(!d) return false; if(start&&d<start) return false; if(end&&d>end) return false; return true; }
var FILTER = {preset:'all', start:null, end:null};
function periodLabelText(){
  if(FILTER.preset==='all') return 'All Time';
  if(FILTER.start===FILTER.end) return fmtDateHuman(FILTER.start);
  return fmtDateHuman(FILTER.start)+' – '+fmtDateHuman(FILTER.end);
}

/* ---------- filtered aggregates built from DATA.daily on every render ---------- */
function buildFilteredMaps(){
  var d = DATA.daily || {sessions:[],deals:[],sales:[]};
  var sessByCity = {}, salesByCity = {}, dealsByPincode = {};
  if(FILTER.preset==='all'){
    return {sessByCity:null, salesByCity:null, dealsByPincode:null};
  }
  d.sessions.forEach(function(r){ if(inRange(r.d,FILTER.start,FILTER.end)){ sessByCity[r.city] = (sessByCity[r.city]||0) + (r.sessions||0); } });
  d.sales.forEach(function(r){ if(inRange(r.d,FILTER.start,FILTER.end)){ var k=r.city; if(!salesByCity[k]) salesByCity[k]={orders:0,sale:0}; salesByCity[k].orders += (r.orders||0); salesByCity[k].sale += (r.sale||0); } });
  d.deals.forEach(function(r){ if(inRange(r.d,FILTER.start,FILTER.end)){ var k=r.pincode; if(!dealsByPincode[k]) dealsByPincode[k]={deals:0,amount:0,won:0,won_amount:0}; dealsByPincode[k].deals += (r.deals||0); dealsByPincode[k].amount += (r.amount||0); dealsByPincode[k].won += (r.won||0); dealsByPincode[k].won_amount += (r.won_amount||0); } });
  return {sessByCity:sessByCity, salesByCity:salesByCity, dealsByPincode:dealsByPincode};
}

function svg(w,h,inner){ return '<svg viewBox="0 0 '+w+' '+h+'" width="100%" height="'+h+'" style="overflow:visible">'+inner+'</svg>'; }
function hbar(items){
  var max=Math.max.apply(null,items.map(function(i){return i.value||0;}).concat([1]));
  var rowH=26, w=620, labelW=170;
  var h=items.length*rowH+6, inner='';
  items.forEach(function(it,i){
    var bw=Math.max(2,(w-labelW-80)*((it.value||0)/max));
    var y=i*rowH;
    inner+='<text x="0" y="'+(y+rowH/2+4)+'" font-size="11" fill="var(--tx2)">'+esc(it.label)+'</text>';
    inner+='<rect x="'+labelW+'" y="'+(y+5)+'" width="'+bw+'" height="'+(rowH-12)+'" rx="4" fill="'+(it.color||'var(--acc)')+'"><title>'+esc(it.label)+': '+esc(it.valueLabel!=null?it.valueLabel:it.value)+'</title></rect>';
    inner+='<text x="'+(labelW+bw+8)+'" y="'+(y+rowH/2+4)+'" font-size="11" fill="var(--tx)" font-family=\'JetBrains Mono\'>'+esc(it.valueLabel!=null?it.valueLabel:it.value)+'</text>';
  });
  return '<div style="overflow-x:auto">'+svg(w,h,inner)+'</div>';
}

var INFO={
 datasources:{title:'Data Sources & Honesty Notes',what:'This dashboard blends three real sources at two different grains, kept clearly separate: CITY grain (GA4 Sessions/PDP/ATC/Checkout + live ERP Orders/Sale, used in the KPI cards and the Top Cities / ATC Rate charts) and PINCODE grain (live Zoho CRM deals + a real WebEngage-to-Zoho mobile-number join, shown in Section 2\'s Pincode-Level Detail table).',why:'GA4 has no pincode dimension and the ERP sales table has no pincode field either — so a true pincode-level funnel/sales table cannot honestly be built from them. Rather than fake it by repeating city numbers on pincode rows, city-grain and pincode-grain data are kept in separate places.',formula:'City KPIs/charts: GA4 cityTotals + zoho_crm city rollup + lucirajewelry-prod.sales_dashboard.sales_reporting (trailing 540 days) joined to GA4 city by exact text match. Pincode table: Zoho CRM deal records grouped by exact pincode, plus lucirajewelry-prod.webengage.webengage_oneview_pdp_atc_data joined to zoho_crm.deals by normalized mobile number (cuid = Mobile/Alternate_mobile, last 10 digits) for real PDP-view/ATC customer counts per pincode.',impact:'Orders/Total Sale (city KPI) undercounts real totals wherever the ERP city spelling differs from GA4\'s (e.g. Gurgaon vs Gurugram). Only 2.4% of WebEngage customers matched a pincode — most pincodes show "not measured" for those columns in Section 2, not zero.',action:'To close the gaps: build a city-name canonicalization table (ERP city → GA4 city), capture more addresses on Zoho deals/contacts, or get WebEngage\'s full raw event export (has its own postal_code per event) built into BigQuery.',practice:'Use the search box in Section 2 to jump to a pincode, city, or state; click any column header to sort.',benchmark:'—'},
 sec1:{title:'Section 1 — Executive KPIs',what:'One-glance totals across every tracked city.',why:'—',formula:'SUM/COUNT across all rows in Section 2.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_cities:{title:'Cities Tracked',what:'Distinct cities with at least one GA4 session in the source window.',formula:'COUNT(cityTotals rows with sessions>0).',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_pincodes:{title:'Pincodes Tracked',what:'Distinct 6-digit pincodes seen anywhere in Zoho deal records.',formula:'COUNT(DISTINCT pincode) across all Zoho deals with a pincode.',why:'This is a CRM-lead proxy for pincode coverage, not a pincode-level web funnel — see Data Sources note.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_sessions:{title:'Total Sessions',what:'Sum of GA4 sessions across all tracked cities.',formula:'SUM(sessions).',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_pdp:{title:'Total PDP Views',what:'Sum of GA4 product-detail-page view events.',formula:'SUM(pdp_views).',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_atc:{title:'Total Add to Cart',what:'Sum of GA4 add_to_cart events.',formula:'SUM(add_to_cart).',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_checkout:{title:'Total Checkout Started',what:'Sum of GA4 begin_checkout events.',formula:'SUM(begin_checkout).',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_atcrate:{title:'Overall ATC / Session',what:'What share of sessions add a product to cart, blended across all cities.',formula:'SUM(add_to_cart) / SUM(sessions).',why:'Blended rate can differ from any single city\'s rate — see the per-city column for outliers.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_deals:{title:'Deals Created (Zoho)',what:'Sum of all-time Zoho CRM deals across every city with a recorded city value.',formula:'SUM(deals) from Zoho city rollup.',why:'All-time pipeline figure — not on the same 540-day window as Orders/Total Sale.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_orders:{title:'Orders (matched cities, 540d)',what:'Real ERP orders, counted only for cities where the ERP city label matched the GA4 city label exactly.',formula:'SUM(orders) for rows with a non-blank Orders value.',why:'Undercounts true total orders — see the "cities matched" sub-label and the honesty note on city-name mismatches.',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_sale:{title:'Total Sale ₹ (matched cities, 540d)',what:'Real ERP net sale value, same match rule as Orders.',formula:'SUM(net) for matched rows, trailing 540 days.',why:'—',impact:'—',action:'—',practice:'—',benchmark:'—'},
 k_we:{title:'WebEngage Pincode-Matched Customers',what:'Distinct WebEngage customers (from the on-site PDP/ATC table) successfully matched to a real pincode via their mobile number.',formula:'COUNT(DISTINCT cuid) WHERE joined to a zoho_crm.deals record with a 6-digit Address_Zip.',why:'Only a 2.4% match rate — most WebEngage-tracked customers have no corresponding Zoho record with an address. This is the real, current ceiling for pincode-level WebEngage data until a fuller pipeline exists.',impact:'—',action:'—',practice:'See Section 2 for the per-pincode breakdown.',benchmark:'—'},
 k_competitor:{title:'Pincodes With Competitor Presence',what:'How many tracked pincodes have at least one real CaratLane or Tanishq store, same source/method as the GA4 Geo Intelligence dashboard.',formula:'CaratLane: union of a public catalog-listing capture (206 stores) + an official Google-Business-Profile store master, matched by exact pincode. Tanishq: official store-locator export (541 stores / 509 pincodes), matched by exact pincode.',why:'A pincode with real Zoho/WebEngage demand AND no CaratLane/Tanishq store is a stronger whitespace signal than demand alone.',impact:'A pincode showing no competitor is NOT proof of zero presence — only that none was found in these captures.',action:'See Section 2\'s CaratLane/Tanishq columns for per-pincode store count, status, rating.',practice:'—',benchmark:'—'},
 sec2:{title:'Section 2 — Pincode-Level Detail (WebEngage + Zoho + Modeled City Funnel + Competitors)',what:'Every one of the 309 distinct pincodes, one per row (never merged). Columns marked * (Sessions*, PDP Views*, Add to Cart*, Checkout Started*, Orders*, Total Sale₹*) are MODELED — allocated from the parent city\'s real total by that pincode\'s share of real Zoho deals within its city, so every pincode shows a different number, not the city figure repeated. Unmarked columns (Deals Created, Amount, Won, Won Amount, WebEngage Customers/PDP/ATC, CaratLane/Tanishq) are real per-pincode measurements.',why:'GA4 has no pincode dimension and the ERP sales table has no pincode field, so a true pincode-level Sessions/PDP/ATC/Checkout/Orders/Sale cannot be directly measured. Allocating the real city total by real deal-share — exactly the method the GA4 Geo Intelligence dashboard already uses — is the honest way to differentiate pincodes within a city instead of either repeating one flat number or fabricating independent numbers.',formula:'share = (this pincode\'s real Zoho deals) / (SUM of real Zoho deals across every pincode in that city). Sessions* = share × city Sessions (GA4 cityTotals). PDP*/ATC*/Checkout* = share × the city\'s real all-time total. Orders*/Sale* = share × lucirajewelry-prod.sales_dashboard.sales_reporting city total (trailing 540 days or the active date filter). WebEngage columns: lucirajewelry-prod.webengage.webengage_oneview_pdp_atc_data joined to zoho_crm.deals by normalized mobile (cuid = Mobile/Alternate_mobile, last 10 digits), pincode from the matched record\'s Address_Zip.',impact:'A pincode with 0 real deals gets share=0, so all its modeled columns show 0 — a limitation of deal-share allocation, not proof of zero real traffic. A city with 0 total pincode-deals means every pincode in it shows 0 modeled demand even though the city itself has real GA4 sessions. Only 2.4% of WebEngage customers matched a usable pincode.',action:'To raise the WebEngage match rate, capture more addresses on Zoho deals/contacts. To get a true (non-modeled) pincode-level funnel, the WebEngage BigQuery pipeline with its own postal_code field would need to be built.',practice:'Search by pincode, city, state, or area; click a column header to sort.',benchmark:'—'}
};
function openInfo(key){
  var d=INFO[key]; var bg=document.getElementById('infoModalBg'); var m=document.getElementById('infoModal');
  if(!d){ d={title:key,what:'No explanation written yet for this element.'}; }
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

/* Deal-share allocation model — SAME methodology as ga4-geo-intelligence-dashboard.html's
   Pin Code Intelligence page: GA4 has no pincode dimension, so a pincode's share of Sessions/
   PDP/ATC/Checkout/Orders is estimated as (that pincode's real Zoho deals ÷ total real Zoho
   deals across every pincode in its city), applied to the city's real total. This makes every
   pincode row show a DIFFERENT modeled number (proportional to its own real deal volume)
   instead of repeating the flat city total on every row. Marked with * = modeled, never
   presented as directly measured. A pincode with 0 deals gets a 0 share (0 modeled demand),
   which is a real limitation of allocating by deal-share, not evidence of zero actual traffic. */
function computeCityDealTotals(dealsFor){
  var totals = {};
  PIN_ROWS.forEach(function(r){ totals[r.city] = (totals[r.city]||0) + dealsFor(r); });
  return totals;
}
function renderPincodeTable(q){
  q=(q||'').toLowerCase().trim();
  var rows = !q ? PIN_VISIBLE : PIN_VISIBLE.filter(function(r){
    return (r.pincode||'').toLowerCase().indexOf(q)>=0 ||
           (r.city||'').toLowerCase().indexOf(q)>=0 ||
           (r.state||'').toLowerCase().indexOf(q)>=0 ||
           (r.areas||'').toLowerCase().indexOf(q)>=0;
  });
  var fm = buildFilteredMaps();
  var filtered = FILTER.preset!=='all';
  function dealsFor(r){ return filtered ? (fm.dealsByPincode[r.pincode]?fm.dealsByPincode[r.pincode].deals:0) : r.deals; }
  var cityDealTotals = computeCityDealTotals(dealsFor);
  var periodTag = filtered ? periodLabelText() : 'all-time';
  var sessLbl = 'Sessions* (modeled, '+periodTag+')';
  var pdpLbl = 'PDP Views* (modeled, all-time)';
  var atcLbl = 'Add to Cart* (modeled, all-time)';
  var chkLbl = 'Checkout Started* (modeled, all-time)';
  var ordLbl = 'Orders* (modeled, '+periodTag+')';
  var saleLbl = 'Total Sale ₹* (modeled, '+periodTag+')';
  var dealLbl = 'Deals Created (pincode, real, '+periodTag+')';
  var amtLbl = 'Amount ₹ (pincode, real, '+periodTag+')';
  var wonLbl = 'Deals Won (pincode, real, '+periodTag+')';
  var wonAmtLbl = 'Won Amount ₹ (pincode, real, '+periodTag+')';
  document.getElementById('pinCount').textContent = rows.length+' of '+PIN_VISIBLE.length+' pincodes';
  table('tblPincodes',['Pincode','Area(s) (Zoho)','City','State',
      sessLbl,pdpLbl,atcLbl,chkLbl,ordLbl,saleLbl,
      'WebEngage Customers (pincode, real, all-time)','PDP Viewers (pincode, real, all-time)','ATC Customers (pincode, real, all-time)',dealLbl,amtLbl,wonLbl,wonAmtLbl,
      'CaratLane Stores','CaratLane Status','CaratLane Rating','CaratLane Catalog Items','Tanishq Stores','Tanishq Status','Tanishq Rating'],
    rows.map(function(r){
      var pinDeals = dealsFor(r);
      var cityTotal = cityDealTotals[r.city] || 0;
      var share = cityTotal>0 ? pinDeals/cityTotal : 0;
      var citySess = filtered ? (fm.sessByCity[r.city]||0) : r.city_sessions;
      var cityOrd = filtered ? (fm.salesByCity[r.city]?fm.salesByCity[r.city].orders:0) : r.city_orders;
      var citySale = filtered ? (fm.salesByCity[r.city]?fm.salesByCity[r.city].sale:0) : r.city_sale;
      var mSess = r.city_sessions==null ? null : share*citySess;
      var mPdp = r.city_pdp==null ? null : share*r.city_pdp;
      var mAtc = r.city_atc==null ? null : share*r.city_atc;
      var mChk = r.city_checkout==null ? null : share*r.city_checkout;
      var mOrd = (r.city_orders==null||cityOrd==null) ? null : share*cityOrd;
      var mSale = (r.city_sale==null||citySale==null) ? null : share*citySale;
      var dp = filtered ? (fm.dealsByPincode[r.pincode]||{deals:0,amount:0,won:0,won_amount:0}) : {deals:r.deals,amount:r.amount,won:r.won,won_amount:r.won_amount};
      var noCityMatch = r.city_sessions==null;
      return [esc(r.pincode), esc(r.areas)||'<span class="gap">—</span>', esc(r.city), esc(r.state),
        noCityMatch?'<span class="gap">—</span>':fmtInt(Math.round(mSess)),
        mPdp==null?'<span class="gap">—</span>':fmtInt(Math.round(mPdp)),
        mAtc==null?'<span class="gap">—</span>':fmtInt(Math.round(mAtc)),
        mChk==null?'<span class="gap">—</span>':fmtInt(Math.round(mChk)),
        mOrd==null?'<span class="gap">no city match</span>':fmtInt(Math.round(mOrd)),
        mSale==null?'<span class="gap">no city match</span>':fmtMoney(mSale),
        r.we_customers==null?'<span class="gap">not measured</span>':fmtInt(r.we_customers),
        r.we_pdp==null?'<span class="gap">not measured</span>':fmtInt(r.we_pdp),
        r.we_atc==null?'<span class="gap">not measured</span>':fmtInt(r.we_atc),
        fmtInt(dp.deals), fmtMoney(dp.amount), fmtInt(dp.won), fmtMoney(dp.won_amount),
        r.cl_present?fmtInt(r.cl_stores):'<span class="gap">none found</span>',
        r.cl_present&&r.cl_status?esc(r.cl_status):'<span class="gap">—</span>',
        r.cl_present&&r.cl_rating!=null?r.cl_rating.toFixed(1):'<span class="gap">—</span>',
        r.cl_present&&r.cl_catalog?fmtInt(r.cl_catalog):'<span class="gap">—</span>',
        r.tq_present?fmtInt(r.tq_stores):'<span class="gap">none found</span>',
        r.tq_present&&r.tq_status?esc(r.tq_status):'<span class="gap">—</span>',
        r.tq_present&&r.tq_rating!=null?r.tq_rating.toFixed(1):'<span class="gap">—</span>'];
    }),
    [0,0,0,0, 1,1,1,1,1,1, 1,1,1,1,1,1,1, 1,0,1,1,1,0,1]);
}

function renderAll(){
  var m = DATA.meta||{}, t = DATA.totals||{};
  ROWS = DATA.cities||[];
  var fm = buildFilteredMaps();
  var filtered = FILTER.preset!=='all';

  var pill=document.getElementById('freshPill');
  pill.innerHTML='<span class="dot"></span> Snapshot generated '+esc(m.generated_at||'unknown');

  var win = m.ga4_fact_window||{}, zwin = m.zoho_window||{}, dc = m.daily_coverage||{};
  document.getElementById('dataNoteBody').innerHTML =
    'GA4 funnel: <code>'+esc(m.ga4_fact_source||'')+'</code> ('+esc(win.min||'?')+' → '+esc(win.max||'?')+'). Zoho CRM: <code>'+esc(m.zoho_source||'')+'</code> ('+esc(zwin.min||'?')+' → '+esc(zwin.max||'?')+', all-time pipeline). Sales: <code>'+esc(m.sales_source||'')+'</code>, trailing '+esc(m.sales_window_days)+' days.<br><b>Known gaps (stated explicitly, never guessed):</b><ul style="margin:6px 0 0 18px;padding:0">'+
    (m.notes||[]).map(function(n){return '<li style="margin-bottom:4px">'+n+'</li>';}).join('')+'</ul>'+
    (filtered ? '<div class="note" style="margin-top:8px"><b>Period filter active: '+esc(periodLabelText())+'.</b> Deals Created (pincode, real) and Sessions*/Orders*/Total Sale₹* (pincode, modeled) are recomputed for this exact period from real daily data. PDP Views*/Add to Cart*/Checkout Started* stay ALL-TIME (GA4 has no daily city breakdown for these), and WebEngage/CaratLane/Tanishq stay ALL-TIME/static (no date field exists in those sources). Daily data currently covers sessions through <b>'+esc(dc.sessions_max_date||'?')+'</b>, sales through <b>'+esc(dc.sales_max_date||'?')+'</b>, deals through <b>'+esc(dc.deals_max_date||'?')+'</b> — a period after that will show 0, not "no data".</div>' : '');

  var fSessions = 0, fOrders = 0, fSale = 0, fDeals = 0;
  if(filtered){
    Object.keys(fm.sessByCity).forEach(function(k){ fSessions += fm.sessByCity[k]; });
    Object.keys(fm.salesByCity).forEach(function(k){ fOrders += fm.salesByCity[k].orders; fSale += fm.salesByCity[k].sale; });
    Object.keys(fm.dealsByPincode).forEach(function(k){ fDeals += fm.dealsByPincode[k].deals; });
  }

  document.getElementById('kpiGrid').innerHTML=[
    kpiCard('Cities Tracked', fmtInt(m.cities_tracked||ROWS.length), 'with ≥1 GA4 session', 'k_cities'),
    kpiCard('Pincodes Tracked', fmtInt(m.pincodes_tracked_total), fmtInt((DATA.pinTotals||{}).deals)+' Zoho deals across them (all-time)', 'k_pincodes'),
    kpiCard('Total Sessions', fmtInt(filtered?fSessions:t.sessions), filtered?periodLabelText():'GA4, all-time', 'k_sessions'),
    kpiCard('Total PDP Views', fmtInt(t.pdp), 'all-time (no daily breakdown)', 'k_pdp'),
    kpiCard('Total Add to Cart', fmtInt(t.atc), 'all-time (no daily breakdown)', 'k_atc'),
    kpiCard('Total Checkout Started', fmtInt(t.checkout), 'all-time (no daily breakdown)', 'k_checkout'),
    kpiCard('Overall ATC / Session', fmtPct(t.sessions?100*t.atc/t.sessions:0), 'blended, all-time only', 'k_atcrate'),
    kpiCard('Deals Created (Zoho)', fmtInt(filtered?fDeals:t.deals), filtered?periodLabelText():'all-time CRM pipeline', 'k_deals'),
    kpiCard('Orders (matched cities)', fmtInt(filtered?fOrders:t.orders), filtered?periodLabelText():('trailing 540d, '+fmtInt(m.cities_with_matched_sales)+' of '+fmtInt(m.cities_tracked)+' cities matched ERP'), 'k_orders', 'warn'),
    kpiCard('Total Sale ₹ (matched cities)', fmtMoney(filtered?fSale:t.sale), filtered?periodLabelText():'trailing 540d, same match as Orders', 'k_sale', 'warn'),
    kpiCard('WebEngage Pincode-Matched Customers', fmtInt((DATA.weTotals||{}).matched_customers), (DATA.weTotals||{}).matched_pincodes+' pincodes, all-time, of '+fmtInt((DATA.weTotals||{}).total_webengage_customers)+' WebEngage customers total', 'k_we', 'warn'),
    kpiCard('Pincodes With Competitor Presence', fmtInt(m.pincodes_with_caratlane)+' CaratLane / '+fmtInt(m.pincodes_with_tanishq)+' Tanishq', 'of '+fmtInt(m.pincodes_tracked_total)+' tracked pincodes (static)', 'k_competitor')
  ].join('');

  PIN_ROWS = DATA.pincodes||[];
  PIN_VISIBLE = PIN_ROWS;
  renderPincodeTable('');

  var top15Src = filtered
    ? ROWS.map(function(r){ return {city:r.city, sessions: fm.sessByCity[r.city]||0}; }).sort(function(a,b){ return b.sessions-a.sessions; }).slice(0,15)
    : ROWS.slice(0,15).map(function(r){ return {city:r.city, sessions:r.sessions}; });
  var top15 = top15Src.map(function(r,i){ return {label:r.city, value:r.sessions, valueLabel:fmtInt(r.sessions), color:'var(--c'+((i%8)+1)+')'}; });
  document.getElementById('chTopSessions').innerHTML = hbar(top15);

  var atcCandidates = ROWS.filter(function(r){ return r.sessions>=1000; }).slice().sort(function(a,b){ return b.atc_rate-a.atc_rate; }).slice(0,12);
  document.getElementById('chAtcRate').innerHTML = hbar(atcCandidates.map(function(r,i){ return {label:r.city, value:r.atc_rate, valueLabel:fmtPct(r.atc_rate), color:'var(--c'+((i%8)+1)+')'}; }));
  document.getElementById('atcRateNote').textContent = 'Cities with ≥1,000 sessions only, to avoid low-volume noise (a city with 5 sessions and 2 ATCs would otherwise show a meaningless 40% rate). Always ALL-TIME — unaffected by the date filter above, since Add to Cart has no daily breakdown.';

  var top = ROWS[0];
  var bestAtc = atcCandidates[0];
  var matched = ROWS.filter(function(r){ return r.orders!=null; });
  var topSale = matched.slice().sort(function(a,b){ return (b.sale||0)-(a.sale||0); })[0];
  var zeroDealCities = ROWS.filter(function(r){ return r.sessions>2000 && r.deals===0; });
  var insights=[];
  insights.push({t:'📊',c:'',h:'<b>'+fmtInt(m.cities_tracked)+' cities</b> generated <b>'+fmtInt(t.sessions)+'</b> GA4 sessions and <b>'+fmtInt(t.deals)+'</b> Zoho deals across the tracked window; only <b>'+fmtInt(m.cities_with_matched_sales)+' of '+fmtInt(m.cities_tracked)+'</b> cities could be matched to real ERP order data by exact city name.'});
  if(top) insights.push({t:'🏙',c:'',h:'<b>'+esc(top.city)+'</b> is the single largest source of web demand: <b>'+fmtInt(top.sessions)+'</b> sessions, <b>'+fmtInt(top.atc)+'</b> add-to-carts ('+fmtPct(top.atc_rate)+'), and <b>'+fmtInt(top.deals)+'</b> Zoho deals.'});
  if(bestAtc) insights.push({t:'🎯',c:'pos',h:'<b>'+esc(bestAtc.city)+'</b> converts sessions to cart adds best among high-volume cities at <b>'+fmtPct(bestAtc.atc_rate)+'</b> (≥1,000 sessions).'});
  if(topSale) insights.push({t:'💰',c:'pos',h:'Among matched cities, <b>'+esc(topSale.city)+'</b> drove the most real ERP revenue in the trailing 540 days: <b>'+fmtMoney(topSale.sale)+'</b> across <b>'+fmtInt(topSale.orders)+'</b> orders.'});
  if(zeroDealCities.length) insights.push({t:'⚠',c:'warn',h:fmtInt(zeroDealCities.length)+' cities have over 2,000 sessions but <b>zero</b> Zoho deals recorded against that exact city spelling ('+zeroDealCities.slice(0,3).map(function(r){return esc(r.city);}).join(', ')+(zeroDealCities.length>3?', …':'')+') — worth checking for a city-label mismatch in the CRM before assuming zero demand.'});
  insights.push({t:'ℹ',c:'warn',h:(fmtInt(m.cities_tracked-m.cities_with_matched_sales))+' cities have GA4 and/or Zoho activity but no matching ERP order row — either genuinely zero orders in the last 540 days, or an ERP city-spelling mismatch (see Data Sources note). This dashboard does not guess which.'});
  document.getElementById('insightsList').innerHTML = insights.map(function(i){return '<div class="itm '+i.c+'"><span class="tag">'+i.t+'</span><span>'+i.h+'</span></div>';}).join('');
}

function wireHeader(){
  document.getElementById('themeBtn').onclick=function(){ var html=document.documentElement; html.setAttribute('data-theme', html.getAttribute('data-theme')==='dark'?'light':'dark'); };
  document.getElementById('printBtn').onclick=function(){ window.print(); };
  document.addEventListener('click',function(e){ var b=e.target.closest('[data-csv]'); if(b){ var csv=tableToCsv(b.getAttribute('data-csv')); downloadBlob(csv,b.getAttribute('data-name')+'.csv','text/csv'); } });
  var nav=document.getElementById('secnavIn');
  var secs=[['sec1','① KPIs'],['sec2','② Pincode Table'],['sec3','③ Top Cities'],['sec4','④ ATC Rate'],['sec5','⑤ Insights']];
  nav.innerHTML=secs.map(function(s){return '<a href="#'+s[0]+'">'+s[1]+'</a>';}).join('');
  document.getElementById('pinSearch').addEventListener('input',function(e){ renderPincodeTable(e.target.value); });
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
      return;
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

function boot(){
  DATA = window.CITY_GEO_FUNNEL_DATA || {meta:{},totals:{},cities:[]};
  wireHeader();
  renderAll();
  document.getElementById('boot').classList.add('hide');
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();

})();
