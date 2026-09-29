/* Marketing Sale Intelligence — executive drill-down analytics on top of
   ds_imputed_reporting.marketing_sale (via hourly-deals-orders-api's
   /marketing-sale-lines endpoint). Loaded ONCE (the table is tiny, ~2.5K
   line items across 13+ months), then every dimension table / filter /
   drill-down / matrix below is pure client-side JS — no repeat BigQuery
   calls. Reuses hdo.js's globals (esc, fmtInt, fmtPct1, fmtMoney,
   CONFIG.DATA_API) — this file is additive only, it never touches hdo.js's
   own state or the existing Hourly Deals vs Orders table/logic. */
'use strict';

/* ---------- dimension registry ---------- */
function priceRangeStartNum(v){ var n=parseFloat(v); return isNaN(n)?999999:n; }
var DIMS = {
  fulfillment:        {label:'Fulfillment',        defaultSort:'orders'},
  company_code:       {label:'Store / Company'},
  city_name:          {label:'City'},
  type_name:          {label:'Category'},
  full_sku:           {label:'SKU', extra:'product_title', extraLabel:'Product'},
  item_group_name:    {label:'Item Group'},
  collection_name:    {label:'Collection'},
  karat_name:         {label:'Karat'},
  metal_color_code:   {label:'Metal Color'},
  is_solitaire:       {label:'Solitaire', mapVal:function(v){ return v==='true'?'Solitaire':(v==='false'?'Non-Solitaire':'(Not Set)'); }},
  gemstone_setting:   {label:'Gemstone Setting'},
  gemstone_shape:     {label:'Gemstone Shape'},
  diamond_setting:    {label:'Diamond Setting'},
  pf_sub_category_1:  {label:'PF Sub Category 1'},
  pf_sub_category_2:  {label:'PF Sub Category 2'},
  diamond_weight_band:{label:'Diamond Weight Band'},
  vendor:             {label:'Vendor'},
  price_range:        {label:'Price Range', sortValueFn:function(row){ return priceRangeStartNum(row.value); }},
};
var DIM_KEYS = Object.keys(DIMS);

/* ---------- state ---------- */
var MSI_STATE = { lines:null, loading:false, error:null, tab:'overview' };
var MSI_FILTERS = {};              // dimKey -> Set(display value)
var MSI_SORT = {};                 // dimKey -> {col, dir}
var MSI_SEARCH = {};               // dimKey -> search text (SKU table etc.)
var MSI_LIMIT = { full_sku: 25 };  // dimKey -> row cap (Top N selector)
var MSI_MATRIX = { d1:'company_code', d2:'type_name', metric:'sales' };
var MSI_TABS = [
  ['overview','Overview'], ['orders','Orders'], ['product','Product'],
  ['attributes','Product Attributes'], ['commercial','Commercial'], ['advanced','Advanced Analysis'],
];

/* ---------- data helpers ---------- */
function dimVal(key, l){
  var raw = l[key], d = DIMS[key];
  if(d.mapVal) return d.mapVal(raw);
  return (raw!=null && String(raw).trim()) ? raw : '(Not Set)';
}
function msiDateRange(){
  var fromEl = document.getElementById('fFrom'), toEl = document.getElementById('fTo');
  return { from: fromEl?fromEl.value:'', to: toEl?toEl.value:'' };
}
function msiDateFilteredLines(){
  var lines = MSI_STATE.lines || [];
  var r = msiDateRange();
  if(r.from) lines = lines.filter(function(l){ return l.date>=r.from; });
  if(r.to)   lines = lines.filter(function(l){ return l.date<=r.to; });
  return lines;
}
function msiFilteredLines(){
  var lines = msiDateFilteredLines();
  var keys = Object.keys(MSI_FILTERS).filter(function(k){ return MSI_FILTERS[k] && MSI_FILTERS[k].size; });
  if(!keys.length) return lines;
  return lines.filter(function(l){
    return keys.every(function(k){ return MSI_FILTERS[k].has(dimVal(k,l)); });
  });
}
function msiAggregate(lines, key){
  var map = new Map();
  lines.forEach(function(l){
    var v = dimVal(key,l);
    var e = map.get(v);
    if(!e){ e = {value:v, extra:null, orders:new Set(), sales:0, units:0}; map.set(v,e); }
    e.orders.add(l.document_no); e.sales += (l.net_sale||0); e.units += (l.pieces||0);
    if(DIMS[key].extra && !e.extra && l[DIMS[key].extra]) e.extra = l[DIMS[key].extra];
  });
  var totalOrders = new Set(lines.map(function(l){ return l.document_no; })).size;
  var totalSales = lines.reduce(function(a,l){ return a+(l.net_sale||0); }, 0);
  var rows = [];
  map.forEach(function(e){
    rows.push({
      value:e.value, extra:e.extra, orders:e.orders.size, sales:e.sales, units:e.units,
      aov: e.orders.size ? e.sales/e.orders.size : 0,
      orderShare: totalOrders ? e.orders.size/totalOrders*100 : 0,
      salesShare: totalSales ? e.sales/totalSales*100 : 0,
    });
  });
  return rows;
}
function msiToggleFilter(key, val){
  if(!MSI_FILTERS[key]) MSI_FILTERS[key] = new Set();
  if(MSI_FILTERS[key].has(val)) MSI_FILTERS[key].delete(val); else MSI_FILTERS[key].add(val);
  if(!MSI_FILTERS[key].size) delete MSI_FILTERS[key];
  renderMSI();
}
function msiClearFilter(key){ delete MSI_FILTERS[key]; renderMSI(); }
function msiClearAllFilters(){ MSI_FILTERS = {}; renderMSI(); }

/* ---------- fetch (once) ---------- */
function fetchMSI(){
  MSI_STATE.loading = true; MSI_STATE.error = null;
  renderMSI();
  fetch(CONFIG.DATA_API + '/marketing-sale-lines').then(function(r){
    if(!r.ok) throw new Error('http '+r.status);
    return r.json();
  }).then(function(data){
    if(data.error) throw new Error(data.error);
    var fi = data.fields.reduce(function(m,f,i){ m[f]=i; return m; }, {});
    MSI_STATE.lines = data.lines.map(function(row){
      var o = {};
      data.fields.forEach(function(f,i){ o[f]=row[i]; });
      return o;
    });
    MSI_STATE.loading = false;
    renderMSI();
  }).catch(function(e){
    MSI_STATE.error = e.message || 'network error';
    MSI_STATE.loading = false;
    renderMSI();
  });
}

/* ---------- generic dimension table ---------- */
function msiSortRows(rows, key, defaultCol){
  var s = MSI_SORT[key] || {col: defaultCol || 'sales', dir:-1};
  if(DIMS[key].sortValueFn && !MSI_SORT[key]){
    rows.sort(function(a,b){ return DIMS[key].sortValueFn(a) - DIMS[key].sortValueFn(b); });
    return rows;
  }
  rows.sort(function(a,b){
    var av=a[s.col], bv=b[s.col];
    if(typeof av==='string') return s.dir * String(av).localeCompare(String(bv));
    return s.dir * ((av||0)-(bv||0));
  });
  return rows;
}
function msiTableHtml(key, opts){
  opts = opts || {};
  var lines = msiFilteredLines();
  var rows = msiAggregate(lines, key);
  var search = MSI_SEARCH[key];
  if(search){
    var q = search.toLowerCase();
    rows = rows.filter(function(r){ return String(r.value).toLowerCase().indexOf(q)>=0 || (r.extra && String(r.extra).toLowerCase().indexOf(q)>=0); });
  }
  msiSortRows(rows, key, DIMS[key].defaultSort);
  var limit = opts.limit || MSI_LIMIT[key];
  var shown = limit ? rows.slice(0, limit) : rows;
  var maxSales = Math.max(1, ...rows.map(function(r){ return r.sales; }));
  var activeSet = MSI_FILTERS[key];
  var cols = [['value', DIMS[key].label]];
  if(DIMS[key].extra) cols.push(['extra', DIMS[key].extraLabel||'']);
  cols.push(['orders','Orders'],['sales','Sales'],['units','Units'],['aov','AOV'],['orderShare','Order Share'],['salesShare','Sales Share']);
  var sortState = MSI_SORT[key];
  var head = cols.map(function(c){
    var sorted = sortState && sortState.col===c[0];
    return '<th data-sort="'+esc(c[0])+'" class="'+(sorted?'sorted':'')+'">'+esc(c[1])+(sorted?(sortState.dir<0?' ▼':' ▲'):'')+'</th>';
  }).join('');
  var body = shown.map(function(r){
    var isActive = activeSet && activeSet.has(r.value);
    var cells = cols.map(function(c){
      var k = c[0];
      if(k==='value') return '<td><span class="bar" style="width:'+Math.max(2, r.sales/maxSales*36)+'px"></span>'+esc(r.value)+'</td>';
      if(k==='extra') return '<td style="text-align:left;max-width:220px;overflow:hidden;text-overflow:ellipsis">'+esc(r.extra||'')+'</td>';
      if(k==='sales'||k==='aov') return '<td>'+fmtMoney(r[k])+'</td>';
      if(k==='orderShare'||k==='salesShare') return '<td>'+fmtPct1(r[k])+'</td>';
      return '<td>'+fmtInt(r[k])+'</td>';
    }).join('');
    return '<tr class="'+(isActive?'active':'')+'" data-dim="'+esc(key)+'" data-val="'+esc(r.value)+'">'+cells+'</tr>';
  }).join('') || ('<tr><td colspan="'+cols.length+'" style="text-align:center;padding:16px;color:var(--tx3)">No data for the current filters</td></tr>');
  return '<table class="msi" data-dim="'+esc(key)+'"><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table>';
}
function msiPanel(key, opts){
  opts = opts || {};
  var title = opts.title || (DIMS[key].label + ' Performance');
  var toolbar = '';
  if(opts.searchable || opts.limitable){
    toolbar = '<div class="msi-toolbar">'
      + (opts.searchable ? '<input type="search" data-search="'+esc(key)+'" placeholder="Search '+esc(DIMS[key].label)+'…" value="'+esc(MSI_SEARCH[key]||'')+'">' : '')
      + (opts.limitable ? '<select data-limit="'+esc(key)+'">'
          + [10,25,50,0].map(function(n){ return '<option value="'+n+'" '+((MSI_LIMIT[key]||25)===n?'selected':'')+'>'+(n?('Top '+n):'All')+'</option>'; }).join('')
          + '</select>' : '')
      + '<button class="btn sm" data-export="'+esc(key)+'" style="margin-left:auto">⬇ CSV</button>'
      + '</div>';
  }else{
    toolbar = '<div class="msi-toolbar"><span></span><button class="btn sm" data-export="'+esc(key)+'" style="margin-left:auto">⬇ CSV</button></div>';
  }
  return '<div class="card'+(opts.full?' msi-panel-full':'')+'"><h3>'+esc(title)+'</h3>'+toolbar
    + '<div class="msi-tblwrap">'+msiTableHtml(key, {limit: opts.limitable ? (MSI_LIMIT[key]||25) : opts.limit})+'</div></div>';
}
function msiExportCsv(key){
  var rows = msiAggregate(msiFilteredLines(), key);
  msiSortRows(rows, key, DIMS[key].defaultSort);
  var extra = DIMS[key].extra;
  var header = [DIMS[key].label];
  if(extra) header.push(DIMS[key].extraLabel||'');
  header.push('Orders','Sales','Units','AOV','Order Share %','Sales Share %');
  var lines = [header.join(',')];
  rows.forEach(function(r){
    var row = [JSON.stringify(r.value)];
    if(extra) row.push(JSON.stringify(r.extra||''));
    row.push(r.orders, r.sales.toFixed(2), r.units, r.aov.toFixed(2), r.orderShare.toFixed(1), r.salesShare.toFixed(1));
    lines.push(row.join(','));
  });
  var blob = new Blob([lines.join('\n')], {type:'text/csv'});
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = key+'_performance.csv'; a.click();
}

/* ---------- KPI cards ---------- */
function msiKpiHtml(){
  var dateLines = msiDateFilteredLines();
  var lines = msiFilteredLines();
  var hasFilters = Object.keys(MSI_FILTERS).some(function(k){ return MSI_FILTERS[k] && MSI_FILTERS[k].size; });
  var baseOrders = new Set(dateLines.map(function(l){ return l.document_no; })).size;
  var orders = new Set(lines.map(function(l){ return l.document_no; })).size;
  var sales = lines.reduce(function(a,l){ return a+(l.net_sale||0); }, 0);
  var units = lines.reduce(function(a,l){ return a+(l.pieces||0); }, 0);
  var aov = orders ? sales/orders : 0;
  var fRows = msiAggregate(lines, 'fulfillment'); fRows.sort(function(a,b){ return b.orders-a.orders; });
  var topF = fRows[0];
  var shareVal = hasFilters && baseOrders ? (orders/baseOrders*100) : null;
  var cards = [
    {lbl:'Total Orders', val:fmtInt(orders), sub:'COUNT(DISTINCT document_no)'},
    {lbl:'Total Sales', val:fmtMoney(sales), sub:'SUM(net_sale)'},
    {lbl:'AOV', val:fmtMoney(aov), sub:'Total Sales ÷ Total Orders'},
    {lbl:'Units Sold', val:fmtInt(units), sub:'SUM(pieces)'},
    {lbl:'Top Fulfillment', val: topF?esc(topF.value):'—', sub: topF?(fmtInt(topF.orders)+' orders ('+fmtPct1(topF.orderShare)+')'):''},
    {lbl:'Order Share', val: shareVal!=null?fmtPct1(shareVal):'—', sub: hasFilters?'of all orders in the date range':'Click a row anywhere below to filter'},
  ];
  return cards.map(function(c){
    return '<div class="kpi"><div class="lbl">'+esc(c.lbl)+'</div><div class="val">'+c.val+'</div><div class="sub">'+esc(c.sub)+'</div></div>';
  }).join('');
}

/* ---------- insights ---------- */
function msiInsightsHtml(){
  var lines = msiFilteredLines();
  if(!lines.length) return '<div class="insight-item">No data in the current filters/date range to generate insights from.</div>';
  var totalSales = lines.reduce(function(a,l){ return a+(l.net_sale||0); }, 0);
  var out = [];
  function top(key, by){
    var r = msiAggregate(lines, key).filter(function(x){ return x.value!=='(Not Set)'; });
    r.sort(function(a,b){ return b[by]-a[by]; });
    return r[0];
  }
  var store = top('company_code','sales');
  if(store) out.push('<b>'+esc(store.value)+'</b> generated the highest sales among stores — '+fmtMoney(store.sales)+' ('+fmtPct1(store.salesShare)+' of total sales).');
  var karat = top('karat_name','sales');
  if(karat) out.push('<b>'+esc(karat.value)+'</b> products contributed the most by karat — '+fmtPct1(karat.salesShare)+' of total sales.');
  var vendor = top('vendor','sales');
  if(vendor) out.push('<b>'+esc(vendor.value)+'</b> is the top vendor by sales — '+fmtMoney(vendor.sales)+'.');
  var city = top('city_name','orders');
  if(city) out.push('<b>'+esc(city.value)+'</b> generated the highest order volume among cities with a known location — '+fmtInt(city.orders)+' orders.');
  var pr = top('price_range','orders');
  if(pr) out.push('The <b>'+esc(pr.value)+'</b> price range generated the most orders — '+fmtInt(pr.orders)+' ('+fmtPct1(pr.orderShare)+').');
  var sol = msiAggregate(lines,'is_solitaire').find(function(r){ return r.value==='Solitaire'; });
  if(sol) out.push('Solitaire products contributed <b>'+fmtPct1(sol.salesShare)+'</b> of total sales.');
  var skuRows = msiAggregate(lines,'full_sku'); skuRows.sort(function(a,b){ return b.sales-a.sales; });
  var top10Sum = skuRows.slice(0,10).reduce(function(a,r){ return a+r.sales; }, 0);
  if(totalSales>0) out.push('The top 10 SKUs contributed <b>'+fmtPct1(top10Sum/totalSales*100)+'</b> of total sales.');
  var cityKnown = lines.filter(function(l){ return l.city_name && l.city_name.trim(); }).length;
  var cityPct = lines.length ? cityKnown/lines.length*100 : 0;
  if(cityPct<60) out.push('⚠ City is known for only '+fmtPct1(cityPct)+' of line items in this range — city-level figures are directional, not complete.');
  var gemKnown = lines.filter(function(l){ return l.gemstone_setting && l.gemstone_setting.trim(); }).length;
  if(lines.length && gemKnown/lines.length < 0.1) out.push('⚠ Gemstone Setting is populated on fewer than 10% of line items — that breakdown is too sparse to be reliable yet.');
  return out.map(function(t){ return '<div class="insight-item">'+t+'</div>'; }).join('');
}

/* ---------- top/bottom performers ---------- */
function msiTopBottomHtml(){
  var lines = msiFilteredLines();
  var dims = [['full_sku','SKUs'],['type_name','Categories'],['vendor','Vendors'],['company_code','Stores'],['collection_name','Collections'],['city_name','Cities']];
  return '<div class="msi-panels">' + dims.map(function(d){
    var rows = msiAggregate(lines, d[0]).filter(function(r){ return r.value!=='(Not Set)'; });
    rows.sort(function(a,b){ return b.sales-a.sales; });
    var top10 = rows.slice(0,10);
    var max = Math.max(1, ...top10.map(function(r){ return r.sales; }));
    var body = top10.length ? top10.map(function(r,i){
      return '<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:3px 0" data-dim="'+esc(d[0])+'" data-val="'+esc(r.value)+'" class="msi-rankrow">'
        + '<span style="width:16px;color:var(--tx3)">'+(i+1)+'</span>'
        + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(r.value)+'">'+esc(r.value)+'</span>'
        + '<span style="width:20%;max-width:120px;text-align:right;font-weight:700">'+fmtMoney(r.sales)+'</span>'
        + '</div>';
    }).join('') : '<div style="color:var(--tx3);font-size:12px">No data</div>';
    return '<div class="card"><h3>Top 10 '+esc(d[1])+' by Sales</h3>'+body+'</div>';
  }).join('') + '</div>';
}

/* ---------- trend (daily/weekly) ---------- */
var MSI_TREND_MODE = 'daily';
function msiWeekStart(dateStr){
  var d = new Date(dateStr+'T00:00:00Z');
  var day = d.getUTCDay(); var diff = (day===0?-6:1-day); // Monday start
  d.setUTCDate(d.getUTCDate()+diff);
  return d.toISOString().slice(0,10);
}
function msiTrendHtml(){
  var lines = msiFilteredLines();
  var map = new Map();
  lines.forEach(function(l){
    var key = MSI_TREND_MODE==='weekly' ? msiWeekStart(l.date) : l.date;
    var e = map.get(key); if(!e){ e={date:key, orders:new Set(), sales:0, units:0}; map.set(key,e); }
    e.orders.add(l.document_no); e.sales += (l.net_sale||0); e.units += (l.pieces||0);
  });
  var rows = [...map.values()].map(function(e){ return {date:e.date, orders:e.orders.size, sales:e.sales, units:e.units, aov: e.orders.size?e.sales/e.orders.size:0}; });
  rows.sort(function(a,b){ return a.date<b.date?1:-1; });
  rows = rows.slice(0,30);
  var body = rows.map(function(r){
    return '<tr><td style="text-align:left">'+esc(r.date)+(MSI_TREND_MODE==='weekly'?' (wk)':'')+'</td><td>'+fmtInt(r.orders)+'</td><td>'+fmtMoney(r.sales)+'</td><td>'+fmtInt(r.units)+'</td><td>'+fmtMoney(r.aov)+'</td></tr>';
  }).join('') || '<tr><td colspan="5" style="text-align:center;padding:14px;color:var(--tx3)">No data</td></tr>';
  return '<div class="card msi-panel-full"><h3>'+(MSI_TREND_MODE==='weekly'?'Weekly':'Daily')+' Orders &amp; Sales Trend'
    + '<span style="margin-left:auto;display:flex;gap:6px">'
    + '<button class="btn sm" data-trend="daily" style="'+(MSI_TREND_MODE==='daily'?'border-color:var(--acc);color:var(--acc)':'')+'">Daily</button>'
    + '<button class="btn sm" data-trend="weekly" style="'+(MSI_TREND_MODE==='weekly'?'border-color:var(--acc);color:var(--acc)':'')+'">Weekly</button>'
    + '</span></h3>'
    + '<div class="note">Hour-level trend already lives in the Hour × Date table above (Section 2) — this keeps that logic as the single source of truth for hourly figures rather than re-deriving it here.</div>'
    + '<div class="msi-tblwrap"><table class="msi"><thead><tr><th style="text-align:left">Date</th><th>Orders</th><th>Sales</th><th>Units</th><th>AOV</th></tr></thead><tbody>'+body+'</tbody></table></div></div>';
}

/* ---------- dimension comparison matrix ---------- */
function msiMatrixHtml(){
  var lines = msiFilteredLines();
  var d1 = MSI_MATRIX.d1, d2 = MSI_MATRIX.d2, metric = MSI_MATRIX.metric;
  var cellMap = new Map();
  lines.forEach(function(l){
    var v1 = dimVal(d1,l), v2 = dimVal(d2,l);
    if(!cellMap.has(v1)) cellMap.set(v1, new Map());
    var row = cellMap.get(v1);
    var c = row.get(v2); if(!c){ c={orders:new Set(),sales:0,units:0}; row.set(v2,c); }
    c.orders.add(l.document_no); c.sales += (l.net_sale||0); c.units += (l.pieces||0);
  });
  function cellVal(v1,v2){
    var c = cellMap.get(v1) && cellMap.get(v1).get(v2);
    if(!c) return 0;
    if(metric==='orders') return c.orders.size;
    if(metric==='units') return c.units;
    if(metric==='aov') return c.orders.size ? c.sales/c.orders.size : 0;
    return c.sales;
  }
  function fmtCell(v){ return (metric==='sales'||metric==='aov') ? fmtMoney(v) : fmtInt(v); }
  var d1Agg = msiAggregate(lines, d1).filter(function(r){ return r.value!=='(Not Set)'; });
  d1Agg.sort(function(a,b){ return b.sales-a.sales; });
  var d2Agg = msiAggregate(lines, d2).filter(function(r){ return r.value!=='(Not Set)'; });
  d2Agg.sort(function(a,b){ return b.sales-a.sales; });
  var d1Vals = d1Agg.slice(0,15).map(function(r){ return r.value; });
  var d2Vals = d2Agg.slice(0,15).map(function(r){ return r.value; });
  if(!d1Vals.length || !d2Vals.length) return '<div class="note">Not enough data in the current filters for this comparison.</div>';
  var head = '<tr><th>'+esc(DIMS[d1].label)+' \\ '+esc(DIMS[d2].label)+'</th>'+d2Vals.map(function(v){ return '<th>'+esc(v)+'</th>'; }).join('')+'<th class="tot">Total</th></tr>';
  var rows = d1Vals.map(function(v1){
    var rowTotal = 0;
    var cells = d2Vals.map(function(v2){ var v=cellVal(v1,v2); rowTotal+=v; return '<td>'+(v?fmtCell(v):'—')+'</td>'; }).join('');
    return '<tr><td>'+esc(v1)+'</td>'+cells+'<td class="tot">'+fmtCell(rowTotal)+'</td></tr>';
  }).join('');
  var colTotals = d2Vals.map(function(v2){ var t=0; d1Vals.forEach(function(v1){ t+=cellVal(v1,v2); }); return '<td class="tot">'+fmtCell(t)+'</td>'; }).join('');
  var grand = 0; d1Vals.forEach(function(v1){ d2Vals.forEach(function(v2){ grand+=cellVal(v1,v2); }); });
  var foot = '<tr><td class="tot">Total</td>'+colTotals+'<td class="tot">'+fmtCell(grand)+'</td></tr>';
  return '<div class="matrix-wrap"><table class="matrix"><thead>'+head+'</thead><tbody>'+rows+foot+'</tbody></table></div>'
    + (d1Agg.length>15||d2Agg.length>15 ? '<div class="note">Showing the top 15 by sales on each axis (of '+d1Agg.length+' / '+d2Agg.length+' total values) to keep the matrix readable.</div>' : '');
}
function msiMatrixControlsHtml(){
  function opts(sel){ return DIM_KEYS.map(function(k){ return '<option value="'+k+'" '+(sel===k?'selected':'')+'>'+esc(DIMS[k].label)+'</option>'; }).join(''); }
  return '<div class="msi-toolbar">'
    + '<label style="font-size:11px;color:var(--tx3)">Dimension 1<br><select id="msiD1">'+opts(MSI_MATRIX.d1)+'</select></label>'
    + '<label style="font-size:11px;color:var(--tx3)">Dimension 2<br><select id="msiD2">'+opts(MSI_MATRIX.d2)+'</select></label>'
    + '<label style="font-size:11px;color:var(--tx3)">Metric<br><select id="msiMetric">'
      + ['sales','orders','units','aov'].map(function(m){ return '<option value="'+m+'" '+(MSI_MATRIX.metric===m?'selected':'')+'>'+m.charAt(0).toUpperCase()+m.slice(1)+'</option>'; }).join('')
      + '</select></label></div>';
}

/* ---------- chip bar ---------- */
function msiChipBarHtml(){
  var keys = Object.keys(MSI_FILTERS).filter(function(k){ return MSI_FILTERS[k] && MSI_FILTERS[k].size; });
  if(!keys.length) return '';
  var chips = keys.map(function(k){
    var vals = [...MSI_FILTERS[k]];
    var label = DIMS[k].label+': '+vals.slice(0,3).join(', ')+(vals.length>3?(' +'+(vals.length-3)):'');
    return '<span class="msi-chip">'+esc(label)+'<button data-clearfilter="'+esc(k)+'">✕</button></span>';
  }).join('');
  return '<div class="msi-chipbar">'+chips+'<button class="btn sm" id="msiClearAllBtn">Clear All Filters</button></div>';
}

/* ---------- tab content builders ---------- */
function msiTabOverview(){
  return '<div class="grid g4" style="margin-bottom:16px">'+msiKpiHtml()+'</div>'
    + '<div class="card" style="margin-bottom:16px"><h3>Key Insights</h3><div class="insight-list">'+msiInsightsHtml()+'</div></div>'
    + msiTrendHtml()
    + '<div style="margin-top:16px">'+msiTopBottomHtml()+'</div>';
}
function msiTabOrders(){
  return '<div class="msi-panels">'
    + msiPanel('fulfillment', {full:false})
    + msiPanel('company_code', {title:'Store Performance'})
    + msiPanel('city_name', {title:'City Performance', searchable:true})
    + '</div>';
}
function msiTabProduct(){
  return '<div class="msi-panels">'
    + msiPanel('type_name', {title:'Category Performance'})
    + msiPanel('item_group_name', {title:'Item Group Performance'})
    + msiPanel('collection_name', {title:'Collection Performance', searchable:true})
    + msiPanel('full_sku', {title:'SKU Performance', full:true, searchable:true, limitable:true})
    + '</div>';
}
function msiTabAttributes(){
  return '<div class="msi-panels">'
    + msiPanel('karat_name', {title:'Karat Performance'})
    + msiPanel('metal_color_code', {title:'Metal Color Performance'})
    + msiPanel('is_solitaire', {title:'Solitaire vs Non-Solitaire'})
    + msiPanel('gemstone_setting', {title:'Gemstone Setting Performance'})
    + msiPanel('gemstone_shape', {title:'Gemstone Shape Performance'})
    + msiPanel('diamond_setting', {title:'Diamond Setting Performance'})
    + msiPanel('pf_sub_category_1', {title:'Product Family — Sub Category 1'})
    + msiPanel('pf_sub_category_2', {title:'Product Family — Sub Category 2'})
    + msiPanel('diamond_weight_band', {title:'Diamond Weight Band Performance'})
    + '</div>'
    + '<div class="note">Coverage caveat: some attribute fields (esp. <b>Gemstone Setting</b>, <b>Diamond Setting</b>) are only populated on a subset of line items — rows without a value show as <b>(Not Set)</b> rather than being dropped, so totals still reconcile with the KPI cards, but sparse dimensions should be read directionally.</div>';
}
function msiTabCommercial(){
  return '<div class="msi-panels">'
    + msiPanel('vendor', {title:'Vendor Performance', searchable:true})
    + msiPanel('price_range', {title:'Price Range Performance'})
    + '</div>';
}
function msiTabAdvanced(){
  return '<div class="card">'
    + '<h3>Dimension Comparison</h3>'
    + msiMatrixControlsHtml()
    + msiMatrixHtml()
    + '</div>';
}
var MSI_TAB_RENDER = { overview:msiTabOverview, orders:msiTabOrders, product:msiTabProduct, attributes:msiTabAttributes, commercial:msiTabCommercial, advanced:msiTabAdvanced };

/* ---------- root render ---------- */
function renderMSI(){
  var root = document.getElementById('msiRoot');
  if(!root) return;
  var sub = document.getElementById('msiSub');
  if(MSI_STATE.error){
    root.innerHTML = '<div class="note">Couldn\'t load Marketing Sale Intelligence: '+esc(MSI_STATE.error)+'</div>';
    if(sub) sub.textContent = '';
    return;
  }
  if(MSI_STATE.loading || MSI_STATE.lines===null){
    root.innerHTML = '<div class="card"><div style="text-align:center;padding:30px;color:var(--tx3)">Loading Marketing Sale line-item history (one-time per session, then everything below is instant)…</div></div>';
    if(sub) sub.textContent = '';
    return;
  }
  if(sub){
    var r = msiDateRange();
    sub.textContent = 'Orders × SKU × attribute drill-down over '+(r.from||'…')+' → '+(r.to||'…')+' — click any row to filter, everywhere';
  }
  var tabsHtml = '<div class="msi-tabs">'+MSI_TABS.map(function(t){
    return '<button class="msi-tab'+(MSI_STATE.tab===t[0]?' on':'')+'" data-msitab="'+t[0]+'">'+esc(t[1])+'</button>';
  }).join('')+'</div>';
  var content = (MSI_TAB_RENDER[MSI_STATE.tab] || msiTabOverview)();
  root.innerHTML = '<div class="msi-sub">Source: <code>ds_imputed_reporting.marketing_sale</code>, one row per line item. Order metrics use <code>COUNT(DISTINCT document_no)</code> (an order with several SKUs counts once); Sales/Units/AOV are computed from that same de-duplicated order base. Uses the Date Range filter above.</div>'
    + tabsHtml + msiChipBarHtml() + '<div id="msiTabContent">'+content+'</div>';
}

/* ---------- event delegation (attached once) ---------- */
document.addEventListener('DOMContentLoaded', function(){
  var root = document.getElementById('msiRoot');
  if(!root) return;

  root.addEventListener('click', function(e){
    var tabBtn = e.target.closest('[data-msitab]');
    if(tabBtn){ MSI_STATE.tab = tabBtn.dataset.msitab; renderMSI(); return; }

    var clearBtn = e.target.closest('[data-clearfilter]');
    if(clearBtn){ msiClearFilter(clearBtn.dataset.clearfilter); return; }
    if(e.target.closest('#msiClearAllBtn')){ msiClearAllFilters(); return; }

    var exportBtn = e.target.closest('[data-export]');
    if(exportBtn){ msiExportCsv(exportBtn.dataset.export); return; }

    var trendBtn = e.target.closest('[data-trend]');
    if(trendBtn){ MSI_TREND_MODE = trendBtn.dataset.trend; renderMSI(); return; }

    var th = e.target.closest('th[data-sort]');
    if(th){
      var table = th.closest('table[data-dim]');
      var key = table.dataset.dim, col = th.dataset.sort;
      var cur = MSI_SORT[key];
      MSI_SORT[key] = (cur && cur.col===col) ? {col:col, dir:-cur.dir} : {col:col, dir:-1};
      renderMSI();
      return;
    }

    var tr = e.target.closest('tr[data-dim][data-val]');
    if(tr){ msiToggleFilter(tr.dataset.dim, tr.dataset.val); return; }

    var rankRow = e.target.closest('.msi-rankrow');
    if(rankRow){ msiToggleFilter(rankRow.dataset.dim, rankRow.dataset.val); return; }
  });

  root.addEventListener('input', function(e){
    var s = e.target.closest('[data-search]');
    if(s){ MSI_SEARCH[s.dataset.search] = s.value; renderMSI(); document.querySelector('[data-search="'+s.dataset.search+'"]').focus(); }
  });
  root.addEventListener('change', function(e){
    var lim = e.target.closest('[data-limit]');
    if(lim){ MSI_LIMIT[lim.dataset.limit] = parseInt(lim.value,10)||0; renderMSI(); return; }
    if(e.target.id==='msiD1'){ MSI_MATRIX.d1 = e.target.value; renderMSI(); return; }
    if(e.target.id==='msiD2'){ MSI_MATRIX.d2 = e.target.value; renderMSI(); return; }
    if(e.target.id==='msiMetric'){ MSI_MATRIX.metric = e.target.value; renderMSI(); return; }
  });

  // Keep MSI in sync with the SAME date-range controls the hourly table
  // already uses (additive listeners only -- hdo.js's own handlers are
  // untouched). Programmatic .value assignment (the quick Today/Yesterday/
  // Weekly buttons) doesn't fire 'change', so those buttons are also hooked
  // directly.
  ['fFrom','fTo'].forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.addEventListener('change', renderMSI);
  });
  ['fLatestBtn','fYesterdayBtn','fWeeklyBtn'].forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.addEventListener('click', function(){ setTimeout(renderMSI, 0); });
  });

  fetchMSI();
});
