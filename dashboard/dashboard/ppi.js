"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   Product Pricing & Cost Configuration Intelligence — Lucira Jewelry

   Base dataset (BigQuery, project lucirajewelry-prod):
     Lucira_Prod.Lucira_Shopify_product_variant_metafields (key='variant_config')
       LEFT JOIN ornaverse_erp_master.items ON owner_id = external_variant_id
     -> per-SKU metal type, purity, metal weight, making charges, up to 3 stone
        configs, making-charges/diamond discount. Exact query supplied by the
        user; see sql/product_pricing_config.sql.

   Gold Rate column: joined from the "Product Pricing" Google Sheet (gid=0),
   "Metal Rate" block (Metal | KT | Purity% | Rate). A1 holds the as-of date.
   Join key = metal name (upper-cased) + KT/purity grade — the exact same
   keys the sheet itself uses; no new rate formula. See ppi_data.js / the
   RATE_CARD_RAW block in build_ppi_data.py for the verbatim transcription.
   This is a refreshed snapshot (not a live per-request pipeline) — rerun
   build_ppi_data.py (which re-reads BigQuery + the Sheet) to update it.
   ══════════════════════════════════════════════════════════════════════════ */

const $ = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>[...r.querySelectorAll(s)];
const n=v=>{ if(v==null||v==="") return 0; const x=typeof v==="number"?v:parseFloat(v); return Number.isFinite(x)?x:0; };
const money=v=>{v=n(v);const s=v<0?"-":"";v=Math.abs(v);
  if(v>=1e7)return s+"₹"+(v/1e7).toFixed(2)+" Cr";
  if(v>=1e5)return s+"₹"+(v/1e5).toFixed(2)+" L";
  if(v>=1e3)return s+"₹"+(v/1e3).toFixed(1)+"K";
  return s+"₹"+Math.round(v);};
const rupee=v=>"₹"+n(v).toLocaleString("en-IN",{maximumFractionDigits:2});
const int=v=>n(v).toLocaleString("en-IN",{maximumFractionDigits:0});
const dec=(v,d=2)=>n(v).toLocaleString("en-IN",{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=(v,d=1)=>dec(n(v),d)+"%";
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const gone=s=>(s==null||s==="")?"—":s;

/* ── data load / decode ────────────────────────────────────────────────── */
const D = window.PPI_DATA || {asOfDate:null, rateCard:[], dict:{metal_type:[],purity:[],remarks:[],stone_type:[],stone_pricing_id:[]}, columns:[], rowCount:0, rows:[]};
const DICT = D.dict;
const RATE_CARD = D.rateCard || [];
const SLAB_CARD = D.slabCard || [];
const SLAB_INDEX = new Map(SLAB_CARD.map((s,i)=>[s.code.trim().toUpperCase(), i]));
function matchSlabIndex(pricingId){
  if(pricingId==null) return -1;
  const hit = SLAB_INDEX.get(String(pricingId).trim().toUpperCase());
  return hit==null ? -1 : hit;
}

/* Daily 24K price -> KT purity split, from lucirajewelry-prod.Pos.metal_rates
   (the 'Gold' row's sales_rate * 10 = price per 10g). Same multipliers as the Metal Rate sheet block:
   22K 92%, 18K 76%, 14K 59%, 9K 40%. */
const GOLD_HISTORY = [
  {date:"2026-09-04",price10g:155563,priceGram:15556.3,kt22:14311.796,kt18:11822.788,kt14:9178.217,kt9:6222.52},
  {date:"2026-09-03",price10g:151860,priceGram:15186,kt22:13971.12,kt18:11541.36,kt14:8959.74,kt9:6074.4},
  {date:"2026-09-02",price10g:152179,priceGram:15217.9,kt22:14000.468,kt18:11565.604,kt14:8978.561,kt9:6087.16},
  {date:"2026-09-01",price10g:154274,priceGram:15427.4,kt22:14193.208,kt18:11724.824,kt14:9102.166,kt9:6170.96},
  {date:"2026-08-31",price10g:155619,priceGram:15561.9,kt22:14316.948,kt18:11827.044,kt14:9181.521,kt9:6224.76},
  {date:"2026-08-30",price10g:155619,priceGram:15561.9,kt22:14316.948,kt18:11827.044,kt14:9181.521,kt9:6224.76},
  {date:"2026-08-29",price10g:157909,priceGram:15790.9,kt22:14527.628,kt18:12001.084,kt14:9316.631,kt9:6316.36},
  {date:"2026-08-28",price10g:157773,priceGram:15777.3,kt22:14515.116,kt18:11990.748,kt14:9308.607,kt9:6310.92},
  {date:"2026-08-27",price10g:160234,priceGram:16023.4,kt22:14741.528,kt18:12177.784,kt14:9453.806,kt9:6409.36},
  {date:"2026-08-26",price10g:161198,priceGram:16119.8,kt22:14830.216,kt18:12251.048,kt14:9510.682,kt9:6447.92},
  {date:"2026-08-25",price10g:162645,priceGram:16264.5,kt22:14963.34,kt18:12361.02,kt14:9596.055,kt9:6505.8},
  {date:"2026-08-24",price10g:160695,priceGram:16069.5,kt22:14783.94,kt18:12212.82,kt14:9481.005,kt9:6427.8},
  {date:"2026-08-23",price10g:160695,priceGram:16069.5,kt22:14783.94,kt18:12212.82,kt14:9481.005,kt9:6427.8},
  {date:"2026-08-22",price10g:160172,priceGram:16017.2,kt22:14735.824,kt18:12173.072,kt14:9450.148,kt9:6406.88},
  {date:"2026-08-21",price10g:158127,priceGram:15812.7,kt22:14547.684,kt18:12017.652,kt14:9329.493,kt9:6325.08},
  {date:"2026-08-20",price10g:156234,priceGram:15623.4,kt22:14373.528,kt18:11873.784,kt14:9217.806,kt9:6249.36},
  {date:"2026-08-19",price10g:152839,priceGram:15283.9,kt22:14061.188,kt18:11615.764,kt14:9017.501,kt9:6113.56},
  {date:"2026-08-18",price10g:154502,priceGram:15450.2,kt22:14214.184,kt18:11742.152,kt14:9115.618,kt9:6180.08},
  {date:"2026-08-17",price10g:152965,priceGram:15296.5,kt22:14072.78,kt18:11625.34,kt14:9024.935,kt9:6118.6},
  {date:"2026-08-16",price10g:152965,priceGram:15296.5,kt22:14072.78,kt18:11625.34,kt14:9024.935,kt9:6118.6},
  {date:"2026-08-15",price10g:153036,priceGram:15303.6,kt22:14079.312,kt18:11630.736,kt14:9029.124,kt9:6121.44},
  {date:"2026-08-14",price10g:151850,priceGram:15185,kt22:13970.2,kt18:11540.6,kt14:8959.15,kt9:6074},
  {date:"2026-08-12",price10g:152100,priceGram:15210,kt22:13993.2,kt18:11559.6,kt14:8973.9,kt9:6084},
  {date:"2026-08-11",price10g:150676,priceGram:15067.6,kt22:13862.192,kt18:11451.376,kt14:8889.884,kt9:6027.04},
  {date:"2026-08-10",price10g:149950,priceGram:14995,kt22:13795.4,kt18:11396.2,kt14:8847.05,kt9:5998},
  {date:"2026-08-09",price10g:149950,priceGram:14995,kt22:13795.4,kt18:11396.2,kt14:8847.05,kt9:5998},
  {date:"2026-08-08",price10g:150140,priceGram:15014,kt22:13812.88,kt18:11410.64,kt14:8858.26,kt9:6005.6},
  {date:"2026-08-07",price10g:147442,priceGram:14744.2,kt22:13564.664,kt18:11205.592,kt14:8699.078,kt9:5897.68},
  {date:"2026-08-06",price10g:147011,priceGram:14701.1,kt22:13525.012,kt18:11172.836,kt14:8673.649,kt9:5880.44},
  {date:"2026-08-05",price10g:142564,priceGram:14256.4,kt22:13115.888,kt18:10834.864,kt14:8411.276,kt9:5702.56},
];

const G2D_CARD = D.g2dCard || [];
// Master Making Charge values live in gold_rates.g2d_making_charges (via
// pos-price-api's /g2d-config endpoint) -- editable from the panel below.
// G2D Range, G2D Band and Dis% are NOT editable and never change here.
const G2D_BAND_KEYS = ["supper_ultra_low","ultra_low","low","medium","high","ultra_high","supper_ultra_high","plain_gold"];
let G2D_CONFIG = G2D_CARD.map((r,i)=>({
  band_key: G2D_BAND_KEYS[i], sort_order: i+1, g2d_range: r.range, g2d_band: r.band,
  making_charge: parseFloat(String(r.makingCharges).replace(/[^\d.]/g,""))||0, dis_pct: r.discPct,
}));
function normBand(s){
  return String(s||"").trim().toUpperCase().replace(/JEWELRY/g,"JEWELLERY").replace(/\bSUPER\b/g,"SUPPER");
}
const G2D_INDEX = new Map(G2D_CARD.map((g,i)=>[normBand(g.band), i]));
function matchG2DIndex(remarks){
  if(remarks==null) return -1;
  const hit = G2D_INDEX.get(normBand(remarks));
  return hit==null ? -1 : hit;
}

function matchRateCardIndex(metalType, purity){
  const metal = (metalType||"").trim().toUpperCase();
  const purityKey = (purity||"").trim().toUpperCase();
  const idxs = [];
  for(let i=0;i<RATE_CARD.length;i++) if(RATE_CARD[i].metal===metal) idxs.push(i);
  if(!idxs.length) return -1;
  if(purityKey){
    const hit = idxs.find(i=>RATE_CARD[i].kt===purityKey);
    if(hit!==undefined) return hit;
    if(idxs.length===1) return idxs[0];
    return -1;
  }
  return idxs[0]; // blank purity: single-row metal (Platinum) or ambiguous default (Silver)
}

const ALL = new Array(D.rows.length);
for(let i=0;i<D.rows.length;i++){
  const r = D.rows[i];
  const metalType = r[1]!=null ? DICT.metal_type[r[1]] : null;
  const purity = r[2]!=null ? DICT.purity[r[2]] : null;
  const metalWeight = r[3], goldRate = r[4];
  ALL[i] = {
    itemCode: r[0], metalType, purity, metalWeight, goldRate,
    makingCharges: r[5], remarks: r[6]!=null ? DICT.remarks[r[6]] : null,
    s1Type: r[7]!=null ? DICT.stone_type[r[7]] : null, s1Pid: r[8]!=null ? DICT.stone_pricing_id[r[8]] : null, s1Qty:r[9], s1Wt:r[10],
    s2Type: r[11]!=null ? DICT.stone_type[r[11]] : null, s2Pid: r[12]!=null ? DICT.stone_pricing_id[r[12]] : null, s2Qty:r[13], s2Wt:r[14],
    s3Type: r[15]!=null ? DICT.stone_type[r[15]] : null, s3Pid: r[16]!=null ? DICT.stone_pricing_id[r[16]] : null, s3Qty:r[17], s3Wt:r[18],
    makingDiscount: r[19], diamondDiscount: r[20], rateFlagged: !!r[21],
    metalValue: (metalWeight!=null && goldRate!=null) ? metalWeight*goldRate : null,
    rcIdx: matchRateCardIndex(metalType, purity),
    stoneCount: (r[7]!=null?1:0)+(r[11]!=null?1:0)+(r[15]!=null?1:0),
    s1SlabIdx: -1, s2SlabIdx: -1, s3SlabIdx: -1
  };
  const rec = ALL[i];
  rec.s1SlabIdx = matchSlabIndex(rec.s1Pid);
  rec.s2SlabIdx = matchSlabIndex(rec.s2Pid);
  rec.s3SlabIdx = matchSlabIndex(rec.s3Pid);
  rec.g2dIdx = matchG2DIndex(rec.remarks);
}

/* ── state / filters ──────────────────────────────────────────────────── */
const STATE = { tab:"overview", search:"", filters:{metal:new Set(), purity:new Set(), stone:new Set()},
  sort:{col:null,dir:1}, page:1, pageSize:100, filtered:ALL, agg:null };

function applyFilters(){
  const f = STATE.filters, q = STATE.search.trim().toUpperCase();
  const hasMetal = f.metal.size>0, hasPurity = f.purity.size>0, hasStone = f.stone.size>0;
  STATE.filtered = ALL.filter(r=>{
    if(q && !(r.itemCode||"").toUpperCase().includes(q)) return false;
    if(hasMetal && !f.metal.has(r.metalType)) return false;
    if(hasPurity && !f.purity.has(r.purity)) return false;
    if(hasStone && !(f.stone.has(r.s1Type)||f.stone.has(r.s2Type)||f.stone.has(r.s3Type))) return false;
    return true;
  });
  STATE.page = 1;
  STATE.agg = computeAggregates(STATE.filtered);
}

/* ── aggregation (single pass, computed once per filter change, all tabs) ─*/
function computeAggregates(rows){
  const a = {
    count: rows.length, dataGaps: 0,
    sumWeight:0, sumValue:0, sumMaking:0, cntMaking:0, sumMakingDisc:0, cntMakingDisc:0, sumDiamondDisc:0, cntDiamondDisc:0,
    byMetal: new Map(), byPurity: new Map(), byRateCard: new Map(), bySlab: new Map(), byG2D: new Map(),
    weightBuckets: new Map(), makingCounts: new Map(), makingDiscCounts: new Map(), diamondDiscCounts: new Map(),
    stoneTypeCounts: new Map(), stonePidCounts: new Map(), stoneCountDist: new Map(), g2dUnmatched: new Map(),
    slabUnmatched: 0, slabOccurrences: 0,
    weights: []
  };
  const bump = (map,key,inc=1)=> map.set(key, (map.get(key)||0)+inc);
  const bumpObj = (map,key,fn)=>{ let o=map.get(key); if(!o){o={count:0,sumWeight:0,sumValue:0,sumMaking:0,cntMaking:0,totalQty:0}; map.set(key,o);} fn(o); };

  for(const r of rows){
    if(r.rateFlagged) a.dataGaps++;
    if(r.metalWeight!=null){ a.sumWeight+=r.metalWeight; a.weights.push(r.metalWeight);
      const b = r.metalWeight<0.5?"0–0.5g":r.metalWeight<1?"0.5–1g":r.metalWeight<1.5?"1–1.5g":r.metalWeight<2?"1.5–2g":r.metalWeight<3?"2–3g":r.metalWeight<5?"3–5g":"5g+";
      bump(a.weightBuckets,b); }
    if(r.metalValue!=null) a.sumValue+=r.metalValue;
    if(r.makingCharges!=null){ a.sumMaking+=r.makingCharges; a.cntMaking++; bump(a.makingCounts,r.makingCharges); }
    if(r.remarks!=null){
      if(r.g2dIdx>=0){ bumpObj(a.byG2D, r.g2dIdx, o=>{ o.count++; if(r.metalWeight!=null)o.sumWeight+=r.metalWeight; }); }
      else bump(a.g2dUnmatched, r.remarks);
    }
    if(r.makingDiscount!=null){ a.sumMakingDisc+=r.makingDiscount; a.cntMakingDisc++; bump(a.makingDiscCounts,r.makingDiscount); }
    if(r.diamondDiscount!=null){ a.sumDiamondDisc+=r.diamondDiscount; a.cntDiamondDisc++; bump(a.diamondDiscCounts,r.diamondDiscount); }
    bump(a.stoneCountDist, r.stoneCount);
    for(const [t,p] of [[r.s1Type,r.s1Pid],[r.s2Type,r.s2Pid],[r.s3Type,r.s3Pid]]){
      if(t!=null){ bump(a.stoneTypeCounts,t); if(p!=null) bump(a.stonePidCounts,t+" / "+p); }
    }
    for(const [type,slabIdx,qty,wt] of [[r.s1Type,r.s1SlabIdx,r.s1Qty,r.s1Wt],[r.s2Type,r.s2SlabIdx,r.s2Qty,r.s2Wt],[r.s3Type,r.s3SlabIdx,r.s3Qty,r.s3Wt]]){
      if(type==null) continue; // no stone in this slot
      a.slabOccurrences++;
      if(slabIdx>=0){ bumpObj(a.bySlab, slabIdx, o=>{ o.count++; if(qty!=null)o.totalQty+=qty; if(wt!=null)o.sumWeight+=wt; }); }
      else a.slabUnmatched++;
    }
    const mKey = r.metalType||"—";
    bumpObj(a.byMetal, mKey, o=>{ o.count++; if(r.metalWeight!=null)o.sumWeight+=r.metalWeight; if(r.metalValue!=null)o.sumValue+=r.metalValue; if(r.makingCharges!=null){o.sumMaking+=r.makingCharges;o.cntMaking++;} });
    const pKey = mKey+" "+(r.purity||"—");
    bumpObj(a.byPurity, pKey, o=>{ o.count++; if(r.metalWeight!=null)o.sumWeight+=r.metalWeight; if(r.metalValue!=null)o.sumValue+=r.metalValue; o.rate=r.goldRate; o.metal=mKey; o.purity=r.purity||"—"; });
    if(r.rcIdx>=0){ bumpObj(a.byRateCard, r.rcIdx, o=>{ o.count++; if(r.metalWeight!=null)o.sumWeight+=r.metalWeight; if(r.metalValue!=null)o.sumValue+=r.metalValue; }); }
  }
  a.weights.sort((x,y)=>x-y);
  a.avgWeight = a.weights.length? a.sumWeight/a.weights.length : 0;
  a.medWeight = a.weights.length? a.weights[Math.floor(a.weights.length/2)] : 0;
  a.minWeight = a.weights.length? a.weights[0] : 0;
  a.maxWeight = a.weights.length? a.weights[a.weights.length-1] : 0;
  a.avgMaking = a.cntMaking? a.sumMaking/a.cntMaking : 0;
  a.avgMakingDisc = a.cntMakingDisc? a.sumMakingDisc/a.cntMakingDisc : 0;
  a.avgDiamondDisc = a.cntDiamondDisc? a.sumDiamondDisc/a.cntDiamondDisc : 0;
  return a;
}

/* ── sidebar filter UI ────────────────────────────────────────────────── */
function distinctCounts(field){
  const m = new Map();
  for(const r of ALL){ const v = r[field]; if(v==null) continue; m.set(v,(m.get(v)||0)+1); }
  return [...m.entries()].sort((a,b)=>b[1]-a[1]);
}
function buildFilterPanel(){
  const stoneTypes = distinctCounts("s1Type");
  const stoneTypesAll = new Map();
  for(const r of ALL) for(const t of [r.s1Type,r.s2Type,r.s3Type]) if(t!=null) stoneTypesAll.set(t,(stoneTypesAll.get(t)||0)+1);
  const metals = distinctCounts("metalType");
  const purities = distinctCounts("purity");
  const stones = [...stoneTypesAll.entries()].sort((a,b)=>b[1]-a[1]);

  function group(title,key,items){
    const rows = items.map(([v,c])=>`<label><input type="checkbox" data-grp="${key}" value="${esc(v)}"> ${esc(v)}<span class="cc">${int(c)}</span></label>`).join("");
    return `<div class="fgrp"><label>${title}</label><div class="chklist">${rows}</div></div>`;
  }
  $("#fbody").innerHTML = group("Metal Type","metal",metals) + group("Purity","purity",purities) + group("Stone Type","stone",stones);
  $$("#fbody input[type=checkbox]").forEach(cb=>cb.addEventListener("change",()=>{
    const grp = cb.dataset.grp, set = STATE.filters[grp];
    cb.checked ? set.add(cb.value) : set.delete(cb.value);
    applyFilters(); renderActive(); updateFilterCount();
  }));
}
function updateFilterCount(){
  const n = STATE.filters.metal.size+STATE.filters.purity.size+STATE.filters.stone.size;
  $("#filterCount").textContent = n? n+" active" : "";
}

/* ── tabs ─────────────────────────────────────────────────────────────── */
const TABS = [
  {id:"overview", label:"Slab"},
  {id:"posprice", label:"Product Price"},
  {id:"variant", label:"Variant Level"},
  {id:"mto", label:"MTO Daily Margin"},
];
function buildNav(){
  $("#nav").innerHTML = TABS.map(t=>`<a data-tab="${t.id}" class="${t.id===STATE.tab?'on':''}">${t.label}</a>`).join("");
  $$("#nav a").forEach(a=>a.addEventListener("click",()=>{ STATE.tab=a.dataset.tab; STATE.page=1; buildNav(); renderActive(); }));
}

function barsHtml(entries,total,fmt=int){
  const max = Math.max(1,...entries.map(e=>e[1]));
  return `<div class="bars">`+entries.map(([k,v])=>`
    <div class="brow"><div class="nm" title="${esc(k)}">${esc(k)}</div>
    <div class="bar"><span style="width:${(v/max*100).toFixed(1)}%"></span></div>
    <div class="amt">${fmt(v)}${total?` <span class="muted" style="font-weight:500">(${pct(v/total*100)})</span>`:""}</div></div>`).join("")+`</div>`;
}
function insightBox(items){
  return `<div class="insight"><ul>${items.map(i=>`<li>${i}</li>`).join("")}</ul></div>`;
}

/* ── render: overview ─────────────────────────────────────────────────── */
function renderOverview(){
  $("#page-overview").innerHTML = `
    <div class="h2">Slab <span class="badge-date" style="margin-left:10px">as of <b id="slabAsOf">${esc(D.asOfDate||"—")}</b></span></div>
    <div class="sub">The Product Pricing sheet's 3 rate-card blocks — Metal Rate, G2D Making Charges, Diamond Slab — transcribed verbatim, no formula invented.</div>
    <div class="ratecard-grid" style="grid-template-columns:1fr 1.6fr">
      <div class="ratecard-panel">
        <div class="ratecard-head">Metal Rate <span style="font-weight:600;text-transform:none;letter-spacing:0;font-size:10.5px;opacity:.85">— gold rows follow Today's Entry</span></div>
        <table><thead><tr><th>Metal</th><th>KT</th><th>Purity%</th><th class="num">Rate</th></tr></thead>
        <tbody>${RATE_CARD.map(r=>`<tr><td>${esc(r.metal)}</td><td>${esc(r.kt)}</td><td>${esc(r.purityPct)}</td><td class="num" ${r.metal==="GOLD"?`id="mrate-${esc(r.kt)}"`:""}>${dec(r.rate,2)}</td></tr>`).join("")}</tbody></table>
      </div>
      <div class="ratecard-panel">
        <div class="ratecard-head">G2D Making Charges <span style="font-weight:600;text-transform:none;letter-spacing:0;font-size:10.5px;opacity:.85">— Making Charges editable</span></div>
        <table><thead><tr><th>G2D Range</th><th>G2D Band</th><th>Making Charges</th><th class="num">Dis%</th></tr></thead>
        <tbody id="g2dPanelBody"></tbody></table>
      </div>
    </div>
    <div class="grid two" style="margin-top:14px;align-items:start">
      <div class="card" style="max-width:420px">
        <h3>Today's Entry <span class="rt">Pos.metal_rates</span></h3>
        <div class="split-field">
          <label for="splitDate">Date</label>
          <input type="date" id="splitDate">
        </div>
        <div class="split-field">
          <label for="splitPrice">24K price / 10 g (₹)</label>
          <input type="number" id="splitPrice" step="1" placeholder="e.g. 155563">
          <div class="split-hint">Same figure as the <code>gold_999_price</code> column</div>
        </div>
        <div class="split-pergram" id="splitPerGram">24K per gram — enter a price</div>
        <button class="split-savebtn" id="splitSaveBtn" disabled>Save today's split</button>
        <div class="split-savemsg" id="splitSaveMsg"></div>
      </div>
      <div class="ratecard-panel">
        <div class="ratecard-head">Diamond Slab <span style="font-weight:600;text-transform:none;letter-spacing:0;font-size:10.5px;opacity:.85">— Disc% editable</span></div>
        <table><thead><tr><th>Code</th><th class="num">Rate</th><th class="num">Cost</th><th class="num">Disc%</th></tr></thead>
        <tbody id="slabPanelBody"></tbody></table>
      </div>
      <div class="ratecard-panel">
        <div class="ratecard-head">Labour <span style="font-weight:600;text-transform:none;letter-spacing:0;font-size:10.5px;opacity:.85">— Amount editable, drives Variant Level's CP. pr gm making</span></div>
        <table><thead><tr><th>Labour</th><th class="num">Amount</th></tr></thead>
        <tbody id="labourPanelBody"></tbody></table>
      </div>
      <div class="ratecard-panel">
        <div class="ratecard-head">Cash Back <span style="font-weight:600;text-transform:none;letter-spacing:0;font-size:10.5px;opacity:.85">— Discount % and Above (₹) editable, drives Variant Level's Cash Back, Additional Disc &amp; Margin2</span></div>
        <table><thead><tr><th>Category</th><th class="num">Above (₹)</th><th class="num">Discount %</th></tr></thead>
        <tbody id="cashBackPanelBody"></tbody></table>
      </div>
    </div>
    <div class="ratecard-panel" id="deployBarCard" style="margin-top:14px;padding:14px 16px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-weight:700;font-size:14px" id="deployPendingText">No pending changes</div>
          <div class="muted" style="font-size:11.5px;margin-top:2px" id="deployLastText">—</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn sm" id="deployDiscardBtn" type="button" style="display:none">Discard Changes</button>
          <button class="btn sm primary" id="deployBtn" type="button" disabled>Deploy &amp; Refresh Calculations</button>
        </div>
      </div>
      <div id="deployStatusLine" class="split-savemsg" style="margin-top:8px"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>Saved History <span class="rt" id="splitHistCount">${int(GOLD_HISTORY.length)} days saved</span></h3>
      <div class="sub" style="margin-bottom:10px">24K (999) price per 10g, split into KT rates using the Metal Rate sheet's purity multipliers — 22K 92%, 18K 76%, 14K 59%, 9K 40%. Live from <b>Pos.metal_rates</b> (the 'Gold' row, latest <code>from_date</code>) via gold-rate-api; a manual save on this browser overrides a given date locally, for preview only.</div>
      <div class="tbl-wrap" style="max-height:420px">
        <table><thead><tr><th>Date</th><th>24K / 10g</th><th>24K / g</th><th>22K</th><th>18K</th><th>14K</th><th>9K</th></tr></thead>
        <tbody id="splitHistBody"></tbody></table>
      </div>
    </div>`;
  setupGoldSplit();
  renderG2DPanel();
  if(!g2dConfigFetchStarted){ g2dConfigFetchStarted = true; fetchG2DConfig(); }
  renderSlabPanel();
  if(!slabConfigFetchStarted){ slabConfigFetchStarted = true; fetchSlabConfig(); }
  renderLabourPanel();
  if(!labourConfigFetchStarted){ labourConfigFetchStarted = true; fetchLabourConfig(); }
  renderCashBackPanel();
  if(!cashBackConfigFetchStarted){ cashBackConfigFetchStarted = true; fetchCashBackConfig(); }
  renderGlobalDeployBar();
  if(!deployHistoryFetchStarted){ deployHistoryFetchStarted = true; fetchDeployHistory(); }
}

/* ── Shared editable-master-table framework (G2D Making Charges, Diamond
   Slab, Labour) ──────────────────────────────────────────────────────────
   Clicking a cell's Edit reveals an input; typing writes ONLY into that
   panel's own draft object (e.g. G2D_DRAFT), never saved and never
   affecting any calculation. A panel's Apply bar appears the moment it has
   any draft entry ("● Unsaved changes") and Apply enables; clicking Apply
   validates every changed field, POSTs each changed row to its existing
   save endpoint, replaces that panel's CONFIG with the server's response,
   clears the draft, and re-renders -- at which point every dependent
   calculation (Product Price, Variant Level) picks up the new values on
   its next request, since they all already read these tables live. Cancel
   discards the draft and restores the last-saved values, no network call.
   Values shown are ALWAYS "effective" = draft override if present, else
   the last-saved CONFIG value -- so a re-render (e.g. switching tabs and
   back) never loses an in-progress edit. */
function editableCellHtml(rowKey, cellClass, effectiveValue, fmt, opts){
  const viewText = fmt ? fmt(effectiveValue) : effectiveValue;
  return `
    <span class="${cellClass}-view">${viewText}</span>
    <input type="number" class="${cellClass}-input" style="display:none;width:70px" value="${effectiveValue}" step="${opts.step}" min="${opts.min}" max="${opts.max||''}">
    <button class="${cellClass}-edit-btn btn sm" type="button" style="margin-left:6px">Edit</button>`;
}
// `editingSet` tracks which cells currently have their input box open (a
// Set of "rowKey:field" strings) -- separate from `draft`, which only holds
// FIELDS WHOSE VALUE ACTUALLY CHANGED. This is what lets the Apply bar
// appear as soon as you click Edit (so you always see where to commit),
// while Apply itself stays disabled until you've actually typed a
// different value -- merely opening a cell isn't "a change" yet.
function wireEditableCell(tr, rowKey, cellClass, field, draft, editingSet, onChange){
  const viewSpan = tr.querySelector(`.${cellClass}-view`);
  const input = tr.querySelector(`.${cellClass}-input`);
  const editBtn = tr.querySelector(`.${cellClass}-edit-btn`);
  editBtn.addEventListener("click", ()=>{
    viewSpan.style.display="none"; editBtn.style.display="none";
    input.style.display=""; input.focus(); input.select();
    editingSet.add(`${rowKey}:${field}`);
    onChange();
  });
  input.addEventListener("input", ()=>{
    const val = parseFloat(input.value);
    draft[rowKey] = draft[rowKey] || {};
    if(Number.isFinite(val)) draft[rowKey][field] = val; else delete draft[rowKey][field];
    if(!Object.keys(draft[rowKey]).length) delete draft[rowKey];
    onChange();
  });
}
function applyBarInnerHtml(applyBtnId, cancelBtnId, applyEnabled){
  return `<div style="display:flex;align-items:center;gap:10px;margin-top:10px;padding:8px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:9px">
    <span style="font-size:12px;font-weight:700;color:var(--warn)">● Unsaved changes</span>
    <span style="flex:1"></span>
    <button class="btn sm" id="${cancelBtnId}" type="button">Cancel</button>
    <button class="btn sm primary" id="${applyBtnId}" type="button" ${applyEnabled?"":"disabled"}>Apply</button>
  </div>`;
}
function setApplyMsg(msgId, text, cls){
  const el = document.getElementById(msgId);
  if(!el) return;
  el.textContent = text || "";
  el.className = "split-savemsg" + (cls ? (" "+cls) : "");
}
function anyUnsavedSlabChanges(){
  return Object.keys(G2D_DRAFT).length>0 || Object.keys(SLAB_DRAFT).length>0 || Object.keys(LABOUR_DRAFT).length>0
    || Object.keys(CASH_BACK_DRAFT).length>0;
}
window.addEventListener("beforeunload", e=>{
  if(anyUnsavedSlabChanges()){ e.preventDefault(); e.returnValue = ""; }
});

/* ── Diamond Slab: Disc% editable master table (pos-price-api /diamond-slab-config) */
let SLAB_CONFIG = SLAB_CARD.map(r=>({code:r.code, rate:r.rate, cost:r.cost, disc_pct:r.discPct}));
let SLAB_DRAFT = {}; // {code: {disc_pct}}
let SLAB_EDITING = new Set(); // "code:field" currently showing an input
let slabConfigFetchStarted = false;
async function fetchSlabConfig(){
  try{
    const res = await fetch(`${PP_API}/diamond-slab-config`);
    const data = await res.json();
    if(data.error || !Array.isArray(data.rows) || !data.rows.length) return;
    SLAB_CONFIG = data.rows;
    if(STATE.tab==="overview") renderSlabPanel();
  }catch(e){ /* network unavailable -- keep the sheet-seeded values */ }
}
function slabEffective(code, field){
  const d = SLAB_DRAFT[code];
  if(d && d[field]!==undefined) return d[field];
  const row = SLAB_CONFIG.find(r=>r.code===code);
  return row ? row[field] : null;
}
function renderSlabPanel(){
  const body = $("#slabPanelBody");
  if(!body) return;
  body.innerHTML = SLAB_CONFIG.map(r=>`
    <tr data-code="${esc(r.code)}">
      <td>${esc(r.code)}</td>
      <td class="num">${int(r.rate)}</td>
      <td class="num">${int(r.cost)}</td>
      <td class="pct">${editableCellHtml(r.code,"slab-dp",slabEffective(r.code,"disc_pct"),v=>int(v),{step:0.5,min:0,max:100})}</td>
    </tr>`).join("");
  $$("#slabPanelBody tr").forEach(tr=>{
    const code = tr.dataset.code;
    wireEditableCell(tr, code, "slab-dp", "disc_pct", SLAB_DRAFT, SLAB_EDITING, renderSlabApplyBar);
  });
  renderSlabApplyBar();
}
// Per-panel Apply/Cancel is replaced by ONE global "Deploy & Refresh
// Calculations" bar (see that section below) that batches every panel's
// draft together -- wireEditableCell's onChange callback still needs a
// per-panel hook to re-render after Edit/typing, so this stays as a thin
// delegator to the shared bar rather than removing it outright.
function renderSlabApplyBar(){ renderGlobalDeployBar(); }

/* ── Labour: editable master table (pos-price-api /labour-config) --
   single source of truth for Variant Level's "CP. pr gm making" column. */
let LABOUR_CONFIG = [
  {rate_key:"for_all", sort_order:1, label:"FOR ALL PRODUCTS", amount:900},
  {rate_key:"below_1_5", sort_order:2, label:"BELOW 1.5 GMS", amount:1500},
];
let LABOUR_DRAFT = {}; // {rate_key: {amount}}
let LABOUR_EDITING = new Set(); // "rate_key:field" currently showing an input
let labourConfigFetchStarted = false;
async function fetchLabourConfig(){
  try{
    const res = await fetch(`${PP_API}/labour-config`);
    const data = await res.json();
    if(data.error || !Array.isArray(data.rows) || !data.rows.length) return;
    LABOUR_CONFIG = data.rows;
    if(STATE.tab==="overview") renderLabourPanel();
  }catch(e){ /* network unavailable -- keep the seeded values */ }
}
function labourEffective(rateKey, field){
  const d = LABOUR_DRAFT[rateKey];
  if(d && d[field]!==undefined) return d[field];
  const row = LABOUR_CONFIG.find(r=>r.rate_key===rateKey);
  return row ? row[field] : null;
}
function renderLabourPanel(){
  const body = $("#labourPanelBody");
  if(!body) return;
  body.innerHTML = LABOUR_CONFIG.map(r=>`
    <tr data-key="${esc(r.rate_key)}">
      <td>${esc(r.label)}</td>
      <td class="num">${editableCellHtml(r.rate_key,"labour-amt",labourEffective(r.rate_key,"amount"),v=>int(v),{step:1,min:1})}</td>
    </tr>`).join("");
  $$("#labourPanelBody tr").forEach(tr=>{
    const rateKey = tr.dataset.key;
    wireEditableCell(tr, rateKey, "labour-amt", "amount", LABOUR_DRAFT, LABOUR_EDITING, renderLabourApplyBar);
  });
  renderLabourApplyBar();
}
function renderLabourApplyBar(){ renderGlobalDeployBar(); }

/* ── Cash Back: editable master table (pos-price-api /cash-back-config) --
   single source of truth for Variant Level's "Cash Back" column. Two
   editable fields per row (Above ₹ = threshold, Discount % = cash_back_pct),
   same two-field-per-row pattern as the G2D Making Charges panel. */
let CASH_BACK_CONFIG = [
  {rate_key:"plain_gold", sort_order:1, label:"Plain Gold", threshold:25000, cash_back_pct:3},
  {rate_key:"diamond", sort_order:2, label:"Diamond", threshold:25000, cash_back_pct:5},
];
let CASH_BACK_DRAFT = {}; // {rate_key: {threshold?, cash_back_pct?}}
let CASH_BACK_EDITING = new Set(); // "rate_key:field" currently showing an input
let cashBackConfigFetchStarted = false;
async function fetchCashBackConfig(){
  try{
    const res = await fetch(`${PP_API}/cash-back-config`);
    const data = await res.json();
    if(data.error || !Array.isArray(data.rows) || !data.rows.length) return;
    CASH_BACK_CONFIG = data.rows;
    if(STATE.tab==="overview") renderCashBackPanel();
  }catch(e){ /* network unavailable -- keep the seeded values */ }
}
function cashBackEffective(rateKey, field){
  const d = CASH_BACK_DRAFT[rateKey];
  if(d && d[field]!==undefined) return d[field];
  const row = CASH_BACK_CONFIG.find(r=>r.rate_key===rateKey);
  return row ? row[field] : null;
}
function renderCashBackPanel(){
  const body = $("#cashBackPanelBody");
  if(!body) return;
  body.innerHTML = CASH_BACK_CONFIG.map(r=>`
    <tr data-key="${esc(r.rate_key)}">
      <td>${esc(r.label)}</td>
      <td class="num">${editableCellHtml(r.rate_key,"cb-th",cashBackEffective(r.rate_key,"threshold"),v=>int(v),{step:1000,min:0})}</td>
      <td class="num">${editableCellHtml(r.rate_key,"cb-pct",cashBackEffective(r.rate_key,"cash_back_pct"),v=>int(v),{step:0.5,min:0,max:100})}</td>
    </tr>`).join("");
  $$("#cashBackPanelBody tr").forEach(tr=>{
    const rateKey = tr.dataset.key;
    wireEditableCell(tr, rateKey, "cb-th", "threshold", CASH_BACK_DRAFT, CASH_BACK_EDITING, renderCashBackApplyBar);
    wireEditableCell(tr, rateKey, "cb-pct", "cash_back_pct", CASH_BACK_DRAFT, CASH_BACK_EDITING, renderCashBackApplyBar);
  });
  renderCashBackApplyBar();
}
function renderCashBackApplyBar(){ renderGlobalDeployBar(); }

/* ── G2D Making Charges: editable master table (pos-price-api /g2d-config) */
let g2dConfigFetchStarted = false;
let G2D_DRAFT = {}; // {band_key: {making_charge?, dis_pct?}}
let G2D_EDITING = new Set(); // "band_key:field" currently showing an input
async function fetchG2DConfig(){
  try{
    const res = await fetch(`${PP_API}/g2d-config`);
    const data = await res.json();
    if(data.error || !Array.isArray(data.rows) || !data.rows.length) return;
    G2D_CONFIG = data.rows;
    if(STATE.tab==="overview") renderG2DPanel();
  }catch(e){ /* network unavailable -- keep the sheet-seeded values */ }
}
function g2dEffective(bandKey, field){
  const d = G2D_DRAFT[bandKey];
  if(d && d[field]!==undefined) return d[field];
  const row = G2D_CONFIG.find(r=>r.band_key===bandKey);
  return row ? row[field] : null;
}
function renderG2DPanel(){
  const body = $("#g2dPanelBody");
  if(!body) return;
  body.innerHTML = G2D_CONFIG.map(r=>`
    <tr data-band="${esc(r.band_key)}">
      <td>${esc(r.g2d_range)}</td>
      <td>${esc(r.g2d_band)}</td>
      <td>${editableCellHtml(r.band_key,"g2d-mc",g2dEffective(r.band_key,"making_charge"),v=>dec(v,0)+"/gm",{step:1,min:1})}</td>
      <td class="pct">${editableCellHtml(r.band_key,"g2d-dp",g2dEffective(r.band_key,"dis_pct"),v=>int(v),{step:0.5,min:0,max:100})}</td>
    </tr>`).join("");
  $$("#g2dPanelBody tr").forEach(tr=>{
    const bandKey = tr.dataset.band;
    wireEditableCell(tr, bandKey, "g2d-mc", "making_charge", G2D_DRAFT, G2D_EDITING, renderG2DApplyBar);
    wireEditableCell(tr, bandKey, "g2d-dp", "dis_pct", G2D_DRAFT, G2D_EDITING, renderG2DApplyBar);
  });
  renderG2DApplyBar();
}
function renderG2DApplyBar(){ renderGlobalDeployBar(); }

/* ── Deploy & Refresh Calculations: ONE button across every editable
   master table (G2D Making Charges / Diamond Slab / Labour / Cash Back),
   replacing the 4 separate per-panel Apply flows above. Collects every
   panel's *_DRAFT into a single batch, POSTs it to pos-price-api's
   /config-deploy, which validates the whole batch, writes every change
   (each *_update() already invalidates its own in-memory cache -- see the
   comments next to those functions in main.py), rebuilds the Variant
   Level/Product Price snapshot ONCE for the whole batch (not once per
   table), spot-checks real SKUs against it, and returns a versioned
   deployment record. Runs as a single long-lived request (same ~3-4 min
   the old per-panel Apply already took) rather than a separate async job
   queue -- the Cloud Function's own 1800s timeout covers it, and a
   browser fetch() just waits, unlike a short-timeout CLI client. */
let DEPLOYING = false;
let LAST_DEPLOYMENT = null;
let deployHistoryFetchStarted = false;

function combinedPendingChanges(){
  const out = [];
  for(const [bandKey, changes] of Object.entries(G2D_DRAFT)) out.push({table:"g2d", band_key:bandKey, ...changes});
  for(const [code, changes] of Object.entries(SLAB_DRAFT)) out.push({table:"diamond_slab", code, ...changes});
  for(const [rateKey, changes] of Object.entries(LABOUR_DRAFT)) out.push({table:"labour", rate_key:rateKey, ...changes});
  for(const [rateKey, changes] of Object.entries(CASH_BACK_DRAFT)) out.push({table:"cash_back", rate_key:rateKey, ...changes});
  return out;
}

async function fetchDeployHistory(){
  try{
    const res = await fetch(`${PP_API}/config-deploy`);
    const data = await res.json();
    if(Array.isArray(data.deployments) && data.deployments.length){
      LAST_DEPLOYMENT = data.deployments[0];
      renderGlobalDeployBar();
    }
  }catch(e){}
}

function fmtDeployTime(iso){
  if(!iso) return "—";
  try{ return new Date(iso).toLocaleString("en-IN", {dateStyle:"medium", timeStyle:"short"}); }
  catch(e){ return iso; }
}

function renderGlobalDeployBar(){
  const bar = $("#deployBarCard");
  if(!bar) return;
  const pending = combinedPendingChanges();
  const pendingText = $("#deployPendingText"), lastText = $("#deployLastText");
  const deployBtn = $("#deployBtn"), discardBtn = $("#deployDiscardBtn");
  if(!deployBtn || !discardBtn) return;
  if(!DEPLOYING){
    pendingText.textContent = pending.length
      ? `${pending.length} pending change${pending.length===1?"":"s"}` : "No pending changes";
    deployBtn.disabled = pending.length===0;
    deployBtn.textContent = "Deploy & Refresh Calculations";
    discardBtn.style.display = pending.length ? "" : "none";
  }
  if(LAST_DEPLOYMENT){
    const suffix = LAST_DEPLOYMENT.status==="SUCCESS" ? "" : " — failed, see status below";
    lastText.textContent = `Last deployed: ${LAST_DEPLOYMENT.version} at ${fmtDeployTime(LAST_DEPLOYMENT.deployed_at)}${suffix}`;
  } else {
    lastText.textContent = "No deployment recorded yet";
  }
  if(!deployBtn.dataset.wired){
    deployBtn.dataset.wired = "1";
    deployBtn.addEventListener("click", runDeploy);
    discardBtn.addEventListener("click", discardAllPendingChanges);
  }
}

function discardAllPendingChanges(){
  G2D_DRAFT = {}; G2D_EDITING.clear(); renderG2DPanel();
  SLAB_DRAFT = {}; SLAB_EDITING.clear(); renderSlabPanel();
  LABOUR_DRAFT = {}; LABOUR_EDITING.clear(); renderLabourPanel();
  CASH_BACK_DRAFT = {}; CASH_BACK_EDITING.clear(); renderCashBackPanel();
  const statusLine = $("#deployStatusLine");
  if(statusLine){ statusLine.textContent = ""; statusLine.className = "split-savemsg"; }
  renderGlobalDeployBar();
}

async function runDeploy(){
  const changes = combinedPendingChanges();
  if(!changes.length) return;
  DEPLOYING = true;
  const deployBtn = $("#deployBtn"), discardBtn = $("#deployDiscardBtn"), statusLine = $("#deployStatusLine");
  deployBtn.disabled = true;
  discardBtn.style.display = "none";
  statusLine.className = "split-savemsg";
  statusLine.textContent = "Saving configuration…";
  deployBtn.textContent = "Deploying…";

  const timers = [
    setTimeout(()=>{ statusLine.textContent = "Recalculating products…"; }, 2000),
    setTimeout(()=>{ statusLine.textContent = "Refreshing variant data… (this can take a few minutes)"; }, 15000),
  ];

  try{
    const res = await fetch(`${PP_API}/config-deploy`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({changes}),
    });
    const data = await res.json();
    timers.forEach(clearTimeout);
    if(data.error) throw new Error(data.error);
    LAST_DEPLOYMENT = data;
    if(data.status === "SUCCESS"){
      G2D_DRAFT = {}; G2D_EDITING.clear();
      SLAB_DRAFT = {}; SLAB_EDITING.clear();
      LABOUR_DRAFT = {}; LABOUR_EDITING.clear();
      CASH_BACK_DRAFT = {}; CASH_BACK_EDITING.clear();
      renderG2DPanel(); renderSlabPanel(); renderLabourPanel(); renderCashBackPanel();
      invalidateVariantSnapshot();
      statusLine.className = "split-savemsg ok";
      statusLine.textContent = `✓ Deployment completed — ${data.version}, ${int(data.product_price_rows)} products / `+
        `${int(data.variant_level_rows)} variants recalculated (${dec(data.duration_sec,1)}s). ${data.validation_detail||""}`;
    } else {
      statusLine.className = "split-savemsg err";
      statusLine.textContent = `Deployment failed — ${data.error_message||"unknown error"}`;
    }
  }catch(e){
    timers.forEach(clearTimeout);
    statusLine.className = "split-savemsg err";
    statusLine.textContent = `Deployment failed — ${e.message}`;
  }finally{
    DEPLOYING = false;
    renderGlobalDeployBar();
  }
}

/* ── gold purity split: local entry + calculator ─────────────────────────*/
const SPLIT_MULT = [
  {kt:"24K", pct:"pure", m:1.00},
  {kt:"22K", pct:"92",   m:0.92},
  {kt:"18K", pct:"76",   m:0.76},
  {kt:"14K", pct:"59",   m:0.59},
  {kt:"9K",  pct:"40",   m:0.40},
];
const SPLIT_LS_KEY = "lj_ppi_gold_split_history";
const GOLD_API = "https://gold-rate-api-3mvv5mdr2q-el.a.run.app";
// Seeded from the static GOLD_HISTORY snapshot until the live fetch below
// resolves -- fetchLiveGoldHistory() replaces this with real, current rows
// from Pos.metal_rates (including today, once entered), so this list never
// again goes stale the way the old hardcoded-only array did.
let LIVE_GOLD_HISTORY = GOLD_HISTORY;
let goldHistoryFetchStarted = false;
// setupGoldSplit() below sets this to its own renderPreview so a live fetch
// that resolves AFTER the initial (necessarily stale-seed) render can
// actually repaint the Metal Rate card -- without this hook, the card was
// stuck showing whichever gold rate was live at ppi_data.js's build time
// forever, since nothing ever re-ran renderPreview() after that one sync
// call in setupGoldSplit.
let _goldSplitRenderPreview = null;
let _goldSplitUserEdited = false; // true once the user manually touches date/price
async function fetchLiveGoldHistory(){
  try{
    const res = await fetch(`${GOLD_API}/?days=90`);
    const data = await res.json();
    if(data.error || !Array.isArray(data.rows) || !data.rows.length) return;
    LIVE_GOLD_HISTORY = data.rows;
    if(STATE.tab==="overview"){
      renderSplitHistory();
      const priceIn = $("#splitPrice"), dateIn = $("#splitDate");
      const latest = loadSplitHistory()[0];
      if(latest && priceIn && dateIn && !_goldSplitUserEdited){
        dateIn.value = latest.date;
        priceIn.value = latest.price10g;
        if(_goldSplitRenderPreview) _goldSplitRenderPreview();
      }
    }
  }catch(e){ /* network unavailable -- keep the static seed, no error surfaced */ }
}
function loadSplitHistory(){
  let saved = [];
  try{ saved = JSON.parse(localStorage.getItem(SPLIT_LS_KEY)||"[]"); }catch(e){ saved = []; }
  const byDate = new Map(LIVE_GOLD_HISTORY.map(r=>[r.date,r]));
  saved.forEach(r=>byDate.set(r.date,r));
  return [...byDate.values()].sort((a,b)=>b.date.localeCompare(a.date));
}
function renderSplitHistory(){
  const rows = loadSplitHistory();
  const body = $("#splitHistBody"), cnt = $("#splitHistCount");
  if(!body) return;
  cnt.textContent = int(rows.length)+" days saved";
  body.innerHTML = rows.map(r=>`<tr><td>${esc(r.date)}</td><td>${dec(r.price10g,0)}</td><td>${dec(r.priceGram,2)}</td><td>${dec(r.kt22,2)}</td><td>${dec(r.kt18,2)}</td><td>${dec(r.kt14,2)}</td><td>${dec(r.kt9,2)}</td></tr>`).join("");
}
function setupGoldSplit(){
  const dateIn = $("#splitDate"), priceIn = $("#splitPrice"), perGram = $("#splitPerGram");
  const saveBtn = $("#splitSaveBtn"), saveMsg = $("#splitSaveMsg");
  if(!dateIn) return;
  dateIn.value = new Date().toISOString().slice(0,10);
  const latest = loadSplitHistory()[0];
  if(latest) priceIn.value = latest.price10g;
  if(!goldHistoryFetchStarted){ goldHistoryFetchStarted = true; fetchLiveGoldHistory(); }

  function updateAsOfBadge(){
    const asOf = $("#slabAsOf");
    if(!asOf || !dateIn.value) return;
    const [y,m,d] = dateIn.value.split("-");
    asOf.textContent = `${d}/${m}/${y}`;
  }
  updateAsOfBadge();

  function splitFor(price10g){
    const perG = price10g/10;
    return SPLIT_MULT.map(k=>({...k, rate: perG*k.m}));
  }
  function renderPreview(){
    const price10g = parseFloat(priceIn.value);
    if(!price10g || price10g<=0){
      perGram.textContent = "24K per gram — enter a price";
      saveBtn.disabled = true;
      return;
    }
    const rows = splitFor(price10g);
    perGram.innerHTML = `24K per gram — <b>${rupee(rows[0].rate)}</b>`;
    saveBtn.disabled = false;
    rows.forEach(r=>{
      const cell = $("#mrate-"+r.kt);
      if(cell) cell.textContent = dec(r.rate,2);
      const rc = RATE_CARD.find(x=>x.metal==="GOLD" && x.kt===r.kt);
      if(rc) rc.rate = r.rate;
    });
  }
  _goldSplitRenderPreview = renderPreview;
  priceIn.addEventListener("input", ()=>{ _goldSplitUserEdited = true; renderPreview(); });
  dateIn.addEventListener("change", ()=>{
    _goldSplitUserEdited = true;
    const match = loadSplitHistory().find(r=>r.date===dateIn.value);
    priceIn.value = match ? match.price10g : "";
    updateAsOfBadge();
    renderPreview();
  });

  saveBtn.addEventListener("click", ()=>{
    const price10g = parseFloat(priceIn.value), date = dateIn.value;
    if(!price10g || !date) return;
    const rows = splitFor(price10g);
    const byKt = Object.fromEntries(rows.map(r=>[r.kt,r.rate]));
    let saved = [];
    try{ saved = JSON.parse(localStorage.getItem(SPLIT_LS_KEY)||"[]"); }catch(e){ saved = []; }
    saved = saved.filter(r=>r.date!==date);
    saved.push({date, price10g, priceGram: byKt["24K"], kt22: byKt["22K"], kt18: byKt["18K"], kt14: byKt["14K"], kt9: byKt["9K"]});
    try{
      localStorage.setItem(SPLIT_LS_KEY, JSON.stringify(saved));
      saveMsg.textContent = "Saved "+date+" to this browser.";
      saveMsg.className = "split-savemsg ok";
      renderSplitHistory();
    }catch(e){
      saveMsg.textContent = "Couldn't save (local storage unavailable).";
      saveMsg.className = "split-savemsg err";
    }
  });

  renderPreview();
  renderSplitHistory();
}

/* ── render: POS product price (lucirajewelry-prod.Pos.Product_price) ───*/
/* Live via pos-price-api. 368K rows -- fetched ONCE (fetchPosPriceAll) and
   held in browser memory, then every filter/search/page interaction is pure
   client-side array work, same "load once, filter client-side" pattern as
   Variant Level (see VL_STATE/vlFilteredRows above). Metal Amount / Selling
   Price / Overall Selling Price now come pre-computed from the backend's
   full=1 response (same merged_amount/selling_price/overall_selling_price
   Python functions the CSV export already used) rather than being
   recalculated client-side from RATE_CARD. See pos-price-api/README.md. */
const PP_API = "https://pos-price-api-3mvv5mdr2q-el.a.run.app";
// Both full=1 responses (Product Price + Variant Level) carry the same
// snapshot metadata (they're refreshed together, once a day at 12:01 PM
// IST -- see pos-price-api's refresh_snapshots/latest_snapshot_status).
// Whichever loads first paints the badge; the other's identical metadata
// is a harmless no-op repaint.
// The /?full=1 and /variant-level?full=1 endpoints don't return the
// dataset directly (it's ~8MB gzipped -- Cloud Functions/Run rejects
// responses over ~10MB) -- they return a small JSON envelope with a
// `snapshot_url` pointing at the pre-rendered gzip blob in GCS, which this
// fetches as a second step. A missing snapshot_url (should not normally
// happen) falls back to whatever `rows` the envelope itself carries, if any.
async function fetchFullDataset(endpointUrl){
  const envRes = await fetch(endpointUrl);
  const envelope = await envRes.json();
  if(envelope.error) throw new Error(envelope.error);
  if(envelope.snapshot_url){
    const dataRes = await fetch(envelope.snapshot_url);
    const data = await dataRes.json();
    if(data.error) throw new Error(data.error);
    return {rows: data.rows, snapshot: data.snapshot || envelope.snapshot};
  }
  return {rows: envelope.rows || [], snapshot: envelope.snapshot};
}
function renderSnapshotBadge(snap){
  const el = $("#snapshotBadge");
  if(!el) return;
  if(!snap){ el.textContent = ""; return; }
  const dateStr = new Date(snap.snapshot_date+"T00:00:00Z").toLocaleDateString("en-GB",
    {day:"2-digit", month:"short", year:"numeric", timeZone:"UTC"});
  const timeStr = new Date(snap.snapshot_created_at).toLocaleTimeString("en-IN",
    {hour:"2-digit", minute:"2-digit", hour12:true, timeZone:"Asia/Kolkata"});
  el.textContent = `Data Snapshot: ${dateStr} · Last Updated: ${timeStr} IST`;
}
const PP_STATE = { allRows:null, page:1, pageSize:50, loading:false, error:null, reqId:0 };
// {colKey: {type:'text', search:'', selected:Set<string>} | {type:'number', min:number|null, max:number|null}}
const PP_FILTERS = {};
const PP_COLS = [
  ["item_code","Item Code"], ["item_name","Item Name"], ["weight","Weight"], ["pieces","Pieces"],
  ["net_weight","Net Weight"], ["purity","Purity"], ["pure_weight","Pure Weight"], ["bom_rate","BOM Rate"],
  ["bom_base_amount","BOM Base Amount"], ["center_stone","Center Stone"], ["item_group_name","Item Group"],
  ["discount_pct","Making Discount %"], ["diamond_disc_pct","Diamond Disc%"],
  ["base_item","Base Item"], ["type_code","Type Code"], ["metal_name","Metal Name"], ["karat_code","Karat Code"],
  ["metal_color_code","Metal Color"], ["collection_name","Collection"], ["super_type_name","Super Type"],
  ["shape_name","Shape"], ["stone_size_id","Stone Size ID"], ["stone_size_name","Stone Size"],
  ["quality_name","Quality"], ["stone_color_name","Stone Color"], ["type_name","Type"],
  ["metal_amount","Metal Amount / SP per Ct"], ["Diamond_type","Diamond Type"], ["g2d_ratio","G2D Ratio"],
  ["making_charge_per_g","Making Charge /g"], ["Saleing_price","Selling Price"],
  ["overall_selling_price","Overall Selling Price"],
  ["carat_weight","Carat Weight"], ["purchase_rate","Purchase Rate"], ["purchase_amount","Pr.Ct Amount"],
  ["diamond_cp","Diamond CP"],
];
const PP_MONEY_COLS = new Set(["metal_amount","Saleing_price","overall_selling_price"]);
// Every numeric column gets a min/max range filter; everything else gets a
// search+checklist filter -- same rule Variant Level's filters use.
const PP_NUMERIC_COLS = new Set([
  "weight","pieces","net_weight","purity","pure_weight","bom_rate","bom_base_amount","center_stone",
  "discount_pct","diamond_disc_pct","stone_size_id","metal_amount","g2d_ratio","making_charge_per_g",
  "Saleing_price","overall_selling_price","carat_weight","purchase_rate","purchase_amount","diamond_cp",
]);
function ppCellValue(r,k){
  if(PP_MONEY_COLS.has(k)) return r[k]!=null ? dec(r[k],2) : "—";
  return esc(gone(r[k]));
}
// Plain-string form of a cell's value, used by filters (search/checklist
// match) -- NOT HTML, unlike ppCellValue.
function ppRawStr(r,k){
  const v = r[k];
  return (v==null || v==="") ? "" : String(v);
}
/* ── Excel-style column filters ──────────────────────────────────────────
   allRows is fetched ONCE (fetchPosPriceAll) then held in browser memory;
   every filter/search/page interaction below is pure client-side array
   work -- no BigQuery round-trip per click. Filters combine with AND
   across columns; row order is never touched. */
function ppFilterActive(f){
  return f.type==="number" ? (f.min!=null || f.max!=null) : ((f.selected && f.selected.size) || f.search);
}
function ppPassesFilter(r,k,f){
  if(f.type==="number"){
    const raw = r[k];
    const num = (raw==null||raw==="") ? null : Number(raw);
    if(f.min!=null && (num==null || num < f.min)) return false;
    if(f.max!=null && (num==null || num > f.max)) return false;
    return true;
  }
  const s = ppRawStr(r,k);
  if(f.selected && f.selected.size) return f.selected.has(s);
  if(f.search) return s.toLowerCase().includes(f.search.toLowerCase());
  return true;
}
function ppFilteredRows(){
  let rows = PP_STATE.allRows || [];
  const q = STATE.search.trim().toLowerCase();
  if(q){
    rows = rows.filter(r=>PP_COLS.some(([k])=>ppRawStr(r,k).toLowerCase().includes(q)));
  }
  const activeKeys = Object.keys(PP_FILTERS).filter(k=>ppFilterActive(PP_FILTERS[k]));
  if(activeKeys.length) rows = rows.filter(r=>activeKeys.every(k=>ppPassesFilter(r,k,PP_FILTERS[k])));
  return rows;
}
const _ppUniqueCache = new Map(); // colKey -> sorted string[] over the FULL dataset, computed once per load
function ppUniqueValuesFor(colKey){
  if(_ppUniqueCache.has(colKey)) return _ppUniqueCache.get(colKey);
  const set = new Set();
  (PP_STATE.allRows||[]).forEach(r=>{ const s=ppRawStr(r,colKey); if(s) set.add(s); });
  const vals = [...set].sort((a,b)=>a.localeCompare(b, undefined, {numeric:true}));
  _ppUniqueCache.set(colKey, vals);
  return vals;
}
function ppFilterChipsHtml(){
  const keys = Object.keys(PP_FILTERS).filter(k=>ppFilterActive(PP_FILTERS[k]));
  if(!keys.length) return "";
  const label = k=>{
    const f = PP_FILTERS[k], col = (PP_COLS.find(c=>c[0]===k)||[k,k])[1];
    if(f.type==="number"){
      const parts=[]; if(f.min!=null) parts.push(`≥ ${f.min}`); if(f.max!=null) parts.push(`≤ ${f.max}`);
      return `${col}: ${parts.join(" and ")}`;
    }
    if(f.selected && f.selected.size) return `${col}: ${[...f.selected].slice(0,3).join(", ")}${f.selected.size>3?` +${f.selected.size-3}`:""}`;
    return `${col}: "${f.search}"`;
  };
  return `<div class="vl-chipbar">${keys.map(k=>
    `<span class="vl-chip">${esc(label(k))}<button class="vl-chip-x pp-chip-x" data-col="${esc(k)}" title="Clear this filter">✕</button></span>`
  ).join("")}<button class="btn sm" id="ppClearAllBtn">Clear All Filters</button></div>`;
}
function ppHeaderCellHtml(k,l){
  const active = PP_FILTERS[k] && ppFilterActive(PP_FILTERS[k]);
  return `<th data-col="${esc(k)}">${l}<button class="vl-filter-btn pp-filter-btn${active?" on":""}" data-col="${esc(k)}" title="Filter ${esc(l)}">▾</button></th>`;
}
function ppTableHtml(){
  const loaded = PP_STATE.allRows!==null;
  const filtered = loaded ? ppFilteredRows() : [];
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total/PP_STATE.pageSize));
  if(PP_STATE.page>totalPages) PP_STATE.page = totalPages;
  if(PP_STATE.page<1) PP_STATE.page = 1;
  const from = total ? (PP_STATE.page-1)*PP_STATE.pageSize+1 : 0;
  const to = Math.min(PP_STATE.page*PP_STATE.pageSize, total);
  const pageRows = filtered.slice((PP_STATE.page-1)*PP_STATE.pageSize, (PP_STATE.page-1)*PP_STATE.pageSize+PP_STATE.pageSize);
  let body;
  if(PP_STATE.error){
    body = `<tr><td colspan="${PP_COLS.length}" class="muted" style="text-align:center;padding:20px">Couldn't load: ${esc(PP_STATE.error)}</td></tr>`;
  }else if(PP_STATE.loading || !loaded){
    body = `<tr><td colspan="${PP_COLS.length}" class="muted" style="text-align:center;padding:30px">Loading the full Product Price dataset (one-time per session)… 368K rows, first load can take a little while; after that, filtering is instant since it all happens in your browser.</td></tr>`;
  }else if(!pageRows.length){
    body = `<tr><td colspan="${PP_COLS.length}" class="muted" style="text-align:center;padding:20px">No rows match the current filters</td></tr>`;
  }else{
    body = pageRows.map(r=>`<tr>${PP_COLS.map(([k])=>`<td>${ppCellValue(r,k)}</td>`).join("")}</tr>`).join("");
  }
  return `
    <div class="h2" style="display:flex;align-items:center;gap:12px">Product Price
      <button class="btn sm" id="ppDownloadBtn" style="margin-left:auto">⭳ Download all (CSV)</button>
    </div>
    <div class="sub">Live from <b>lucirajewelry-prod.Pos.Product_price</b> via pos-price-api — all ${int(PP_COLS.length)} columns, one row per metal/stone line item. <b>Metal Amount</b> is computed per item code (Pure Weight × the Slab tab's Metal Rate for that karat) where the source column is blank. Click any column's ▾ to filter it.</div>
    ${ppFilterChipsHtml()}
    <div class="pager" style="justify-content:space-between;margin-bottom:8px">
      <span>${total? `Showing ${int(from)}–${int(to)} of ${int(total)}${loaded && total!==PP_STATE.allRows.length ? ` (filtered from ${int(PP_STATE.allRows.length)})`:""}` : (loaded?"No matches":"")}</span>
      <span>
        <button id="ppPrevBtn" ${PP_STATE.page<=1?"disabled":""}>‹ Prev</button>
        Page ${int(PP_STATE.page)} of ${int(totalPages)}
        <button id="ppNextBtn" ${PP_STATE.page>=totalPages?"disabled":""}>Next ›</button>
      </span>
    </div>
    <div class="tbl-wrap" style="max-height:70vh">
      <table><thead><tr>${PP_COLS.map(([k,l])=>ppHeaderCellHtml(k,l)).join("")}</tr></thead>
      <tbody>${body}</tbody></table>
    </div>
    <div id="ppFilterPop" class="vl-filterpop" style="display:none"></div>`;
}
function renderPosPrice(){
  $("#page-posprice").innerHTML = ppTableHtml();
  $("#ppDownloadBtn").addEventListener("click",downloadAllPosPriceCsv);
  const prevBtn = $("#ppPrevBtn"), nextBtn = $("#ppNextBtn");
  if(prevBtn) prevBtn.addEventListener("click",()=>{ if(PP_STATE.page>1){ PP_STATE.page--; renderPosPrice(); } });
  if(nextBtn) nextBtn.addEventListener("click",()=>{ PP_STATE.page++; renderPosPrice(); });
  $$(".pp-filter-btn").forEach(btn=>btn.addEventListener("click",e=>{ e.stopPropagation(); openPpFilterPopover(btn.dataset.col, btn); }));
  $$(".pp-chip-x").forEach(x=>x.addEventListener("click",()=>{ delete PP_FILTERS[x.dataset.col]; PP_STATE.page=1; renderPosPrice(); }));
  const clearAllBtn = $("#ppClearAllBtn");
  if(clearAllBtn) clearAllBtn.addEventListener("click",()=>{ Object.keys(PP_FILTERS).forEach(k=>delete PP_FILTERS[k]); PP_STATE.page=1; renderPosPrice(); });
  if(PP_STATE.allRows===null && !PP_STATE.loading && !PP_STATE.error) fetchPosPriceAll();
}
async function fetchPosPriceAll(){
  PP_STATE.loading = true; PP_STATE.error = null;
  const myReq = ++PP_STATE.reqId;
  if(STATE.tab==="posprice") $("#page-posprice").innerHTML = ppTableHtml();
  try{
    const data = await fetchFullDataset(`${PP_API}/?full=1`);
    if(myReq!==PP_STATE.reqId) return;
    PP_STATE.allRows = data.rows;
    _ppUniqueCache.clear();
    renderSnapshotBadge(data.snapshot);
  }catch(e){
    if(myReq!==PP_STATE.reqId) return;
    PP_STATE.error = e.message || "network error";
    PP_STATE.allRows = [];
  }finally{
    if(myReq===PP_STATE.reqId){
      PP_STATE.loading = false;
      if(STATE.tab==="posprice") renderPosPrice();
    }
  }
}
function downloadAllPosPriceCsv(){
  // Streamed straight from BigQuery by pos-price-api -- every row, not just
  // the loaded/filtered page. The browser handles the download natively, so
  // nothing is held in this tab's JS memory.
  window.location.href = `${PP_API}/?format=csv`;
}

/* ── Excel-style filter popover (one shared floating panel, positioned per
   column) -- same markup/behavior as Variant Level's, scoped to Product
   Price's own state/columns. ───────────────────────────────────────────*/
function closePpFilterPopover(){
  const pop = $("#ppFilterPop");
  if(pop){ pop.style.display = "none"; pop.innerHTML = ""; }
  document.removeEventListener("click", _ppPopOutsideHandler, true);
}
function _ppPopOutsideHandler(e){
  const pop = $("#ppFilterPop");
  if(pop && !pop.contains(e.target) && !e.target.classList.contains("pp-filter-btn")) closePpFilterPopover();
}
function openPpFilterPopover(colKey, anchorEl){
  const pop = $("#ppFilterPop");
  if(!pop) return;
  const isOpenForSameCol = pop.style.display!=="none" && pop.dataset.col===colKey;
  closePpFilterPopover();
  if(isOpenForSameCol) return; // clicking the same filter icon again just closes it
  const colLabel = (PP_COLS.find(c=>c[0]===colKey)||[colKey,colKey])[1];
  const isNumeric = PP_NUMERIC_COLS.has(colKey);
  const existing = PP_FILTERS[colKey] || (isNumeric ? {type:"number",min:null,max:null} : {type:"text",search:"",selected:new Set()});

  let html = `<div class="vl-fp-head">${esc(colLabel)}</div>`;
  if(isNumeric){
    html += `
      <div class="vl-fp-row"><label>Min<input type="number" id="ppFpMin" step="any" value="${existing.min!=null?existing.min:""}"></label></div>
      <div class="vl-fp-row"><label>Max<input type="number" id="ppFpMax" step="any" value="${existing.max!=null?existing.max:""}"></label></div>
      <div class="vl-fp-hint">Leave Min blank for "≤ Max" only, Max blank for "≥ Min" only, or set both equal for an exact match.</div>`;
  }else{
    const values = ppUniqueValuesFor(colKey);
    html += `<input type="text" id="ppFpSearch" placeholder="Search…" value="${esc(existing.search||"")}">
      <div class="vl-fp-actions"><a href="#" id="ppFpSelectAll">Select all shown</a><a href="#" id="ppFpClearSel">Clear selection</a></div>
      <div class="chklist vl-fp-list" id="ppFpList">${values.slice(0,300).map(v=>
        `<label data-v="${esc(v)}"><input type="checkbox" value="${esc(v)}" ${existing.selected.has(v)?"checked":""}> ${esc(v)}</label>`
      ).join("")}</div>
      ${values.length>300?'<div class="vl-fp-hint">Showing first 300 distinct values — use Search to narrow further.</div>':""}`;
  }
  html += `<div class="vl-fp-foot"><button class="btn sm" id="ppFpClear">Clear Filter</button><span style="flex:1"></span><button class="btn sm" id="ppFpCancel">Cancel</button><button class="btn sm primary" id="ppFpApply">Apply</button></div>`;
  pop.innerHTML = html;
  pop.dataset.col = colKey;

  const r = anchorEl.getBoundingClientRect();
  pop.style.display = "block";
  const popW = 260;
  let left = r.left + window.scrollX;
  if(left + popW > window.scrollX + document.documentElement.clientWidth - 8) left = window.scrollX + document.documentElement.clientWidth - popW - 8;
  pop.style.left = `${Math.max(8,left)}px`;
  pop.style.top = `${r.bottom + window.scrollY + 4}px`;

  if(!isNumeric){
    const search = $("#ppFpSearch"), list = $("#ppFpList");
    search.addEventListener("input",()=>{
      const q = search.value.trim().toLowerCase();
      $$("label",list).forEach(lb=>{ lb.style.display = lb.dataset.v.toLowerCase().includes(q) ? "" : "none"; });
    });
    search.focus();
    $("#ppFpSelectAll").addEventListener("click",e=>{ e.preventDefault(); $$("label",list).forEach(lb=>{ if(lb.style.display!=="none") lb.querySelector("input").checked=true; }); });
    $("#ppFpClearSel").addEventListener("click",e=>{ e.preventDefault(); $$("input[type=checkbox]",list).forEach(cb=>cb.checked=false); });
  }
  $("#ppFpCancel").addEventListener("click",closePpFilterPopover);
  $("#ppFpClear").addEventListener("click",()=>{ delete PP_FILTERS[colKey]; closePpFilterPopover(); PP_STATE.page=1; renderPosPrice(); });
  $("#ppFpApply").addEventListener("click",()=>{
    if(isNumeric){
      const minV = $("#ppFpMin").value.trim(), maxV = $("#ppFpMax").value.trim();
      const f = {type:"number", min: minV===""?null:Number(minV), max: maxV===""?null:Number(maxV)};
      if(ppFilterActive(f)) PP_FILTERS[colKey]=f; else delete PP_FILTERS[colKey];
    }else{
      const selected = new Set($$("#ppFpList input[type=checkbox]:checked").map(cb=>cb.value));
      const f = {type:"text", search: $("#ppFpSearch").value.trim(), selected};
      if(ppFilterActive(f)) PP_FILTERS[colKey]=f; else delete PP_FILTERS[colKey];
    }
    closePpFilterPopover();
    PP_STATE.page = 1;
    renderPosPrice();
  });
  setTimeout(()=>document.addEventListener("click", _ppPopOutsideHandler, true), 0);
}

/* ── render: Variant Level (one row per Product Price item_code, NOT per
   component) ─ Product Price above is component-level (a Variant/item_code
   can have several metal/stone rows). This tab collapses that to one row per
   Variant. The base list of WHICH variants appear is Product Price's own
   distinct item_code set (matches its count exactly) -- ds_imputed_reporting
   .items only fills in variant detail columns, never decides membership.
   Item Group is a per-variant classification (Diamond if it has any Diamond
   component, else Gold if it has a Gold component, else Other); Consignment
   variants (Item Name starting "Consignment") always sort last regardless of
   Item Group. The pricing waterfall (Metal Amount ... Final After GST
   Overall) is computed server-side per pos-price-api's _build_variant_row --
   see that function for the exact formulas; nothing is recalculated
   differently here on the frontend. */
// allRows === null until the one-time full load completes; after that every
// filter/page interaction is pure in-memory JS -- no further network calls.
const VL_STATE = { allRows:null, page:1, pageSize:50, loading:false, error:null, reqId:0 };
// {colKey: {type:'text', search:'', selected:Set<string>} | {type:'number', min:number|null, max:number|null}}
const VL_FILTERS = {};
// Called after a slab/labour/cash-back Apply whose LAST write reports
// snapshot_refreshed:true (pos-price-api rebuilds the snapshot synchronously
// on that write -- see _safe_refresh_snapshots). VL_STATE.allRows is loaded
// ONCE per session from that snapshot and never polled again on its own, so
// without this, an edit here would silently never show up in the Variant
// Level tab until the next scheduled noon rebuild.
function invalidateVariantSnapshot(){
  VL_STATE.allRows = null;
  VL_STATE.error = null;
  _vlUniqueCache.clear();
  if(STATE.tab==="variant") renderVariantLevel();
}
// Pricing waterfall (Metal/Diamond Amount -> Final After GST Overall) is all
// per-Variant arithmetic computed server-side (pos-price-api) -- see its
// _build_variant_row for the formulas. GST is a flat 3%. Pre-existing detail/
// reference columns are appended after the waterfall, unchanged. Status
// (Shopify) is inserted right after Item Name; Image (Shopify) is appended
// as the very last column -- both additive, nothing else reordered.
const VL_COLS = [
  ["item_code","Item Code"], ["product_composition","Product Composition"],
  ["item_name","Item Name"], ["image_url","Image"], ["status","Status"], ["item_group","Item Group"],
  ["net_weight","Net Weight"], ["weight","Weight"], ["diamond_weight","Diamond Weight"],
  ["purity","Purity"], ["g2d","G2D Ratio"], ["g2d_band","G2D Band"],
  ["metal_amount","Metal Amount"], ["diamond_amount","Diamond Amount"],
  ["overall_selling_price","Overall Selling Price"],
  ["making_charge_per_g","Making Charge /g"], ["making_amount","Making Amount"],
  ["before_gst_overall","Before GST Overall"],
  ["before_gst_value","Before GST Value"], ["original_after_gst_overall","Original After GST Overall"],
  ["making_discount_pct","Making Discount %"], ["making_discount_amount","Making Discount Amount"],
  ["net_making_amount","Net Making Amount"],
  ["diamond_disc_pct","Diamond Disc%"], ["diamond_discount_amount","Diamond Discount Amount"],
  ["net_diamond_amount","Net Diamond Amount"],
  ["after_discount","After Discount"], ["gst","GST"], ["final_after_gst_overall","Final After GST Overall"],
  ["total_diamond_cp","Total Diamond CP"],
  ["cp_pr_gm_making","CP. pr gm making"],
  ["total_cp_cost","Total CP Cost"],
  ["cash_back_pct","Cash Back"], ["final_amount_post_discount","Final Amount Post Discount"], ["margin_pct","Margin %"],
  ["additional_disc","Additional Disc"], ["margin2_pct","Margin2"],
];
const VL_MONEY_COLS = new Set([
  "metal_amount","diamond_amount","overall_selling_price","making_amount","before_gst_overall","before_gst_value",
  "original_after_gst_overall","making_discount_amount","net_making_amount","diamond_discount_amount",
  "net_diamond_amount","after_discount","gst","total_diamond_cp",
  "cp_pr_gm_making","total_cp_cost","additional_disc","final_amount_post_discount",
]);
// Every numeric column gets a min/max range filter; everything else (incl.
// Image, which isn't filterable) gets a search+checklist filter.
const VL_NUMERIC_COLS = new Set([
  ...VL_MONEY_COLS, "net_weight","weight","diamond_weight","purity","g2d",
  "making_discount_pct","diamond_disc_pct","margin_pct","final_after_gst_overall","cash_back_pct",
  "margin2_pct",
]);
const VL_STATUS_TONE = { active:"good", draft:"warn", archived:"muted" };
const G2D_BAND_TONE = {
  "Supper Ultra Low": "muted", "Ultra Low": "muted",
  "Low": "good",
  "Medium": "warn", "High": "warn",
  "Ultra High": "crit", "Supper Ultra High": "crit",
};
function normG2DBandKey(s){ return String(s||"").trim().toUpperCase(); }
const G2D_BAND_RANGE = new Map(G2D_CARD.map(g=>[normG2DBandKey(g.band), g.range]));
function vlCellValue(r,k){
  if(k==="status"){
    if(!r.status) return `<span class="muted">—</span>`;
    const tone = VL_STATUS_TONE[String(r.status).toLowerCase()] || "muted";
    return `<span class="pill ${tone}">${esc(r.status)}</span>`;
  }
  if(k==="image_url"){
    if(!r.image_url) return `<span class="muted">—</span>`;
    return `<img src="${esc(r.image_url)}" alt="" loading="lazy" style="width:38px;height:38px;object-fit:cover;border-radius:6px;border:1px solid var(--border);vertical-align:middle" onerror="this.replaceWith(document.createTextNode('—'))">`;
  }
  if((k==="weight"||k==="net_weight"||k==="diamond_weight"||k==="purity") && r[k]!=null) return dec(r[k],3);
  if(k==="final_after_gst_overall" && r[k]!=null) return int(r[k]); // rounded UP to the nearest whole rupee
  if(k==="g2d_band"){
    if(!r.g2d_band) return `<span class="muted">—</span>`;
    const range = G2D_BAND_RANGE.get(normG2DBandKey(r.g2d_band));
    return `<span class="pill ${G2D_BAND_TONE[r.g2d_band]||"muted"}" title="${esc(range?`G2D Range: ${range}`:r.g2d_band)}">${esc(r.g2d_band)}</span>`;
  }
  if(k==="margin_pct"||k==="margin2_pct") return r[k]==null ? `<span class="muted">—</span>` : `${dec(r[k],2)}%`;
  if(k==="cash_back_pct") return r[k]==null ? `<span class="muted">—</span>` : `${int(r[k])}%`;
  if(VL_MONEY_COLS.has(k) && r[k]!=null) return dec(r[k],2);
  if((k==="making_discount_pct"||k==="diamond_disc_pct") && r[k]!=null) return dec(r[k],1);
  if(k==="g2d" && r[k]!=null) return dec(r[k],4);
  return esc(gone(r[k]));
}
// Plain-string form of a cell's value, used by filters (search/checklist
// match) -- NOT HTML, unlike vlCellValue.
function vlRawStr(r,k){
  const v = r[k];
  return (v==null || v==="") ? "" : String(v);
}
/* ── Excel-style column filters ──────────────────────────────────────────
   allRows is fetched ONCE (fetchVariantAll) then held in browser memory;
   every filter/search/page interaction below is pure client-side array
   work -- no BigQuery round-trip per click. Filters combine with AND across
   columns; row order is never touched (Array.filter preserves it), so the
   server's Gold->Diamond->Other / Consignment-last sort survives filtering
   untouched (req. #11). */
function vlFilterActive(f){
  return f.type==="number" ? (f.min!=null || f.max!=null) : ((f.selected && f.selected.size) || f.search);
}
function vlPassesFilter(r,k,f){
  if(f.type==="number"){
    const raw = r[k];
    const num = (raw==null||raw==="") ? null : Number(raw);
    if(f.min!=null && (num==null || num < f.min)) return false;
    if(f.max!=null && (num==null || num > f.max)) return false;
    return true;
  }
  const s = vlRawStr(r,k);
  if(f.selected && f.selected.size) return f.selected.has(s);
  if(f.search) return s.toLowerCase().includes(f.search.toLowerCase());
  return true;
}
function vlFilteredRows(){
  let rows = VL_STATE.allRows || [];
  const q = STATE.search.trim().toLowerCase();
  if(q){
    rows = rows.filter(r=>`${r.item_code||""} ${r.item_name||""} ${r.item_group||""} ${r.status||""}`.toLowerCase().includes(q));
  }
  const activeKeys = Object.keys(VL_FILTERS).filter(k=>vlFilterActive(VL_FILTERS[k]));
  if(activeKeys.length) rows = rows.filter(r=>activeKeys.every(k=>vlPassesFilter(r,k,VL_FILTERS[k])));
  return rows;
}
const _vlUniqueCache = new Map(); // colKey -> sorted string[] over the FULL dataset, computed once per load
function vlUniqueValuesFor(colKey){
  if(_vlUniqueCache.has(colKey)) return _vlUniqueCache.get(colKey);
  const set = new Set();
  (VL_STATE.allRows||[]).forEach(r=>{ const s=vlRawStr(r,colKey); if(s) set.add(s); });
  const vals = [...set].sort((a,b)=>a.localeCompare(b, undefined, {numeric:true}));
  _vlUniqueCache.set(colKey, vals);
  return vals;
}
function vlFilterChipsHtml(){
  const keys = Object.keys(VL_FILTERS).filter(k=>vlFilterActive(VL_FILTERS[k]));
  if(!keys.length) return "";
  const label = k=>{
    const f = VL_FILTERS[k], col = (VL_COLS.find(c=>c[0]===k)||[k,k])[1];
    if(f.type==="number"){
      const parts=[]; if(f.min!=null) parts.push(`≥ ${f.min}`); if(f.max!=null) parts.push(`≤ ${f.max}`);
      return `${col}: ${parts.join(" and ")}`;
    }
    if(f.selected && f.selected.size) return `${col}: ${[...f.selected].slice(0,3).join(", ")}${f.selected.size>3?` +${f.selected.size-3}`:""}`;
    return `${col}: "${f.search}"`;
  };
  return `<div class="vl-chipbar">${keys.map(k=>
    `<span class="vl-chip">${esc(label(k))}<button class="vl-chip-x" data-col="${esc(k)}" title="Clear this filter">✕</button></span>`
  ).join("")}<button class="btn sm" id="vlClearAllBtn">Clear All Filters</button></div>`;
}
function vlHeaderCellHtml(k,l){
  const active = VL_FILTERS[k] && vlFilterActive(VL_FILTERS[k]);
  const filterable = k!=="image_url";
  return `<th data-col="${esc(k)}">${l}${filterable?`<button class="vl-filter-btn${active?" on":""}" data-col="${esc(k)}" title="Filter ${esc(l)}">▾</button>`:""}</th>`;
}
function vlTableHtml(){
  const loaded = VL_STATE.allRows!==null;
  const filtered = loaded ? vlFilteredRows() : [];
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total/VL_STATE.pageSize));
  if(VL_STATE.page>totalPages) VL_STATE.page = totalPages;
  if(VL_STATE.page<1) VL_STATE.page = 1;
  const from = total ? (VL_STATE.page-1)*VL_STATE.pageSize+1 : 0;
  const to = Math.min(VL_STATE.page*VL_STATE.pageSize, total);
  const pageRows = filtered.slice((VL_STATE.page-1)*VL_STATE.pageSize, (VL_STATE.page-1)*VL_STATE.pageSize+VL_STATE.pageSize);
  let body;
  if(VL_STATE.error){
    body = `<tr><td colspan="${VL_COLS.length}" class="muted" style="text-align:center;padding:20px">Couldn't load: ${esc(VL_STATE.error)}</td></tr>`;
  }else if(VL_STATE.loading || !loaded){
    body = `<tr><td colspan="${VL_COLS.length}" class="muted" style="text-align:center;padding:30px">Loading the full Variant Level dataset (one-time per session)… first load after a cache refresh can take a minute or two (full re-aggregation across every component row); after that, filtering is instant since it all happens in your browser.</td></tr>`;
  }else if(!pageRows.length){
    body = `<tr><td colspan="${VL_COLS.length}" class="muted" style="text-align:center;padding:20px">No variants match the current filters</td></tr>`;
  }else{
    body = pageRows.map(r=>`<tr>${VL_COLS.map(([k])=>`<td>${vlCellValue(r,k)}</td>`).join("")}</tr>`).join("");
  }
  return `
    <div class="h2" style="display:flex;align-items:center;gap:12px">Variant Level
      <button class="btn sm" id="vlDownloadBtn" style="margin-left:auto">⭳ Download all (CSV)</button>
    </div>
    <div class="sub">One row per Variant that exists in <b>Product Price</b> (not per component) — same variant count as that tab. Details come from <b>ds_imputed_reporting.items</b>; <b>Status</b>/<b>Image</b> come from Shopify (blank when a variant has no Shopify SKU match). Metal/Diamond Amount are summed from Product Price's component rows; Making Amount = Net Weight × Making Charge /g; GST is a flat 3%. Sorted Gold → Diamond → Other, with Consignment variants always last — filtering never changes that order. Click any column's ▾ to filter it.</div>
    ${vlFilterChipsHtml()}
    <div class="pager" style="justify-content:space-between;margin-bottom:8px">
      <span>${total? `Showing ${int(from)}–${int(to)} of ${int(total)}${loaded && total!==VL_STATE.allRows.length ? ` (filtered from ${int(VL_STATE.allRows.length)})`:""}` : (loaded?"No matches":"")}</span>
      <span>
        <button id="vlPrevBtn" ${VL_STATE.page<=1?"disabled":""}>‹ Prev</button>
        Page ${int(VL_STATE.page)} of ${int(totalPages)}
        <button id="vlNextBtn" ${VL_STATE.page>=totalPages?"disabled":""}>Next ›</button>
      </span>
    </div>
    <div class="tbl-wrap" style="max-height:70vh">
      <table><thead><tr>${VL_COLS.map(([k,l])=>vlHeaderCellHtml(k,l)).join("")}</tr></thead>
      <tbody>${body}</tbody></table>
    </div>
    <div id="vlFilterPop" class="vl-filterpop" style="display:none"></div>`;
}
function renderVariantLevel(){
  $("#page-variant").innerHTML = vlTableHtml();
  $("#vlDownloadBtn").addEventListener("click",downloadAllVariantCsv);
  const prevBtn = $("#vlPrevBtn"), nextBtn = $("#vlNextBtn");
  if(prevBtn) prevBtn.addEventListener("click",()=>{ if(VL_STATE.page>1){ VL_STATE.page--; renderVariantLevel(); } });
  if(nextBtn) nextBtn.addEventListener("click",()=>{ VL_STATE.page++; renderVariantLevel(); });
  $$(".vl-filter-btn").forEach(btn=>btn.addEventListener("click",e=>{ e.stopPropagation(); openVlFilterPopover(btn.dataset.col, btn); }));
  $$(".vl-chip-x").forEach(x=>x.addEventListener("click",()=>{ delete VL_FILTERS[x.dataset.col]; VL_STATE.page=1; renderVariantLevel(); }));
  const clearAllBtn = $("#vlClearAllBtn");
  if(clearAllBtn) clearAllBtn.addEventListener("click",()=>{ Object.keys(VL_FILTERS).forEach(k=>delete VL_FILTERS[k]); VL_STATE.page=1; renderVariantLevel(); });
  if(VL_STATE.allRows===null && !VL_STATE.loading && !VL_STATE.error) fetchVariantAll();
}
async function fetchVariantAll(){
  VL_STATE.loading = true; VL_STATE.error = null;
  const myReq = ++VL_STATE.reqId;
  if(STATE.tab==="variant") $("#page-variant").innerHTML = vlTableHtml();
  try{
    const data = await fetchFullDataset(`${PP_API}/variant-level?full=1`);
    if(myReq!==VL_STATE.reqId) return;
    VL_STATE.allRows = data.rows;
    _vlUniqueCache.clear();
    renderSnapshotBadge(data.snapshot);
  }catch(e){
    if(myReq!==VL_STATE.reqId) return;
    VL_STATE.error = e.message || "network error";
    VL_STATE.allRows = [];
  }finally{
    if(myReq===VL_STATE.reqId){
      VL_STATE.loading = false;
      if(STATE.tab==="variant") renderVariantLevel();
    }
  }
}
function downloadAllVariantCsv(){
  const q = STATE.search.trim();
  window.location.href = `${PP_API}/variant-level?q=${encodeURIComponent(q)}&format=csv`;
}

/* ── Excel-style filter popover (one shared floating panel, positioned per
   column) ────────────────────────────────────────────────────────────── */
function closeVlFilterPopover(){
  const pop = $("#vlFilterPop");
  if(pop){ pop.style.display = "none"; pop.innerHTML = ""; }
  document.removeEventListener("click", _vlPopOutsideHandler, true);
}
function _vlPopOutsideHandler(e){
  const pop = $("#vlFilterPop");
  if(pop && !pop.contains(e.target) && !e.target.classList.contains("vl-filter-btn")) closeVlFilterPopover();
}
function openVlFilterPopover(colKey, anchorEl){
  const pop = $("#vlFilterPop");
  if(!pop) return;
  const isOpenForSameCol = pop.style.display!=="none" && pop.dataset.col===colKey;
  closeVlFilterPopover();
  if(isOpenForSameCol) return; // clicking the same filter icon again just closes it
  const colLabel = (VL_COLS.find(c=>c[0]===colKey)||[colKey,colKey])[1];
  const isNumeric = VL_NUMERIC_COLS.has(colKey);
  const existing = VL_FILTERS[colKey] || (isNumeric ? {type:"number",min:null,max:null} : {type:"text",search:"",selected:new Set()});

  let html = `<div class="vl-fp-head">${esc(colLabel)}</div>`;
  if(isNumeric){
    html += `
      <div class="vl-fp-row"><label>Min<input type="number" id="vlFpMin" step="any" value="${existing.min!=null?existing.min:""}"></label></div>
      <div class="vl-fp-row"><label>Max<input type="number" id="vlFpMax" step="any" value="${existing.max!=null?existing.max:""}"></label></div>
      <div class="vl-fp-hint">Leave Min blank for "≤ Max" only, Max blank for "≥ Min" only, or set both equal for an exact match.</div>`;
  }else{
    const values = vlUniqueValuesFor(colKey);
    html += `<input type="text" id="vlFpSearch" placeholder="Search…" value="${esc(existing.search||"")}">
      <div class="vl-fp-actions"><a href="#" id="vlFpSelectAll">Select all shown</a><a href="#" id="vlFpClearSel">Clear selection</a></div>
      <div class="chklist vl-fp-list" id="vlFpList">${values.map(v=>
        `<label data-v="${esc(v)}"><input type="checkbox" value="${esc(v)}" ${existing.selected.has(v)?"checked":""}> ${esc(v)}</label>`
      ).join("")}</div>
      ${values.length>=300?'<div class="vl-fp-hint">Showing first 300 distinct values — use Search to narrow further.</div>':""}`;
  }
  html += `<div class="vl-fp-foot"><button class="btn sm" id="vlFpClear">Clear Filter</button><span style="flex:1"></span><button class="btn sm" id="vlFpCancel">Cancel</button><button class="btn sm primary" id="vlFpApply">Apply</button></div>`;
  pop.innerHTML = html;
  pop.dataset.col = colKey;

  const r = anchorEl.getBoundingClientRect();
  pop.style.display = "block";
  const popW = 260;
  let left = r.left + window.scrollX;
  if(left + popW > window.scrollX + document.documentElement.clientWidth - 8) left = window.scrollX + document.documentElement.clientWidth - popW - 8;
  pop.style.left = `${Math.max(8,left)}px`;
  pop.style.top = `${r.bottom + window.scrollY + 4}px`;

  if(!isNumeric){
    const search = $("#vlFpSearch"), list = $("#vlFpList");
    search.addEventListener("input",()=>{
      const q = search.value.trim().toLowerCase();
      $$("label",list).forEach(lb=>{ lb.style.display = lb.dataset.v.toLowerCase().includes(q) ? "" : "none"; });
    });
    search.focus();
    $("#vlFpSelectAll").addEventListener("click",e=>{ e.preventDefault(); $$("label",list).forEach(lb=>{ if(lb.style.display!=="none") lb.querySelector("input").checked=true; }); });
    $("#vlFpClearSel").addEventListener("click",e=>{ e.preventDefault(); $$("input[type=checkbox]",list).forEach(cb=>cb.checked=false); });
  }
  $("#vlFpCancel").addEventListener("click",closeVlFilterPopover);
  $("#vlFpClear").addEventListener("click",()=>{ delete VL_FILTERS[colKey]; closeVlFilterPopover(); VL_STATE.page=1; renderVariantLevel(); });
  $("#vlFpApply").addEventListener("click",()=>{
    if(isNumeric){
      const minV = $("#vlFpMin").value.trim(), maxV = $("#vlFpMax").value.trim();
      const f = {type:"number", min: minV===""?null:Number(minV), max: maxV===""?null:Number(maxV)};
      if(vlFilterActive(f)) VL_FILTERS[colKey]=f; else delete VL_FILTERS[colKey];
    }else{
      const selected = new Set($$("#vlFpList input[type=checkbox]:checked").map(cb=>cb.value));
      const f = {type:"text", search: $("#vlFpSearch").value.trim(), selected};
      if(vlFilterActive(f)) VL_FILTERS[colKey]=f; else delete VL_FILTERS[colKey];
    }
    closeVlFilterPopover();
    VL_STATE.page = 1;
    renderVariantLevel();
  });
  setTimeout(()=>document.addEventListener("click", _vlPopOutsideHandler, true), 0);
}

/* ── render: product details table (paginated, sortable) ────────────────*/
const DETAIL_COLS = [
  ["itemCode","Item Code"], ["metalType","Metal Type"], ["purity","Purity"], ["metalWeight","Metal Weight"],
  ["goldRate","Gold Rate"], ["makingCharges","Making Charges"],
  ["s1Type","Stone 1 Type"], ["s1Pid","Stone 1 Pricing ID"], ["s1Qty","Stone 1 Qty"], ["s1Wt","Stone 1 Weight"],
  ["s2Type","Stone 2 Type"], ["s2Pid","Stone 2 Pricing ID"], ["s2Qty","Stone 2 Qty"], ["s2Wt","Stone 2 Weight"],
  ["s3Type","Stone 3 Type"], ["s3Pid","Stone 3 Pricing ID"], ["s3Qty","Stone 3 Qty"], ["s3Wt","Stone 3 Weight"],
  ["makingDiscount","Making Ch. Discount"], ["diamondDiscount","Diamond Discount"], ["remarks","Remarks"],
];
function sortedFiltered(){
  const {col,dir} = STATE.sort;
  if(!col) return STATE.filtered;
  const arr = STATE.filtered.slice();
  arr.sort((a,b)=>{
    let x=a[col], y=b[col];
    if(x==null&&y==null) return 0; if(x==null) return 1; if(y==null) return -1;
    if(typeof x==="string") return x.localeCompare(y)*dir;
    return (x-y)*dir;
  });
  return arr;
}
function renderDetails(){
  const rows = sortedFiltered();
  const totalPages = Math.max(1,Math.ceil(rows.length/STATE.pageSize));
  STATE.page = Math.min(STATE.page,totalPages);
  const start = (STATE.page-1)*STATE.pageSize;
  const page = rows.slice(start,start+STATE.pageSize);
  const head = DETAIL_COLS.map(([k,l])=>`<th data-col="${k}" class="${STATE.sort.col===k?'sorted':''}">${l}${STATE.sort.col===k?(STATE.sort.dir>0?' ↑':' ↓'):''}</th>`).join("");
  const body = page.map(r=>`<tr>${DETAIL_COLS.map(([k])=>{
    let v = r[k];
    if(k==="goldRate") v = v!=null?rupee(v):"—";
    else if(k==="metalWeight"||k==="s1Wt"||k==="s2Wt"||k==="s3Wt") v = v!=null?dec(v,3)+" g":"—";
    else if(k==="makingCharges") v = v!=null?rupee(v):"—";
    else if(k==="makingDiscount"||k==="diamondDiscount") v = v!=null?pct(v):"—";
    else v = gone(v);
    return `<td>${esc(v)}</td>`;
  }).join("")}</tr>`).join("");
  $("#page-details").innerHTML = `
    <div class="h2">Product Details</div>
    <div class="sub">${int(rows.length)} SKUs matching current filters · showing ${int(start+1)}–${int(Math.min(start+STATE.pageSize,rows.length))}</div>
    <div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body||`<tr><td colspan="${DETAIL_COLS.length}" class="muted" style="text-align:center;padding:24px">No SKUs match the current filters.</td></tr>`}</tbody></table></div>
    <div class="pager">
      <span>Page ${STATE.page} of ${totalPages}</span>
      <button id="pgFirst" ${STATE.page<=1?"disabled":""}>« First</button>
      <button id="pgPrev" ${STATE.page<=1?"disabled":""}>‹ Prev</button>
      <button id="pgNext" ${STATE.page>=totalPages?"disabled":""}>Next ›</button>
      <button id="pgLast" ${STATE.page>=totalPages?"disabled":""}>Last »</button>
    </div>`;
  $$("#page-details th[data-col]").forEach(th=>th.addEventListener("click",()=>{
    const col = th.dataset.col;
    STATE.sort = STATE.sort.col===col ? {col,dir:-STATE.sort.dir} : {col,dir:1};
    renderDetails();
  }));
  const go=p=>{STATE.page=p;renderDetails();};
  $("#pgFirst")?.addEventListener("click",()=>go(1));
  $("#pgPrev")?.addEventListener("click",()=>go(STATE.page-1));
  $("#pgNext")?.addEventListener("click",()=>go(STATE.page+1));
  $("#pgLast")?.addEventListener("click",()=>go(totalPages));
}

/* ── render: metal type analysis ──────────────────────────────────────── */
function renderMetal(){
  const a = STATE.agg;
  const rows = [...a.byMetal.entries()].sort((x,y)=>y[1].count-x[1].count);
  $("#page-metal").innerHTML = `
    <div class="h2">Metal Type Analysis</div>
    <div class="sub">${int(rows.length)} metal type(s) in current filter</div>
    <div class="grid two">
      <div class="card"><h3>SKU Share by Metal Type</h3>${barsHtml(rows.map(([k,o])=>[k,o.count]),a.count)}</div>
      <div class="card"><h3>Metal Type Detail</h3><table><thead><tr><th>Metal</th><th>SKUs</th><th>Total Weight</th><th>Est. Value</th><th>Avg Making</th></tr></thead>
      <tbody>${rows.map(([k,o])=>`<tr><td>${esc(k)}</td><td>${int(o.count)}</td><td>${dec(o.sumWeight,1)} g</td><td>${money(o.sumValue)}</td><td>${rupee(o.cntMaking?o.sumMaking/o.cntMaking:0)}</td></tr>`).join("")}</tbody></table></div>
    </div>`;
}

/* ── render: purity analysis ──────────────────────────────────────────── */
function renderPurity(){
  const a = STATE.agg;
  const rows = [...a.byPurity.values()].sort((x,y)=>y.count-x.count);
  $("#page-purity").innerHTML = `
    <div class="h2">Purity Analysis</div>
    <div class="sub">${int(rows.length)} metal + purity combination(s) in current filter</div>
    <div class="grid two">
      <div class="card"><h3>SKU Share by Purity</h3>${barsHtml(rows.map(o=>[o.metal+" "+o.purity,o.count]),a.count)}</div>
      <div class="card"><h3>Purity Detail</h3><table><thead><tr><th>Metal</th><th>Purity</th><th>Gold Rate</th><th>SKUs</th><th>Total Weight</th><th>Est. Value</th></tr></thead>
      <tbody>${rows.map(o=>`<tr><td>${esc(o.metal)}</td><td>${esc(o.purity)}</td><td>${o.rate!=null?rupee(o.rate):"—"}</td><td>${int(o.count)}</td><td>${dec(o.sumWeight,1)} g</td><td>${money(o.sumValue)}</td></tr>`).join("")}</tbody></table></div>
    </div>`;
}

/* ── render: gold rate ────────────────────────────────────────────────── */
function renderRate(){
  const a = STATE.agg;
  const cardRows = RATE_CARD.map((rc,i)=>({...rc, agg:a.byRateCard.get(i)||{count:0,sumWeight:0,sumValue:0}}));
  $("#page-rate").innerHTML = `
    <div class="h2">Gold Rate <span class="badge-date" style="margin-left:10px">as of <b>${esc(D.asOfDate||"—")}</b></span></div>
    <div class="sub">Sourced verbatim from the <b>Product Pricing</b> Google Sheet, "Metal Rate" block — Metal / KT / Purity% / Rate. Matched to each SKU by Metal Type + Purity(KT), the exact join the sheet itself implies.</div>
    <div class="card" style="margin-bottom:14px">
      <h3>Rate Card <span class="rt">SKUs mapped in current filter</span></h3>
      <table><thead><tr><th>Metal</th><th>KT</th><th>Purity%</th><th>Rate</th><th>SKUs</th><th>Total Weight</th><th>Est. Value</th></tr></thead>
      <tbody>${cardRows.map(r=>`<tr><td>${esc(r.metal)}</td><td>${esc(r.kt)}</td><td>${esc(r.purityPct)}</td><td>${rupee(r.rate)}</td><td>${int(r.agg.count)}</td><td>${dec(r.agg.sumWeight,1)} g</td><td>${money(r.agg.sumValue)}</td></tr>`).join("")}</tbody></table>
    </div>
    ${a.dataGaps>0 ? `<div class="note">⚠ <b>${int(a.dataGaps)}</b> SKU(s) in the current filter have a metal type with more than one sheet row (Silver: 999 vs 92.5) and no purity value on the product to disambiguate — the rate shown defaults to the first matching sheet row for that metal. Not hidden, just flagged.</div>` : ""}
  `;
}

/* ── render: metal weight ─────────────────────────────────────────────── */
function renderWeight(){
  const a = STATE.agg;
  const buckets = ["0–0.5g","0.5–1g","1–1.5g","1.5–2g","2–3g","3–5g","5g+"].map(k=>[k,a.weightBuckets.get(k)||0]);
  $("#page-weight").innerHTML = `
    <div class="h2">Metal Weight</div>
    <div class="sub">${int(a.weights.length)} SKUs with a recorded metal weight</div>
    <div class="grid kpis" style="margin-bottom:16px">
      <div class="card kpi"><div class="lbl">Total Weight</div><div class="val">${dec(a.sumWeight,1)} g</div></div>
      <div class="card kpi"><div class="lbl">Avg Weight / SKU</div><div class="val">${dec(a.avgWeight,3)} g</div></div>
      <div class="card kpi"><div class="lbl">Median Weight</div><div class="val">${dec(a.medWeight,3)} g</div></div>
      <div class="card kpi"><div class="lbl">Min / Max</div><div class="val" style="font-size:18px">${dec(a.minWeight,3)} – ${dec(a.maxWeight,3)} g</div></div>
    </div>
    <div class="card"><h3>Weight Distribution</h3>${barsHtml(buckets,a.weights.length)}</div>`;
}

/* ── render: making charges ───────────────────────────────────────────── */
function renderMaking(){
  const a = STATE.agg;
  const rows = [...a.makingCounts.entries()].sort((x,y)=>x[0]-y[0]);
  $("#page-making").innerHTML = `
    <div class="h2">Making Charges</div>
    <div class="sub">${int(a.cntMaking)} SKUs with a recorded making charge</div>
    <div class="grid kpis" style="margin-bottom:16px">
      <div class="card kpi"><div class="lbl">Avg Making Charge / g</div><div class="val">${rupee(a.avgMaking)}</div></div>
      <div class="card kpi"><div class="lbl">Distinct Rates</div><div class="val">${int(rows.length)}</div></div>
    </div>
    <div class="card"><h3>Making Charge / g — Distribution</h3>${barsHtml(rows.map(([k,v])=>[rupee(k)+"/g",v]),a.cntMaking)}</div>`;
}

/* ── render: stone details ────────────────────────────────────────────── */
function renderStones(){
  const a = STATE.agg;
  const typeRows = [...a.stoneTypeCounts.entries()].sort((x,y)=>y[1]-x[1]);
  const pidRows = [...a.stonePidCounts.entries()].sort((x,y)=>y[1]-x[1]).slice(0,15);
  const distRows = [0,1,2,3].map(k=>[k+" stone(s)", a.stoneCountDist.get(k)||0]);
  $("#page-stones").innerHTML = `
    <div class="h2">Stone Details</div>
    <div class="sub">Across Stone 1 / 2 / 3 slots on ${int(a.count)} SKUs</div>
    <div class="grid two">
      <div class="card"><h3>Stone Type Occurrences</h3>${barsHtml(typeRows,null)}</div>
      <div class="card"><h3>SKUs by Stone Count</h3>${barsHtml(distRows,a.count)}</div>
    </div>
    <div class="card" style="margin-top:14px"><h3>Top Stone Type / Pricing ID Combinations</h3>${barsHtml(pidRows,null)}</div>`;
}

/* ── render: discounts ─────────────────────────────────────────────────── */
function renderDiscounts(){
  const a = STATE.agg;
  const mRows = [...a.makingDiscCounts.entries()].sort((x,y)=>x[0]-y[0]);
  const dRows = [...a.diamondDiscCounts.entries()].sort((x,y)=>x[0]-y[0]);
  $("#page-discounts").innerHTML = `
    <div class="h2">Discounts</div>
    <div class="sub">Making-charge and diamond discount configuration across current filter</div>
    <div class="grid kpis" style="margin-bottom:16px">
      <div class="card kpi"><div class="lbl">Avg Making Ch. Discount</div><div class="val">${pct(a.avgMakingDisc)}</div></div>
      <div class="card kpi"><div class="lbl">Avg Diamond Discount</div><div class="val">${pct(a.avgDiamondDisc)}</div></div>
    </div>
    <div class="grid two">
      <div class="card"><h3>Making Charge Discount %</h3>${barsHtml(mRows.map(([k,v])=>[pct(k),v]),a.cntMakingDisc)}</div>
      <div class="card"><h3>Diamond Discount %</h3>${barsHtml(dRows.map(([k,v])=>[pct(k),v]),a.cntDiamondDisc)}</div>
    </div>`;
}

/* ── MTO Daily Margin ─────────────────────────────────────────────────────
   Reuses the EXISTING Sales Analytics fact (sales_dashboard.sales_reporting,
   sale_type='MTO') + its existing SKU-then-style cost fallback
   (cost_reference / cost_reference_style) via pos-price-api's
   /mto-daily-margin -- NOT a second pricing engine, and not the Product
   Price/Variant Level pipeline (this reports what an MTO order actually
   sold for and cost, not a catalog SKU's list price). Cost/Margin are
   blank (never guessed) for any SKU/style the cost tables don't cover. */
const MTO_STATE = { date:null, availableDates:[], rows:null, loading:false, error:null };
function mtoFmtDateLong(iso){
  if(!iso) return "";
  const [y,m,d] = iso.split("-");
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${parseInt(d,10)} ${months[parseInt(m,10)-1]} ${y}`;
}
function mtoRowHtml(r){
  const marginCls = r.margin_amt==null ? "" : (r.margin_amt<0 ? ` style="color:var(--crit)"` : "");
  return `<tr>
    <td>${esc(r.document_no)}</td>
    <td>${esc(r.sku)}</td>
    <td>${esc(r.product_name)}</td>
    <td>${esc(r.store||"")}</td>
    <td class="num">${dec(r.gross,2)}</td>
    <td class="num">${dec(r.discount,2)}</td>
    <td class="num">${dec(r.net,2)}</td>
    <td class="num">${r.cost==null?`<span class="muted">—</span>`:dec(r.cost,2)}</td>
    <td class="num"${marginCls}>${r.margin_amt==null?`<span class="muted">—</span>`:dec(r.margin_amt,2)}</td>
    <td class="num"${marginCls}>${r.margin_pct==null?`<span class="muted">—</span>`:dec(r.margin_pct,2)+"%"}</td>
  </tr>`;
}
function mtoTableHtml(){
  const rows = MTO_STATE.rows;
  const opts = (MTO_STATE.availableDates||[]).map(d=>`<option value="${d}" ${d===MTO_STATE.date?"selected":""}>${d}</option>`).join("");
  let body;
  if(MTO_STATE.loading) body = `<tr><td colspan="10" class="muted" style="padding:20px;text-align:center">Loading…</td></tr>`;
  else if(MTO_STATE.error) body = `<tr><td colspan="10" style="padding:20px;text-align:center;color:var(--crit)">${esc(MTO_STATE.error)}</td></tr>`;
  else if(!rows || !rows.length) body = `<tr><td colspan="10" class="muted" style="padding:20px;text-align:center">No MTO sales for this date.</td></tr>`;
  else body = rows.map(mtoRowHtml).join("");

  let totalsRow = "";
  if(rows && rows.length){
    const sum = (k)=>rows.reduce((a,r)=>a+(r[k]==null?0:r[k]),0);
    const totGross = sum("gross"), totDisc = sum("discount"), totNet = sum("net");
    const withCost = rows.filter(r=>r.cost!=null);
    const totCost = withCost.reduce((a,r)=>a+r.cost,0);
    const totMargin = withCost.reduce((a,r)=>a+(r.margin_amt||0),0);
    const totMarginPct = totNet ? (totMargin/totNet*100) : null;
    totalsRow = `<tr style="font-weight:700;border-top:2px solid var(--border)">
      <td colspan="4">Total (${int(rows.length)} line${rows.length===1?"":"s"}${withCost.length<rows.length?`, cost known for ${int(withCost.length)}`:""})</td>
      <td class="num">${dec(totGross,2)}</td>
      <td class="num">${dec(totDisc,2)}</td>
      <td class="num">${dec(totNet,2)}</td>
      <td class="num">${withCost.length?dec(totCost,2):`<span class="muted">—</span>`}</td>
      <td class="num"${totMargin<0?` style="color:var(--crit)"`:""}>${withCost.length?dec(totMargin,2):`<span class="muted">—</span>`}</td>
      <td class="num"${totMargin<0?` style="color:var(--crit)"`:""}>${totMarginPct==null?`<span class="muted">—</span>`:dec(totMarginPct,2)+"%"}</td>
    </tr>`;
  }

  return `
    <div id="mtoPrintHead">
      <h2>MTO Daily Margin Report — ${esc(mtoFmtDateLong(MTO_STATE.date))}</h2>
      <div class="sub">Lucira Jewelry — Made-To-Order sales, cost & margin</div>
    </div>
    <div class="h2 no-print">MTO Daily Margin</div>
    <div class="sub no-print">Made-To-Order sales for a selected day — cost from the existing SKU-then-style cost reference, margin computed the same way as the Sales dashboard.</div>
    <div class="card no-print" style="margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <label style="font-size:12.5px;font-weight:700;color:var(--ink-2)">Date
        <select id="mtoDateSelect" style="margin-left:8px">${opts}</select>
      </label>
      <span style="flex:1"></span>
      <button class="btn sm primary" id="mtoPrintBtn" type="button">🖨 Print</button>
    </div>
    <div class="card">
      <div class="tbl-wrap">
        <table>
          <thead><tr>
            <th>Order/Invoice No.</th><th>SKU</th><th>Product Name</th><th>Store</th>
            <th class="num">Selling Amount</th><th class="num">Discount</th><th class="num">Net Amount</th>
            <th class="num">Cost</th><th class="num">Margin Amount</th><th class="num">Margin %</th>
          </tr></thead>
          <tbody>${body}${totalsRow}</tbody>
        </table>
      </div>
    </div>`;
}
async function fetchMTO(dateStr){
  MTO_STATE.loading = true; MTO_STATE.error = null;
  if(STATE.tab==="mto") $("#page-mto").innerHTML = mtoTableHtml();
  try{
    const url = dateStr ? `${PP_API}/mto-daily-margin?date=${encodeURIComponent(dateStr)}` : `${PP_API}/mto-daily-margin`;
    const res = await fetch(url);
    const data = await res.json();
    if(data.error) throw new Error(data.error);
    MTO_STATE.date = data.date;
    MTO_STATE.availableDates = data.available_dates || [];
    MTO_STATE.rows = data.rows || [];
  }catch(e){
    MTO_STATE.error = e.message || "network error";
    MTO_STATE.rows = [];
  }finally{
    MTO_STATE.loading = false;
    if(STATE.tab==="mto") renderMTO();
  }
}
function renderMTO(){
  $("#page-mto").innerHTML = mtoTableHtml();
  const sel = $("#mtoDateSelect");
  if(sel) sel.addEventListener("change", ()=>fetchMTO(sel.value));
  const printBtn = $("#mtoPrintBtn");
  if(printBtn) printBtn.addEventListener("click", ()=>window.print());
  if(MTO_STATE.rows===null && !MTO_STATE.loading) fetchMTO();
}

const RENDERERS = { overview:renderOverview, details:renderDetails, metal:renderMetal, purity:renderPurity, rate:renderRate, weight:renderWeight, making:renderMaking, stones:renderStones, discounts:renderDiscounts, posprice:renderPosPrice, variant:renderVariantLevel, mto:renderMTO };
function renderActive(){ RENDERERS[STATE.tab](); }

/* ── boot ─────────────────────────────────────────────────────────────── */
function buildPages(){
  $("#pages").innerHTML = TABS.map(t=>`<div class="page ${t.id===STATE.tab?'on':''}" id="page-${t.id}"></div>`).join("");
}
function showTabPages(){
  $$(".page").forEach(p=>p.classList.toggle("on", p.id==="page-"+STATE.tab));
}
const _renderActiveOrig = renderActive;
renderActive = function(){ showTabPages(); _renderActiveOrig(); };

document.addEventListener("DOMContentLoaded", ()=>{
  buildNav(); buildPages(); buildFilterPanel();
  applyFilters(); renderActive();
  $("#statusDot").classList.remove("demo");
  $("#statusText").textContent = `${int(D.rowCount)} SKUs · rate as of ${D.asOfDate||"—"}`;

  $("#toggleFilters").addEventListener("click",()=>document.body.classList.toggle("filters-collapsed"));
  $("#clearFilters").addEventListener("click",()=>{
    STATE.filters.metal.clear(); STATE.filters.purity.clear(); STATE.filters.stone.clear();
    $$("#fbody input[type=checkbox]").forEach(cb=>cb.checked=false);
    applyFilters(); renderActive(); updateFilterCount();
  });
  let searchTimer;
  $("#itemSearch").addEventListener("input",e=>{
    clearTimeout(searchTimer);
    searchTimer = setTimeout(()=>{
      STATE.search = e.target.value; applyFilters();
      if(STATE.tab==="posprice"){ PP_STATE.page=1; } // client-side filter, just re-render below
      if(STATE.tab==="variant"){ VL_STATE.page=1; } // client-side filter, just re-render below
      renderActive();
    }, 300);
  });
  $("#themeBtn").addEventListener("click",()=>{
    document.body.classList.toggle("light");
    try{ localStorage.setItem("lj_ppi_theme", document.body.classList.contains("light")?"light":"dark"); }catch(e){}
  });
  try{ if(localStorage.getItem("lj_ppi_theme")==="light") document.body.classList.add("light"); }catch(e){}
});
