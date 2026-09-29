"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   GA4 SKU Intelligence — Lucira Jewelry
   For every SKU with GA4 activity: GA4 performance, total historical sales,
   current inventory availability, and exactly where that inventory sits.

   Sources (BigQuery, project lucirajewelry-prod):
     ga4_data.ga4_data                         — GA4 demand (all-time), SKU grain
     ds_imputed_reporting.marketing_sale       — actual sales, SKU + store grain
     ds_imputed_reporting.Live_inventory       — current stock, SKU + store grain

   DELIBERATELY NO SCORING. No demand/opportunity/risk/transfer score, no
   weighted priority engine. Every field is a real, named metric: PDP Views,
   ATC, ATC% (=ATC/PDP*100), Checkout, Total Sale (units), Total Inventory
   (units), Store, Qty, Stock Age (days).
   ══════════════════════════════════════════════════════════════════════════ */
const CONFIG = {
  SKU_SNAPSHOT_BASE: "https://storage.googleapis.com/lucirajewelry-prod-dashboards/ga4-sku-intelligence/sku-daily-",
  CITY_SNAPSHOT_BASE: "https://storage.googleapis.com/lucirajewelry-prod-dashboards/ga4-sku-intelligence/city-daily-",
  CITY_STYLE_SNAPSHOT_BASE: "https://storage.googleapis.com/lucirajewelry-prod-dashboards/ga4-sku-intelligence/city-style-daily-",
  AI_BASE: "https://ga4-sku-ai-385594025448.asia-south1.run.app"
};
(function(){
  const q = new URLSearchParams(location.search);
  const w = window.__GSI_CONFIG__ || {};
  CONFIG.SKU_SNAPSHOT_BASE = q.get("base") || w.SKU_SNAPSHOT_BASE || CONFIG.SKU_SNAPSHOT_BASE;
  CONFIG.CITY_SNAPSHOT_BASE = q.get("citybase") || w.CITY_SNAPSHOT_BASE || CONFIG.CITY_SNAPSHOT_BASE;
  CONFIG.CITY_STYLE_SNAPSHOT_BASE = q.get("citystylebase") || w.CITY_STYLE_SNAPSHOT_BASE || CONFIG.CITY_STYLE_SNAPSHOT_BASE;
  CONFIG.AI_BASE = q.get("aibase") || w.AI_BASE || CONFIG.AI_BASE;
})();

/* ── helpers ────────────────────────────────────────────────────────────── */
const $ = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>[...r.querySelectorAll(s)];
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const n=v=>{ if(v==null||v==="") return 0; const x=typeof v==="number"?v:parseFloat(v); return Number.isFinite(x)?x:0; };
const money=v=>{v=n(v);const s=v<0?"-":"";v=Math.abs(v);
  if(v>=1e7)return s+"₹"+(v/1e7).toFixed(2)+" Cr";
  if(v>=1e5)return s+"₹"+(v/1e5).toFixed(2)+" L";
  if(v>=1e3)return s+"₹"+(v/1e3).toFixed(1)+"K";
  return s+"₹"+Math.round(v);};
const int=v=>n(v).toLocaleString("en-IN",{maximumFractionDigits:0});
const dec=(v,d=1)=>n(v).toLocaleString("en-IN",{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=(v,d=2)=>dec(n(v),d)+"%";
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/* ── state ──────────────────────────────────────────────────────────────── */
const STATE = { skus:[], cities:[], cityStyle:[], cityStyleLoading:true, live:false, filters:{}, tab:"skus", sort:{}, page:{}, search:"", drillSku:"",
  asOfDate:null, range:{preset:"all", from:null, to:null}, ai:{log:[], busy:false} };

/* ── ingest one raw NDJSON row ─────────────────────────────────────────────*/
function ingestSku(r){
  const s = {
    sku:r.sku, title:r.title||r.sku, category:r.category||"Unclassified", subcat1:r.subcat1||"—", subcat2:r.subcat2||"—",
    gender:r.gender||"—", price:n(r.price), priceRange:r.priceRange||"—",
    pdpViews:n(r.pdpViews), atc:n(r.atc), atcPct:n(r.atcPct), checkout:n(r.checkout), lastSeen:r.lastSeen||null,
    plpImpressions:n(r.plpImpressions), plpClick:n(r.plpClick), addToWishlist:n(r.addToWishlist), removeFromCart:n(r.removeFromCart),
    totalSale:n(r.totalSale), totalNetSale:n(r.totalNetSale),
    totalInventory:n(r.totalInventory), availability:r.availability||"NOT FOUND",
    oldestAgeOverall:(r.oldestAgeOverall!=null)?n(r.oldestAgeOverall):null,
    storeInventory:(r.storeInventory||[]).map(x=>({store:x.store,qty:n(x.qty),oldestAge:n(x.oldestAge)})),
    storeBreakdown:(r.storeBreakdown||[]).map(x=>({store:x.store,saleCount:n(x.saleCount),qty:n(x.qty),
      oldestAge:(x.oldestAge!=null)?n(x.oldestAge):null,status:x.status||"OUT OF STOCK"})),
    daily:(r.daily||[]).map(x=>({d:x.d,pdp:n(x.pdp),atc:n(x.atc),chk:n(x.chk),plpImp:n(x.plpImp),plpClick:n(x.plpClick),wish:n(x.wish),rfc:n(x.rfc)})),
    allTime:{ pdpViews:n(r.pdpViews), atc:n(r.atc), atcPct:n(r.atcPct), checkout:n(r.checkout),
      plpImpressions:n(r.plpImpressions), plpClick:n(r.plpClick), addToWishlist:n(r.addToWishlist), removeFromCart:n(r.removeFromCart) }
  };
  if(r.asOfDate && (!STATE.asOfDate || r.asOfDate > STATE.asOfDate)) STATE.asOfDate = r.asOfDate;
  s.onlineSale = s.storeBreakdown.filter(x=>x.store==="HO").reduce((sum,x)=>sum+x.saleCount,0);
  s.storeSale = s.storeBreakdown.filter(x=>x.store!=="HO").reduce((sum,x)=>sum+x.saleCount,0);
  s.storeWiseInventory = s.storeInventory.length
    ? s.storeInventory.map(x=>`${x.store}-${x.qty}-${x.oldestAge}`).join(" | ")
    : "No Stock";
  return s;
}
function ingestCity(r){
  const c = {
    city:r.city, skuCount:n(r.skuCount), sessions:n(r.sessions), pdpViews:n(r.pdpViews), atc:n(r.atc), checkout:n(r.checkout),
    plpImpressions:n(r.plpImpressions), plpClick:n(r.plpClick), addToWishlist:n(r.addToWishlist), removeFromCart:n(r.removeFromCart)
  };
  c.atcPct = c.pdpViews ? c.atc/c.pdpViews*100 : 0;
  return c;
}
function ingestCityStyle(r){
  return {
    city:r.city, styleCode:r.style_code,
    pdpViews:n(r.pdpViews), atc:n(r.atc), checkout:n(r.checkout),
    plpImpressions:n(r.plpImpressions), plpClick:n(r.plpClick),
    addToWishlist:n(r.addToWishlist), removeFromCart:n(r.removeFromCart)
  };
}

/* ── deterministic sample (offline fallback) ──────────────────────────────*/
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const SAMPLE_CITIES=["Mumbai","Pune","Delhi","Bengaluru","Hyderabad","Ahmedabad","Kolkata","Chennai","Jaipur","Surat"];
function buildSample(){
  const rnd=mulberry32(20260901); const pick=a=>a[Math.floor(rnd()*a.length)];
  const cats=["Rings","Earrings","Necklaces","Bracelets","Pendants"];
  const stores=["HO","PN1","CS1","BO1","N18","FCS","PV1","LPN"];
  const genders=["Women","Men","Unisex"];
  const priceRanges=["0 to 10k","10k to 20k","20k to 40k","40k to 50k","50k to 75k","75k to 100k"];
  const rows=[];
  for(let i=0;i<150;i++){
    const pdpViews=Math.round(rnd()<0.6?rnd()*500:500+rnd()*8000);
    const atcPct=0.3+rnd()*5; const atc=Math.round(pdpViews*atcPct/100);
    const checkout=Math.round(atc*(0.2+rnd()*0.4));
    const plpImpressions=Math.round(pdpViews*(3+rnd()*4));
    const plpClick=Math.round(pdpViews*(1.1+rnd()*0.4));
    const addToWishlist=Math.round(pdpViews*0.01*rnd());
    const removeFromCart=Math.round(atc*0.15*rnd());
    const totalSale=rnd()<0.5?0:Math.round(rnd()*40);
    const hasInv=rnd()<0.4;
    const daily=[]; const asOf="2026-08-22";
    for(let d=59;d>=0;d--){
      if(rnd()<0.7) continue; // sparse, like the real data
      const date=shiftDate(asOf,d);
      const dp=Math.round(pdpViews/40*(0.3+rnd()*1.4));
      daily.push({d:date, pdp:dp, atc:Math.round(dp*atcPct/100), chk:Math.round(dp*atcPct/100*0.3),
        plpImp:Math.round(dp*3.5), plpClick:Math.round(dp*1.2), wish:rnd()<0.1?1:0, rfc:rnd()<0.1?1:0});
    }
    const storeInventory=[]; const storeBreakdown=[];
    if(hasInv){
      const nStores=1+Math.floor(rnd()*2);
      const used=new Set();
      for(let j=0;j<nStores;j++){ const st=pick(stores); if(used.has(st))continue; used.add(st);
        storeInventory.push({store:st,qty:1+Math.floor(rnd()*3),oldestAge:Math.round(rnd()*300)}); }
    }
    storeInventory.forEach(si=>storeBreakdown.push({store:si.store,saleCount:Math.round(rnd()*5),qty:si.qty,oldestAge:si.oldestAge,status:"AVAILABLE"}));
    if(totalSale>0 && rnd()<0.4){ const st=pick(stores); if(!storeBreakdown.some(b=>b.store===st)) storeBreakdown.push({store:st,saleCount:1+Math.floor(rnd()*4),qty:0,oldestAge:null,status:"OUT OF STOCK"}); }
    const totalInventory=storeInventory.reduce((s,x)=>s+x.qty,0);
    rows.push(ingestSku({
      sku:"LJ-SMP"+(1000+i), title:pick(cats).slice(0,-1)+" Sample "+i, category:pick(cats), subcat1:"—",
      gender:pick(genders), price:Math.round((3000+rnd()*90000)/100)*100, priceRange:pick(priceRanges),
      pdpViews, atc, atcPct, checkout, lastSeen:"2026-08-30",
      plpImpressions, plpClick, addToWishlist, removeFromCart,
      totalSale, totalNetSale:totalSale*5000,
      totalInventory, availability: totalInventory>0?"AVAILABLE":(rnd()<0.5?"OUT OF STOCK":"NOT FOUND"),
      oldestAgeOverall: storeInventory.length?Math.max(...storeInventory.map(x=>x.oldestAge)):null,
      storeInventory, storeBreakdown, daily, asOfDate:asOf
    }));
  }
  return rows;
}
function buildSampleCities(){
  const rnd=mulberry32(20260902);
  return SAMPLE_CITIES.map(city=>{
    const sessions=Math.round(50000+rnd()*400000);
    const pdpViews=Math.round(sessions*(0.15+rnd()*0.1));
    const atc=Math.round(pdpViews*(0.02+rnd()*0.03));
    return ingestCity({
      city, sessions, pdpViews, atc, checkout:Math.round(atc*0.4),
      plpImpressions:Math.round(pdpViews*4), plpClick:Math.round(pdpViews*1.2),
      addToWishlist:Math.round(pdpViews*0.008), removeFromCart:Math.round(atc*0.12),
      skuCount:Math.round(500+rnd()*3000)
    });
  }).sort((a,b)=>b.sessions-a.sessions);
}

/* ── boot: fetch every export shard until a confirmed 404 ─────────────────
   A 404 means "this shard index doesn't exist" — genuine end of data.
   Any other failure (timeout, connection reset, 5xx) is a transient network
   error, not an end-of-data signal, so it's retried; if still failing after
   retries the whole fetch aborts rather than silently returning a truncated
   dataset as if it were complete. */
const BOOT_TS = Date.now(); // busts GCS/CDN edge caching (per-object Cache-Control survives client "no-store"); one fresh value per page load
function shardUrl(base,i){ return base + String(i).padStart(12,"0") + ".json?v=" + BOOT_TS; }
async function fetchShard(url,retries=3){
  for(let attempt=0;attempt<=retries;attempt++){
    try{
      const res=await fetch(url,{cache:"no-store"});
      if(res.status===404) return {kind:"missing"};
      if(!res.ok) throw new Error("HTTP "+res.status);
      return {kind:"ok",text:await res.text()};
    }catch(e){
      if(attempt===retries) return {kind:"error",error:e};
      await new Promise(r=>setTimeout(r,300*(attempt+1)));
    }
  }
}
async function fetchAllShards(base){
  const BATCH=20; // shards are fetched BATCH-at-a-time in parallel instead of one round-trip at a time
  const all=[]; let i=0, done=false;
  while(!done && i<600){
    const batch=Array.from({length:BATCH},(_,b)=>i+b);
    const results=await Promise.all(batch.map(idx=>fetchShard(shardUrl(base,idx))));
    for(const r of results){
      if(r.kind==="missing"){ done=true; break; }
      if(r.kind==="error") throw new Error("Network error fetching a data shard from "+base+" after retries — aborting rather than showing an incomplete dataset. "+(r.error&&r.error.message||""));
      r.text.split("\n").filter(Boolean).forEach(l=>all.push(JSON.parse(l)));
    }
    i+=BATCH;
  }
  if(!all.length) throw new Error("No snapshot shards reachable at "+base);
  return all;
}
async function boot(){
  STATE.skus = buildSample(); STATE.cities = buildSampleCities(); STATE.live=false; STATE.cityStyleLoading=true;
  $("#statusDot").className="dot demo"; $("#statusText").textContent="Sample data — loading live snapshot…";
  buildFilterUI(); buildNav(); render(); initAiWidget();
  try{
    const [skuRows,cityRows] = await Promise.all([
      fetchAllShards(CONFIG.SKU_SNAPSHOT_BASE),
      fetchAllShards(CONFIG.CITY_SNAPSHOT_BASE).catch(e=>{ console.warn("City snapshot unreachable, keeping sample cities.",e); return null; })
    ]);
    STATE.skus = skuRows.map(ingestSku);
    if(cityRows) STATE.cities = cityRows.map(ingestCity);
    STATE.live=true;
    $("#statusDot").className="dot"; $("#statusText").textContent=`Live BigQuery snapshot · ${int(STATE.skus.length)} GA4 SKUs · sales & inventory joined`;
    if(STATE.asOfDate){
      const minD=shiftDate(STATE.asOfDate,59);
      [$("#rangeFrom"),$("#rangeTo")].forEach(inp=>{ if(inp){ inp.min=minD; inp.max=STATE.asOfDate; } });
    }
    buildFilterUI(); buildNav(); updateRangeNote(); render();
  }catch(e){
    console.warn("Snapshot load failed, staying on sample.", e);
    $("#statusDot").className="dot demo"; $("#statusText").textContent="Sample data (snapshot unreachable)";
  }
  // City x Style is the single largest snapshot (~11MB) and only feeds the City Wise
  // table inside Inventory Availability Analysis — load it after everything else so
  // it never blocks the main "live" status or any other tab.
  fetchAllShards(CONFIG.CITY_STYLE_SNAPSHOT_BASE)
    .then(rows=>{ STATE.cityStyle = rows.map(ingestCityStyle); })
    .catch(e=>{ console.warn("City x Style snapshot unreachable — City Wise inventory analysis will be empty.",e); })
    .finally(()=>{ STATE.cityStyleLoading=false; if(STATE.tab==="overview") render(); });
}

/* ── pills ──────────────────────────────────────────────────────────────── */
function pillAvail(a){const cls=a==="AVAILABLE"?"good":a==="OUT OF STOCK"?"warn":"crit";return `<span class="pill ${cls}">${esc(a)}</span>`;}
function pillStatus(s){return `<span class="pill ${s==="AVAILABLE"?"good":"warn"}">${esc(s)}</span>`;}

/* ── filters ────────────────────────────────────────────────────────────── */
const FILTER_DEFS=[
  {k:"category",label:"Category",type:"select",col:"category"},
  {k:"subcat1",label:"Sub Category",type:"select",col:"subcat1"},
  {k:"priceRange",label:"Price Range",type:"select",col:"priceRange"},
  {k:"gender",label:"Gender",type:"select",col:"gender"},
  {k:"availability",label:"Availability",type:"select",col:"availability"},
  {k:"store",label:"Store",type:"storeselect"},
  {k:"lastSeenMin",label:"Last GA4 Activity On/After",type:"date"},
];
function uniq(col){return [...new Set(STATE.skus.map(x=>x[col]).filter(v=>v!=null&&v!==""&&v!=="—"))].sort();}
function allStoreCodes(){const set=new Set();STATE.skus.forEach(s=>{s.storeInventory.forEach(x=>set.add(x.store));s.storeBreakdown.forEach(x=>set.add(x.store));});return [...set].sort();}
function buildFilterUI(){
  const F=STATE.filters, host=$("#fbody"); host.innerHTML="";
  FILTER_DEFS.forEach(d=>{
    const el=document.createElement("div"); el.className="fgrp";
    if(d.type==="select"){
      const opts=["<option value=''>All</option>"].concat(uniq(d.col).map(v=>`<option>${esc(v)}</option>`)).join("");
      el.innerHTML=`<label>${d.label}</label><select data-fk="${d.k}">${opts}</select>`;
      $("select",el).onchange=e=>{F[d.k]=e.target.value;applyFilters();};
    }else if(d.type==="storeselect"){
      const opts=["<option value=''>All</option>"].concat(allStoreCodes().map(v=>`<option>${esc(v)}</option>`)).join("");
      el.innerHTML=`<label>${d.label}</label><select data-fk="${d.k}">${opts}</select>`;
      $("select",el).onchange=e=>{F[d.k]=e.target.value;applyFilters();};
    }else if(d.type==="date"){
      el.innerHTML=`<label>${d.label}</label><input type="date" data-fk="${d.k}">`;
      $("input",el).oninput=e=>{F[d.k]=e.target.value||null;applyFilters();};
    }
    host.appendChild(el);
  });
}
function passes(it){
  const F=STATE.filters;
  for(const d of FILTER_DEFS){
    if(d.type==="select"&&F[d.k]&&it[d.col]!==F[d.k])return false;
    if(d.type==="storeselect"&&F[d.k]&&!it.storeInventory.some(x=>x.store===F[d.k])&&!it.storeBreakdown.some(x=>x.store===F[d.k]))return false;
  }
  if(F.lastSeenMin && (!it.lastSeen || it.lastSeen<F.lastSeenMin)) return false;
  if(STATE.search){const hay=(it.sku+" "+it.title).toLowerCase(); if(!hay.includes(STATE.search.toLowerCase())) return false;}
  return true;
}
function filtered(){return STATE.skus.filter(passes);}

/* ── GA4 date range (Today/Yesterday/Weekly/Monthly/Custom/All Time) ──────
   Sales (Total Sale) and Inventory (Total Inventory/Availability/Store data)
   are current-state / all-time facts and are NEVER affected by this range —
   only GA4 activity metrics (PDP Views, ATC, ATC%, Checkout, PLP, Wishlist,
   Remove From Cart) get re-summed from the per-SKU daily array. Day-level
   data only exists for the last 60 days from asOfDate; older custom ranges
   fall back to whatever days are actually present (0, not invented). */
function shiftDate(dateStr,days){
  const d=new Date(dateStr+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()-days);
  return d.toISOString().slice(0,10);
}
function getRangeDates(){
  const r=STATE.range, asOf=STATE.asOfDate;
  if(r.preset==="all"||!asOf) return null;
  switch(r.preset){
    case "today": return {from:asOf, to:asOf};
    case "yesterday": { const y=shiftDate(asOf,1); return {from:y, to:y}; }
    case "weekly": return {from:shiftDate(asOf,6), to:asOf};
    case "monthly": return {from:shiftDate(asOf,29), to:asOf};
    case "custom": return {from:r.from||shiftDate(asOf,6), to:r.to||asOf};
    default: return null;
  }
}
function sumDaily(s,from,to){
  let pdp=0,atc=0,chk=0,plpImp=0,plpClick=0,wish=0,rfc=0;
  (s.daily||[]).forEach(d=>{ if(d.d>=from && d.d<=to){ pdp+=d.pdp; atc+=d.atc; chk+=d.chk; plpImp+=d.plpImp; plpClick+=d.plpClick; wish+=d.wish; rfc+=d.rfc; } });
  return { pdpViews:pdp, atc, checkout:chk, plpImpressions:plpImp, plpClick, addToWishlist:wish, removeFromCart:rfc, atcPct: pdp? atc/pdp*100:0 };
}
function applyRange(items){
  const rd=getRangeDates();
  if(!rd) return items;
  return items.map(s=>({...s, ...sumDaily(s,rd.from,rd.to)}));
}
function rangeLabel(){
  const r=STATE.range;
  if(r.preset==="all") return "All-time";
  const rd=getRangeDates(); if(!rd) return "All-time";
  return rd.from===rd.to? rd.from : `${rd.from} to ${rd.to}`;
}
function activeFilterCount(){let c=0;const F=STATE.filters;for(const k in F){if(F[k]!=null&&F[k]!=="")c++;}return c;}
function applyFilters(){$("#filterCount").textContent=activeFilterCount()?activeFilterCount()+" active":"";render();}
function clearAllFilters(){STATE.filters={};STATE.search="";$("#globalSearch").value="";buildFilterUI();applyFilters();}

/* ── generic sortable/paginated table ─────────────────────────────────────*/
function sortRows(rows,key,dir){return [...rows].sort((a,b)=>{const av=a[key],bv=b[key];
  if(typeof av==="string"||typeof bv==="string") return dir*String(av??"").localeCompare(String(bv??""));
  return dir*((n(av))-(n(bv)));});}
function renderInteractiveTable(host,rows,cols,storeKey,pageSize=40,sortable=true){
  if(!sortable) STATE.sort[storeKey]={k:"order",dir:1};
  else if(!STATE.sort[storeKey]) STATE.sort[storeKey]={k:cols[0].k,dir:-1};
  if(!STATE.page[storeKey]) STATE.page[storeKey]=1;
  const srt=STATE.sort[storeKey];
  const sorted=sortRows(rows,srt.k,srt.dir);
  const totalPages=Math.max(1,Math.ceil(sorted.length/pageSize));
  STATE.page[storeKey]=clamp(STATE.page[storeKey],1,totalPages);
  const pageRows=sorted.slice((STATE.page[storeKey]-1)*pageSize,STATE.page[storeKey]*pageSize);
  host.innerHTML=`<div class="tbl-wrap"><table><thead><tr>${cols.map(c=>`<th${sortable?` data-k="${c.k}"`:""}>${esc(c.label)}${sortable&&srt.k===c.k?(srt.dir===1?' ▲':' ▼'):''}</th>`).join("")}</tr></thead>
    <tbody>${pageRows.map(r=>`<tr>${cols.map(c=>`<td>${c.render?c.render(r):esc(r[c.k]??"")}</td>`).join("")}</tr>`).join("")||`<tr><td colspan="${cols.length}" class="muted">No rows match under current filters.</td></tr>`}</tbody></table></div>
    <div class="pager"><span>${int(sorted.length)} rows</span><button data-pg="prev">‹ Prev</button><span>Page ${STATE.page[storeKey]} / ${totalPages}</span><button data-pg="next">Next ›</button></div>`;
  if(sortable) $$("th",host).forEach(th=>th.onclick=()=>{const k=th.dataset.k;if(srt.k===k)srt.dir*=-1;else{srt.k=k;srt.dir=-1;}STATE.page[storeKey]=1;renderInteractiveTable(host,rows,cols,storeKey,pageSize,sortable);});
  const prev=host.querySelector('[data-pg="prev"]'),next=host.querySelector('[data-pg="next"]');
  if(prev)prev.onclick=()=>{if(STATE.page[storeKey]>1){STATE.page[storeKey]--;renderInteractiveTable(host,rows,cols,storeKey,pageSize,sortable);}};
  if(next)next.onclick=()=>{if(STATE.page[storeKey]<totalPages){STATE.page[storeKey]++;renderInteractiveTable(host,rows,cols,storeKey,pageSize,sortable);}};
}
function kpiCard(label,val,cls="",foot=""){
  return `<div class="card kpi"><div class="lbl">${esc(label)}</div><div class="val ${cls}">${val}</div>${foot?`<div class="foot" style="font-size:11.5px;color:var(--ink-2);margin-top:5px">${esc(foot)}</div>`:""}</div>`;
}

/* ── rollups ────────────────────────────────────────────────────────────── */
function rollupKPIs(items){
  return {
    total: items.length,
    available: items.filter(x=>x.availability==="AVAILABLE").length,
    notAvailable: items.filter(x=>x.availability!=="AVAILABLE").length,
    totalSales: items.reduce((s,x)=>s+x.totalSale,0),
    pdpNoSale: items.filter(x=>x.pdpViews>0&&x.totalSale===0).length,
    demandNoInv: items.filter(x=>x.pdpViews>0&&x.atc>0&&x.totalInventory===0).length,
  };
}
function flattenStoreBreakdown(items){
  const rows=[];
  items.forEach(s=>s.storeBreakdown.forEach(b=>rows.push({sku:s.sku,title:s.title,store:b.store,saleCount:b.saleCount,qty:b.qty,oldestAge:b.oldestAge,status:b.status})));
  return rows;
}
function rollupStores(items){
  const m=new Map();
  items.forEach(s=>s.storeBreakdown.forEach(b=>{
    if(!m.has(b.store)) m.set(b.store,{store:b.store,skuSet:new Set(),totalSales:0,totalInventory:0});
    const g=m.get(b.store); g.skuSet.add(s.sku); g.totalSales+=b.saleCount; g.totalInventory+=b.qty;
  }));
  return [...m.values()].map(g=>({store:g.store,skuCount:g.skuSet.size,totalSales:g.totalSales,totalInventory:g.totalInventory})).sort((a,b)=>b.totalInventory-a.totalInventory);
}
function rollupByDim(items,col){
  const m=new Map();
  items.forEach(s=>{
    const key=s[col]||"—";
    if(!m.has(key)) m.set(key,{key,skuCount:0,available:0,pdpViews:0,atc:0,checkout:0,totalSale:0,totalInventory:0});
    const g=m.get(key);
    g.skuCount++; if(s.availability==="AVAILABLE") g.available++;
    g.pdpViews+=s.pdpViews; g.atc+=s.atc; g.checkout+=s.checkout; g.totalSale+=s.totalSale; g.totalInventory+=s.totalInventory;
  });
  return [...m.values()].map(g=>({...g,atcPct:g.pdpViews?g.atc/g.pdpViews*100:0,availPct:g.skuCount?g.available/g.skuCount*100:0}))
    .sort((a,b)=>b.pdpViews-a.pdpViews);
}
function rollupFunnel(items){
  const sum=k=>items.reduce((s,x)=>s+n(x[k]),0);
  const plpImpressions=sum("plpImpressions"), plpClick=sum("plpClick"), pdpViews=sum("pdpViews"),
    atc=sum("atc"), addToWishlist=sum("addToWishlist"), removeFromCart=sum("removeFromCart"), checkout=sum("checkout");
  return {
    plpImpressions, plpClick, plpToPdp: plpClick?pdpViews/plpClick*100:0,
    pdpViews, atc, atcToPdp: pdpViews?atc/pdpViews*100:0,
    addToWishlist, removeFromCart, checkout, atcToCheckout: atc?checkout/atc*100:0
  };
}

/* ── column sets ───────────────────────────────────────────────────────── */
const SKU_COLS=[
  {k:"sku",label:"SKU",render:r=>`<b>${esc(r.sku)}</b>`},
  {k:"title",label:"Product",render:r=>esc(r.title)},
  {k:"pdpViews",label:"PDP Views",render:r=>int(r.pdpViews)},
  {k:"atc",label:"ATC",render:r=>int(r.atc)},
  {k:"atcPct",label:"ATC %",render:r=>pct(r.atcPct)},
  {k:"checkout",label:"Checkout",render:r=>int(r.checkout)},
  {k:"totalSale",label:"Total Sale",render:r=>int(r.totalSale)},
  {k:"onlineSale",label:"Online Sale",render:r=>int(r.onlineSale)},
  {k:"storeSale",label:"Store Sale",render:r=>int(r.storeSale)},
  {k:"availability",label:"Availability",render:r=>pillAvail(r.availability)},
  {k:"totalInventory",label:"Total Inventory",render:r=>int(r.totalInventory)},
  {k:"storeWiseInventory",label:"Store-wise Inventory",render:r=>`<span style="font-family:var(--mono);font-size:11px">${esc(r.storeWiseInventory)}</span>`},
];
const STORE_DETAIL_COLS=[
  {k:"sku",label:"SKU",render:r=>`<b>${esc(r.sku)}</b>`},
  {k:"title",label:"Product",render:r=>esc(r.title)},
  {k:"store",label:"Store"},
  {k:"saleCount",label:"Sale Count",render:r=>int(r.saleCount)},
  {k:"qty",label:"Current Qty",render:r=>int(r.qty)},
  {k:"oldestAge",label:"Stock Age",render:r=>r.oldestAge!=null?int(r.oldestAge):"—"},
  {k:"status",label:"Status",render:r=>pillStatus(r.status)},
];
const PROBLEM1_COLS=[
  {k:"sku",label:"SKU",render:r=>`<b>${esc(r.sku)}</b>`},{k:"title",label:"Product"},
  {k:"pdpViews",label:"PDP Views",render:r=>int(r.pdpViews)},{k:"atc",label:"ATC",render:r=>int(r.atc)},
  {k:"atcPct",label:"ATC %",render:r=>pct(r.atcPct)},{k:"checkout",label:"Checkout",render:r=>int(r.checkout)},
  {k:"totalSale",label:"Total Sale",render:r=>int(r.totalSale)},{k:"availability",label:"Availability",render:r=>pillAvail(r.availability)},
];

/* ── TABS ───────────────────────────────────────────────────────────────── */
const TABS=[
  {k:"overview",label:"Overview"},
  {k:"style",label:"Style Performance"},
  {k:"skus",label:"SKU Performance"},
  {k:"category",label:"Category Detail"},
  {k:"city",label:"City Detail"},
  {k:"stores",label:"Store Performance"},
  {k:"problems",label:"Problem SKUs"},
  {k:"drilldown",label:"SKU Detail"},
  {k:"logic",label:"How It Works"}
];
function buildNav(){
  $("#nav").innerHTML=TABS.map(t=>`<a data-tab="${t.k}" class="${t.k===STATE.tab?"on":""}">${t.label}</a>`).join("");
  $("#pages").innerHTML=TABS.map(t=>`<section class="page ${t.k===STATE.tab?"on":""}" data-page="${t.k}"></section>`).join("");
  $$("#nav a").forEach(a=>a.onclick=()=>gotoTab(a.dataset.tab));
  const hash=location.hash.replace("#","");
  if(hash&&TABS.some(t=>t.k===hash)) gotoTab(hash,true);
}
function gotoTab(tab,skipHash){
  STATE.tab=tab; if(!skipHash) location.hash=tab;
  $$("#nav a").forEach(x=>x.classList.toggle("on",x.dataset.tab===tab));
  $$(".page").forEach(p=>p.classList.toggle("on",p.dataset.page===tab));
  render();
}
function render(){
  const items=applyRange(filtered()); const k=rollupKPIs(items);
  const el=$(`.page[data-page="${STATE.tab}"]`); if(!el)return;
  try{
    ({overview:renderOverview,style:renderStyle,skus:renderSkus,category:renderCategoryDetail,city:renderCityDetail,stores:renderStores,problems:renderProblems,drilldown:renderDrilldown,logic:renderLogic}[STATE.tab]||(()=>{}))(el,items,k);
  }catch(e){ el.innerHTML=`<div class="card"><h3>⚠ Render error</h3><p class="muted">${esc(e.message)}</p></div>`; console.error(e); }
  $$("[data-goto]",el).forEach(c=>c.onclick=()=>gotoTab(c.dataset.goto));
}

/* ── OVERVIEW — exactly 6 KPIs + the GA4 funnel, per spec ─────────────────*/
function renderFunnelSection(f){
  const maxVol=Math.max(f.plpImpressions,f.plpClick,f.pdpViews,f.atc,f.addToWishlist,f.removeFromCart,f.checkout,1);
  const bar=(label,val)=>`<div class="funnel-row"><div class="nm">${esc(label)}</div><div class="bar"><span style="width:${clamp(val/maxVol*100,0,100)}%"></span></div><div class="amt">${int(val)}</div></div>`;
  const ratio=(label,val)=>`<div class="funnel-ratio"><span>${esc(label)}</span><b>${pct(val)}</b></div>`;
  return `<div class="card" style="margin-bottom:14px"><h3>GA4 Funnel</h3>
    ${bar("PLP Impressions",f.plpImpressions)}
    ${bar("PLP Click",f.plpClick)}
    ${ratio("PLP to PDP",f.plpToPdp)}
    ${bar("PDP Views",f.pdpViews)}
    ${bar("Add to Cart",f.atc)}
    ${ratio("ATC to PDP Ratio",f.atcToPdp)}
    ${bar("Add to Wishlist",f.addToWishlist)}
    ${bar("Remove From Cart",f.removeFromCart)}
    ${bar("Begin Checkout",f.checkout)}
    ${ratio("ATC to Checkout Ratio",f.atcToCheckout)}
  </div>`;
}
function renderOverview(el,items,k){
  const f=rollupFunnel(items);
  el.innerHTML=`
   <div class="h2">GA4 PDP × ATC × Inventory</div>
   <div class="sub">GA4 performance, total sales, current stock, and where it's sitting — for every SKU with GA4 activity.</div>
   <div class="grid kpis" style="margin-bottom:14px">
     ${kpiCard("Total GA4 SKUs",int(k.total))}
     ${kpiCard("Available SKUs",int(k.available),"good")}
     ${kpiCard("Out of Stock / Not Found",int(k.notAvailable),"crit")}
     ${kpiCard("Total Sales (units, all-time)",int(k.totalSales))}
     ${kpiCard("PDP Views but Zero Sales",int(k.pdpNoSale),"warn")}
     ${kpiCard("PDP + ATC but Zero Inventory",int(k.demandNoInv),"crit")}
   </div>
   ${renderFunnelSection(f)}
   <div class="note">No demand score, opportunity score, or priority engine here — every number above is a direct count from the data. GA4 metrics are all-time totals (no date window applied). "Total Sale" = units sold, from marketing_sale. "Out of Stock / Not Found" combines SKUs with a zero-inventory record and SKUs that don't appear in Live_inventory at all — see the SKU Performance tab's Availability column for the distinction.</div>`;
  renderInventoryAvailabilitySection(el,items);
}

/* ── INVENTORY AVAILABILITY ANALYSIS — Style/Category/Price Band/City,
   split by whether the underlying Style currently has inventory (>0) or
   not. Grain is always Style (never SKU variant) — every KPI is summed
   from the same Style rollup used by the Style Performance tab, so there
   is exactly one inventory-availability classification per Style, decided
   once, before any KPI aggregation (no double counting, no per-variant
   splitting). ATC % is recomputed from summed totals (never averaged) and
   its Available%/Not Available% share cells are intentionally left blank
   — a "% of ATC%" number would be meaningless. Lives entirely on the
   Overview tab — no new tab, no new page. ────────────────────────────── */
const INVENTORY_KPI_DEFS=[
  {k:"styleCount",label:"Style Count",isCount:true},
  {k:"pdpViews",label:"PDP Views"},
  {k:"atc",label:"ATC"},
  {k:"atcPct",label:"ATC %",isRatio:true,numK:"atc",denK:"pdpViews"},
  {k:"checkout",label:"Checkout"},
  {k:"plpImpressions",label:"PLP Impressions"},
  {k:"plpClick",label:"PLP Click"},
  {k:"addToWishlist",label:"Add to Wishlist"},
  {k:"removeFromCart",label:"Remove From Cart"},
  {k:"totalSale",label:"Total Sale",isSale:true},
  {k:"onlineSale",label:"Online Sale",isSale:true},
  {k:"storeSale",label:"Store Sale",isSale:true},
];
function computeInventoryKpiRows(rows,{includeSales=true}={}){
  const avail=rows.filter(r=>r.inventoryAvailable);
  const notAvail=rows.filter(r=>!r.inventoryAvailable);
  const sum=(arr,k)=>arr.reduce((s,x)=>s+n(x[k]),0);
  return INVENTORY_KPI_DEFS.filter(d=>includeSales||!d.isSale).map((d,kpiOrder)=>{
    if(d.isCount){
      const total=rows.length, a=avail.length, na=notAvail.length;
      return {kpi:d.label,kpiOrder,total,avail:a,notAvail:na,availPct:total?a/total*100:null,notAvailPct:total?na/total*100:null,isRatio:false};
    }
    if(d.isRatio){
      const tNum=sum(rows,d.numK), tDen=sum(rows,d.denK);
      const aNum=sum(avail,d.numK), aDen=sum(avail,d.denK);
      const naNum=sum(notAvail,d.numK), naDen=sum(notAvail,d.denK);
      return {kpi:d.label,kpiOrder,total:tDen?tNum/tDen*100:0,avail:aDen?aNum/aDen*100:0,notAvail:naDen?naNum/naDen*100:0,availPct:null,notAvailPct:null,isRatio:true};
    }
    const total=sum(rows,d.k), a=sum(avail,d.k), na=sum(notAvail,d.k);
    return {kpi:d.label,kpiOrder,total,avail:a,notAvail:na,availPct:total?a/total*100:null,notAvailPct:total?na/total*100:null,isRatio:false};
  });
}
const INV_ANALYSIS_COLS=[
  {k:"dimension",label:"Dimension",render:r=>`<b>${esc(r.dimension)}</b>`},
  {k:"kpi",label:"KPI",render:r=>esc(r.kpi)},
  {k:"total",label:"Total",render:r=>r.isRatio?pct(r.total):int(r.total)},
  {k:"avail",label:"Inventory Available",render:r=>r.isRatio?pct(r.avail):int(r.avail)},
  {k:"notAvail",label:"Inventory Not Available",render:r=>r.isRatio?pct(r.notAvail):int(r.notAvail)},
  {k:"availPct",label:"Inventory Available %",render:r=>r.availPct==null?"—":pct(r.availPct)},
  {k:"notAvailPct",label:"Inventory Not Available %",render:r=>r.notAvailPct==null?"—":pct(r.notAvailPct)},
];
const INV_ANALYSIS_COLS_NO_DIM=[
  {k:"kpi",label:"KPI",render:r=>esc(r.kpi)},
  {k:"total",label:"Total",render:r=>r.isRatio?pct(r.total):int(r.total)},
  {k:"avail",label:"Inventory Available",render:r=>r.isRatio?pct(r.avail):int(r.avail)},
  {k:"notAvail",label:"Inventory Not Available",render:r=>r.isRatio?pct(r.notAvail):int(r.notAvail)},
  {k:"availPct",label:"Inventory Available %",render:r=>r.availPct==null?"—":pct(r.availPct)},
  {k:"notAvailPct",label:"Inventory Not Available %",render:r=>r.notAvailPct==null?"—":pct(r.notAvailPct)},
];
function groupByKey(rows,keyFn){
  const m=new Map();
  rows.forEach(r=>{ const key=keyFn(r)||"—"; if(!m.has(key)) m.set(key,[]); m.get(key).push(r); });
  return m;
}
/* Fixed price bands for Price Band Wise — ascending order, half-open [min,max) except the top band. */
const PRICE_BANDS=[
  {label:"0k-5k",min:0,max:5000},
  {label:"5k-10k",min:5000,max:10000},
  {label:"10k-15k",min:10000,max:15000},
  {label:"15k-20k",min:15000,max:20000},
  {label:"20k-35k",min:20000,max:35000},
  {label:"35k-50k",min:35000,max:50000},
  {label:"50k-75k",min:50000,max:75000},
  {label:"75k-100k",min:75000,max:100000},
  {label:"100k-150k",min:100000,max:150000},
  {label:"150k-225k",min:150000,max:225000},
  {label:"225k+",min:225000,max:Infinity},
];
function priceBandOf(price){
  if(!(price>0)) return "Unknown";
  for(const b of PRICE_BANDS){ if(price>=b.min && price<b.max) return b.label; }
  return "Unknown";
}
function groupByPriceBand(styleRows){
  const m=new Map();
  styleRows.forEach(r=>{ const band=priceBandOf(r.price); if(!m.has(band)) m.set(band,[]); m.get(band).push(r); });
  const order=PRICE_BANDS.map(b=>b.label).concat(["Unknown"]);
  return order.filter(label=>m.has(label)).map(label=>({dim:label,styleRows:m.get(label)}));
}
function buildCityStyleRows(styleRows){
  const availMap=new Map(styleRows.map(s=>[s.styleCode,s.inventoryAvailable]));
  const byCity=new Map();
  (STATE.cityStyle||[]).forEach(r=>{
    if(!availMap.has(r.styleCode)) return; // style filtered out under current sidebar filters
    if(!byCity.has(r.city)) byCity.set(r.city,[]);
    byCity.get(r.city).push({...r, inventoryAvailable:availMap.get(r.styleCode)});
  });
  return byCity;
}
function buildInventoryAnalysisRows(items){
  const styleRows=rollupStyleTable(items);
  // groups(): dimension values sorted largest-first, each holding its own rows — feeds the
  // Category Wise / Price Band Wise / City Wise pivot dropdowns (pick a value, see its KPIs, drill-down style).
  const groups=(groupsMap)=>[...groupsMap.entries()].sort((a,b)=>b[1].length-a[1].length).map(([dim,grp])=>({dim,styleRows:grp}));
  return {
    styleRows,
    style: computeInventoryKpiRows(styleRows,{includeSales:true}).map(r=>({dimension:"Style",...r,order:r.kpiOrder})),
    categoryGroups: groups(groupByKey(styleRows,r=>r.category)),
    priceBandGroups: groupByPriceBand(styleRows),
    cityGroups: groups(buildCityStyleRows(styleRows)),
  };
}
function renderPivotDrilldown(hostSelectId,hostTableId,groups,storeKey,includeSales=true){
  const opts=groups.map(g=>`<option value="${esc(g.dim)}">${esc(g.dim)} (${int(g.styleRows.length)} styles)</option>`).join("");
  $(hostSelectId).innerHTML=opts;
  const draw=()=>{
    const dim=$(hostSelectId).value;
    const g=groups.find(x=>x.dim===dim)||groups[0];
    const rows=g?computeInventoryKpiRows(g.styleRows,{includeSales}).map(r=>({dimension:g.dim,...r,order:r.kpiOrder})):[];
    renderInteractiveTable($(hostTableId),rows,INV_ANALYSIS_COLS_NO_DIM,storeKey,15,false);
  };
  $(hostSelectId).onchange=draw;
  draw();
}
function renderInventoryAvailabilitySection(el,items){
  const {styleRows,style,categoryGroups,priceBandGroups,cityGroups}=buildInventoryAnalysisRows(items);
  const availCount=styleRows.filter(s=>s.inventoryAvailable).length;
  const notAvailCount=styleRows.length-availCount;
  el.insertAdjacentHTML("beforeend",`
    <div class="h2" style="margin-top:30px">Inventory Availability Analysis</div>
    <div class="sub">GA4 engagement and sales split by whether the underlying <b>Style</b> (never the individual SKU variant) currently has inventory available — Current Available Inventory &gt; 0. Availability is decided once per Style, then every KPI below is summed from that classification. ATC % rows show the real conversion rate (Available/Not Available cells are the actual ATC ÷ PDP Views for that bucket, never averaged) — their Inventory Available %/Not Available % share cells are intentionally left blank since a "share of a percentage" would be misleading. These tables respect the sidebar filters and date range, same as the rest of the dashboard.</div>
    <div class="grid kpis" style="margin-bottom:14px">
      ${kpiCard("Total Styles",int(styleRows.length))}
      ${kpiCard("Styles — Inventory Available",int(availCount),"good",styleRows.length?pct(availCount/styleRows.length*100)+" of styles":"")}
      ${kpiCard("Styles — Inventory Not Available",int(notAvailCount),"crit",styleRows.length?pct(notAvailCount/styleRows.length*100)+" of styles":"")}
    </div>
    <div class="card" style="margin-bottom:16px"><h3>Style Wise</h3>
      <div class="scroll-x" id="invStyleHost"></div></div>
    <div class="card" style="margin-bottom:16px"><h3>Category Wise</h3>
      <div class="sub" style="margin-bottom:8px">Pick a category to drill into its 12 KPIs — same pivot pattern as Category Detail.</div>
      <div class="toolbar"><select id="invCategorySelect" class="search"></select></div>
      <div class="scroll-x" id="invCategoryHost"></div></div>
    <div class="card" style="margin-bottom:16px"><h3>Price Band Wise</h3>
      <div class="sub" style="margin-bottom:8px">Pick a price band to drill into its 12 KPIs.</div>
      <div class="toolbar"><select id="invPriceBandSelect" class="search"></select></div>
      <div class="scroll-x" id="invPriceBandHost"></div></div>
    <div class="card" style="margin-bottom:16px"><h3>City Wise</h3>
      <div class="sub" style="margin-bottom:10px">Pick a city to drill into its GA4 engagement KPIs. No Total Sale / Online Sale / Store Sale here — sales are recorded against a customer city in the Sales system, a different field than GA4's session city, with no reliable name match between the two (and ~43% of sale line items have no city recorded at all) — showing a joined number here would be exactly the kind of incorrect mapping to avoid. Accurate sales splits are in Style Wise, Category Wise and Price Band Wise above.</div>
      <div id="invCityPivotWrap"><div class="toolbar"><select id="invCitySelect" class="search"></select></div>
      <div class="scroll-x" id="invCityHost"></div></div></div>`);
  renderInteractiveTable($("#invStyleHost"),style,INV_ANALYSIS_COLS_NO_DIM,"invStyle",15,false);
  renderPivotDrilldown("#invCategorySelect","#invCategoryHost",categoryGroups,"invCategory");
  renderPivotDrilldown("#invPriceBandSelect","#invPriceBandHost",priceBandGroups,"invPriceBand");
  if(STATE.cityStyleLoading && !STATE.cityStyle.length){
    $("#invCityPivotWrap").innerHTML=`<p class="muted">Loading city-level data (~11MB, largest snapshot — loads in the background so it never holds up the rest of the dashboard)…</p>`;
  }else{
    renderPivotDrilldown("#invCitySelect","#invCityHost",cityGroups,"invCity",false);
  }
}

/* ── STYLE CODE ROLLUP — same SKU-level data, grouped by Style Code ───────
   Style Code = base SKU with its trailing metal/karat/diamond-type segment
   stripped, e.g. LJ-E00065-14YGLGD and LJ-E00065-18YGLGD both roll into
   LJ-E00065. Verified against real data: ~99.5% of SKUs are exactly
   LJ-<style>-<metalcode> (3 hyphen-segments); the last segment is dropped.
   SKUs with 2 or fewer segments have no variant suffix to strip, so the
   Style Code is just the SKU itself. Percentages are recalculated from the
   summed totals (never averaged across variants) — same formulas as the
   SKU Performance tab, just at a higher grain. */
function styleCodeOf(sku){
  const parts=(sku||"").split("-");
  return parts.length>2 ? parts.slice(0,-1).join("-") : sku;
}
function rollupStyleTable(items){
  const m=new Map();
  items.forEach(s=>{
    const code=styleCodeOf(s.sku);
    if(!m.has(code)) m.set(code,{
      styleCode:code, variantCount:0, repTitle:s.title, repPdp:-1,
      category:s.category, subcat1:s.subcat1, gender:s.gender, priceRange:s.priceRange, price:s.price,
      pdpViews:0, atc:0, checkout:0, plpImpressions:0, plpClick:0, addToWishlist:0, removeFromCart:0,
      totalSale:0, onlineSale:0, storeSale:0, totalNetSale:0, totalInventory:0,
      hasInvRecord:false, oldestAgeOverall:null,
      storeInvMap:new Map(), storeBrkMap:new Map()
    });
    const g=m.get(code);
    g.variantCount++;
    if(s.pdpViews>g.repPdp){ g.repPdp=s.pdpViews; g.repTitle=s.title; g.category=s.category; g.subcat1=s.subcat1; g.gender=s.gender; g.priceRange=s.priceRange; g.price=s.price; }
    g.pdpViews+=n(s.pdpViews); g.atc+=n(s.atc); g.checkout+=n(s.checkout);
    g.plpImpressions+=n(s.plpImpressions); g.plpClick+=n(s.plpClick); g.addToWishlist+=n(s.addToWishlist); g.removeFromCart+=n(s.removeFromCart);
    g.totalSale+=n(s.totalSale); g.onlineSale+=n(s.onlineSale); g.storeSale+=n(s.storeSale); g.totalNetSale+=n(s.totalNetSale);
    g.totalInventory+=n(s.totalInventory);
    if(s.availability!=="NOT FOUND") g.hasInvRecord=true;
    if(s.oldestAgeOverall!=null) g.oldestAgeOverall = g.oldestAgeOverall==null ? s.oldestAgeOverall : Math.max(g.oldestAgeOverall,s.oldestAgeOverall);
    (s.storeInventory||[]).forEach(si=>{
      const cur=g.storeInvMap.get(si.store)||{store:si.store,qty:0,oldestAge:null};
      cur.qty+=n(si.qty); cur.oldestAge = cur.oldestAge==null ? si.oldestAge : Math.max(cur.oldestAge, si.oldestAge??0);
      g.storeInvMap.set(si.store,cur);
    });
    (s.storeBreakdown||[]).forEach(sb=>{
      const cur=g.storeBrkMap.get(sb.store)||{store:sb.store,saleCount:0,qty:0,oldestAge:null};
      cur.saleCount+=n(sb.saleCount); cur.qty+=n(sb.qty);
      if(sb.oldestAge!=null) cur.oldestAge = cur.oldestAge==null ? sb.oldestAge : Math.max(cur.oldestAge, sb.oldestAge);
      g.storeBrkMap.set(sb.store,cur);
    });
  });
  return [...m.values()].map(g=>{
    const storeInventory=[...g.storeInvMap.values()].sort((a,b)=>b.qty-a.qty);
    const storeBreakdown=[...g.storeBrkMap.values()].map(x=>({...x,status:x.qty>0?"AVAILABLE":"OUT OF STOCK"})).sort((a,b)=>b.qty-a.qty||b.saleCount-a.saleCount);
    const availability = g.totalInventory>0 ? "AVAILABLE" : (g.hasInvRecord ? "OUT OF STOCK" : "NOT FOUND");
    return {
      styleCode:g.styleCode, title:g.repTitle, variantCount:g.variantCount,
      category:g.category, subcat1:g.subcat1, gender:g.gender, priceRange:g.priceRange, price:g.price,
      pdpViews:g.pdpViews, atc:g.atc, atcPct: g.pdpViews? g.atc/g.pdpViews*100:0,
      checkout:g.checkout, checkoutPct: g.atc? g.checkout/g.atc*100:0,
      plpImpressions:g.plpImpressions, plpClick:g.plpClick, addToWishlist:g.addToWishlist, removeFromCart:g.removeFromCart,
      totalSale:g.totalSale, onlineSale:g.onlineSale, storeSale:g.storeSale, totalNetSale:g.totalNetSale,
      totalInventory:g.totalInventory, availability,
      inventoryAvailable: g.totalInventory>0,
      oldestAgeOverall:g.oldestAgeOverall,
      storeInventory, storeBreakdown,
      storeWiseInventory: storeInventory.length ? storeInventory.map(x=>`${x.store}-${x.qty}-${x.oldestAge}`).join(" | ") : "No Stock"
    };
  });
}
const STYLE_COLS=[
  {k:"styleCode",label:"Style Code",render:r=>`<b>${esc(r.styleCode)}</b>`},
  {k:"title",label:"Product",render:r=>esc(r.title)},
  {k:"variantCount",label:"Variants",render:r=>int(r.variantCount)},
  {k:"pdpViews",label:"PDP Views",render:r=>int(r.pdpViews)},
  {k:"atc",label:"ATC",render:r=>int(r.atc)},
  {k:"atcPct",label:"ATC %",render:r=>pct(r.atcPct)},
  {k:"checkout",label:"Checkout",render:r=>int(r.checkout)},
  {k:"checkoutPct",label:"Checkout %",render:r=>pct(r.checkoutPct)},
  {k:"totalSale",label:"Total Sale",render:r=>int(r.totalSale)},
  {k:"onlineSale",label:"Online Sale",render:r=>int(r.onlineSale)},
  {k:"storeSale",label:"Store Sale",render:r=>int(r.storeSale)},
  {k:"availability",label:"Availability",render:r=>pillAvail(r.availability)},
  {k:"totalInventory",label:"Total Inventory",render:r=>int(r.totalInventory)},
  {k:"storeWiseInventory",label:"Store-wise Inventory",render:r=>`<span style="font-family:var(--mono);font-size:11px">${esc(r.storeWiseInventory)}</span>`},
];
function renderStyle(el,items){
  const rows=rollupStyleTable(items);
  el.innerHTML=`<div class="h2">Style Performance</div>
    <div class="sub">Same GA4 / Sales / Inventory logic as SKU Performance, rolled up from individual SKU (metal/karat variant) to Style Code — e.g. LJ-E00065-14YGLGD and LJ-E00065-18YGLGD both roll into <b>LJ-E00065</b>. ATC % and Checkout % are recalculated from the summed totals, never averaged across variants. ${int(rows.length)} Style Codes from ${int(items.length)} SKUs.</div>
    <div class="scroll-x" id="styleHost"></div>`;
  renderInteractiveTable($("#styleHost"),rows,STYLE_COLS,"style",50);
}

/* ── SECTION 1 — SKU PERFORMANCE (the main table) ─────────────────────────*/
function renderSkus(el,items){
  el.innerHTML=`<div class="h2">SKU Performance</div>
    <div class="sub">One row per GA4 SKU. Store-wise Inventory reads as STORE-QTY-AGE, e.g. <span style="font-family:var(--mono)">HO-5-123</span> = 5 units at HO, 123 days old. ${int(items.length)} SKUs.</div>
    <div class="scroll-x" id="skusHost"></div>`;
  renderInteractiveTable($("#skusHost"),items,SKU_COLS,"skus",50);
}

/* ── CATEGORY DETAIL — category / sub category / price range / gender ─────*/
const DIM_DEFS=[
  {k:"category",label:"Category"},
  {k:"subcat1",label:"Sub Category"},
  {k:"priceRange",label:"Price Range"},
  {k:"gender",label:"Gender"},
];
const DIM_COLS=[
  {k:"key",label:"Value"},
  {k:"skuCount",label:"SKU Count",render:r=>int(r.skuCount)},
  {k:"available",label:"Available",render:r=>int(r.available)},
  {k:"availPct",label:"Availability %",render:r=>pct(r.availPct,1)},
  {k:"pdpViews",label:"PDP Views",render:r=>int(r.pdpViews)},
  {k:"atc",label:"ATC",render:r=>int(r.atc)},
  {k:"atcPct",label:"ATC %",render:r=>pct(r.atcPct)},
  {k:"checkout",label:"Checkout",render:r=>int(r.checkout)},
  {k:"totalSale",label:"Total Sale",render:r=>int(r.totalSale)},
  {k:"totalInventory",label:"Total Inventory",render:r=>int(r.totalInventory)},
];
function renderCategoryDetail(el,items){
  el.innerHTML=`<div class="h2">Category Detail</div>
    <div class="sub">GA4 performance, sales and inventory broken down by product attribute — pick a dimension below. Same simple math as everywhere else, just grouped.</div>
    <div class="toolbar"><select id="dimSelect" class="search">${DIM_DEFS.map(d=>`<option value="${d.k}">${d.label}</option>`).join("")}</select></div>
    <div class="scroll-x" id="dimHost"></div>`;
  const draw=()=>{const dim=$("#dimSelect").value; renderInteractiveTable($("#dimHost"),rollupByDim(items,dim),DIM_COLS,"dim_"+dim,30);};
  $("#dimSelect").onchange=draw; draw();
}

/* ── CITY DETAIL — portfolio-wide GA4 rollup by city ──────────────────────*/
const CITY_COLS=[
  {k:"city",label:"City"},
  {k:"skuCount",label:"SKU Count",render:r=>int(r.skuCount)},
  {k:"sessions",label:"Sessions",render:r=>int(r.sessions)},
  {k:"pdpViews",label:"PDP Views",render:r=>int(r.pdpViews)},
  {k:"atc",label:"ATC",render:r=>int(r.atc)},
  {k:"atcPct",label:"ATC %",render:r=>pct(r.atcPct)},
  {k:"checkout",label:"Checkout",render:r=>int(r.checkout)},
  {k:"plpImpressions",label:"PLP Impressions",render:r=>int(r.plpImpressions)},
  {k:"plpClick",label:"PLP Click",render:r=>int(r.plpClick)},
  {k:"addToWishlist",label:"Wishlist",render:r=>int(r.addToWishlist)},
  {k:"removeFromCart",label:"Remove From Cart",render:r=>int(r.removeFromCart)},
];
function renderCityDetail(el){
  const rows=STATE.cities||[];
  el.innerHTML=`<div class="h2">City Detail</div>
    <div class="sub">Top ${int(rows.length)} cities by sessions, across all in-scope GA4 SKUs. This is a separate portfolio-wide rollup — it does not respond to the sidebar filters, since it isn't computed per SKU.</div>
    <div class="scroll-x" id="cityHost"></div>`;
  renderInteractiveTable($("#cityHost"),rows,CITY_COLS,"city",60);
}

/* ── SECTION 2 — STORE PERFORMANCE ────────────────────────────────────────*/
function renderStores(el,items){
  const storeRows=rollupStores(items);
  const detail=flattenStoreBreakdown(items);
  el.innerHTML=`<div class="h2">Store Performance</div>
    <div class="sub">Sale Count and Current Qty are shown side by side per store — a store keeps its row even at zero sales or zero current stock, so both gaps stay visible.</div>
    <div class="card" style="margin-bottom:14px"><h3>By Store</h3>
      <div class="tbl-wrap" style="max-height:260px"><table><thead><tr><th>Store</th><th>SKU Count</th><th>Total Sales</th><th>Current Inventory</th></tr></thead>
      <tbody>${storeRows.map(r=>`<tr><td><b>${esc(r.store)}</b></td><td>${int(r.skuCount)}</td><td>${int(r.totalSales)}</td><td>${int(r.totalInventory)}</td></tr>`).join("")}</tbody></table></div>
    </div>
    <div class="card"><h3>SKU × Store Detail <span class="rt">${int(detail.length)} rows</span></h3><div class="scroll-x" id="storeDetailHost"></div></div>`;
  renderInteractiveTable($("#storeDetailHost"),detail,STORE_DETAIL_COLS,"storedetail",50);
}

/* ── SECTION 3 — PROBLEM SKUS ─────────────────────────────────────────────*/
function renderProblems(el,items){
  const demandNoInv=items.filter(x=>x.pdpViews>0&&x.atc>0&&x.totalInventory===0).sort((a,b)=>b.pdpViews-a.pdpViews);
  const lowSalesStock=flattenStoreBreakdown(items).filter(r=>r.qty>0&&r.saleCount===0).sort((a,b)=>b.qty-a.qty);
  const lowSalesCols=[{k:"sku",label:"SKU",render:r=>`<b>${esc(r.sku)}</b>`},{k:"title",label:"Product"},{k:"store",label:"Store"},
    {k:"qty",label:"Current Qty",render:r=>int(r.qty)},{k:"oldestAge",label:"Stock Age",render:r=>r.oldestAge!=null?int(r.oldestAge):"—"},{k:"saleCount",label:"Sale Count",render:r=>int(r.saleCount)}];
  el.innerHTML=`<div class="h2">Problem SKUs</div>
    <div class="sub">Two simple, data-backed lists — no scoring involved.</div>
    <div class="card" style="margin-bottom:14px"><h3>GA4 Demand but No Inventory <span class="rt">PDP Views &gt; 0 and ATC &gt; 0, Total Inventory = 0 · ${int(demandNoInv.length)} SKUs</span></h3>
      <div class="scroll-x" id="demandNoInvHost"></div>
    </div>
    <div class="card"><h3>Stock Available but Zero Store Sales <span class="rt">store has current qty &gt; 0 but 0 recorded sales at that store · ${int(lowSalesStock.length)} rows</span></h3>
      <div class="scroll-x" id="lowSalesHost"></div>
    </div>`;
  renderInteractiveTable($("#demandNoInvHost"),demandNoInv,PROBLEM1_COLS,"demandnoinv",30);
  renderInteractiveTable($("#lowSalesHost"),lowSalesStock,lowSalesCols,"lowsales",30);
}

/* ── SKU DETAIL ────────────────────────────────────────────────────────── */
function renderDrilldown(el){
  el.innerHTML=`<div class="h2">SKU Detail</div><div class="sub">Search any SKU to see GA4, Sales, Inventory and Store Breakdown in one place.</div>
    <input class="search" id="drillSearch" placeholder="Type a SKU (e.g. LJ-R00069)…" style="width:100%;max-width:420px;margin-bottom:14px" value="${esc(STATE.drillSku||"")}">
    <div id="drillResult"></div>`;
  $("#drillSearch").oninput=e=>{STATE.drillSku=e.target.value;renderDrillResult();};
  renderDrillResult();
}
function renderDrillResult(){
  const host=$("#drillResult"); if(!host)return;
  const q=(STATE.drillSku||"").trim().toUpperCase();
  if(!q){host.innerHTML=`<p class="muted">Type a SKU above to see its full profile.</p>`;return;}
  const s=STATE.skus.find(x=>x.sku.includes(q));
  if(!s){host.innerHTML=`<p class="muted">No SKU matching "${esc(q)}".</p>`;return;}
  const storeRows=s.storeBreakdown.map(b=>`<tr><td><b>${esc(b.store)}</b></td><td>${int(b.saleCount)}</td><td>${int(b.qty)}</td><td>${b.oldestAge!=null?int(b.oldestAge):"—"}</td><td>${pillStatus(b.status)}</td></tr>`).join("");
  host.innerHTML=`<div class="grid two">
    <div class="sku-drill"><h3 style="margin-top:0">Product</h3>
      <p><b>${esc(s.sku)}</b> — ${esc(s.title)}<br>${esc(s.category)} · ${esc(s.subcat1)}<br>Last GA4 activity: ${esc(s.lastSeen||"—")}</p>
    </div>
    <div class="sku-drill"><h3 style="margin-top:0">GA4</h3>
      <p>PDP Views: <b>${int(s.pdpViews)}</b> · ATC: <b>${int(s.atc)}</b> · ATC%: <b>${pct(s.atcPct)}</b> · Checkout: <b>${int(s.checkout)}</b></p>
    </div>
  </div>
  <div class="grid two" style="margin:14px 0">
    <div class="sku-drill"><h3 style="margin-top:0">Sales</h3><p>Total Sale: <b>${int(s.totalSale)}</b> units${s.totalNetSale?` (${money(s.totalNetSale)}, for reference)`:""}</p></div>
    <div class="sku-drill"><h3 style="margin-top:0">Inventory</h3><p>Total Inventory: <b>${int(s.totalInventory)}</b> · Availability: ${pillAvail(s.availability)}${s.oldestAgeOverall!=null?` · Oldest stock: <b>${int(s.oldestAgeOverall)}</b> days`:""}</p></div>
  </div>
  <div class="card"><h3>Store Breakdown</h3>
    <div class="tbl-wrap scroll-x"><table><thead><tr><th>Store</th><th>Sale Count</th><th>Current Qty</th><th>Stock Age</th><th>Status</th></tr></thead>
    <tbody>${storeRows||`<tr><td colspan="5" class="muted">No sales or inventory record at any store.</td></tr>`}</tbody></table></div>
  </div>`;
}

/* ── ASK AI — Gemini copilot grounded on the live loaded dataset ──────────*/
function csvEsc(v){
  const s=(v==null)?"":String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}
function buildAiContext(items){
  const skuCols=["sku","title","category","subcat1","gender","priceRange","price",
    "plpImpressions","plpClick","pdpViews","atc","atcPct","checkout","addToWishlist","removeFromCart",
    "totalSale","onlineSale","storeSale","totalNetSale","totalInventory","availability","oldestAgeOverall"];
  const skuLines=[skuCols.join(",")];
  items.forEach(r=>{ skuLines.push(skuCols.map(c=>csvEsc(c==="atcPct"?Math.round((r[c]||0)*100)/100:r[c])).join(",")); });

  const styleCols=["styleCode","title","variantCount","pdpViews","atc","atcPct","checkout","checkoutPct","totalSale","onlineSale","storeSale","totalInventory","availability"];
  const styleRows=rollupStyleTable(items);
  const styleLines=[styleCols.join(",")];
  styleRows.forEach(r=>{ styleLines.push(styleCols.map(c=>csvEsc((c==="atcPct"||c==="checkoutPct")?Math.round((r[c]||0)*100)/100:r[c])).join(",")); });

  const storeCols=["sku","store","saleCount","qty","oldestAge","status"];
  const storeLines=[storeCols.join(",")];
  items.forEach(r=>{ (r.storeBreakdown||[]).forEach(sb=>{
    storeLines.push([csvEsc(r.sku),csvEsc(sb.store),csvEsc(sb.saleCount),csvEsc(sb.qty),csvEsc(sb.oldestAge),csvEsc(sb.status)].join(","));
  }); });

  const cityCols=["city","sessions","pdpViews","atc","atcPct","checkout","plpImpressions","plpClick","addToWishlist","removeFromCart","skuCount"];
  const cityLines=[cityCols.join(",")];
  (STATE.cities||[]).forEach(c=>{ cityLines.push(cityCols.map(k=>csvEsc(k==="atcPct"?Math.round((c[k]||0)*100)/100:c[k])).join(",")); });

  return `SKUS (${items.length} rows, as of ${STATE.asOfDate||"latest"}):\n${skuLines.join("\n")}\n\n`
       + `STYLES (${styleLines.length-1} rows — SKUs rolled up by Style Code, stripping the trailing metal/karat variant segment, e.g. LJ-E00065-14YGLGD -> LJ-E00065; atcPct/checkoutPct recomputed from summed totals, not averaged):\n${styleLines.join("\n")}\n\n`
       + `STORES (${storeLines.length-1} rows):\n${storeLines.join("\n")}\n\n`
       + `CITIES (${cityLines.length-1} rows):\n${cityLines.join("\n")}`;
}
function renderAiLog(){
  const host=$("#aiLog"); if(!host) return;
  host.innerHTML=STATE.ai.log.map(m=>{
    if(m.role==="user") return `<div class="ai-msg user">${esc(m.text)}</div>`;
    if(m.role==="pending") return `<div class="ai-msg pending">Thinking…</div>`;
    if(m.role==="error") return `<div class="ai-msg bot err">${esc(m.text)}</div>`;
    return `<div class="ai-msg bot">${esc(m.text)}</div>`;
  }).join("") || `<p class="muted">Ask anything about the SKUs, stores or cities currently loaded — e.g. "Which SKUs have high ATC but zero inventory?" or "Which store has the oldest stock?"</p>`;
  host.scrollTop=host.scrollHeight;
}
async function askAi(question){
  if(!question.trim()||STATE.ai.busy) return;
  STATE.ai.busy=true;
  STATE.ai.log.push({role:"user",text:question});
  STATE.ai.log.push({role:"pending"});
  renderAiLog();
  try{
    const context=buildAiContext(applyRange(filtered()));
    const res=await fetch(CONFIG.AI_BASE+"/ask",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question,context})});
    const data=await res.json();
    STATE.ai.log.pop();
    if(data.error) STATE.ai.log.push({role:"error",text:data.error});
    else STATE.ai.log.push({role:"bot",text:data.answer||"(no answer)"});
  }catch(e){
    STATE.ai.log.pop();
    STATE.ai.log.push({role:"error",text:"Could not reach the AI service. "+e.message});
  }
  STATE.ai.busy=false;
  renderAiLog();
}
function initAiWidget(){
  const suggestions=["Which SKUs have high ATC but zero inventory?","Which store has the most old stock (>180 days)?","Top 10 SKUs by PDP Views with 0 sales.","Which category converts best from PDP to ATC?"];
  $("#aiSuggest").innerHTML=suggestions.map(s=>`<span data-q="${esc(s)}">${esc(s)}</span>`).join("");
  renderAiLog();
  const panel=$("#aiPanel"), fab=$("#aiFab");
  const send=()=>{ const t=$("#aiInput"); const q=t.value; t.value=""; askAi(q); };
  fab.onclick=()=>panel.classList.toggle("open");
  $("#aiCloseBtn").onclick=()=>panel.classList.remove("open");
  $("#aiSendBtn").onclick=send;
  $("#aiClearBtn").onclick=()=>{ STATE.ai.log=[]; renderAiLog(); };
  $("#aiInput").onkeydown=e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); send(); } };
  $$(".ai-suggest span",$("#aiSuggest")).forEach(s=>s.onclick=()=>{ panel.classList.add("open"); $("#aiInput").value=s.dataset.q; send(); });
}

/* ── HOW IT WORKS — step-by-step logic, no scoring anywhere ───────────────*/
function renderLogic(el){
  const steps=[
    {n:1,src:"ga4",tag:"GA4",title:"GA4 Raw Events",
      desc:"Every pageview / add-to-cart / checkout event in ga4_data.ga4_data is matched to a SKU. The trailing size (e.g. \"-12\", \"-6.5\") is stripped so ring/bangle size variants of the same style roll up into one base SKU — the same base SKU is then used to match Sales and Inventory below."},
    {n:2,src:"ga4",tag:"GA4",title:"PDP Views",
      desc:"SUM(pdp_views) per SKU, all-time. How many times customers opened the product page."},
    {n:3,src:"ga4",tag:"GA4",title:"ATC (Add to Cart)",
      desc:"SUM(add_to_cart) per SKU, all-time. How many times customers added it to cart."},
    {n:4,src:"ga4",tag:"Calculated",title:"ATC %",
      desc:"ATC ÷ PDP Views × 100 — never divided by Sessions. If PDP Views is 0, ATC% shows as 0%, not an error."},
    {n:5,src:"ga4",tag:"GA4",title:"Checkout",
      desc:"SUM(begin_checkout) per SKU, all-time — shown for context; it doesn't feed into any other number here."},
    {n:6,src:"sales",tag:"marketing_sale",title:"Total Sale",
      desc:"SUM(pieces) from ds_imputed_reporting.marketing_sale, matched to the same base SKU. This is real, completed sales — \"ye SKU ab tak kitni baar bika hai\". A SKU with GA4 views but 0 here genuinely has never sold."},
    {n:7,src:"inv",tag:"Live_inventory",title:"Total Inventory",
      desc:"SUM of currently-held units in ds_imputed_reporting.Live_inventory for that SKU, added up across every store."},
    {n:8,src:"inv",tag:"Calculated",title:"Availability",
      desc:"AVAILABLE (inventory > 0) · OUT OF STOCK (has an inventory record but the total is 0) · NOT FOUND (no inventory record at all). See the note below — OUT OF STOCK is rare at this grain."},
    {n:9,src:"inv",tag:"Calculated",title:"Store-wise Breakdown",
      desc:"For each store: Sale Count (from marketing_sale) + Current Qty + Stock Age in days (from Live_inventory's document_date), side by side. A store keeps its row even at zero sales or zero current stock, so both gaps stay visible — never hidden."},
  ];
  const stepHtml=steps.map(s=>`<div class="flow-step src-${s.src}"><div class="num">${s.n}</div><div class="body"><b>${esc(s.title)}</b><span class="tag">${esc(s.tag)}</span><p>${esc(s.desc)}</p></div></div>`).join("");
  const cols=[
    {c:"PDP Views",d:"SUM(pdp_views) from GA4, all-time, per SKU."},
    {c:"ATC",d:"SUM(add_to_cart) from GA4, all-time, per SKU."},
    {c:"ATC %",d:"ATC ÷ PDP Views × 100. Safe against zero PDP Views."},
    {c:"Checkout",d:"SUM(begin_checkout) from GA4, all-time, per SKU."},
    {c:"Total Sale",d:"SUM(pieces) from marketing_sale — actual completed sales, all-time."},
    {c:"Online Sale",d:"Total Sale where the selling store is HO — Lucira's Head Office / Divinecarat entity, used as the online-order channel."},
    {c:"Store Sale",d:"Total Sale where the selling store is anything other than HO — i.e. sold in-store at a physical location."},
    {c:"Availability",d:"AVAILABLE / OUT OF STOCK / NOT FOUND, derived from Total Inventory."},
    {c:"Total Inventory",d:"Sum of current units held across all stores, from Live_inventory."},
    {c:"Store-wise Inventory",d:"Formatted STORE-QTY-AGE, e.g. HO-5-123 = 5 units at HO, 123 days old."},
  ];
  const stores=[
    {code:"HO",name:"Head Office (Divinecarat Lifestyles Pvt. Ltd.)"},
    {code:"PN1",name:"JM Road, Pune"},
    {code:"CS1",name:"Head-office-side entity — sales-only, no matching inventory record found"},
    {code:"BO1",name:"SkyCity Borivali, Mumbai"},
    {code:"N18",name:"Noida Sector 18"},
    {code:"FCS",name:"HWI Ventures (head-office-side)"},
    {code:"PV1",name:"Paschim Vihar, Delhi"},
    {code:"LPN",name:"Lajpat Nagar, Delhi"},
  ];
  el.innerHTML=`<div class="h2">How This Dashboard Works</div>
    <div class="sub">Every step below is a real, named calculation. There is no demand score, opportunity score, risk score, or AI recommendation anywhere in this dashboard.</div>
    <div class="card" style="margin-bottom:16px"><h3>Step-by-Step Flow <button class="info-i" id="flowInfoBtn" title="Plain-language summary">ⓘ</button></h3>
      <div id="flowInfoText" class="note" style="display:none">Customer ne kitna dekha → kitna ATC kiya → ATC% kya hai → kitni baar sale hua → abhi stock hai ya nahi → stock kis store mein hai → kitna hai → kitne din purana hai.</div>
      <div class="flow">${stepHtml}</div>
      <div class="legend">
        <span class="li"><span class="sw" style="background:var(--s1)"></span>GA4 (ga4_data.ga4_data)</span>
        <span class="li"><span class="sw" style="background:var(--gold)"></span>Sales (marketing_sale)</span>
        <span class="li"><span class="sw" style="background:var(--brand-mauve)"></span>Inventory (Live_inventory)</span>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px"><h3>Column Definitions</h3>
      <div class="tbl-wrap" style="max-height:400px"><table><thead><tr><th>Column</th><th>Definition</th></tr></thead>
      <tbody>${cols.map(c=>`<tr><td><b>${esc(c.c)}</b></td><td class="muted">${esc(c.d)}</td></tr>`).join("")}</tbody></table></div>
    </div>
    <div class="card" style="margin-bottom:16px"><h3>Store Codes</h3>
      <div class="tbl-wrap" style="max-height:300px"><table><thead><tr><th>Code</th><th>Store</th></tr></thead>
      <tbody>${stores.map(s=>`<tr><td><b>${esc(s.code)}</b></td><td class="muted">${esc(s.name)}</td></tr>`).join("")}</tbody></table></div>
    </div>
    <div class="note"><b>Good to know</b><br>
      • SKU matching strips ring/bangle size suffixes (e.g. "-12") so size variants of the same style count as one SKU across GA4, Sales, and Inventory — this is an approximation, not an exact key.<br>
      • "OUT OF STOCK" is rare at the SKU level, by design: Live_inventory only stores currently-held pieces, not a placeholder row once a SKU hits zero everywhere — so most zero-inventory SKUs show as "NOT FOUND" rather than "OUT OF STOCK". Store Performance is where OUT OF STOCK shows up meaningfully (a specific store with sales history but 0 units right now).<br>
      • Gold Coin (LJ-GC*) and Silver Pendant (LJ-SLP*) products are excluded from this dashboard entirely, by SKU prefix — jewelry only, matching every other Lucira dashboard's scope.<br>
      • Channel split (Online Sale vs. Store Sale) is a simple store-code rule: HO = Online, every other store code = Store. This is an approximation — HO also covers some head-office-side operations, not purely e-commerce.<br>
      • Style Performance rolls SKU Performance up from the individual metal/karat variant (e.g. LJ-E00065-14YGLGD) to its Style Code (LJ-E00065) by stripping the trailing variant segment. ATC % and Checkout % are recomputed from the summed totals — never averaged across variants. Sidebar filters still apply at the variant level first, then roll up, same as every other tab.<br>
      • Inventory Availability Analysis (on Overview) classifies every Style once — Inventory Available if its summed current inventory &gt; 0, else Inventory Not Available — then splits every KPI by that classification. City Wise there is GA4 engagement only: Sales in this dataset are recorded against a customer city in the Sales system (marketing_sale), not GA4's session city, the two don't reliably match by name, and ~43% of sale line items have no city at all — so Sale columns are left out there rather than shown from an incorrect join. Price Band Wise there uses fixed bands (0k-5k, 5k-10k, 10k-15k, 15k-20k, 20k-35k, 35k-50k, 50k-75k, 75k-100k, 100k-150k, 150k-225k, 225k+) computed from each Style's representative price, not the raw GA4 price_range field — styles with no price data fall into "Unknown".<br>
      • All GA4 and Sales numbers are all-time totals; there is no date-window toggle on this dashboard.<br>
      • This dashboard reads a static snapshot exported from BigQuery, not a live query on every page load — it's refreshed by re-running the export.
    </div>`;
  const infoBtn=$("#flowInfoBtn");
  if(infoBtn) infoBtn.onclick=()=>{const t=$("#flowInfoText"); if(t) t.style.display=t.style.display==="none"?"block":"none";};
}

/* ── CSV export ────────────────────────────────────────────────────────── */
function exportCSV(){
  const items=filtered();
  const keys=["sku","title","category","subcat1","gender","priceRange","pdpViews","atc","atcPct","checkout","plpImpressions","plpClick","addToWishlist","removeFromCart","totalSale","onlineSale","storeSale","availability","totalInventory","oldestAgeOverall","storeWiseInventory","lastSeen"];
  const head=keys.join(",");
  const lines=items.map(r=>keys.map(k=>{let v=r[k];if(typeof v==="string"&&v.includes(","))v='"'+v.replace(/"/g,'""')+'"';return v??"";}).join(","));
  const csv=[head,...lines].join("\n");
  const blob=new Blob([csv],{type:"text/csv"}); const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download="ga4-sku-intelligence.csv"; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

/* ── range selector wiring ─────────────────────────────────────────────── */
function updateRangeNote(){
  const note=$("#rangeNote"); if(!note) return;
  if(STATE.range.preset==="all"){ note.textContent="GA4 metrics: all-time. Total Sale, Inventory & Store data are always all-time regardless of range."; return; }
  note.textContent=`GA4 metrics for ${rangeLabel()} (day-level data covers the last 60 days from ${STATE.asOfDate||"—"}). Total Sale, Inventory & Store data are always all-time.`;
}
$("#rangeSelect").onchange=e=>{
  STATE.range.preset=e.target.value;
  $("#rangeCustomWrap").style.display=STATE.range.preset==="custom"?"inline-flex":"none";
  if(STATE.range.preset==="custom"){
    if(!$("#rangeFrom").value && STATE.asOfDate) $("#rangeFrom").value=shiftDate(STATE.asOfDate,6);
    if(!$("#rangeTo").value && STATE.asOfDate) $("#rangeTo").value=STATE.asOfDate;
    STATE.range.from=$("#rangeFrom").value||null; STATE.range.to=$("#rangeTo").value||null;
  }
  updateRangeNote(); render();
};
$("#rangeFrom").onchange=e=>{ STATE.range.from=e.target.value||null; updateRangeNote(); render(); };
$("#rangeTo").onchange=e=>{ STATE.range.to=e.target.value||null; updateRangeNote(); render(); };

/* ── wire up chrome + boot ─────────────────────────────────────────────── */
$("#toggleFilters").onclick=()=>document.body.classList.toggle("filters-collapsed");
$("#themeBtn").onclick=()=>{document.body.classList.toggle("light");localStorage.setItem("gsi_theme",document.body.classList.contains("light")?"light":"dark");};
if(localStorage.getItem("gsi_theme")==="light")document.body.classList.add("light");
$("#refreshBtn").onclick=()=>boot();
$("#exportBtn").onclick=()=>exportCSV();
$("#clearFilters").onclick=()=>clearAllFilters();
$("#globalSearch").oninput=e=>{STATE.search=e.target.value;render();};
boot();
