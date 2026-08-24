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
  SKU_SNAPSHOT_BASE: "https://storage.googleapis.com/lucirajewelry-prod-dashboards/ga4-sku-intelligence/sku-latest-"
};
(function(){
  const q = new URLSearchParams(location.search);
  const w = window.__GSI_CONFIG__ || {};
  CONFIG.SKU_SNAPSHOT_BASE = q.get("base") || w.SKU_SNAPSHOT_BASE || CONFIG.SKU_SNAPSHOT_BASE;
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
const STATE = { skus:[], live:false, filters:{}, tab:"skus", sort:{}, page:{}, search:"", drillSku:"" };

/* ── ingest one raw NDJSON row ─────────────────────────────────────────────*/
function ingestSku(r){
  const s = {
    sku:r.sku, title:r.title||r.sku, category:r.category||"Unclassified", subcat1:r.subcat1||"—", subcat2:r.subcat2||"—",
    pdpViews:n(r.pdpViews), atc:n(r.atc), atcPct:n(r.atcPct), checkout:n(r.checkout), lastSeen:r.lastSeen||null,
    totalSale:n(r.totalSale), totalNetSale:n(r.totalNetSale),
    totalInventory:n(r.totalInventory), availability:r.availability||"NOT FOUND",
    oldestAgeOverall:(r.oldestAgeOverall!=null)?n(r.oldestAgeOverall):null,
    storeInventory:(r.storeInventory||[]).map(x=>({store:x.store,qty:n(x.qty),oldestAge:n(x.oldestAge)})),
    storeBreakdown:(r.storeBreakdown||[]).map(x=>({store:x.store,saleCount:n(x.saleCount),qty:n(x.qty),
      oldestAge:(x.oldestAge!=null)?n(x.oldestAge):null,status:x.status||"OUT OF STOCK"}))
  };
  s.storeWiseInventory = s.storeInventory.length
    ? s.storeInventory.map(x=>`${x.store}-${x.qty}-${x.oldestAge}`).join(" | ")
    : "No Stock";
  return s;
}

/* ── deterministic sample (offline fallback) ──────────────────────────────*/
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function buildSample(){
  const rnd=mulberry32(20260901); const pick=a=>a[Math.floor(rnd()*a.length)];
  const cats=["Rings","Earrings","Necklaces","Bracelets","Pendants"];
  const stores=["HO","PN1","CS1","BO1","N18","FCS","PV1","LPN"];
  const rows=[];
  for(let i=0;i<150;i++){
    const pdpViews=Math.round(rnd()<0.6?rnd()*500:500+rnd()*8000);
    const atcPct=0.3+rnd()*5; const atc=Math.round(pdpViews*atcPct/100);
    const checkout=Math.round(atc*(0.2+rnd()*0.4));
    const totalSale=rnd()<0.5?0:Math.round(rnd()*40);
    const hasInv=rnd()<0.4;
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
      pdpViews, atc, atcPct, checkout, lastSeen:"2026-08-30",
      totalSale, totalNetSale:totalSale*5000,
      totalInventory, availability: totalInventory>0?"AVAILABLE":(rnd()<0.5?"OUT OF STOCK":"NOT FOUND"),
      oldestAgeOverall: storeInventory.length?Math.max(...storeInventory.map(x=>x.oldestAge)):null,
      storeInventory, storeBreakdown
    }));
  }
  return rows;
}

/* ── boot: fetch every export shard until a 404 ───────────────────────────*/
function shardUrl(i){ return CONFIG.SKU_SNAPSHOT_BASE + String(i).padStart(12,"0") + ".json"; }
async function fetchAllShards(){
  const all=[]; let i=0;
  while(i<300){
    let res;
    try{ res = await fetch(shardUrl(i),{cache:"no-store"}); } catch(e){ break; }
    if(!res.ok) break;
    const txt = await res.text();
    txt.split("\n").filter(Boolean).forEach(l=>all.push(JSON.parse(l)));
    i++;
  }
  if(!all.length) throw new Error("No snapshot shards reachable");
  return all;
}
async function boot(){
  STATE.skus = buildSample(); STATE.live=false;
  $("#statusDot").className="dot demo"; $("#statusText").textContent="Sample data — loading live snapshot…";
  buildFilterUI(); buildNav(); render();
  try{
    const rows = await fetchAllShards();
    STATE.skus = rows.map(ingestSku); STATE.live=true;
    $("#statusDot").className="dot"; $("#statusText").textContent=`Live BigQuery snapshot · ${int(STATE.skus.length)} GA4 SKUs · sales & inventory joined`;
    buildFilterUI(); buildNav(); render();
  }catch(e){
    console.warn("Snapshot load failed, staying on sample.", e);
    $("#statusDot").className="dot demo"; $("#statusText").textContent="Sample data (snapshot unreachable)";
  }
}

/* ── pills ──────────────────────────────────────────────────────────────── */
function pillAvail(a){const cls=a==="AVAILABLE"?"good":a==="OUT OF STOCK"?"warn":"crit";return `<span class="pill ${cls}">${esc(a)}</span>`;}
function pillStatus(s){return `<span class="pill ${s==="AVAILABLE"?"good":"warn"}">${esc(s)}</span>`;}

/* ── filters ────────────────────────────────────────────────────────────── */
const FILTER_DEFS=[
  {k:"category",label:"Category",type:"select",col:"category"},
  {k:"subcat1",label:"Sub Category",type:"select",col:"subcat1"},
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
function activeFilterCount(){let c=0;const F=STATE.filters;for(const k in F){if(F[k]!=null&&F[k]!=="")c++;}return c;}
function applyFilters(){$("#filterCount").textContent=activeFilterCount()?activeFilterCount()+" active":"";render();}
function clearAllFilters(){STATE.filters={};STATE.search="";$("#globalSearch").value="";buildFilterUI();applyFilters();}

/* ── generic sortable/paginated table ─────────────────────────────────────*/
function sortRows(rows,key,dir){return [...rows].sort((a,b)=>{const av=a[key],bv=b[key];
  if(typeof av==="string"||typeof bv==="string") return dir*String(av??"").localeCompare(String(bv??""));
  return dir*((n(av))-(n(bv)));});}
function renderInteractiveTable(host,rows,cols,storeKey,pageSize=40){
  if(!STATE.sort[storeKey]) STATE.sort[storeKey]={k:cols[0].k,dir:-1};
  if(!STATE.page[storeKey]) STATE.page[storeKey]=1;
  const srt=STATE.sort[storeKey];
  const sorted=sortRows(rows,srt.k,srt.dir);
  const totalPages=Math.max(1,Math.ceil(sorted.length/pageSize));
  STATE.page[storeKey]=clamp(STATE.page[storeKey],1,totalPages);
  const pageRows=sorted.slice((STATE.page[storeKey]-1)*pageSize,STATE.page[storeKey]*pageSize);
  host.innerHTML=`<div class="tbl-wrap"><table><thead><tr>${cols.map(c=>`<th data-k="${c.k}">${esc(c.label)}${srt.k===c.k?(srt.dir===1?' ▲':' ▼'):''}</th>`).join("")}</tr></thead>
    <tbody>${pageRows.map(r=>`<tr>${cols.map(c=>`<td>${c.render?c.render(r):esc(r[c.k]??"")}</td>`).join("")}</tr>`).join("")||`<tr><td colspan="${cols.length}" class="muted">No rows match under current filters.</td></tr>`}</tbody></table></div>
    <div class="pager"><span>${int(sorted.length)} rows</span><button data-pg="prev">‹ Prev</button><span>Page ${STATE.page[storeKey]} / ${totalPages}</span><button data-pg="next">Next ›</button></div>`;
  $$("th",host).forEach(th=>th.onclick=()=>{const k=th.dataset.k;if(srt.k===k)srt.dir*=-1;else{srt.k=k;srt.dir=-1;}STATE.page[storeKey]=1;renderInteractiveTable(host,rows,cols,storeKey,pageSize);});
  const prev=host.querySelector('[data-pg="prev"]'),next=host.querySelector('[data-pg="next"]');
  if(prev)prev.onclick=()=>{if(STATE.page[storeKey]>1){STATE.page[storeKey]--;renderInteractiveTable(host,rows,cols,storeKey,pageSize);}};
  if(next)next.onclick=()=>{if(STATE.page[storeKey]<totalPages){STATE.page[storeKey]++;renderInteractiveTable(host,rows,cols,storeKey,pageSize);}};
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

/* ── column sets ───────────────────────────────────────────────────────── */
const SKU_COLS=[
  {k:"sku",label:"SKU",render:r=>`<b>${esc(r.sku)}</b>`},
  {k:"title",label:"Product",render:r=>esc(r.title)},
  {k:"pdpViews",label:"PDP Views",render:r=>int(r.pdpViews)},
  {k:"atc",label:"ATC",render:r=>int(r.atc)},
  {k:"atcPct",label:"ATC %",render:r=>pct(r.atcPct)},
  {k:"checkout",label:"Checkout",render:r=>int(r.checkout)},
  {k:"totalSale",label:"Total Sale",render:r=>int(r.totalSale)},
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
  {k:"skus",label:"SKU Performance"},
  {k:"stores",label:"Store Performance"},
  {k:"problems",label:"Problem SKUs"},
  {k:"drilldown",label:"SKU Detail"}
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
  const items=filtered(); const k=rollupKPIs(items);
  const el=$(`.page[data-page="${STATE.tab}"]`); if(!el)return;
  try{
    ({overview:renderOverview,skus:renderSkus,stores:renderStores,problems:renderProblems,drilldown:renderDrilldown}[STATE.tab]||(()=>{}))(el,items,k);
  }catch(e){ el.innerHTML=`<div class="card"><h3>⚠ Render error</h3><p class="muted">${esc(e.message)}</p></div>`; console.error(e); }
  $$("[data-goto]",el).forEach(c=>c.onclick=()=>gotoTab(c.dataset.goto));
}

/* ── OVERVIEW — exactly 6 KPIs, per spec ─────────────────────────────────*/
function renderOverview(el,items,k){
  el.innerHTML=`
   <div class="h2">GA4 SKU Intelligence</div>
   <div class="sub">Customer ne kitna dekha → kitna ATC kiya → ATC% kya hai → kitni baar sale hua → abhi stock hai ya nahi → stock kis store mein hai → kitna hai → kitne din purana hai.</div>
   <div class="grid kpis" style="margin-bottom:14px">
     ${kpiCard("Total GA4 SKUs",int(k.total))}
     ${kpiCard("Available SKUs",int(k.available),"good")}
     ${kpiCard("Out of Stock / Not Found",int(k.notAvailable),"crit")}
     ${kpiCard("Total Sales (units, all-time)",int(k.totalSales))}
     ${kpiCard("PDP Views but Zero Sales",int(k.pdpNoSale),"warn")}
     ${kpiCard("PDP + ATC but Zero Inventory",int(k.demandNoInv),"crit")}
   </div>
   <div class="note">No demand score, opportunity score, or priority engine here — every number above is a direct count from the data. GA4 metrics are all-time totals (no date window applied). "Total Sale" = units sold, from marketing_sale. "Out of Stock / Not Found" combines SKUs with a zero-inventory record and SKUs that don't appear in Live_inventory at all — see the SKU Performance tab's Availability column for the distinction.</div>`;
}

/* ── SECTION 1 — SKU PERFORMANCE (the main table) ─────────────────────────*/
function renderSkus(el,items){
  el.innerHTML=`<div class="h2">SKU Performance</div>
    <div class="sub">One row per GA4 SKU. Store-wise Inventory reads as STORE-QTY-AGE, e.g. <span style="font-family:var(--mono)">HO-5-123</span> = 5 units at HO, 123 days old. ${int(items.length)} SKUs.</div>
    <div class="scroll-x" id="skusHost"></div>`;
  renderInteractiveTable($("#skusHost"),items,SKU_COLS,"skus",50);
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

/* ── CSV export ────────────────────────────────────────────────────────── */
function exportCSV(){
  const items=filtered();
  const keys=["sku","title","category","subcat1","pdpViews","atc","atcPct","checkout","totalSale","availability","totalInventory","oldestAgeOverall","storeWiseInventory","lastSeen"];
  const head=keys.join(",");
  const lines=items.map(r=>keys.map(k=>{let v=r[k];if(typeof v==="string"&&v.includes(","))v='"'+v.replace(/"/g,'""')+'"';return v??"";}).join(","));
  const csv=[head,...lines].join("\n");
  const blob=new Blob([csv],{type:"text/csv"}); const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download="ga4-sku-intelligence.csv"; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

/* ── wire up chrome + boot ─────────────────────────────────────────────── */
$("#toggleFilters").onclick=()=>document.body.classList.toggle("filters-collapsed");
$("#themeBtn").onclick=()=>{document.body.classList.toggle("light");localStorage.setItem("gsi_theme",document.body.classList.contains("light")?"light":"dark");};
if(localStorage.getItem("gsi_theme")==="light")document.body.classList.add("light");
$("#refreshBtn").onclick=()=>boot();
$("#exportBtn").onclick=()=>exportCSV();
$("#clearFilters").onclick=()=>clearAllFilters();
$("#globalSearch").oninput=e=>{STATE.search=e.target.value;render();};
boot();
