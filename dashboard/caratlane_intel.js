/* CaratLane Competitive Intelligence — rendering engine.
   All figures come from window.CARATLANE_STORES (dashboard/caratlane_intel_data.js).
   Category total = sum of product-type categories only (materials kept separate, see data file header). */
(function(){
'use strict';

var CATEGORY_KEYS=['Rings','Earrings','Necklaces','Pendants','Bracelets','Bangles','Nose pin'];
var CATEGORY_COLORS={Rings:'var(--s1)',Earrings:'var(--s2)',Necklaces:'var(--s3)',Pendants:'var(--s4)',Bracelets:'var(--s5)',Bangles:'var(--s6)','Nose pin':'var(--s7)'};
var PRICE_BANDS=[
  {key:'u5k',label:'Under ₹5,000',short:'<₹5k',color:'var(--s1)'},
  {key:'b5_10',label:'₹5,001–₹10,000',short:'₹5-10k',color:'var(--s2)'},
  {key:'b10_15',label:'₹10,001–₹15,000',short:'₹10-15k',color:'var(--s3)'},
  {key:'b15_20',label:'₹15,001–₹20,000',short:'₹15-20k',color:'var(--s4)'},
  {key:'b20_30',label:'₹20,001–₹30,000',short:'₹20-30k',color:'var(--s5)'},
  {key:'b30_40',label:'₹30,001–₹40,000',short:'₹30-40k',color:'var(--s6)'}
];

function esc(s){ return (s==null?'':''+s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function fmtInt(n){ return (n==null||isNaN(n))?'—':Math.round(n).toLocaleString('en-IN'); }
function downloadBlob(content,filename,mime){ if(mime==='text/csv' && content.charCodeAt(0)!==0xFEFF) content='﻿'+content; var blob=new Blob([content],{type:mime+';charset=utf-8'}); var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},800); }
function csvOf(rows){ return rows.map(function(r){return r.map(function(v){ v=(v==null?'':''+v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }).join(',');}).join('\n'); }

var STORES=(window.CARATLANE_STORES||[]).map(function(s){
  var total=0; CATEGORY_KEYS.forEach(function(k){ if(s.cat&&s.cat[k]) total+=s.cat[k]; });
  var pbTotal=0; PRICE_BANDS.forEach(function(b){ if(s.pb&&s.pb[b.key]) pbTotal+=s.pb[b.key]; });
  return Object.assign({},s,{total:total,pbTotal:pbTotal});
});

var sortKey='total', sortDir=-1;
var qFilter='', cityFilterVal='';

function buildKpis(){
  var totalStores=STORES.length;
  var cities=Object.keys(STORES.reduce(function(a,s){a[s.city]=1;return a;},{})).length;
  var totalItems=STORES.reduce(function(a,s){return a+s.total;},0);
  var avg=totalStores?Math.round(totalItems/totalStores):0;
  var meta=window.CARATLANE_META||{};
  var known=(meta.city_known_vs_captured||[]).reduce(function(a,c){return a+c.known;},0);
  var kpis=[
    {lbl:'Stores captured',val:fmtInt(totalStores),foot:known?('vs '+fmtInt(known)+'+ known across 7 metros alone'):''},
    {lbl:'Cities covered',val:fmtInt(cities),foot:'Metro + tier-2/3 towns'},
    {lbl:'Total catalog items indexed',val:fmtInt(totalItems),foot:'Across all product categories — a floor, not the full catalog'},
    {lbl:'Avg items / store',val:fmtInt(avg),foot:'Across captured product-type categories'}
  ];
  var row=document.getElementById('kpiRow');
  row.innerHTML=kpis.map(function(k){
    return '<div class="card kpi"><div class="lbl">'+esc(k.lbl)+'</div><div class="val tnum">'+k.val+'</div><div class="foot">'+esc(k.foot)+'</div></div>';
  }).join('');
}

function buildCatChart(){
  var agg={}; CATEGORY_KEYS.forEach(function(k){agg[k]=0;});
  STORES.forEach(function(s){ CATEGORY_KEYS.forEach(function(k){ if(s.cat&&s.cat[k]) agg[k]+=s.cat[k]; }); });
  var total=Object.keys(agg).reduce(function(a,k){return a+agg[k];},0);
  var max=Math.max.apply(null,Object.keys(agg).map(function(k){return agg[k];}));
  document.getElementById('catTotalTag').textContent=fmtInt(total)+' items';
  var html=CATEGORY_KEYS.filter(function(k){return agg[k]>0;}).sort(function(a,b){return agg[b]-agg[a];}).map(function(k){
    var pct=max?Math.round(100*agg[k]/max):0;
    return '<div class="barrow"><div class="nm">'+esc(k)+'</div><div class="track"><div class="fill" style="width:'+pct+'%;background:'+CATEGORY_COLORS[k]+'"></div></div><div class="amt tnum">'+fmtInt(agg[k])+'</div></div>';
  }).join('');
  document.getElementById('catChart').innerHTML=html;
}

function buildPbChart(){
  var agg={}; PRICE_BANDS.forEach(function(b){agg[b.key]=0;});
  STORES.forEach(function(s){ PRICE_BANDS.forEach(function(b){ if(s.pb&&s.pb[b.key]) agg[b.key]+=s.pb[b.key]; }); });
  var total=Object.keys(agg).reduce(function(a,k){return a+agg[k];},0);
  var max=Math.max.apply(null,PRICE_BANDS.map(function(b){return agg[b.key];}));
  document.getElementById('pbTotalTag').textContent=fmtInt(total)+' items';
  var html=PRICE_BANDS.filter(function(b){return agg[b.key]>0;}).map(function(b){
    var pct=max?Math.round(100*agg[b.key]/max):0;
    return '<div class="barrow"><div class="nm">'+esc(b.label)+'</div><div class="track"><div class="fill" style="width:'+pct+'%;background:'+b.color+'"></div></div><div class="amt tnum">'+fmtInt(agg[b.key])+'</div></div>';
  }).join('');
  document.getElementById('pbChart').innerHTML=html;
}

function buildCityChart(){
  var agg={};
  STORES.forEach(function(s){ agg[s.city]=agg[s.city]||{stores:0,total:0}; agg[s.city].stores++; agg[s.city].total+=s.total; });
  var cities=Object.keys(agg).sort(function(a,b){return agg[b].total-agg[a].total;});
  var max=Math.max.apply(null,cities.map(function(c){return agg[c].total;}));
  document.getElementById('cityTag').textContent=cities.length+' cities';
  var html=cities.map(function(c){
    var pct=max?Math.round(100*agg[c].total/max):0;
    return '<div class="barrow"><div class="nm">'+esc(c)+'</div><div class="track"><div class="fill" style="width:'+pct+'%;background:var(--gold)"></div></div><div class="amt tnum">'+fmtInt(agg[c].total)+' <span style="color:var(--muted);font-weight:600">('+agg[c].stores+')</span></div></div>';
  }).join('');
  document.getElementById('cityChart').innerHTML=html;

  var sel=document.getElementById('cityFilter');
  cities.slice().sort().forEach(function(c){
    var opt=document.createElement('option'); opt.value=c; opt.textContent=c; sel.appendChild(opt);
  });
}

/* ---------- table: pincode/store/city/total + one column per category + one per price band ---------- */
function buildTableHead(){
  var row1=['<th class="grp" rowspan="2" data-k="pincode">Pincode</th>',
            '<th class="grp" rowspan="2" data-k="store">Store</th>',
            '<th class="grp" rowspan="2" data-k="city">City</th>',
            '<th class="grp on" rowspan="2" data-k="total">Total Catalog Items <span class="arrow">▼</span></th>',
            '<th class="grp cat-grp" colspan="'+CATEGORY_KEYS.length+'">Category-wise Inventory</th>',
            '<th class="grp pb-grp" colspan="'+PRICE_BANDS.length+'">Price-band Inventory</th>',
            '<th class="grp" rowspan="2" data-k="none">Source</th>'].join('');
  var row2=CATEGORY_KEYS.map(function(k){ return '<th class="sub cat-col" data-k="cat:'+esc(k)+'">'+esc(k)+'</th>'; }).join('')+
           PRICE_BANDS.map(function(b){ return '<th class="sub pb-col" data-k="pb:'+esc(b.key)+'" title="'+esc(b.label)+'">'+esc(b.short)+'</th>'; }).join('');
  document.getElementById('thead').innerHTML='<tr>'+row1+'</tr><tr>'+row2+'</tr>';
}

function sortValue(s,key){
  if(key.indexOf('cat:')===0){ var ck=key.slice(4); return (s.cat&&s.cat[ck])||0; }
  if(key.indexOf('pb:')===0){ var pk=key.slice(3); return (s.pb&&s.pb[pk])||0; }
  return s[key];
}

function passFilter(s){
  if(cityFilterVal && s.city!==cityFilterVal) return false;
  if(!qFilter) return true;
  var hay=(s.store+' '+s.city+' '+(s.pincode||'')+' '+(s.address||'')).toLowerCase();
  return hay.indexOf(qFilter)!==-1;
}

function renderTable(){
  var rows=STORES.filter(passFilter);
  rows.sort(function(a,b){
    var av=sortValue(a,sortKey), bv=sortValue(b,sortKey);
    if(typeof av==='string'){ av=(av||'').toLowerCase(); bv=(bv||'').toLowerCase(); return sortDir*(av<bv?-1:av>bv?1:0); }
    return sortDir*((av||0)-(bv||0));
  });
  var totalCols=4+CATEGORY_KEYS.length+PRICE_BANDS.length+1;
  var body=rows.map(function(s){
    var noteFlag=s.note?'<div class="note-flag" title="'+esc(s.note)+'">⚠ anomalous count</div>':'';
    var catCells=CATEGORY_KEYS.map(function(k){
      var v=s.cat&&s.cat[k];
      return '<td class="num tnum cat-col">'+(v!=null?fmtInt(v):'<span style="color:var(--muted)">—</span>')+'</td>';
    }).join('');
    var pbCells=PRICE_BANDS.map(function(b){
      var v=s.pb&&s.pb[b.key];
      return '<td class="num tnum pb-col">'+(v!=null?fmtInt(v):'<span style="color:var(--muted)">—</span>')+'</td>';
    }).join('');
    return '<tr>'+
      '<td class="pincode">'+esc(s.pincode||'—')+'</td>'+
      '<td class="store"><b>'+esc(s.store)+'</b><small>'+esc(s.address||'')+'</small>'+noteFlag+'</td>'+
      '<td>'+esc(s.city)+'</td>'+
      '<td class="num tnum">'+fmtInt(s.total)+'</td>'+
      catCells+pbCells+
      '<td><a class="srclink" href="'+esc(s.url)+'" target="_blank" rel="noopener">view ↗</a></td>'+
      '</tr>';
  }).join('');
  document.getElementById('tbody').innerHTML=body||('<tr><td colspan="'+totalCols+'" style="text-align:center;color:var(--muted);padding:20px">No stores match this filter.</td></tr>');
  document.getElementById('rowCount').textContent=rows.length+' of '+STORES.length+' stores shown';
}

function exportCsv(){
  var rows=[['Pincode','Store','City','Address','Total Catalog Items'].concat(CATEGORY_KEYS).concat(PRICE_BANDS.map(function(b){return b.label;})).concat(['Source URL'])];
  STORES.filter(passFilter).forEach(function(s){
    var r=[s.pincode||'',s.store,s.city,s.address||'',s.total];
    CATEGORY_KEYS.forEach(function(k){ r.push((s.cat&&s.cat[k])||''); });
    PRICE_BANDS.forEach(function(b){ r.push((s.pb&&s.pb[b.key])||''); });
    r.push(s.url);
    rows.push(r);
  });
  downloadBlob(csvOf(rows),'caratlane-store-intelligence.csv','text/csv');
}

function wireEvents(){
  document.querySelectorAll('#thead th[data-k]').forEach(function(th){
    th.addEventListener('click',function(){
      var k=th.getAttribute('data-k');
      if(k==='none') return;
      if(sortKey===k){ sortDir*=-1; } else { sortKey=k; sortDir = (k==='store'||k==='city'||k==='pincode')?1:-1; }
      document.querySelectorAll('#thead th[data-k]').forEach(function(t){ t.classList.remove('on'); var a=t.querySelector('.arrow'); if(a)a.remove(); });
      th.classList.add('on');
      th.insertAdjacentHTML('beforeend','<span class="arrow">'+(sortDir===1?'▲':'▼')+'</span>');
      renderTable();
    });
  });
  document.getElementById('q').addEventListener('input',function(e){ qFilter=e.target.value.trim().toLowerCase(); renderTable(); });
  document.getElementById('cityFilter').addEventListener('change',function(e){ cityFilterVal=e.target.value; renderTable(); });
  document.getElementById('exportBtn').addEventListener('click',exportCsv);
  document.getElementById('themeBtn').addEventListener('click',function(){
    document.body.classList.toggle('light');
    try{ localStorage.setItem('caratlane_intel_theme', document.body.classList.contains('light')?'light':'dark'); }catch(e){}
  });
}

function init(){
  try{ if(localStorage.getItem('caratlane_intel_theme')==='light') document.body.classList.add('light'); }catch(e){}
  buildKpis();
  buildCatChart();
  buildPbChart();
  buildCityChart();
  buildTableHead();
  wireEvents();
  renderTable();
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
