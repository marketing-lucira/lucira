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
  diamond_dis_pct: 0,
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
  {id:"posprice", label:"Ornaverse BOM Wise"},
  {id:"variant", label:"Ornaverse Variant"},
  {id:"style", label:"Ornaverse Product Default"},
  {id:"shopify", label:"Shopify"},
  {id:"invmargin", label:"Inventory Margin"},
  {id:"margin", label:"Margin"},
  {id:"mto", label:"MTO Daily Margin"},
  {id:"health", label:"Daily Check"},
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
    <div class="sub">Rate cards that drive the pricing — Metal Rate, G2D Making Charges, the Slab Excel Table — plus the ERP Stone Rate Slab and Labour Rate Slab.</div>
    <div class="note view-only" style="margin-bottom:12px">🔒 <b>View only.</b> Changing any slab or rate is limited to ${EDITOR_LIST.map(esc).join(", ")} — use <b>Editor login</b> (top right) if you are one of them.</div>
    <div class="ratecard-grid" style="grid-template-columns:1fr 1.6fr">
      <div class="ratecard-panel">
        <div class="ratecard-head">Metal Rate <span style="font-weight:600;text-transform:none;letter-spacing:0;font-size:10.5px;opacity:.85">— gold rows follow Today's Entry</span></div>
        <table><thead><tr><th>Metal</th><th>KT</th><th>Purity%</th><th class="num">Rate</th></tr></thead>
        <tbody>${RATE_CARD.map(r=>`<tr><td>${esc(r.metal)}</td><td>${esc(r.kt)}</td><td>${esc(r.purityPct)}</td><td class="num" ${r.metal==="GOLD"?`id="mrate-${esc(r.kt)}"`:""}>${dec(r.rate,2)}</td></tr>`).join("")}</tbody></table>
      </div>
      <div class="ratecard-panel">
        <div class="ratecard-head">G2D Making Charges <span style="font-weight:600;text-transform:none;letter-spacing:0;font-size:10.5px;opacity:.85">— Making Charges editable</span></div>
        <table><thead><tr><th>G2D Range</th><th>G2D Band</th><th>Making Charges</th><th class="num">Dis%</th><th class="num">Diamond Discount</th></tr></thead>
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
        <button class="split-savebtn edit-only" id="splitSaveBtn" disabled>Save today's split</button>
        <div class="split-savemsg" id="splitSaveMsg"></div>
      </div>
    </div>
    <div class="ratecard-panel" style="margin-top:14px">
      <div class="ratecard-head">Slab Excel Table <span style="font-weight:600;text-transform:none;letter-spacing:0;font-size:10.5px;opacity:.85">— Export → edit in Excel → Import → <b>Deploy to Dashboard</b> · blank Category / Material Type / G2D = applies to all; filled discount / making replaces the existing one, blank keeps it. Free coin: Final After GST ÷ 1.03 ≥ Price Range → ₹1,600 per coin (fixed), ×2 = ₹3,200 at 2× the range, ×3 = ₹4,800 at 3×… Actual SP = Final After GST − coin value; Final Margin % = (Actual SP − CP) ÷ Actual SP (CP incl. 3% GST)</span></div>
      <div class="toolbar" style="margin:10px 0">
        <button class="btn sm edit-only" id="sxImportBtn" type="button">⭱ Import Excel</button>
        <input type="file" id="sxFile" accept=".xlsx" style="display:none">
        <button class="btn sm" id="sxExportBtn" type="button">⭳ Export Excel</button>
        <button class="btn sm edit-only" id="sxDeployBtn" type="button" style="background:var(--brand-mauve);color:#fff;border-color:transparent">🚀 Deploy to Dashboard</button>
        <span class="muted" id="sxCount" style="font-size:11.5px"></span>
      </div>
      <div id="sxMsg" class="split-savemsg" style="margin-bottom:8px"></div>
      <div class="tbl-wrap" style="max-height:420px">
        <table><thead><tr>${SX_COLS.map(([k,l])=>`<th class="${["category","material_type","free"].includes(k)?"":"num"}">${l}</th>`).join("")}</tr></thead>
        <tbody id="sxBody"><tr><td colspan="8" class="muted">Loading…</td></tr></tbody></table>
      </div>
    </div>
    <div class="ratecard-panel" style="margin-top:14px">
      <div class="ratecard-head">Labour Rate Slab <span style="font-weight:600;text-transform:none;letter-spacing:0;font-size:10.5px;opacity:.85">— ERP labour_rates × common_attributes · drives Variant Level / Style Level's Labour Charge &amp; CP. pr gm making (Net Weight × Labour Charge above 1.5 g; fixed ₹1,500 at or below 1.5 g)</span></div>
      <div class="toolbar" style="margin:10px 0">
        <select class="search" id="lrsGroup" style="min-width:170px"></select>
        <input class="search" id="lrsSearch" placeholder="Search type (Rings, Pendants…)">
        <span class="muted" id="lrsCount" style="font-size:11.5px"></span>
      </div>
      <div class="tbl-wrap" style="max-height:420px">
        <table><thead><tr><th>Item Group</th><th>Type</th><th class="num">From Wt</th><th class="num">To Wt</th><th class="num">Labour Charge</th></tr></thead>
        <tbody id="lrsBody"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table>
      </div>
    </div>
    <div class="ratecard-panel" id="deployBarCard" style="margin-top:14px;padding:14px 16px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-weight:700;font-size:14px" id="deployPendingText">No pending changes</div>
          <div class="muted" style="font-size:11.5px;margin-top:2px" id="deployLastText">—</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn sm edit-only" id="deployDiscardBtn" type="button" style="display:none">Discard Changes</button>
          <button class="btn sm primary edit-only" id="deployBtn" type="button" disabled>Deploy &amp; Refresh Calculations</button>
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
    </div>
    <div class="ratecard-panel" style="margin-top:14px">
      <div class="ratecard-head">Stone Rate Slab <span style="font-weight:600;text-transform:none;letter-spacing:0;font-size:10.5px;opacity:.85">— ERP stone_rates × common_attributes · latest rate only (older entries for the same slab removed) · view only, not yet used in calculations</span></div>
      <div class="toolbar" style="margin:10px 0">
        <select class="search" id="srsGroup" style="min-width:150px"></select>
        <div id="srsTypes" style="display:flex;gap:6px;flex-wrap:wrap"></div>
        <input class="search" id="srsSearch" placeholder="Search attribute / shape…">
        <span class="muted" id="srsCount" style="font-size:11.5px"></span>
      </div>
      <div class="tbl-wrap" style="max-height:460px">
        <table><thead><tr><th>Item Group</th><th>Attribute</th><th>Type</th><th>Shape</th><th class="num">From Wt</th><th class="num">To Wt</th><th class="num">Purchase Rate</th><th class="num">Sales Rate</th><th>From Date</th><th>To Date</th></tr></thead>
        <tbody id="srsBody"><tr><td colspan="10" class="muted">Loading…</td></tr></tbody></table>
      </div>
    </div>`;
  setupGoldSplit();
  renderG2DPanel();
  if(!g2dConfigFetchStarted){ g2dConfigFetchStarted = true; fetchG2DConfig(); }
  renderCashBackPanel();
  if(!cashBackConfigFetchStarted){ cashBackConfigFetchStarted = true; fetchCashBackConfig(); }
  renderGlobalDeployBar();
  if(!deployHistoryFetchStarted){ deployHistoryFetchStarted = true; fetchDeployHistory(); }
  renderStoneRateSlab();
  if(!stoneRateSlabFetchStarted){ stoneRateSlabFetchStarted = true; fetchStoneRateSlab(); }
  wireSlabExcel();
  renderLabourRateSlab();
  if(!labourRateSlabFetchStarted){ labourRateSlabFetchStarted = true; fetchLabourRateSlab(); }
}

/* ── Labour Rate Slab: read-only (pos-price-api /labour-rate-slab ->
   gold_rates.labour_rate_slab view). Labour Charge = labour_rates.purchase_rate
   per item group + type + weight slab. Drives Variant Level's CP. pr gm making
   (pos-price-api fetch_labour_rate_slab / labour_charge_for). */
let LABOUR_RATE_SLAB = null; // null = not loaded yet
let labourRateSlabFetchStarted = false;
const LRS_STATE = {group:"", q:""};
async function fetchLabourRateSlab(){
  try{
    const res = await fetch(`${PP_API}/labour-rate-slab`);
    const data = await res.json();
    if(data.error || !Array.isArray(data.rows)) throw new Error(data.error||"bad response");
    LABOUR_RATE_SLAB = data.rows;
  }catch(e){ LABOUR_RATE_SLAB = []; labourRateSlabFetchStarted = false; }
  if(STATE.tab==="overview") renderLabourRateSlab();
}
function renderLabourRateSlab(){
  const body = $("#lrsBody");
  if(!body) return;
  if(LABOUR_RATE_SLAB==null){ body.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`; return; }
  const rows = LABOUR_RATE_SLAB;
  const groups = [...new Set(rows.map(r=>r.item_group_name||"—"))].sort();
  const sel = $("#lrsGroup");
  sel.innerHTML = `<option value="">All Item Groups</option>` + groups.map(g=>`<option value="${esc(g)}" ${g===LRS_STATE.group?"selected":""}>${esc(g)}</option>`).join("");
  sel.onchange = ()=>{ LRS_STATE.group = sel.value; renderLabourRateSlab(); };
  const search = $("#lrsSearch");
  if(search.value!==LRS_STATE.q) search.value = LRS_STATE.q;
  search.oninput = ()=>{ LRS_STATE.q = search.value; renderLabourRateSlab(); };
  const q = LRS_STATE.q.trim().toUpperCase();
  const shown = rows.filter(r=>(!LRS_STATE.group || (r.item_group_name||"—")===LRS_STATE.group)
    && (!q || String(r.type_name||"").toUpperCase().includes(q)));
  $("#lrsCount").textContent = rows.length ? `${int(shown.length)} of ${int(rows.length)} slabs` : "";
  if(!rows.length){ body.innerHTML = `<tr><td colspan="5" class="muted">Couldn't load the Labour Rate Slab — check pos-price-api.</td></tr>`; return; }
  body.innerHTML = shown.length ? shown.map(r=>`<tr>
      <td>${esc(gone(r.item_group_name))}</td><td>${esc(gone(r.type_name))}</td>
      <td class="num">${r.from_weight==null?"—":r.from_weight}</td><td class="num">${r.to_weight==null?"—":r.to_weight}</td>
      <td class="num">${r.purchase_rate==null?"—":rupee(r.purchase_rate)}</td></tr>`).join("")
    : `<tr><td colspan="5" class="muted">No slabs match these filters.</td></tr>`;
}

/* ── Stone Rate Slab: read-only (pos-price-api /stone-rate-slab ->
   gold_rates.stone_rate_slab view). The view already keeps only rates valid
   today and only the newest from_date per stone + weight slab, so every row
   here is the current rate for its slab. Display-only for now. */
let STONE_RATE_SLAB = null; // null = not loaded yet
let stoneRateSlabFetchStarted = false;
const SRS_STATE = {group:"", type:"", q:""};
async function fetchStoneRateSlab(){
  try{
    const res = await fetch(`${PP_API}/stone-rate-slab`);
    const data = await res.json();
    if(data.error || !Array.isArray(data.rows)) throw new Error(data.error||"bad response");
    STONE_RATE_SLAB = data.rows;
  }catch(e){ STONE_RATE_SLAB = []; stoneRateSlabFetchStarted = false; }
  if(STATE.tab==="overview") renderStoneRateSlab();
}
function renderStoneRateSlab(){
  const body = $("#srsBody");
  if(!body) return;
  if(STONE_RATE_SLAB==null){ body.innerHTML = `<tr><td colspan="10" class="muted">Loading…</td></tr>`; return; }
  const rows = STONE_RATE_SLAB;
  const groups = [...new Set(rows.map(r=>r.item_group_name||"—"))].sort();
  const inGroup = rows.filter(r=>!SRS_STATE.group || (r.item_group_name||"—")===SRS_STATE.group);
  const typeCounts = new Map();
  inGroup.forEach(r=>{ const k=r.type_code||"—"; typeCounts.set(k,(typeCounts.get(k)||0)+1); });
  if(SRS_STATE.type && !typeCounts.has(SRS_STATE.type)) SRS_STATE.type = "";
  const types = [...typeCounts.entries()].sort((a,b)=>b[1]-a[1]);
  const typeName = new Map(rows.map(r=>[r.type_code||"—", r.type_name||r.type_code||"—"]));

  const sel = $("#srsGroup");
  sel.innerHTML = `<option value="">All Item Groups</option>` + groups.map(g=>`<option value="${esc(g)}" ${g===SRS_STATE.group?"selected":""}>${esc(g)}</option>`).join("");
  sel.onchange = ()=>{ SRS_STATE.group = sel.value; renderStoneRateSlab(); };
  $("#srsTypes").innerHTML = [["",inGroup.length]].concat(types).map(([k,c])=>
    `<button type="button" class="btn sm ${k===SRS_STATE.type?"on":""}" data-srs-type="${esc(k)}" title="${esc(k?typeName.get(k):"All types")}">${esc(k||"All")} <span class="cc">${int(c)}</span></button>`).join("");
  $$("#srsTypes [data-srs-type]").forEach(b=>b.addEventListener("click",()=>{ SRS_STATE.type = b.dataset.srsType; renderStoneRateSlab(); }));
  const search = $("#srsSearch");
  if(search.value!==SRS_STATE.q) search.value = SRS_STATE.q;
  search.oninput = ()=>{ SRS_STATE.q = search.value; renderStoneRateSlab(); };

  const q = SRS_STATE.q.trim().toUpperCase();
  const shown = inGroup.filter(r=>(!SRS_STATE.type || (r.type_code||"—")===SRS_STATE.type)
    && (!q || String(r.attribute||"").toUpperCase().includes(q) || String(r.shape_name||"").toUpperCase().includes(q) || String(r.shape_code||"").toUpperCase().includes(q)));
  $("#srsCount").textContent = rows.length ? `${int(shown.length)} of ${int(rows.length)} slabs` : "";
  if(!rows.length){ body.innerHTML = `<tr><td colspan="10" class="muted">Couldn't load the Stone Rate Slab — check pos-price-api.</td></tr>`; return; }
  body.innerHTML = shown.length ? shown.map(r=>`<tr>
      <td>${esc(gone(r.item_group_name))}</td><td>${esc(gone(r.attribute))}</td>
      <td title="${esc(r.type_name||"")}">${esc(gone(r.type_code))}</td>
      <td title="${esc(r.shape_code||"")}">${esc(gone(r.shape_name))}</td>
      <td class="num">${r.from_weight==null?"—":r.from_weight}</td><td class="num">${r.to_weight==null?"—":r.to_weight}</td>
      <td class="num">${r.purchase_rate==null?"—":rupee(r.purchase_rate)}</td><td class="num">${r.sales_rate==null?"—":rupee(r.sales_rate)}</td>
      <td>${esc(gone(r.from_date))}</td><td>${esc(gone(r.to_date))}</td></tr>`).join("")
    : `<tr><td colspan="10" class="muted">No slabs match these filters.</td></tr>`;
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
    <button class="${cellClass}-edit-btn btn sm edit-only" type="button" style="margin-left:6px">Edit</button>`;
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
  return Object.keys(G2D_DRAFT).length>0 || Object.keys(SLAB_DRAFT).length>0
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
    </tr>`).join("");
  // Disc% column removed: Variant Level's Diamond Disc% now comes from the
  // G2D Making Charges panel's Diamond Discount (E-F / CD / RB / SC only).
  renderSlabApplyBar();
}
// Per-panel Apply/Cancel is replaced by ONE global "Deploy & Refresh
// Calculations" bar (see that section below) that batches every panel's
// draft together -- wireEditableCell's onChange callback still needs a
// per-panel hook to re-render after Edit/typing, so this stays as a thin
// delegator to the shared bar rather than removing it outright.
function renderSlabApplyBar(){ renderGlobalDeployBar(); }

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
let G2D_DRAFT = {}; // {band_key: {making_charge?, dis_pct?, diamond_dis_pct?}}
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
      <td class="pct">${editableCellHtml(r.band_key,"g2d-ddp",g2dEffective(r.band_key,"diamond_dis_pct") ?? 0,v=>int(v),{step:0.5,min:0,max:100})}</td>
    </tr>`).join("");
  $$("#g2dPanelBody tr").forEach(tr=>{
    const bandKey = tr.dataset.band;
    wireEditableCell(tr, bandKey, "g2d-mc", "making_charge", G2D_DRAFT, G2D_EDITING, renderG2DApplyBar);
    wireEditableCell(tr, bandKey, "g2d-dp", "dis_pct", G2D_DRAFT, G2D_EDITING, renderG2DApplyBar);
    wireEditableCell(tr, bandKey, "g2d-ddp", "diamond_dis_pct", G2D_DRAFT, G2D_EDITING, renderG2DApplyBar);
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
      method: "POST", headers: editHeaders(),
      body: JSON.stringify({changes}),
    });
    editRefused(res);
    const data = await res.json();
    timers.forEach(clearTimeout);
    if(data.error) throw new Error(data.error);
    LAST_DEPLOYMENT = data;
    if(data.status === "SUCCESS"){
      G2D_DRAFT = {}; G2D_EDITING.clear();
      SLAB_DRAFT = {}; SLAB_EDITING.clear();
      CASH_BACK_DRAFT = {}; CASH_BACK_EDITING.clear();
      renderG2DPanel(); renderSlabPanel(); renderCashBackPanel();
      fetchG2DConfig(); // re-read saved G2D values so edited cells show the new numbers
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

/* ── Editor access ────────────────────────────────────────────────────────
   Only the editors pos-price-api allows (data@ / data.cat@ / tech@
   lucirajewelry.com) can change slabs, rate cards or MTO extra discounts.
   An editor signs in with email + password (POST /editor-login); the signed
   token is kept in this browser and sent as X-Edit-Token on every write.
   The API refuses any write without a valid token, so hiding the controls
   here is only the visible half. body.can-edit shows the .edit-only
   controls and hides the .view-only notes. */
const EDITOR_LS_KEY = "lj_ppi_editor";
let EDITOR = null; // {email, token, expires}
let EDITOR_LIST = ["data@lucirajewelry.com", "data.cat@lucirajewelry.com", "tech@lucirajewelry.com"];
function canEdit(){ return !!(EDITOR && EDITOR.expires*1000 > Date.now()); }
function editHeaders(){ return canEdit() ? {"Content-Type":"application/json", "X-Edit-Token":EDITOR.token} : {"Content-Type":"application/json"}; }
function setEditor(e){
  EDITOR = e;
  try{ if(e) localStorage.setItem(EDITOR_LS_KEY, JSON.stringify(e)); else localStorage.removeItem(EDITOR_LS_KEY); }catch(_){}
  document.body.classList.toggle("can-edit", canEdit());
  const b = $("#editorBtn");
  if(b) b.textContent = canEdit() ? `✎ ${EDITOR.email} · Sign out` : "🔒 Editor login";
  if(STATE.tab==="mto" && MTO_STATE.rows) renderMTO();
}
// The API refused a write for lack of edit access -> forget the stale token.
function editRefused(res){ if(res.status===401 || res.status===403){ setEditor(null); return true; } return false; }
function openEditorLogin(){
  if(canEdit()){ if(confirm(`Sign out ${EDITOR.email}? Editing stays locked until an editor signs in again.`)) setEditor(null); return; }
  let m = $("#editorModal");
  if(!m){ m = document.createElement("div"); m.id = "editorModal"; m.className = "ed-modal"; document.body.appendChild(m); }
  m.innerHTML = `<div class="card ed-box">
      <h3 style="margin:0 0 4px">Editor login</h3>
      <div class="muted" style="font-size:12px;margin-bottom:12px">Only ${EDITOR_LIST.map(esc).join(", ")} can change slabs and MTO extra discounts. Everyone else is view-only.</div>
      <label class="ed-l">Email<input class="search" id="edEmail" type="email" autocomplete="username"></label>
      <label class="ed-l">Password<input class="search" id="edPass" type="password" autocomplete="current-password"></label>
      <div id="edMsg" class="split-savemsg"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
        <button class="btn sm" id="edCancel" type="button">Cancel</button>
        <button class="btn sm primary" id="edGo" type="button">Sign in</button>
      </div></div>`;
  m.style.display = "flex";
  const close = ()=>{ m.style.display = "none"; };
  const go = async ()=>{
    const msg = $("#edMsg"); msg.className = "split-savemsg"; msg.textContent = "Checking…";
    try{
      const res = await fetch(`${PP_API}/editor-login`, {method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({email:$("#edEmail").value, password:$("#edPass").value})});
      const d = await res.json();
      if(!res.ok || d.error) throw new Error(d.error || "Sign in failed");
      setEditor({email:d.email, token:d.token, expires:d.expires}); close();
    }catch(e){ msg.className = "split-savemsg err"; msg.textContent = e.message; }
  };
  $("#edCancel").addEventListener("click", close);
  $("#edGo").addEventListener("click", go);
  $("#edPass").addEventListener("keydown", e=>{ if(e.key==="Enter") go(); });
  m.addEventListener("click", e=>{ if(e.target===m) close(); });
  $("#edEmail").focus();
}
async function initEditor(){
  let saved = null;
  try{ saved = JSON.parse(localStorage.getItem(EDITOR_LS_KEY) || "null"); }catch(_){}
  setEditor(saved && saved.expires*1000 > Date.now() ? saved : null);
  try{
    const d = await (await fetch(`${PP_API}/editor-check`, {headers:canEdit() ? {"X-Edit-Token":EDITOR.token} : {}, cache:"no-store"})).json();
    if(Array.isArray(d.editors) && d.editors.length) EDITOR_LIST = d.editors;
    if(canEdit() && !d.can_edit) setEditor(null);
  }catch(_){ /* offline -- the API re-checks the token on every write anyway */ }
}
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
  const envRes = await fetch(endpointUrl, {cache:"no-store"});
  const envelope = await envRes.json();
  if(envelope.error) throw new Error(envelope.error);
  if(envelope.snapshot_url){
    // The blob always lives at the SAME GCS URL and GCS serves it with
    // "Cache-Control: public, max-age=3600" -- without a version in the URL
    // the browser (and Google's edge cache) keeps handing back the previous
    // snapshot for up to an hour after a Deploy & Refresh. Keying the URL by
    // the snapshot's build time fetches a new snapshot immediately while an
    // unchanged one is still served from cache.
    const ver = (envelope.snapshot && envelope.snapshot.snapshot_created_at) || envelope.generated_at || Date.now();
    const sep = envelope.snapshot_url.includes("?") ? "&" : "?";
    const dataRes = await fetch(`${envelope.snapshot_url}${sep}v=${encodeURIComponent(ver)}`);
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
/* ── Column sort (Asc/Desc from each column's ▾ popover) ─ shared by Product
   Price and Variant Level. The FULL dataset is sorted once per sort change
   and cached; filters then run over that sorted array (Array.filter keeps
   order), so paging/filtering stays instant. Blanks always sort last; ties
   keep the server's original order (Array.sort is stable). No sort = the
   server's own Gold->Diamond->Other / Consignment-last order, untouched. */
function sortedAllRows(state, numericCols){
  const rows = state.allRows || [];
  const s = state.sort;
  if(!s || !s.col) return rows;
  const c = state._sortCache;
  if(c && c.src===rows && c.col===s.col && c.dir===s.dir) return c.rows;
  const k = s.col, dir = s.dir, isNum = numericCols.has(k);
  const keyOf = r=>{
    const v = r[k];
    if(v==null || v==="") return null;
    if(isNum){ const n = Number(v); return Number.isFinite(n) ? n : null; }
    return String(v);
  };
  const decorated = rows.map((r,i)=>[keyOf(r), r]);
  decorated.sort((a,b)=>{
    if(a[0]===null || b[0]===null) return a[0]===null ? (b[0]===null ? 0 : 1) : -1;
    const d = isNum ? a[0]-b[0] : a[0].localeCompare(b[0], undefined, {numeric:true, sensitivity:"base"});
    return d*dir;
  });
  const out = decorated.map(d=>d[1]);
  state._sortCache = {src:rows, col:k, dir, rows:out};
  return out;
}
function sortArrow(state, k){
  return state.sort && state.sort.col===k ? (state.sort.dir>0 ? " ↑" : " ↓") : "";
}
function sortButtonsHtml(prefix, state, colKey, isNumeric){
  const on = state.sort && state.sort.col===colKey ? state.sort.dir : 0;
  const asc = isNumeric ? "Smallest → Largest" : "A → Z";
  const desc = isNumeric ? "Largest → Smallest" : "Z → A";
  return `<div class="vl-fp-sort">
      <button class="btn sm${on>0?" primary":""}" id="${prefix}FpSortAsc" type="button">↑ Sort ${asc}</button>
      <button class="btn sm${on<0?" primary":""}" id="${prefix}FpSortDesc" type="button">↓ Sort ${desc}</button>
      ${on?`<a href="#" id="${prefix}FpSortClear">Clear sort</a>`:""}
    </div>`;
}
// Wires the popover's sort buttons: set/clear state.sort, back to page 1, re-render.
function wireSortButtons(prefix, state, colKey, closeFn, renderFn){
  const apply = dir=>{ state.sort = dir ? {col:colKey, dir} : null; state.page = 1; closeFn(); renderFn(); };
  $(`#${prefix}FpSortAsc`).addEventListener("click",()=>apply(1));
  $(`#${prefix}FpSortDesc`).addEventListener("click",()=>apply(-1));
  const clr = $(`#${prefix}FpSortClear`);
  if(clr) clr.addEventListener("click",e=>{ e.preventDefault(); apply(0); });
}

const PP_STATE = { allRows:null, page:1, pageSize:50, loading:false, error:null, reqId:0, sort:null };
// {colKey: {type:'text', search:'', selected:Set<string>} | {type:'number', min:number|null, max:number|null}}
const PP_FILTERS = {};
const PP_COLS = [
  ["item_code","Item Code"], ["item_name","Item Name"], ["attribute","Attribute"], ["cost_price","Cost Price"], ["sale_price","Sale Price"], ["weight","Weight"], ["pieces","Pieces"],
  ["net_weight","Net Weight"], ["purity","Purity"], ["pure_weight","Pure Weight"], ["bom_rate","BOM Rate"],
  ["bom_base_amount","BOM Base Amount"], ["center_stone","Center Stone"], ["item_group_name","Item Group"],
  ["discount_pct","Making Discount %"], ["diamond_disc_pct","Diamond Disc%"],
  ["base_item","Base Item"], ["type_code","Type Code"], ["metal_name","Metal Name"], ["karat_code","Karat Code"],
  ["metal_color_code","Metal Color"], ["collection_name","Collection"], ["super_type_name","Super Type"],
  ["shape_name","Shape"], ["stone_size_id","Stone Size ID"], ["stone_size_name","Stone Size"],
  ["quality_name","Quality"], ["stone_color_name","Stone Color"], ["type_name","Type"],
  ["metal_amount","Metal Amount / SP per Ct"], ["Diamond_type","Diamond Type"], ["g2d_ratio","G2D Ratio"],
  ["making_charge_per_g","Making Charge /g"], ["Saleing_price","Selling Price"],
  ["carat_weight","Carat Weight"], ["purchase_rate","Purchase Rate"], ["purchase_amount","Pr.Ct Amount"],
  ["diamond_cp","Diamond CP"],
];
const PP_MONEY_COLS = new Set(["cost_price","sale_price","metal_amount","Saleing_price","overall_selling_price"]);
// Every numeric column gets a min/max range filter; everything else gets a
// search+checklist filter -- same rule Variant Level's filters use.
const PP_NUMERIC_COLS = new Set([
  "weight","pieces","net_weight","purity","pure_weight","bom_rate","bom_base_amount","center_stone",
  "discount_pct","diamond_disc_pct","stone_size_id","metal_amount","g2d_ratio","making_charge_per_g",
  "Saleing_price","overall_selling_price","carat_weight","purchase_rate","purchase_amount","diamond_cp",
  "cost_price","sale_price",
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
  let rows = sortedAllRows(PP_STATE, PP_NUMERIC_COLS);
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
  const sorted = PP_STATE.sort && PP_STATE.sort.col===k;
  return `<th data-col="${esc(k)}"${sorted?' class="sorted"':""}>${l}${sortArrow(PP_STATE,k)}<button class="vl-filter-btn pp-filter-btn${active||sorted?" on":""}" data-col="${esc(k)}" title="Sort / filter ${esc(l)}">▾</button></th>`;
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
    <div class="h2" style="display:flex;align-items:center;gap:12px">Ornaverse BOM Wise
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
// Download = exactly what the table shows (search box + column filters), every
// page of it. With nothing filtered (or the dataset not loaded yet) the full
// table is streamed from pos-price-api instead of built in the browser.
function downloadRowsCsv(rows, cols, filename){
  const cell = v=>{ if(v==null) return ""; const s = typeof v==="number" ? String(Math.round(v*10000)/10000) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  const csv = [cols.map(c=>cell(c[1])).join(",")].concat(rows.map(r=>cols.map(([k])=>cell(r[k])).join(","))).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], {type:"text/csv"}));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
}
function downloadAllPosPriceCsv(){
  const rows = PP_STATE.allRows!==null ? ppFilteredRows() : null;
  if(!rows || rows.length===PP_STATE.allRows.length){ window.location.href = `${PP_API}/?format=csv`; return; }
  downloadRowsCsv(rows, PP_COLS.filter(([k])=>k!=="image_url"), "product_price_filtered.csv");
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

  let html = `<div class="vl-fp-head">${esc(colLabel)}</div>` + sortButtonsHtml("pp", PP_STATE, colKey, isNumeric);
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
  wireSortButtons("pp", PP_STATE, colKey, closePpFilterPopover, renderPosPrice);
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
  if(STATE.tab==="style") renderStyleLevel();
  if(STATE.tab==="margin") renderMargin();
  // Product Price is rebuilt by the same deploy -- reload it too.
  PP_STATE.allRows = null;
  PP_STATE.error = null;
  _ppUniqueCache.clear();
  if(STATE.tab==="posprice") renderPosPrice();
}
// Pricing waterfall (Metal/Diamond Amount -> Final After GST Overall) is all
// per-Variant arithmetic computed server-side (pos-price-api) -- see its
// _build_variant_row for the formulas. GST is a flat 3%. Pre-existing detail/
// reference columns are appended after the waterfall, unchanged. Status
// (Shopify) is inserted right after Item Name; Image (Shopify) is appended
// as the very last column -- both additive, nothing else reordered.
// Column order + names = the user's sheet (2026-10-08). This ONE list drives the
// sequence on every tab that shows these columns: Ornaverse Variant, Ornaverse
// Product Default (Style), Shopify and Inventory Margin (Calc · …).
const VL_COLS = [
  // Front block = the user's column order (2026-10-23); the rest follows the pricing flow.
  // Product Composition / Final Amount Post Discount / Amount ex GST / Overall Selling Price
  // are no longer shown or exported (logic unchanged).
  ["item_code","Item Code"], ["item_name","Item Name"], ["image_url","Image"], ["status","Status"],
  ["material_type","Material Type"], ["item_group","Item Group"], ["category","Category"], ["purity","Purity"],
  ["slab_status","Slab Status"], ["net_weight","Net Weight"], ["diamond_weight","Diamond Weight"],
  ["diamond_pieces","Diamond Pieces"], ["weight","Weight"],
  ["g2d","G2D Ratio"], ["g2d_band","G2D Band"], ["main_shape","Main Shape"],
  ["total_diamond_cp","Total Diamond CP"], ["labour_charge","Labour Charge"], ["cp_pr_gm_making","CP. pr gm making"],
  ["total_cp_cost","Total CP Cost (incl. 3% GST)"], ["metal_amount","Metal Amount"],
  ["diamond_amount","Diamond Amount"],
  // Other BOM block (colour stone / CZ / accessories, 2026-10-30): Other BOM Amount is
  // inside Final After GST, Other BOM CP inside Total CP Cost.
  ["gemstone_type","Other BOM Items"], ["gemstone_pieces","Other BOM Pcs"], ["gemstone_weight","Other BOM Stone Wt (ct)"],
  ["gemstone_amount","Other BOM Amount"], ["gemstone_cp","Other BOM CP"],
  ["making_charge_per_g","Making Charge /g"],
  ["making_amount","Making Amount"], ["before_gst_overall","Before GST Overall"], ["before_gst_value","GST Value"],
  ["original_after_gst_overall","With GST SP"], ["margin1_pct","Margin 1% (without discount)"],
  ["making_discount_pct","Making Discount %"], ["making_discount_amount","Making Discount Amount"],
  ["net_making_amount","Net Making Amount"], ["diamond_disc_pct","Diamond Disc%"],
  ["diamond_discount_amount","Diamond Discount Amount"], ["net_diamond_amount","Net Diamond Amount"],
  ["total_discount","Total Discount"], ["final_after_gst_overall","Final After GST Overall"],
  ["margin_pct","Margin 2% with discount"],
  // Actual SP = Final After GST Overall - Free Coin Value; Final Margin = Actual SP - Total CP Cost.
  ["free_gold_coin","Free Gold Coin"], ["free_coin_qty","Free Coin Qty"],
  ["free_coin_cp","Free Coin Value"], ["actual_sp","Actual SP"], ["net_margin","Final Margin (SP − CP)"],
  ["net_margin_pct","Final Margin %"],
];
// Still calculated (Margin / Inventory tabs use them) but not in the sheet's list.
const VL_EXTRA_LABELS = {after_discount:"After Discount", gst:"GST",
  cash_back_pct:"Cash Back", margin2_pct:"Margin2 (after Cash Back)"};
const VL_MONEY_COLS = new Set([
  "metal_amount","diamond_amount","overall_selling_price","making_amount","before_gst_overall","before_gst_value",
  "original_after_gst_overall","making_discount_amount","net_making_amount","diamond_discount_amount",
  "net_diamond_amount","after_discount","gst","total_diamond_cp",
  "cp_pr_gm_making","total_cp_cost","additional_disc","final_amount_post_discount","labour_charge","total_discount",
  "net_margin","free_coin_cp","amount_ex_gst","actual_sp","gemstone_amount","gemstone_cp",
]);
// Every numeric column gets a min/max range filter; everything else (incl.
// Image, which isn't filterable) gets a search+checklist filter.
const VL_NUMERIC_COLS = new Set([
  ...VL_MONEY_COLS, "net_weight","weight","diamond_weight","purity","g2d",
  "diamond_pieces","gemstone_pieces","gemstone_weight",
  "making_discount_pct","diamond_disc_pct","margin_pct","final_after_gst_overall","cash_back_pct",
  "margin2_pct", "margin1_pct", "net_margin_pct", "free_coin_qty",
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
  if((k==="weight"||k==="net_weight"||k==="diamond_weight"||k==="purity"||k==="gemstone_weight") && r[k]!=null) return dec(r[k],3);
  if((k==="diamond_pieces"||k==="gemstone_pieces") && r[k]!=null) return int(r[k]);
  if(k==="final_after_gst_overall" && r[k]!=null) return int(r[k]); // rounded UP to the nearest whole rupee
  if(k==="g2d_band"){
    if(!r.g2d_band) return `<span class="muted">—</span>`;
    const range = G2D_BAND_RANGE.get(normG2DBandKey(r.g2d_band));
    return `<span class="pill ${G2D_BAND_TONE[r.g2d_band]||"muted"}" title="${esc(range?`G2D Range: ${range}`:r.g2d_band)}">${esc(r.g2d_band)}</span>`;
  }
  if(k==="slab_status"){
    const v = r.slab_status || "";
    if(!v) return `<span class="muted">—</span>`;
    const tone = v.startsWith("Error")||v.includes("; Error") ? "crit" : v.startsWith("No slab") ? "muted" : v.includes("kept existing") ? "warn" : "good";
    return `<span class="pill ${tone}" title="${esc(v)}">${esc(v)}</span>`;
  }
  if(k==="margin_pct"||k==="margin2_pct"||k==="margin1_pct"||k==="net_margin_pct") return r[k]==null ? `<span class="muted">—</span>` : `${dec(r[k],2)}%`;
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
  let rows = sortedAllRows(VL_STATE, VL_NUMERIC_COLS);
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
  const sorted = VL_STATE.sort && VL_STATE.sort.col===k;
  return `<th data-col="${esc(k)}"${sorted?' class="sorted"':""}>${l}${sortArrow(VL_STATE,k)}${filterable?`<button class="vl-filter-btn${active||sorted?" on":""}" data-col="${esc(k)}" title="Sort / filter ${esc(l)}">▾</button>`:""}</th>`;
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
    <div class="h2" style="display:flex;align-items:center;gap:12px">Ornaverse Variant
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
      if(STATE.tab==="style") renderStyleLevel();
      if(STATE.tab==="margin") renderMargin();
      if(STATE.tab==="shopify") renderShopify();
      if(STATE.tab==="invmargin") renderInvMargin();
    }
  }
}
function downloadAllVariantCsv(){
  const rows = VL_STATE.allRows!==null ? vlFilteredRows() : null;
  if(!rows || rows.length===VL_STATE.allRows.length){ window.location.href = `${PP_API}/variant-level?format=csv`; return; }
  downloadRowsCsv(rows, VL_COLS.filter(([k])=>k!=="image_url"), "variant_level_filtered.csv");
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

  let html = `<div class="vl-fp-head">${esc(colLabel)}</div>` + sortButtonsHtml("vl", VL_STATE, colKey, isNumeric);
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
  wireSortButtons("vl", VL_STATE, colKey, closeVlFilterPopover, renderVariantLevel);
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

/* ── Style Level ─────────────────────────────────────────────────────────
   One row per Style = the item_code's first two segments (LJ-SBR0007-14RGLGD-2.3
   -> LJ-SBR0007). Built entirely in the browser from the SAME Variant Level
   dataset (no extra API call, no separate snapshot), so it always agrees
   with the Variant Level tab. Every number is the AVERAGE across the style's
   variants (sizes / karats / metal colours), plus Min/Max Final After GST;
   text columns show the most common value among the variants. Row order =
   the style's first appearance in Variant Level (Gold -> Diamond -> Other,
   Consignment last). */
const SL_STATE = { allRows:null, src:null, page:1, pageSize:50, sort:null };
const SL_FILTERS = {};
const SL_TEXT_MODE_COLS = ["product_composition","item_name","status","item_group","g2d_band","category","main_shape","free_gold_coin","material_type","slab_status","gemstone_type"];
const SL_AVG_COLS = VL_COLS.map(c=>c[0]).filter(k=>VL_NUMERIC_COLS.has(k));
const SL_COLS = [
  ["style","Style"], ["item_code","Default Item Code"], ["variant_count","Variants"],
  ...VL_COLS.filter(([k])=>k!=="item_code").flatMap(c=>c[0]==="final_after_gst_overall"
    ? [c, ["min_final","Min Final After GST"], ["max_final","Max Final After GST"]] : [c]),
];
const SL_NUMERIC_COLS = new Set([...SL_AVG_COLS, "variant_count", "min_final", "max_final"]);
function styleOf(code){
  const m = /^([^-]+-[^-]+)/.exec(String(code||""));
  return m ? m[1] : (code||"—");
}
/* Product Default (user, 2026-10-24): each style shows ONE default variant, not an
   average -- 14KT, YG, and the default size for its category (Rings: Men 18 / else 12;
   Bracelets 6.5in; bangles / stiff bracelets 2.4 anna; Chains 18in; the rest have no size).
   Missing exact match -> closest: 14KT first, then YG, then the nearest size. */
const PD_KARAT = "14", PD_COLOR = "YG";
function pdParse(code){  // "LJ-R00373-14YGLGD-16" -> {karat:"14", color:"YG", size:16}
  const m = /-(\d{2,3})([A-Z]{2})[A-Z]*(?:-([\d.]+))?$/i.exec(String(code||""));
  return m ? {karat:m[1], color:m[2].toUpperCase(), size:m[3]!=null ? Number(m[3]) : null} : {karat:null, color:null, size:null};
}
function pdTargetSize(r){
  const cat = String(r.category||"").toLowerCase(), name = String(r.item_name||"").toLowerCase();
  if(cat==="rings"){
    const men = /^lj-mr/i.test(r.item_code||"") || /(^|[^a-z])(men'?s?|gents?)([^a-z]|$)/.test(name);
    return men ? 18 : 12;
  }
  if(cat==="bracelets") return 6.5;
  if(cat==="stiff bracelets" || cat==="sbr" || cat.startsWith("bangle")) return 2.4;
  if(cat==="chain" || cat==="chains") return 18;
  return null;
}
function pdPick(rows){
  let best = null, bestScore = -Infinity;
  for(const r of rows){
    const p = pdParse(r.item_code), t = pdTargetSize(r);
    let score = (p.karat===PD_KARAT ? 1e6 : 0) + (p.color===PD_COLOR ? 1e5 : 0);
    if(t!=null) score -= p.size==null ? 5e4 : Math.abs(p.size - t) * 100;
    if(score > bestScore){ bestScore = score; best = r; }
  }
  return best || rows[0];
}
function buildStyleRows(vrows){
  const groups = new Map();
  for(const r of vrows){
    const k = styleOf(r.item_code);
    let g = groups.get(k);
    if(!g){ g = []; groups.set(k, g); }
    g.push(r);
  }
  const out = [];
  for(const [style, rows] of groups){
    const d = pdPick(rows);
    const o = { ...d, style, variant_count: rows.length };
    o.image_url = d.image_url || (rows.find(r=>r.image_url)||{}).image_url || null;
    const finals = rows.map(r=>r.final_after_gst_overall).filter(v=>v!=null && Number.isFinite(Number(v))).map(Number);
    o.min_final = finals.length ? Math.min(...finals) : null;
    o.max_final = finals.length ? Math.max(...finals) : null;
    out.push(o);
  }
  return out;
}
function ensureStyleRows(){
  if(VL_STATE.allRows && SL_STATE.src!==VL_STATE.allRows){
    SL_STATE.allRows = buildStyleRows(VL_STATE.allRows);
    SL_STATE.src = VL_STATE.allRows;
    SL_STATE._sortCache = null;
    _slUniqueCache.clear();
  }
}
function slCellValue(r,k){
  if(k==="style") return `<b>${esc(r.style)}</b>`;
  if(k==="variant_count") return int(r.variant_count);
  if(k==="min_final"||k==="max_final") return r[k]==null ? `<span class="muted">—</span>` : int(r[k]);
  if(k==="cash_back_pct") return r[k]==null ? `<span class="muted">—</span>` : `${dec(r[k],1)}%`;
  return vlCellValue(r,k);
}
function slFilteredRows(){
  let rows = sortedAllRows(SL_STATE, SL_NUMERIC_COLS);
  const q = STATE.search.trim().toLowerCase();
  if(q) rows = rows.filter(r=>`${r.style||""} ${r.item_name||""} ${r.item_group||""} ${r.status||""}`.toLowerCase().includes(q));
  const keys = Object.keys(SL_FILTERS).filter(k=>vlFilterActive(SL_FILTERS[k]));
  if(keys.length) rows = rows.filter(r=>keys.every(k=>vlPassesFilter(r,k,SL_FILTERS[k])));
  return rows;
}
const _slUniqueCache = new Map();
function slUniqueValuesFor(k){
  if(_slUniqueCache.has(k)) return _slUniqueCache.get(k);
  const set = new Set();
  (SL_STATE.allRows||[]).forEach(r=>{ const s=vlRawStr(r,k); if(s) set.add(s); });
  const vals = [...set].sort((a,b)=>a.localeCompare(b, undefined, {numeric:true}));
  _slUniqueCache.set(k, vals);
  return vals;
}
function slFilterChipsHtml(){
  const keys = Object.keys(SL_FILTERS).filter(k=>vlFilterActive(SL_FILTERS[k]));
  if(!keys.length) return "";
  const label = k=>{
    const f = SL_FILTERS[k], col = (SL_COLS.find(c=>c[0]===k)||[k,k])[1];
    if(f.type==="number"){ const p=[]; if(f.min!=null) p.push(`≥ ${f.min}`); if(f.max!=null) p.push(`≤ ${f.max}`); return `${col}: ${p.join(" and ")}`; }
    if(f.selected && f.selected.size) return `${col}: ${[...f.selected].slice(0,3).join(", ")}${f.selected.size>3?` +${f.selected.size-3}`:""}`;
    return `${col}: "${f.search}"`;
  };
  return `<div class="vl-chipbar">${keys.map(k=>`<span class="vl-chip">${esc(label(k))}<button class="vl-chip-x sl-chip-x" data-col="${esc(k)}" title="Clear this filter">✕</button></span>`).join("")}<button class="btn sm" id="slClearAllBtn">Clear All Filters</button></div>`;
}
function slTableHtml(){
  const loaded = SL_STATE.allRows!==null && VL_STATE.allRows!==null;
  const filtered = loaded ? slFilteredRows() : [];
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total/SL_STATE.pageSize));
  if(SL_STATE.page>totalPages) SL_STATE.page = totalPages;
  if(SL_STATE.page<1) SL_STATE.page = 1;
  const start = (SL_STATE.page-1)*SL_STATE.pageSize;
  const pageRows = filtered.slice(start, start+SL_STATE.pageSize);
  let body;
  if(VL_STATE.error){
    body = `<tr><td colspan="${SL_COLS.length}" class="muted" style="text-align:center;padding:20px">Couldn't load: ${esc(VL_STATE.error)}</td></tr>`;
  }else if(!loaded){
    body = `<tr><td colspan="${SL_COLS.length}" class="muted" style="text-align:center;padding:30px">Loading the Variant Level dataset and grouping it by style…</td></tr>`;
  }else if(!pageRows.length){
    body = `<tr><td colspan="${SL_COLS.length}" class="muted" style="text-align:center;padding:20px">No styles match the current filters</td></tr>`;
  }else{
    body = pageRows.map(r=>`<tr>${SL_COLS.map(([k])=>`<td>${slCellValue(r,k)}</td>`).join("")}</tr>`).join("");
  }
  const head = SL_COLS.map(([k,l])=>{
    const active = SL_FILTERS[k] && vlFilterActive(SL_FILTERS[k]);
    const sorted = SL_STATE.sort && SL_STATE.sort.col===k;
    const filterable = k!=="image_url";
    return `<th data-col="${esc(k)}"${sorted?' class="sorted"':""}>${l}${sortArrow(SL_STATE,k)}${filterable?`<button class="vl-filter-btn sl-filter-btn${active||sorted?" on":""}" data-col="${esc(k)}" title="Sort / filter ${esc(l)}">▾</button>`:""}</th>`;
  }).join("");
  const from = total ? start+1 : 0, to = Math.min(start+SL_STATE.pageSize, total);
  return `
    <div class="h2" style="display:flex;align-items:center;gap:12px">Ornaverse Product Default
      <button class="btn sm" id="slDownloadBtn" style="margin-left:auto" ${loaded?"":"disabled"}>⭳ Download all (CSV)</button>
    </div>
    <div class="sub">One row per <b>Style</b> — the Item Code without its karat/colour and size (e.g. <b>LJ-SBR0007</b>-14RGLGD-2.3). Built from the same data as <b>Variant Level</b>: each row is the style's <b>default variant</b> (<b>Default Item Code</b>): <b>14KT · YG</b> and the category's default size — Rings Men 18 / Women 12, Bracelets 6.5in, Bangles / Stiff Bracelets 2.4 anna, Chains 18in, others no size (closest variant if the exact one doesn't exist). <b>Variants</b> is how many there are, and Min/Max Final After GST show the price range across all of them. Click any column's ▾ to sort or filter.</div>
    ${slFilterChipsHtml()}
    <div class="pager" style="justify-content:space-between;margin-bottom:8px">
      <span>${total? `Showing ${int(from)}–${int(to)} of ${int(total)} styles${loaded && total!==SL_STATE.allRows.length ? ` (filtered from ${int(SL_STATE.allRows.length)})`:""}` : (loaded?"No matches":"")}</span>
      <span>
        <button id="slPrevBtn" ${SL_STATE.page<=1?"disabled":""}>‹ Prev</button>
        Page ${int(SL_STATE.page)} of ${int(totalPages)}
        <button id="slNextBtn" ${SL_STATE.page>=totalPages?"disabled":""}>Next ›</button>
      </span>
    </div>
    <div class="tbl-wrap" style="max-height:70vh">
      <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    </div>
    <div id="slFilterPop" class="vl-filterpop" style="display:none"></div>`;
}
function renderStyleLevel(){
  ensureStyleRows();
  $("#page-style").innerHTML = slTableHtml();
  $("#slDownloadBtn").addEventListener("click",downloadStyleCsv);
  const prev = $("#slPrevBtn"), next = $("#slNextBtn");
  if(prev) prev.addEventListener("click",()=>{ if(SL_STATE.page>1){ SL_STATE.page--; renderStyleLevel(); } });
  if(next) next.addEventListener("click",()=>{ SL_STATE.page++; renderStyleLevel(); });
  $$("#page-style .sl-filter-btn").forEach(b=>b.addEventListener("click",e=>{ e.stopPropagation(); openSlFilterPopover(b.dataset.col, b); }));
  $$("#page-style .sl-chip-x").forEach(x=>x.addEventListener("click",()=>{ delete SL_FILTERS[x.dataset.col]; SL_STATE.page=1; renderStyleLevel(); }));
  const clr = $("#slClearAllBtn");
  if(clr) clr.addEventListener("click",()=>{ Object.keys(SL_FILTERS).forEach(k=>delete SL_FILTERS[k]); SL_STATE.page=1; renderStyleLevel(); });
  if(VL_STATE.allRows===null && !VL_STATE.loading && !VL_STATE.error) fetchVariantAll();
}
function downloadStyleCsv(){
  const rows = slFilteredRows();
  const cols = SL_COLS.filter(([k])=>k!=="image_url");
  const cell = v=>{ if(v==null) return ""; const s = typeof v==="number" ? String(Math.round(v*100)/100) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  const csv = [cols.map(c=>cell(c[1])).join(",")].concat(rows.map(r=>cols.map(([k])=>cell(r[k])).join(","))).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], {type:"text/csv"}));
  a.download = "style_level.csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
}
function closeSlFilterPopover(){
  const pop = $("#slFilterPop");
  if(pop){ pop.style.display = "none"; pop.innerHTML = ""; }
  document.removeEventListener("click", _slPopOutsideHandler, true);
}
function _slPopOutsideHandler(e){
  const pop = $("#slFilterPop");
  if(pop && !pop.contains(e.target) && !e.target.classList.contains("sl-filter-btn")) closeSlFilterPopover();
}
function openSlFilterPopover(colKey, anchorEl){
  const pop = $("#slFilterPop");
  if(!pop) return;
  const same = pop.style.display!=="none" && pop.dataset.col===colKey;
  closeSlFilterPopover();
  if(same) return;
  const colLabel = (SL_COLS.find(c=>c[0]===colKey)||[colKey,colKey])[1];
  const isNumeric = SL_NUMERIC_COLS.has(colKey);
  const existing = SL_FILTERS[colKey] || (isNumeric ? {type:"number",min:null,max:null} : {type:"text",search:"",selected:new Set()});
  let html = `<div class="vl-fp-head">${esc(colLabel)}</div>` + sortButtonsHtml("sl", SL_STATE, colKey, isNumeric);
  if(isNumeric){
    html += `
      <div class="vl-fp-row"><label>Min<input type="number" id="slFpMin" step="any" value="${existing.min!=null?existing.min:""}"></label></div>
      <div class="vl-fp-row"><label>Max<input type="number" id="slFpMax" step="any" value="${existing.max!=null?existing.max:""}"></label></div>`;
  }else{
    const values = slUniqueValuesFor(colKey);
    html += `<input type="text" id="slFpSearch" placeholder="Search…" value="${esc(existing.search||"")}">
      <div class="chklist vl-fp-list" id="slFpList">${values.map(v=>`<label data-v="${esc(v)}"><input type="checkbox" value="${esc(v)}" ${existing.selected.has(v)?"checked":""}> ${esc(v)}</label>`).join("")}</div>`;
  }
  html += `<div class="vl-fp-foot"><button class="btn sm" id="slFpClear">Clear Filter</button><span style="flex:1"></span><button class="btn sm" id="slFpCancel">Cancel</button><button class="btn sm primary" id="slFpApply">Apply</button></div>`;
  pop.innerHTML = html;
  pop.dataset.col = colKey;
  const r = anchorEl.getBoundingClientRect();
  pop.style.display = "block";
  let left = r.left + window.scrollX;
  if(left + 260 > window.scrollX + document.documentElement.clientWidth - 8) left = window.scrollX + document.documentElement.clientWidth - 268;
  pop.style.left = `${Math.max(8,left)}px`;
  pop.style.top = `${r.bottom + window.scrollY + 4}px`;
  if(!isNumeric){
    const search = $("#slFpSearch"), list = $("#slFpList");
    search.addEventListener("input",()=>{ const q = search.value.trim().toLowerCase(); $$("label",list).forEach(lb=>{ lb.style.display = lb.dataset.v.toLowerCase().includes(q) ? "" : "none"; }); });
    search.focus();
  }
  wireSortButtons("sl", SL_STATE, colKey, closeSlFilterPopover, renderStyleLevel);
  $("#slFpCancel").addEventListener("click",closeSlFilterPopover);
  $("#slFpClear").addEventListener("click",()=>{ delete SL_FILTERS[colKey]; closeSlFilterPopover(); SL_STATE.page=1; renderStyleLevel(); });
  $("#slFpApply").addEventListener("click",()=>{
    let f;
    if(isNumeric){
      const a = $("#slFpMin").value.trim(), b = $("#slFpMax").value.trim();
      f = {type:"number", min: a===""?null:Number(a), max: b===""?null:Number(b)};
    }else{
      f = {type:"text", search: $("#slFpSearch").value.trim(), selected: new Set($$("#slFpList input[type=checkbox]:checked").map(cb=>cb.value))};
    }
    if(vlFilterActive(f)) SL_FILTERS[colKey]=f; else delete SL_FILTERS[colKey];
    closeSlFilterPopover(); SL_STATE.page = 1; renderStyleLevel();
  });
  setTimeout(()=>document.addEventListener("click", _slPopOutsideHandler, true), 0);
}

/* ── Margin ──────────────────────────────────────────────────────────────
   Catalogue margin broken down by Category, Material Type, Main Shape,
   Diamond Carat Band, G2D Band and Price Band -- STYLE level (per the user:
   count styles, not variants). Each unit is one Style Level row, i.e. that
   style's averages across its variants; text dimensions use the style's most
   common value, bands use its average carat weight / average price:
     Margin %  = (Σ Final After GST − Σ Total CP Cost) / Σ Final After GST
     Margin2 % = same, after Cash Back (Additional Disc) comes off the price
   i.e. value-weighted, not a plain average of each variant's %. */
const MG_STATE = { status:"", includeZeroCp:false };
const MG_CARAT_BANDS = [
  ["No diamond", w=>!(w>0)], ["< 0.10 ct", w=>w<0.10], ["0.10 – 0.25 ct", w=>w<0.25],
  ["0.25 – 0.50 ct", w=>w<0.50], ["0.50 – 1.00 ct", w=>w<1.00], ["1.00 – 2.00 ct", w=>w<2.00], ["2.00 ct +", ()=>true],
];
const MG_PRICE_BANDS = [
  ["< ₹10K", p=>p<10000], ["₹10K – 25K", p=>p<25000], ["₹25K – 50K", p=>p<50000],
  ["₹50K – 1L", p=>p<100000], ["₹1L – 2L", p=>p<200000], ["₹2L – 5L", p=>p<500000], ["₹5L +", ()=>true],
];
function mgBand(bands, v){ for(const [label, test] of bands){ if(test(v)) return label; } return "—"; }
const MG_DIMS = [
  {key:"category", title:"Category", of:r=>r.category||"—"},
  {key:"material", title:"Material Type", of:r=>r.product_composition||"—"},
  {key:"shape", title:"Main Shape", of:r=>r.main_shape||"No diamond"},
  {key:"carat", title:"Diamond Carat Band", of:r=>mgBand(MG_CARAT_BANDS, Number(r.diamond_weight)||0), order:MG_CARAT_BANDS.map(b=>b[0])},
  {key:"g2d", title:"G2D Band", of:r=>r.g2d_band||"—", order:G2D_CARD.map(g=>g.band)},
  {key:"price", title:"Price Band", of:r=>mgBand(MG_PRICE_BANDS, Number(r.final_after_gst_overall)||0), order:MG_PRICE_BANDS.map(b=>b[0])},
];
function mgRows(){
  ensureStyleRows();
  let rows = (SL_STATE.allRows||[]).filter(r=>Number(r.final_after_gst_overall)>0);
  // Styles with no cost at all (Total CP 0 -- e.g. Cubic Zirconia / Silver,
  // which have no metal/diamond/labour cost in the data) would show a fake
  // 100% margin, so they're left out unless the user ticks them back in.
  if(!MG_STATE.includeZeroCp) rows = rows.filter(r=>Number(r.total_cp_cost)>0);
  if(MG_STATE.status) rows = rows.filter(r=>String(r.status||"").toLowerCase()===MG_STATE.status);
  const q = STATE.search.trim().toLowerCase();
  if(q) rows = rows.filter(r=>`${r.style||""} ${r.item_name||""} ${r.category||""} ${r.main_shape||""}`.toLowerCase().includes(q));
  return rows;
}
// One margin basis everywhere (2026-10-09): Final Margin % = (Σ Actual SP − Σ CP) ÷ Σ Actual SP,
// Actual SP = Final After GST Overall − free gold coin value (CP incl. 3% GST).
// margin2 = the older "Margin 2% with discount" basis (Final After GST, GST in) for comparison.
function mgAgg(rows){
  let sp=0, fin=0, cp=0, sumPct=0, nPct=0;
  for(const r of rows){
    const f = Number(r.final_after_gst_overall)||0, c = Number(r.total_cp_cost)||0;
    const a = (r.actual_sp!=null && r.actual_sp!=="") ? Number(r.actual_sp) : f;
    sp += a; fin += f; cp += c;
    const m = r.net_margin_pct!=null ? r.net_margin_pct : r.margin_pct;
    if(m!=null){ sumPct += Number(m); nPct++; }
  }
  return { n:rows.length, sell:sp, cp,
    margin: sp ? (sp-cp)/sp*100 : null,
    margin2: fin ? (fin-cp)/fin*100 : null,
    avg: nPct ? sumPct/nPct : null };
}
function mgGroup(rows, dim){
  const m = new Map();
  for(const r of rows){ const k = dim.of(r); if(!m.has(k)) m.set(k, []); m.get(k).push(r); }
  let out = [...m.entries()].map(([k, rs])=>({key:k, ...mgAgg(rs)}));
  if(dim.order){
    const idx = new Map(dim.order.map((k,i)=>[k,i]));
    out.sort((a,b)=>(idx.has(a.key)?idx.get(a.key):999)-(idx.has(b.key)?idx.get(b.key):999));
  }else out.sort((a,b)=>b.sell-a.sell);
  return out;
}
function mgTone(p){ return p==null ? "muted" : p<20 ? "crit" : p<35 ? "warn" : "good"; }
function mgPct(p){ return p==null ? `<span class="muted">—</span>` : `<span class="pill ${mgTone(p)}">${dec(p,1)}%</span>`; }
function mgTableHtml(dim, groups, total, labels){
  labels = labels || {unit:"Styles", sell:"Actual SP", cp:"Total CP"};
  const maxM = Math.max(1, ...groups.map(g=>g.margin||0));
  return `<div class="card" style="min-width:0">
    <h3>Margin by ${esc(dim.title)} <span class="rt">${int(groups.length)} groups</span></h3>
    <div class="tbl-wrap" style="max-height:420px">
      <table><thead><tr><th>${esc(dim.title)}</th><th class="num">${labels.unit}</th><th class="num">${labels.sell}</th><th class="num">${labels.cp}</th><th class="num">Final Margin %</th><th></th><th class="num">Margin 2% (incl. GST)</th><th class="num">Avg Final Margin %</th></tr></thead>
      <tbody>${groups.map(g=>`<tr>
        <td><b>${esc(g.key)}</b></td>
        <td class="num">${int(g.n)} <span class="muted" style="font-size:10.5px">(${pct(total.n? g.n/total.n*100 : 0)})</span></td>
        <td class="num">${money(g.sell)}</td><td class="num">${money(g.cp)}</td>
        <td class="num">${mgPct(g.margin)}</td>
        <td style="min-width:90px"><div class="bar"><span style="width:${Math.max(0,(g.margin||0)/maxM*100).toFixed(1)}%"></span></div></td>
        <td class="num">${mgPct(g.margin2)}</td><td class="num">${g.avg==null?"—":dec(g.avg,1)+"%"}</td>
      </tr>`).join("")}</tbody></table>
    </div></div>`;
}
function renderMargin(){
  const el = $("#page-margin");
  if(VL_STATE.allRows===null){
    el.innerHTML = `<div class="h2">Margin</div><div class="card muted" style="text-align:center;padding:30px">${VL_STATE.error?`Couldn't load: ${esc(VL_STATE.error)}`:"Loading the data and grouping it by style…"}</div>`;
    if(!VL_STATE.loading && !VL_STATE.error) fetchVariantAll();
    return;
  }
  const rows = mgRows();
  const total = mgAgg(rows);
  const zeroCp = (SL_STATE.allRows||[]).filter(r=>Number(r.final_after_gst_overall)>0 && !(Number(r.total_cp_cost)>0)).length;
  const byDim = MG_DIMS.map(d=>({dim:d, groups:mgGroup(rows, d)}));
  const big = (list)=>list.filter(g=>g.n>=5 && g.margin!=null);
  const cat = big(byDim[0].groups).sort((a,b)=>b.margin-a.margin);
  const priceG = big(byDim[5].groups).sort((a,b)=>a.margin-b.margin);
  const low = rows.filter(r=>r.margin_pct!=null && Number(r.margin_pct)<20).length;
  const insights = [];
  if(cat.length) insights.push(`<b>${esc(cat[0].key)}</b> has the highest category margin at <b>${dec(cat[0].margin,1)}%</b>; <b>${esc(cat[cat.length-1].key)}</b> the lowest at <b>${dec(cat[cat.length-1].margin,1)}%</b>.`);
  if(priceG.length) insights.push(`Thinnest price band: <b>${esc(priceG[0].key)}</b> at <b>${dec(priceG[0].margin,1)}%</b> across ${int(priceG[0].n)} styles.`);
  insights.push(`<b>${int(low)}</b> styles (${pct(rows.length? low/rows.length*100 : 0)}) sit below a <b>20%</b> average margin.`);
  if(total.margin!=null && total.margin2!=null) insights.push(`Final Margin (incl. GST, free coin off) is <b>${dec(total.margin,1)}%</b> vs <b>${dec(total.margin2,1)}%</b> on Final After GST (no coin).`);
  el.innerHTML = `
    <div class="h2" style="display:flex;align-items:center;gap:12px">Margin
      <label class="muted" style="font-size:12px;font-weight:600;margin-left:auto;display:flex;align-items:center;gap:6px;cursor:pointer" title="These styles have no metal/diamond/labour cost in the data, so their margin shows as 100%">
        <input type="checkbox" id="mgZeroCp" ${MG_STATE.includeZeroCp?"checked":""}> Include ${int(zeroCp)} styles with ₹0 cost
      </label>
      <select class="search" id="mgStatus" style="min-width:150px">
        <option value="">All statuses</option>
        ${["active","draft","archived"].map(s=>`<option value="${s}" ${MG_STATE.status===s?"selected":""}>Shopify: ${s}</option>`).join("")}
      </select>
    </div>
    <div class="sub"><b>Style level</b> — every style counts once, whatever number of variants it has (same rows as the <b>Product Default</b> tab: each style's default variant — 14KT · YG · category default size). <b>Margin %</b> = (Σ avg Final After GST − Σ avg Total CP Cost) ÷ Σ avg Final After GST, so higher-priced styles weigh more; <b>Margin2 %</b> is after Cash Back; <b>Avg Margin %</b> is the plain average of each style's margin. Category / Material / Shape / G2D Band = the style's most common value; Carat and Price Band use its average carat weight and price. The top search box filters this tab too.</div>
    <div class="grid kpis" style="margin-bottom:13px">
      <div class="card kpi"><div class="lbl">Styles</div><div class="val">${int(total.n)}</div></div>
      <div class="card kpi"><div class="lbl">Avg-Price Actual SP</div><div class="val">${money(total.sell)}</div></div>
      <div class="card kpi"><div class="lbl">Avg-Price CP Cost</div><div class="val">${money(total.cp)}</div></div>
      <div class="card kpi"><div class="lbl">Final Margin %</div><div class="val">${total.margin==null?"—":dec(total.margin,1)+"%"}</div><div class="sub2">(Actual SP − CP) ÷ Actual SP</div></div>
      <div class="card kpi"><div class="lbl">Margin 2% (incl. GST)</div><div class="val">${total.margin2==null?"—":dec(total.margin2,1)+"%"}</div><div class="sub2">old basis, for comparison</div></div>
    </div>
    ${insightBox(insights)}
    <div class="grid" style="align-items:start;grid-template-columns:repeat(auto-fit,minmax(min(100%,620px),1fr));margin-top:13px">${byDim.map(x=>mgTableHtml(x.dim, x.groups, total)).join("")}</div>`;
  $("#mgStatus").addEventListener("change",e=>{ MG_STATE.status = e.target.value; renderMargin(); });
  $("#mgZeroCp").addEventListener("change",e=>{ MG_STATE.includeZeroCp = e.target.checked; renderMargin(); });
}

/* ── Daily Check ─────────────────────────────────────────────────────────
   Tick-box health list from pos-price-api GET /health-check: gold rate
   updated today, daily refresh ran on it, rate edits deployed, every slab
   loaded, every calculation re-verified on the published rows. ok:true =
   ticked, false = problem (red), null = nothing to tick today (blank). */
const HC_STATE = { data:null, loading:false, error:null };
async function fetchHealthCheck(){
  HC_STATE.loading = true; HC_STATE.error = null;
  if(STATE.tab==="health") renderHealth();
  try{
    const res = await fetch(`${PP_API}/health-check`, {cache:"no-store"});
    const data = await res.json();
    if(data.error) throw new Error(data.error);
    HC_STATE.data = data;
  }catch(e){ HC_STATE.error = e.message || "network error"; }
  HC_STATE.loading = false;
  if(STATE.tab==="health") renderHealth();
}
function hcBox(ok){
  const base = "display:inline-grid;place-items:center;width:22px;height:22px;border-radius:6px;font-size:15px;font-weight:900;flex:none;";
  if(ok===true) return `<span style="${base}background:var(--good);color:#fff" title="OK">✓</span>`;
  if(ok===false) return `<span style="${base}background:var(--crit);color:#fff" title="Problem">✕</span>`;
  return `<span style="${base}border:2px solid var(--border)" title="Nothing to tick today"></span>`;
}
function renderHealth(){
  const el = $("#page-health");
  const d = HC_STATE.data;
  const head = `
    <div class="h2" style="display:flex;align-items:center;gap:12px">Daily Check
      <button class="btn sm" id="hcRerun" style="margin-left:auto" ${HC_STATE.loading?"disabled":""}>${HC_STATE.loading?"Checking…":"↻ Re-run checks"}</button>
    </div>
    <div class="sub">Every box is worked out live from BigQuery each time this tab opens. A tick means it's correct today; a <b style="color:var(--crit)">✕</b> means something needs fixing; an empty box means there was nothing to do today (e.g. no rate changes were deployed). Calculations are re-checked on every published row, not a sample.</div>`;
  if(HC_STATE.error && !d){ el.innerHTML = head + `<div class="card muted" style="padding:20px">Couldn't run the checks: ${esc(HC_STATE.error)}</div>`; }
  else if(!d){ el.innerHTML = head + `<div class="card muted" style="text-align:center;padding:30px">Running checks… (takes about half a minute)</div>`; }
  else{
    const at = new Date(d.checked_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});
    const total = d.checks.length;
    const allGood = d.failed===0;
    const groups = [...new Set(d.checks.map(c=>c.group))];
    el.innerHTML = head + `
      <div class="grid kpis" style="margin-bottom:13px">
        <div class="card kpi"><div class="lbl">Status today</div><div class="val ${allGood?"good":"crit"}">${allGood?"All OK":`${int(d.failed)} problem${d.failed>1?"s":""}`}</div><div class="sub2">${esc(d.date)} · checked ${esc(at)} IST</div></div>
        <div class="card kpi"><div class="lbl">Ticked</div><div class="val good">${int(d.passed)} / ${int(total)}</div></div>
        <div class="card kpi"><div class="lbl">Problems</div><div class="val ${d.failed?"crit":""}">${int(d.failed)}</div></div>
        <div class="card kpi"><div class="lbl">Nothing to do today</div><div class="val">${int(d.blank)}</div></div>
      </div>
      ${groups.map(g=>`<div class="card" style="margin-bottom:13px">
        <h3>${esc(g)} <span class="rt">${int(d.checks.filter(c=>c.group===g && c.ok===true).length)} / ${int(d.checks.filter(c=>c.group===g).length)} ticked</span></h3>
        ${d.checks.filter(c=>c.group===g).map(c=>`
          <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 2px;border-top:1px solid var(--border)">
            ${hcBox(c.ok)}
            <div style="min-width:0"><div style="font-weight:700">${esc(c.name)}</div>
            <div class="muted" style="font-size:12px;margin-top:2px">${esc(c.detail)}</div></div>
          </div>`).join("")}
      </div>`).join("")}`;
  }
  $("#hcRerun").addEventListener("click", fetchHealthCheck);
  if(!d && !HC_STATE.loading && !HC_STATE.error) fetchHealthCheck();
}

/* ── Gold Rate strip: above EVERY tab ───────────────────────────────────
   Today's per-gram gold rate per karat (24K/22K/18K/14K/9K) from
   pos-price-api /gold-rate-strip, plus the per-gram rate actually inside
   the published prices, with a ✓ when they match -- so anyone looking at
   any tab can confirm the prices are on today's rate. */
const GS_STATE = { data:null, error:null };
async function fetchGoldStrip(){
  try{
    const res = await fetch(`${PP_API}/gold-rate-strip`, {cache:"no-store"});
    const data = await res.json();
    if(data.error) throw new Error(data.error);
    GS_STATE.data = data; GS_STATE.error = null;
    if(STATE.tab==="shopify" && typeof renderShopify==="function") renderShopify();
  }catch(e){ GS_STATE.error = e.message || "network error"; }
  renderGoldStrip();
}
function renderGoldStrip(){
  const el = $("#goldStrip");
  if(!el) return;
  const d = GS_STATE.data;
  if(!d){
    el.innerHTML = `<div class="card muted" style="margin-bottom:13px;padding:10px 14px;font-size:12px">${GS_STATE.error?`Gold rate couldn't load: ${esc(GS_STATE.error)}`:"Loading today's gold rate…"}</div>`;
    return;
  }
  const allMatch = d.karats.every(k=>k.match!==false);
  const dateTxt = d.rate_date ? new Date(d.rate_date+"T00:00:00").toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}) : "—";
  const snapTxt = d.snapshot_created_at ? new Date(d.snapshot_created_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "—";
  const cell = v=>v==null ? `<span class="muted">—</span>` : `₹${n(v).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  el.innerHTML = `<div class="card" style="margin-bottom:13px;padding:10px 14px">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
      <b>Gold Rate per gram</b>
      <span class="muted" style="font-size:11.5px">rate date ${esc(dateTxt)} · 24K ₹${int(d.rate_24k_10g)} / 10 g · prices published ${esc(snapTxt)} IST</span>
      <span class="pill ${allMatch?"good":"crit"}" style="margin-left:auto">${allMatch?"✓ Prices use today's rate":"✕ Prices are NOT on today's rate"}</span>
    </div>
    <div class="scroll-x"><table style="min-width:520px"><thead><tr><th></th>${d.karats.map(k=>`<th class="num">${esc(k.kt)}KT <span class="muted" style="font-weight:600">(${k.purity_pct}%)</span></th>`).join("")}</tr></thead>
    <tbody>
      <tr><td><b>Today's rate</b></td>${d.karats.map(k=>{
        // Green = the prices on every tab use exactly this rate; red = they don't (refresh needed).
        const bad = k.match===false;
        const tip = bad ? `Prices use ₹${n(k.published).toLocaleString("en-IN",{minimumFractionDigits:2})} — not today's rate` : "Prices use this rate";
        return `<td class="num" title="${esc(tip)}" style="${bad?"background:rgba(224,80,90,.16);color:var(--crit)":"color:var(--good)"}"><b>${cell(k.today)}</b> ${bad?"✕":"✓"}</td>`;
      }).join("")}</tr>
    </tbody></table></div>
  </div>`;
}

/* ── Shopify ─────────────────────────────────────────────────────────────
   Variant Level's calculation re-run on SHOPIFY weights (pos-price-api
   /shopify?full=1 -> gzip blob, rebuilt with the daily refresh). One row per
   Shopify variant with an Item Code. Shopify columns come from the variant
   metafields (ornaverse first, as in the user's query); diamond_pieces falls
   back to total_number_of_diamonds and diamond_weight to total_weight_approx_.
   Every pricing column is produced server-side by the SAME function that
   builds Variant Level -- only Net Weight / Diamond Weight are the Shopify
   ones (see shopify_variant_level_rows in pos-price-api). */
const SH_STATE = { allRows:null, loading:false, error:null, snapshot:null, page:1, pageSize:50, sort:null, view:"calc" };
// {colKey: {type:'text', search, selected:Set} | {type:'number', min, max}} -- same as Variant Level's VL_FILTERS
const SH_FILTERS = {};
const VL_LABEL = Object.assign(Object.fromEntries(VL_COLS), VL_EXTRA_LABELS);
const SH_LABEL = Object.assign({}, VL_LABEL, {
  owner_id:"Owner ID", style:"Style", item_code:"Item Code", item_name:"Item Name", status:"Status", weight_basis:"Weight Basis",
  synced:"Synced",
  color_stone_pieces:"Color Stone Pcs", color_stone_weight:"Color Stone Wt",
  diamond_1_numbers:"Diamond 1 Pcs", diamond_1_weight:"Diamond 1 Wt", diamond_2_numbers:"Diamond 2 Pcs", diamond_2_weight:"Diamond 2 Wt",
  diamond_3_numbers:"Diamond 3 Pcs", diamond_3_weight:"Diamond 3 Wt", diamond_4_numbers:"Diamond 4 Pcs", diamond_4_weight:"Diamond 4 Wt",
  diamond_pieces:"Diamond Pieces", diamond_weight:"Diamond Weight (Shopify)", gemstone_1_numbers:"Gemstone 1 Pcs", gemstone_1_weight:"Gemstone 1 Wt",
  metal_purity:"Metal Purity", metal_weight:"Net Weight (Shopify)", stone_pieces:"Stone Pcs", stone_weight:"Stone Wt",
  karat:"Karat", diamond_rate:"Diamond Rate /ct", erp_net_weight:"ERP Net Weight", erp_diamond_weight:"ERP Diamond Weight",
  diamond_weight_used:"Diamond Wt Used", diamond_wt_check:"Diamond Wt Check",
  diamond_pieces:"Diamond Pcs (Shopify)", erp_diamond_pieces:"ERP Diamond Pcs",
});
// diamond_wt_check value -> pill tone (see _diamond_wt_check in pos-price-api)
const SH_DW_CHECK_TONE = {"OK":"good", "Not diamond":"muted", "Shopify blank (ERP used)":"warn",
  "Shopify wt ≠ ERP":"warn", "Shopify pcs ≠ ERP":"warn",
  "Missing weight (Shopify & ERP)":"crit", "Missing pieces (Shopify & ERP)":"crit", "No diamond rate / CP":"crit"};
const SH_WEIGHT_COLS = ["color_stone_pieces","color_stone_weight","diamond_1_numbers","diamond_1_weight","diamond_2_numbers","diamond_2_weight",
  "diamond_3_numbers","diamond_3_weight","diamond_4_numbers","diamond_4_weight","diamond_pieces","diamond_weight",
  "gemstone_1_numbers","gemstone_1_weight","metal_purity","metal_weight","stone_pieces","stone_weight"];
// Same sequence as VL_COLS (the user's sheet); Net Weight / Diamond Weight
// positions show the SHOPIFY weights the calculation used.
const SH_CALC_COLS = VL_COLS.map(c=>c[0])
  .filter(k=>!["item_code","item_name","image_url","status"].includes(k))
  .flatMap(k=>k==="net_weight" ? ["metal_weight"] : k==="diamond_weight" ? [k, "diamond_weight_used"]
    : k==="diamond_pieces" ? [k, "erp_diamond_pieces", "diamond_wt_check"] : [k]);
// The user's front-column order (2026-10-23): Owner ID, Style, Item Code, Item Name, Status, Synced, then the calc flow.
const SH_FRONT = ["owner_id","style","item_code","item_name","status","synced"];
const SH_VIEWS = {
  calc: {label:"Calculation on Shopify weights", cols:[...SH_FRONT, ...SH_CALC_COLS, "metal_purity","karat","diamond_rate"]},
  weights: {label:"Shopify weights", cols:[...SH_FRONT, "material_type", ...SH_WEIGHT_COLS, "erp_net_weight","erp_diamond_weight","diamond_weight_used","erp_diamond_pieces","diamond_wt_check","weight_basis"]},
  all: {label:"All columns", cols:[...SH_FRONT, ...SH_CALC_COLS,
    ...SH_WEIGHT_COLS.filter(k=>!SH_CALC_COLS.includes(k)), "karat","diamond_rate", ...Object.keys(VL_EXTRA_LABELS), "erp_net_weight","erp_diamond_weight","weight_basis"]},
};
const SH_TEXT = new Set(["synced","free_gold_coin","material_type","slab_status","owner_id","style","item_code","item_name","status","weight_basis","diamond_wt_check","gemstone_type","metal_purity","product_composition","item_group","category","main_shape","karat","g2d_band"]);
const SH_NUMERIC = new Set(Object.keys(SH_LABEL).filter(k=>!SH_TEXT.has(k)));
function shCols(){ return (SH_VIEWS[SH_STATE.view]||SH_VIEWS.calc).cols.map(k=>[k, SH_LABEL[k]||k]); }
async function fetchShopify(force){
  SH_STATE.loading = true; SH_STATE.error = null;
  if(STATE.tab==="shopify") renderShopify();
  try{
    const data = await fetchFullDataset(`${PP_API}/shopify?full=1${force?"&refresh=1":""}`);
    data.rows.forEach(r=>{ r.style = styleOf(r.item_code); });  // same Style rule as the Style Level tab
    SH_STATE.allRows = data.rows; SH_STATE.snapshot = data.snapshot || null; SH_STATE._sortCache = null; _shUniqueCache.clear();
    shopifyLogValidation(data.rows, data.snapshot);
  }catch(e){ SH_STATE.error = e.message || "network error"; }
  SH_STATE.loading = false;
  if(STATE.tab==="shopify") renderShopify();
}
function shopifyLogValidation(rows, snap){
  const ids = new Set(rows.map(r=>r.owner_id));
  console.log("[Shopify tab] validation", {
    "Total Shopify variants": rows.length, "Duplicate owner_id count": rows.length - ids.size,
    "Blank item_code": rows.filter(r=>!r.item_code).length,
    "Diamond weight from ERP (no Shopify value)": rows.filter(r=>String(r.weight_basis||"").includes("diamond wt from ERP")).length,
    "Active count": rows.filter(r=>r.status==="Active").length, "Draft count": rows.filter(r=>r.status==="Draft").length,
    "Server checks": snap && snap.validation });
}
function shopifyFiltered(){
  let rows = sortedAllRows(SH_STATE, SH_NUMERIC);
  const q = STATE.search.trim().toLowerCase();
  if(q) rows = rows.filter(r=>`${r.owner_id} ${r.item_code||""} ${r.item_name||""} ${r.status||""}`.toLowerCase().includes(q));
  const keys = Object.keys(SH_FILTERS).filter(k=>vlFilterActive(SH_FILTERS[k]));
  if(keys.length) rows = rows.filter(r=>keys.every(k=>vlPassesFilter(r,k,SH_FILTERS[k])));
  return rows;
}
const _shUniqueCache = new Map();
function shUniqueValuesFor(k){
  if(_shUniqueCache.has(k)) return _shUniqueCache.get(k);
  const set = new Set();
  (SH_STATE.allRows||[]).forEach(r=>{ const v = vlRawStr(r,k); if(v) set.add(v); });
  const vals = [...set].sort((a,b)=>a.localeCompare(b, undefined, {numeric:true}));
  _shUniqueCache.set(k, vals);
  return vals;
}
function shFilterChipsHtml(){
  const keys = Object.keys(SH_FILTERS).filter(k=>vlFilterActive(SH_FILTERS[k]));
  if(!keys.length) return "";
  const label = k=>{
    const f = SH_FILTERS[k], col = SH_LABEL[k]||k;
    if(f.type==="number"){ const p=[]; if(f.min!=null) p.push(`≥ ${f.min}`); if(f.max!=null) p.push(`≤ ${f.max}`); return `${col}: ${p.join(" and ")}`; }
    if(f.selected && f.selected.size) return `${col}: ${[...f.selected].slice(0,3).join(", ")}${f.selected.size>3?` +${f.selected.size-3}`:""}`;
    return `${col}: "${f.search}"`;
  };
  return `<div class="vl-chipbar">${keys.map(k=>`<span class="vl-chip">${esc(label(k))}<button class="vl-chip-x sh-chip-x" data-col="${esc(k)}" title="Clear this filter">✕</button></span>`).join("")}<button class="btn sm" id="shClearAllBtn">Clear All Filters</button></div>`;
}
function closeShFilterPopover(){
  const pop = $("#shFilterPop");
  if(pop){ pop.style.display = "none"; pop.innerHTML = ""; }
  document.removeEventListener("click", _shPopOutsideHandler, true);
}
function _shPopOutsideHandler(e){
  const pop = $("#shFilterPop");
  if(pop && !pop.contains(e.target) && !e.target.classList.contains("sh-filter-btn")) closeShFilterPopover();
}
// Same popover as Variant Level's openVlFilterPopover: Sort A→Z / Z→A (or
// Smallest/Largest), then Min/Max for number columns or Search + checklist
// for text columns, Clear / Cancel / Apply.
function openShFilterPopover(colKey, anchorEl){
  const pop = $("#shFilterPop");
  if(!pop) return;
  const same = pop.style.display!=="none" && pop.dataset.col===colKey;
  closeShFilterPopover();
  if(same) return;
  const colLabel = SH_LABEL[colKey]||colKey;
  const isNumeric = SH_NUMERIC.has(colKey);
  const existing = SH_FILTERS[colKey] || (isNumeric ? {type:"number",min:null,max:null} : {type:"text",search:"",selected:new Set()});
  let html = `<div class="vl-fp-head">${esc(colLabel)}</div>` + sortButtonsHtml("sh", SH_STATE, colKey, isNumeric);
  if(isNumeric){
    html += `
      <div class="vl-fp-row"><label>Min<input type="number" id="shFpMin" step="any" value="${existing.min!=null?existing.min:""}"></label></div>
      <div class="vl-fp-row"><label>Max<input type="number" id="shFpMax" step="any" value="${existing.max!=null?existing.max:""}"></label></div>
      <div class="vl-fp-hint">Leave Min blank for "≤ Max" only, Max blank for "≥ Min" only, or set both equal for an exact match.</div>`;
  }else{
    const values = shUniqueValuesFor(colKey);
    html += `<input type="text" id="shFpSearch" placeholder="Search…" value="${esc(existing.search||"")}">
      <div class="vl-fp-actions"><a href="#" id="shFpSelectAll">Select all shown</a><a href="#" id="shFpClearSel">Clear selection</a></div>
      <div class="chklist vl-fp-list" id="shFpList">${values.map(v=>`<label data-v="${esc(v)}"><input type="checkbox" value="${esc(v)}" ${existing.selected.has(v)?"checked":""}> ${esc(v)}</label>`).join("")}</div>`;
  }
  html += `<div class="vl-fp-foot"><button class="btn sm" id="shFpClear">Clear Filter</button><span style="flex:1"></span><button class="btn sm" id="shFpCancel">Cancel</button><button class="btn sm primary" id="shFpApply">Apply</button></div>`;
  pop.innerHTML = html;
  pop.dataset.col = colKey;
  const r = anchorEl.getBoundingClientRect();
  pop.style.display = "block";
  let left = r.left + window.scrollX;
  if(left + 260 > window.scrollX + document.documentElement.clientWidth - 8) left = window.scrollX + document.documentElement.clientWidth - 268;
  pop.style.left = `${Math.max(8,left)}px`;
  pop.style.top = `${r.bottom + window.scrollY + 4}px`;
  if(!isNumeric){
    const search = $("#shFpSearch"), list = $("#shFpList");
    search.addEventListener("input",()=>{ const q = search.value.trim().toLowerCase(); $$("label",list).forEach(lb=>{ lb.style.display = lb.dataset.v.toLowerCase().includes(q) ? "" : "none"; }); });
    search.focus();
    $("#shFpSelectAll").addEventListener("click",e=>{ e.preventDefault(); $$("label",list).forEach(lb=>{ if(lb.style.display!=="none") lb.querySelector("input").checked=true; }); });
    $("#shFpClearSel").addEventListener("click",e=>{ e.preventDefault(); $$("input[type=checkbox]",list).forEach(cb=>cb.checked=false); });
  }
  wireSortButtons("sh", SH_STATE, colKey, closeShFilterPopover, renderShopify);
  $("#shFpCancel").addEventListener("click",closeShFilterPopover);
  $("#shFpClear").addEventListener("click",()=>{ delete SH_FILTERS[colKey]; closeShFilterPopover(); SH_STATE.page=1; renderShopify(); });
  $("#shFpApply").addEventListener("click",()=>{
    let f;
    if(isNumeric){
      const a = $("#shFpMin").value.trim(), b = $("#shFpMax").value.trim();
      f = {type:"number", min: a===""?null:Number(a), max: b===""?null:Number(b)};
    }else{
      f = {type:"text", search: $("#shFpSearch").value.trim(), selected: new Set($$("#shFpList input[type=checkbox]:checked").map(cb=>cb.value))};
    }
    if(vlFilterActive(f)) SH_FILTERS[colKey]=f; else delete SH_FILTERS[colKey];
    closeShFilterPopover(); SH_STATE.page = 1; renderShopify();
  });
  setTimeout(()=>document.addEventListener("click", _shPopOutsideHandler, true), 0);
}
function shCell(r,k){
  const blank = `<span class="muted">—</span>`;
  if(k==="status") return r.status ? `<span class="pill ${VL_STATUS_TONE[String(r.status).toLowerCase()]||"muted"}">${esc(r.status)}</span>` : `<span class="muted">Not on Shopify</span>`;
  if(k==="owner_id") return `<span style="font-family:var(--mono)">${esc(r.owner_id)}</span>`;
  if(k==="style") return `<b>${esc(r.style||"—")}</b>`;
  // Synced = Shopify has the {"components":[...]} JSON for this variant
  if(k==="synced") return r.synced==="Yes" ? `<span class="pill good">Yes</span>` : `<span class="pill muted">No</span>`;
  if(k==="weight_basis") return r.weight_basis==="Shopify" ? `<span class="pill good">Shopify</span>` : `<span class="pill warn" title="${esc(r.weight_basis||"")}">${esc(r.weight_basis||"—")}</span>`;
  if(k==="diamond_wt_check") return r[k] ? `<span class="pill ${SH_DW_CHECK_TONE[r[k]]||"warn"}">${esc(r[k])}</span>` : blank;
  if(k==="karat") return r.karat ? `${esc(r.karat)}K` : blank;
  if(k==="diamond_rate") return r[k]==null ? blank : dec(r[k],2);
  if(SH_WEIGHT_COLS.includes(k) || k==="erp_net_weight" || k==="erp_diamond_weight" || k==="diamond_weight_used" || k==="erp_diamond_pieces"){
    if(r[k]==null || r[k]==="") return blank;
    if(k==="metal_purity") return esc(r[k]);
    return /numbers|pieces/.test(k) ? int(r[k]) : dec(r[k],3);
  }
  return vlCellValue(r,k);  // every Variant Level column: same formatting as Variant Level
}
function shSummary(rows){  // Final Margin basis: Actual SP vs CP (margin2 = old GST-inclusive basis)
  let sp=0, fin=0, cp=0, n=0;
  for(const r of rows){ const f=Number(r.final_after_gst_overall); if(!(f>0)) continue; n++; fin+=f; sp+=Number(r.actual_sp!=null?r.actual_sp:f); cp+=Number(r.total_cp_cost)||0; }
  return { n, sell:sp, cp, margin: sp?(sp-cp)/sp*100:null, margin2: fin?(fin-cp)/fin*100:null };
}
function renderShopify(){
  const el = $("#page-shopify");
  const head = `<div class="h2" style="display:flex;align-items:center;gap:12px">Shopify
      <button class="btn sm" id="shRefresh" style="margin-left:auto" ${SH_STATE.loading?"disabled":""}>${SH_STATE.loading?"Loading…":"↻ Rebuild from BigQuery"}</button>
      <button class="btn sm" id="shCsv" ${SH_STATE.allRows?"":"disabled"}>⭳ Download (CSV)</button>
    </div>
    <div class="sub"><b>Variant Level's calculation, run on Shopify weights.</b> One row per Shopify variant with an Item Code. Shopify columns come from the variant metafields; <b>Diamond Pieces</b> = diamond_pieces, else total_number_of_diamonds; <b>Diamond Weight</b> = diamond_weight, else total_weight_approx_ (first value above 0 — Ornaverse's 0.0 placeholder is skipped). For a diamond Material Type the diamond weight and pieces are compulsory: if Shopify has no weight, the ERP weight is used (<b>Diamond Wt Used</b>), and <b>Diamond Wt Check</b> flags blank, missing, no-CP and Shopify ≠ ERP (weight &gt; 0.01 ct, or pieces) variants. <b>Other BOM</b> columns (colour stone, CZ, accessories such as silicon band / ceramic / stretchable belt) come from the ERP BOM; their amount is in Final After GST and their CP in Total CP. Every pricing column — Metal Amount (Shopify metal weight × today's karat rate), Diamond Amount (Shopify diamond weight × the variant's diamond rate /ct), G2D, Making /g and discounts (from that G2D band), Labour, GST, Cash Back, CP and Margin — is produced by the <b>same code</b> as Variant Level, with only the weights swapped. If Shopify has no weight, the ERP weight is used and <b>Weight Basis</b> says so. Click any column's <b>▾</b> to sort or filter it — same filters as Variant Level.</div>`;
  if(!SH_STATE.allRows){
    el.innerHTML = head + `<div class="card muted" style="text-align:center;padding:30px">${SH_STATE.error?`Couldn't load: ${esc(SH_STATE.error)}`:"Loading Shopify variants… (if today's data isn't built yet this takes about 3 minutes; it's normally pre-built by the daily refresh)"}</div>`;
    wireShopifyButtons();
    if(!SH_STATE.loading && !SH_STATE.error) fetchShopify(false);
    return;
  }
  const all = SH_STATE.allRows, rows = shopifyFiltered(), cols = shCols();
  const s = shSummary(rows);
  const totalPages = Math.max(1, Math.ceil(rows.length/SH_STATE.pageSize));
  SH_STATE.page = Math.min(Math.max(1, SH_STATE.page), totalPages);
  const start = (SH_STATE.page-1)*SH_STATE.pageSize;
  const built = SH_STATE.snapshot && SH_STATE.snapshot.snapshot_created_at
    ? new Date(SH_STATE.snapshot.snapshot_created_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "—";
  const tile = (lbl,val,sub="",cls="")=>`<div class="card kpi"><div class="lbl">${lbl}</div><div class="val ${cls}">${val}</div>${sub?`<div class="sub2">${sub}</div>`:""}</div>`;
  const dwc = {}; rows.forEach(r=>{ if(r.diamond_wt_check && r.diamond_wt_check!=="Not diamond") dwc[r.diamond_wt_check] = (dwc[r.diamond_wt_check]||0)+1; });
  const dwTotal = Object.values(dwc).reduce((a,b)=>a+b,0);
  const dwBad = (dwc["Missing weight (Shopify & ERP)"]||0) + (dwc["Missing pieces (Shopify & ERP)"]||0) + (dwc["No diamond rate / CP"]||0);
  const th = cols.map(([k,l])=>{
    const active = SH_FILTERS[k] && vlFilterActive(SH_FILTERS[k]);
    const sorted = SH_STATE.sort && SH_STATE.sort.col===k;
    return `<th data-col="${k}" class="${SH_NUMERIC.has(k)?"num":""}${sorted?" sorted":""}">${esc(l)}${sortArrow(SH_STATE,k)}<button class="vl-filter-btn sh-filter-btn${active||sorted?" on":""}" data-col="${esc(k)}" title="Sort / filter ${esc(l)}">▾</button></th>`;
  }).join("");
  el.innerHTML = head + `
    <div class="grid kpis" style="margin-bottom:13px">
      ${tile("Styles", int(new Set(rows.map(r=>r.style)).size), `unique styles · ${int(rows.length)} variants${rows.length!==all.length?` (filtered from ${int(all.length)})`:""}`)}
      ${tile("Active / Draft Styles", `${int(new Set(rows.filter(r=>r.status==="Active").map(r=>r.style)).size)} / ${int(new Set(rows.filter(r=>r.status==="Draft").map(r=>r.style)).size)}`, "unique styles with an Active / Draft variant")}
      ${tile("Actual SP", money(s.sell), "Σ (Final After GST − free coin)")}
      ${tile("Total CP Cost", money(s.cp))}
      ${tile("Final Margin %", s.margin==null?"—":mgPct(s.margin), "(Actual SP − CP) ÷ Actual SP")}
      ${tile("Margin 2% (incl. GST)", s.margin2==null?"—":mgPct(s.margin2), "old basis, for comparison")}
      ${tile("Diamond Wt Check", `${int(dwc["OK"]||0)} / ${int(dwTotal)} OK`, `diamond variants · ${int(dwc["Shopify blank (ERP used)"]||0)} Shopify blank (ERP used) · ${int((dwc["Shopify wt ≠ ERP"]||0)+(dwc["Shopify pcs ≠ ERP"]||0))} Shopify ≠ ERP (wt / pcs) · ${int(dwBad)} no weight / pieces / CP`, dwBad?"crit":"good")}
    </div>
    <div class="toolbar" style="margin-bottom:8px">
      <select class="search" id="shView" style="min-width:230px">${Object.entries(SH_VIEWS).map(([k,v])=>`<option value="${k}" ${k===SH_STATE.view?"selected":""}>View: ${esc(v.label)}</option>`).join("")}</select>
      <span class="muted" style="font-size:11.5px;margin-left:auto">built ${esc(built)} IST</span>
    </div>
    ${shFilterChipsHtml()}
    <div class="pager" style="justify-content:space-between;margin-bottom:8px">
      <span>${rows.length?`Showing ${int(start+1)}–${int(Math.min(start+SH_STATE.pageSize, rows.length))} of ${int(rows.length)}${rows.length!==all.length?` (filtered from ${int(all.length)})`:""}`:"No matches"}</span>
      <span><button id="shPrev" ${SH_STATE.page<=1?"disabled":""}>‹ Prev</button> Page ${int(SH_STATE.page)} of ${int(totalPages)} <button id="shNext" ${SH_STATE.page>=totalPages?"disabled":""}>Next ›</button></span>
    </div>
    <div class="tbl-wrap" style="max-height:65vh"><table><thead><tr>${th}</tr></thead><tbody>
      ${rows.slice(start, start+SH_STATE.pageSize).map(r=>`<tr>${cols.map(([k])=>`<td class="${SH_NUMERIC.has(k)?"num":""}">${shCell(r,k)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length}" class="muted" style="text-align:center;padding:20px">No variants match the filters</td></tr>`}
    </tbody></table></div>
    <div id="shFilterPop" class="vl-filterpop" style="display:none"></div>`;
  wireShopifyButtons();
  const rerender = ()=>{ SH_STATE.page = 1; renderShopify(); };
  $("#shView").addEventListener("change",e=>{ SH_STATE.view = e.target.value; renderShopify(); });
  $$("#page-shopify .sh-filter-btn").forEach(b=>b.addEventListener("click",e=>{ e.stopPropagation(); openShFilterPopover(b.dataset.col, b); }));
  $$("#page-shopify .sh-chip-x").forEach(x=>x.addEventListener("click",()=>{ delete SH_FILTERS[x.dataset.col]; rerender(); }));
  const clr = $("#shClearAllBtn");
  if(clr) clr.addEventListener("click",()=>{ Object.keys(SH_FILTERS).forEach(k=>delete SH_FILTERS[k]); rerender(); });
  $("#shPrev").addEventListener("click",()=>{ SH_STATE.page--; renderShopify(); });
  $("#shNext").addEventListener("click",()=>{ SH_STATE.page++; renderShopify(); });
}
function wireShopifyButtons(){
  const r = $("#shRefresh"); if(r) r.addEventListener("click",()=>fetchShopify(true));
  const c = $("#shCsv"); if(c) c.addEventListener("click",downloadShopifyCsv);
}
function downloadShopifyCsv(){
  const rows = shopifyFiltered(), cols = shCols().map(c=>c[0]);  // export = the columns on screen
  const cell = v=>{ if(v==null) return ""; const s=String(v); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; };
  const csv = [cols.map(k=>cell(SH_LABEL[k]||k)).join(",")].concat(rows.map(r=>cols.map(k=>cell(k==="owner_id"?`'${r[k]}`:r[k])).join(","))).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"})); a.download = "shopify_variant_level.csv";
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

/* ── Company ─────────────────────────────────────────────────────────────
   Live stock per company (ds_imputed_reporting.Live_inventory, via
   pos-price-api /company-inventory). Purchase Amount = item_cost as booked;
   Selling Amount = Variant Level's Final After GST for that Item Code x
   pieces (the published snapshot, i.e. the same price the Variant Level tab
   shows). Margin % = (Selling − Purchase) ÷ Selling, value-weighted -- only
   over pieces that have BOTH amounts; pieces whose Item Code isn't in
   Variant Level are counted separately, never guessed. */
const CO_STATE = { rows:null, loading:false, error:null, snapshot:null, company:"", q:"", sort:{col:"selling_amount", dir:-1}, page:1, pageSize:50 };
async function fetchCompany(){
  CO_STATE.loading = true; CO_STATE.error = null;
  if(STATE.tab==="company") renderCompany();
  try{
    const res = await fetch(`${PP_API}/company-inventory`, {cache:"no-store"});
    const data = await res.json();
    if(data.error) throw new Error(data.error);
    CO_STATE.rows = data.rows; CO_STATE.snapshot = data.snapshot || null;
  }catch(e){ CO_STATE.error = e.message || "network error"; }
  CO_STATE.loading = false;
  if(STATE.tab==="company") renderCompany();
  if(STATE.tab==="invmargin") renderInvMargin();
}
function coAgg(rows){
  let pcs=0, pur=0, sell=0, priced=0, unpriced=0;
  for(const r of rows){
    pcs += r.pieces||0;
    // a Variant Level price of 0 is "not priced" (no component price), same as a missing one
    if(r.selling_amount>0 && r.purchase_amount!=null){ pur += r.purchase_amount; sell += r.selling_amount; priced += r.pieces||0; }
    else unpriced += r.pieces||0;
  }
  return { pcs, pur, sell, priced, unpriced, styles:new Set(rows.map(r=>styleOf(r.item_code))).size,
           margin: sell ? (sell-pur)/sell*100 : null };
}
function coName(code, name){
  const short = String(name||"").match(/\(([^)]+)\)/);
  return short ? short[1] : (name || "—");
}
function renderCompany(){
  const el = $("#page-company");
  const head = `<div class="h2" style="display:flex;align-items:center;gap:12px">Company
      <button class="btn sm" id="coReload" style="margin-left:auto" ${CO_STATE.loading?"disabled":""}>${CO_STATE.loading?"Loading…":"↻ Reload"}</button>
      <button class="btn sm" id="coCsv" ${CO_STATE.rows?"":"disabled"}>⭳ Download (CSV)</button>
    </div>
    <div class="sub">Live stock by company from <b>Live_inventory</b>. <b>Purchase Amount</b> = the inventory's own item cost; <b>Selling Amount</b> = the Variant Level <b>Final After GST</b> for that Item Code × pieces (today's published price); <b>Margin %</b> = (Selling − Purchase) ÷ Selling, value-weighted. Pieces whose Item Code isn't in Variant Level, or whose Variant Level price is ₹0, have no selling price and are left out of the margin (shown as "not priced").</div>`;
  if(!CO_STATE.rows){
    el.innerHTML = head + `<div class="card muted" style="text-align:center;padding:30px">${CO_STATE.error?`Couldn't load: ${esc(CO_STATE.error)}`:"Loading live inventory…"}</div>`;
    wireCompanyButtons();
    if(!CO_STATE.loading && !CO_STATE.error) fetchCompany();
    return;
  }
  const all = CO_STATE.rows, t = coAgg(all);
  const companies = [...new Set(all.map(r=>r.company_code).filter(Boolean))];
  const byCo = companies.map(c=>{ const rs = all.filter(r=>r.company_code===c); return {code:c, name:coName(c, rs[0].company_name), ...coAgg(rs)}; })
    .sort((a,b)=>b.sell-a.sell);
  const tile = (lbl,val,sub="")=>`<div class="card kpi"><div class="lbl">${lbl}</div><div class="val">${val}</div>${sub?`<div class="sub2">${sub}</div>`:""}</div>`;
  const maxM = Math.max(1, ...byCo.map(c=>Math.abs(c.margin||0)));
  // detail rows
  const q = (CO_STATE.q + " " + STATE.search).trim().toLowerCase();
  let rows = all.filter(r=>(!CO_STATE.company || r.company_code===CO_STATE.company) &&
    (!q || `${r.item_code||""} ${r.item_name||""} ${r.location_name||""}`.toLowerCase().includes(q)));
  rows.forEach(r=>{ r.margin_pct = (r.selling_amount>0 && r.purchase_amount!=null) ? (r.selling_amount-r.purchase_amount)/r.selling_amount*100 : null; });
  if(CO_STATE.sort){ const {col,dir} = CO_STATE.sort; rows = rows.slice().sort((a,b)=>{ const x=a[col], y=b[col]; if(x==null) return 1; if(y==null) return -1; return (typeof x==="number" ? x-y : String(x).localeCompare(String(y)))*dir; }); }
  const totalPages = Math.max(1, Math.ceil(rows.length/CO_STATE.pageSize));
  CO_STATE.page = Math.min(Math.max(1, CO_STATE.page), totalPages);
  const start = (CO_STATE.page-1)*CO_STATE.pageSize;
  const dCols = [["company_code","Company"],["location_name","Location"],["item_code","Item Code"],["item_name","Item Name"],["category","Category"],["pieces","Pcs"],["purchase_amount","Purchase Amount"],["selling_amount","Selling Amount"],["margin_pct","Margin %"]];
  const dNum = new Set(["pieces","purchase_amount","selling_amount","margin_pct"]);
  const arrow = k=>CO_STATE.sort && CO_STATE.sort.col===k ? (CO_STATE.sort.dir>0?" ↑":" ↓") : "";
  const cellD = (r,k)=>{
    if(k==="margin_pct") return r.margin_pct==null ? `<span class="muted">—</span>` : mgPct(r.margin_pct);
    if(k==="selling_amount") return !(r[k]>0) ? `<span class="muted">not priced</span>` : dec(r[k],0);
    if(k==="purchase_amount") return r[k]==null ? `<span class="muted">—</span>` : dec(r[k],0);
    if(k==="pieces") return int(r[k]);
    return esc(gone(r[k]));
  };
  el.innerHTML = head + `
    <div class="grid kpis" style="margin-bottom:13px">
      ${tile("Pieces in stock", int(t.pcs), `${int(t.styles)} styles · ${int(companies.length)} companies`)}
      ${tile("Purchase Amount", money(t.pur), "priced pieces")}
      ${tile("Selling Amount", money(t.sell), "Variant Level Final After GST × pcs")}
      ${tile("Margin %", t.margin==null?"—":mgPct(t.margin), "(Selling − Purchase) ÷ Selling")}
      ${tile("Not priced", int(t.unpriced), "pieces with no / ₹0 Variant Level price")}
    </div>
    <div class="card" style="margin-bottom:13px">
      <h3>Margin by Company <span class="rt">click a row to filter the list below</span></h3>
      <div class="tbl-wrap"><table><thead><tr><th>Company</th><th>Name</th><th class="num">Pieces</th><th class="num">Styles</th><th class="num">Purchase Amount</th><th class="num">Selling Amount</th><th class="num">Margin %</th><th></th><th class="num">Not priced</th></tr></thead>
      <tbody>${byCo.map(c=>`<tr data-co="${esc(c.code)}" style="cursor:pointer${CO_STATE.company===c.code?";background:var(--surface-2)":""}">
        <td><b>${esc(c.code)}</b></td><td>${esc(c.name)}</td><td class="num">${int(c.pcs)}</td><td class="num">${int(c.styles)}</td>
        <td class="num">${money(c.pur)}</td><td class="num">${money(c.sell)}</td><td class="num">${c.margin==null?"—":mgPct(c.margin)}</td>
        <td style="min-width:110px"><div class="bar"><span style="width:${(Math.abs(c.margin||0)/maxM*100).toFixed(1)}%;${(c.margin||0)<0?"background:var(--crit)":""}"></span></div></td>
        <td class="num">${c.unpriced?int(c.unpriced):"—"}</td></tr>`).join("")}
        <tr style="font-weight:800;border-top:2px solid var(--border)"><td>Total</td><td></td><td class="num">${int(t.pcs)}</td><td class="num">${int(t.styles)}</td><td class="num">${money(t.pur)}</td><td class="num">${money(t.sell)}</td><td class="num">${t.margin==null?"—":mgPct(t.margin)}</td><td></td><td class="num">${t.unpriced?int(t.unpriced):"—"}</td></tr>
      </tbody></table></div>
    </div>
    <div class="toolbar" style="margin-bottom:8px">
      <select class="search" id="coCompany" style="min-width:200px"><option value="">All companies</option>${byCo.map(c=>`<option value="${esc(c.code)}" ${c.code===CO_STATE.company?"selected":""}>${esc(c.code)} — ${esc(c.name)}</option>`).join("")}</select>
      <input class="search" id="coSearch" placeholder="Item Code / Name / Location…" value="${esc(CO_STATE.q)}" style="min-width:260px">
      <span class="muted" style="font-size:11.5px;margin-left:auto">${CO_STATE.snapshot&&CO_STATE.snapshot.snapshot_date?`prices from ${esc(CO_STATE.snapshot.snapshot_date)} snapshot`:""}</span>
    </div>
    <div class="pager" style="justify-content:space-between;margin-bottom:8px">
      <span>${rows.length?`Showing ${int(start+1)}–${int(Math.min(start+CO_STATE.pageSize, rows.length))} of ${int(rows.length)} stock lines`:"No matches"}</span>
      <span><button id="coPrev" ${CO_STATE.page<=1?"disabled":""}>‹ Prev</button> Page ${int(CO_STATE.page)} of ${int(totalPages)} <button id="coNext" ${CO_STATE.page>=totalPages?"disabled":""}>Next ›</button></span>
    </div>
    <div class="tbl-wrap" style="max-height:60vh"><table><thead><tr>${dCols.map(([k,l])=>`<th data-col="${k}" style="cursor:pointer" class="${dNum.has(k)?"num":""}">${l}${arrow(k)}</th>`).join("")}</tr></thead>
      <tbody>${rows.slice(start, start+CO_STATE.pageSize).map(r=>`<tr>${dCols.map(([k])=>`<td class="${dNum.has(k)?"num":""}">${cellD(r,k)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${dCols.length}" class="muted" style="text-align:center;padding:20px">No stock lines match</td></tr>`}</tbody></table></div>`;
  wireCompanyButtons();
  const rerender = ()=>{ CO_STATE.page = 1; renderCompany(); };
  $$("#page-company tr[data-co]").forEach(tr=>tr.addEventListener("click",()=>{ CO_STATE.company = CO_STATE.company===tr.dataset.co ? "" : tr.dataset.co; rerender(); }));
  $("#coCompany").addEventListener("change",e=>{ CO_STATE.company = e.target.value; rerender(); });
  let tm; $("#coSearch").addEventListener("input",e=>{ clearTimeout(tm); CO_STATE.q = e.target.value; tm = setTimeout(()=>{ rerender(); const x=$("#coSearch"); x.focus(); x.setSelectionRange(x.value.length,x.value.length); }, 250); });
  $("#coPrev").addEventListener("click",()=>{ CO_STATE.page--; renderCompany(); });
  $("#coNext").addEventListener("click",()=>{ CO_STATE.page++; renderCompany(); });
  $$("#page-company th[data-col]").forEach(h=>h.addEventListener("click",()=>{
    const k = h.dataset.col, cur = CO_STATE.sort && CO_STATE.sort.col===k ? CO_STATE.sort.dir : 0;
    CO_STATE.sort = cur===0 ? {col:k, dir:-1} : cur===-1 ? {col:k, dir:1} : null; rerender();
  }));
}
function wireCompanyButtons(){
  const r = $("#coReload"); if(r) r.addEventListener("click",()=>{ CO_STATE.rows = null; fetchCompany(); });
  const c = $("#coCsv"); if(c) c.addEventListener("click",()=>{
    const cols = ["company_code","company_name","location_name","item_code","item_name","item_group","category","product_composition","document_date","pieces","purchase_amount","selling_price","selling_amount"];
    const cell = v=>{ if(v==null) return ""; const s=String(v); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; };
    const csv = [cols.join(",")].concat(CO_STATE.rows.map(r=>cols.map(k=>cell(r[k])).join(","))).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"})); a.download = "company_inventory_margin.csv";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  });
}

/* ── Inventory Margin ────────────────────────────────────────────────────
   The Margin tab's breakdown, but for the stock actually held: one unit = one
   Live_inventory piece-line (Company tab data). Selling = Variant Level Final
   After GST x pieces, Purchase = the inventory's item_cost; dimensions
   (Category, Material, Shape, Carat Band, G2D Band, Price Band) come from that
   Item Code's Variant Level row. Margin % = (Σ Selling − Σ Purchase) ÷ Σ Selling;
   Margin2 % = after that variant's Cash Back. Only pieces with both amounts. */
const IM_STATE = { company:"" };
const IM_DIMS = [{key:"company", title:"Company", of:r=>r.company_label||"—"}, ...MG_DIMS];
function imRows(){
  if(!IG_STATE.rows) return null;
  const q = STATE.search.trim().toLowerCase();
  const out = [];
  for(const r of IG_STATE.rows){
    if(!(r.selling_amount>0) || r.purchase_amount==null) continue;
    if(IM_STATE.company && r.company_code!==IM_STATE.company) continue;
    if(q && !`${r.item_code||""} ${r.item_name||""} ${r.location_name||""}`.toLowerCase().includes(q)) continue;
    const pcs = r.pieces || 1;
    out.push({
      company_label: `${r.company_code||"—"} · ${coName(r.company_code, r.company_name)}`,
      category: r.calc_category, product_composition: r.calc_product_composition, main_shape: r.calc_main_shape,
      diamond_weight: r.diamond_weight, g2d_band: r.calc_g2d_band,
      unit_price: r.calc_final_after_gst_overall,
      final_after_gst_overall: (Number(r.calc_final_after_gst_overall)||0) * pcs,
      actual_sp: r.selling_amount, total_cp_cost: r.purchase_amount,
      net_margin_pct: r.margin_pct,
    });
  }
  return out;
}
function renderInvMargin(){
  const el = $("#page-invmargin");
  const head = `<div class="h2" style="display:flex;align-items:center;gap:12px">Inventory Margin
      <select class="search" id="imCompany" style="min-width:220px;margin-left:auto"><option value="">All companies</option>${
        IG_STATE.rows ? [...new Map(IG_STATE.rows.filter(r=>r.company_code).map(r=>[r.company_code, coName(r.company_code, r.company_name)])).entries()]
          .map(([c,n])=>`<option value="${esc(c)}" ${c===IM_STATE.company?"selected":""}>${esc(c)} — ${esc(n)}</option>`).join("") : ""}</select>
    </div>
    <div class="sub">Margin on the <b>stock you hold</b> (Live_inventory), broken down like the Margin tab. One unit = one stock line. <b>Selling</b> = today's Final After GST for <b>this piece's own weights</b> × pieces; <b>Purchase / CP</b> = the inventory's own item_cost. <b>Margin %</b> = (Σ Selling − Σ Purchase) ÷ Σ Selling; <b>Margin2 %</b> after that variant's Cash Back; <b>Avg Margin %</b> = plain average per stock line. Category / Material / Shape / Carat / G2D / Price band come from the Item Code's Variant Level row (Price Band uses the unit price). Pieces with no Variant Level price are left out.</div>`;
  if(!IG_STATE.rows && !IG_STATE.loading && !IG_STATE.error) fetchInventoryFull(false);
  const rows = imRows();
  if(!rows){
    const err = IG_STATE.error;
    el.innerHTML = head + `<div class="card muted" style="text-align:center;padding:30px">${err?`Couldn't load: ${esc(err)}`:"Loading live inventory and pricing each piece at today's rates… (first load can take a minute or two)"}</div><div id="invGrid"></div>`;
    renderInvGrid();
    return;
  }
  const total = mgAgg(rows);
  const dims = IM_DIMS.map(d=>{
    const dd = d.key==="price" ? {...d, of:r=>mgBand(MG_PRICE_BANDS, Number(r.unit_price)||0)} : d;
    return {dim:dd, groups:mgGroup(rows, dd)};
  });
  const labels = {unit:"Stock lines", sell:"Actual SP", cp:"Purchase Amount (CP)"};
  const tile = (lbl,val,sub="")=>`<div class="card kpi"><div class="lbl">${lbl}</div><div class="val">${val}</div>${sub?`<div class="sub2">${sub}</div>`:""}</div>`;
  const cat = dims[1].groups.filter(g=>g.n>=10 && g.margin!=null).sort((a,b)=>b.margin-a.margin);
  const co = dims[0].groups.filter(g=>g.margin!=null).sort((a,b)=>a.margin-b.margin);
  const low = rows.filter(r=>r.margin_pct<20).length;
  const insights = [];
  if(co.length) insights.push(`Lowest company margin: <b>${esc(co[0].key)}</b> at <b>${dec(co[0].margin,1)}%</b>; highest: <b>${esc(co[co.length-1].key)}</b> at <b>${dec(co[co.length-1].margin,1)}%</b>.`);
  if(cat.length) insights.push(`Best category: <b>${esc(cat[0].key)}</b> (${dec(cat[0].margin,1)}%); weakest: <b>${esc(cat[cat.length-1].key)}</b> (${dec(cat[cat.length-1].margin,1)}%).`);
  insights.push(`<b>${int(low)}</b> stock lines (${pct(rows.length? low/rows.length*100 : 0)}) are below a <b>20%</b> margin.`);
  el.innerHTML = head + `
    <div class="grid kpis" style="margin-bottom:13px">
      ${tile("Stock lines", int(total.n), `${int(new Set(rows.map(r=>r.company_label)).size)} companies`)}
      ${tile("Purchase Amount", money(total.cp))}
      ${tile("Actual SP", money(total.sell), "Final After GST − free coin")}
      ${tile("Final Margin %", total.margin==null?"—":mgPct(total.margin), "(Actual SP − CP) ÷ Actual SP")}
      ${tile("Margin 2% (incl. GST)", total.margin2==null?"—":mgPct(total.margin2), "old basis, for comparison")}
    </div>
    ${insightBox(insights)}
    <div class="grid" style="align-items:start;grid-template-columns:repeat(auto-fit,minmax(min(100%,620px),1fr));margin-top:13px">${dims.map(x=>mgTableHtml(x.dim, x.groups, total, labels)).join("")}</div>
    <div id="invGrid"></div>`;
  renderInvGrid();
  $("#imCompany").addEventListener("change",e=>{ IM_STATE.company = e.target.value; renderInvMargin(); });
}

/* ── Slab Excel table (Slab tab, below Cash Back) ─────────────────────────
   Category / Material Type / G2D / Making Discount / Diamond Discount /
   Making Charges / Price Range / Free, stored in gold_rates.slab_excel via
   pos-price-api /slab-excel. Export -> edit in Excel -> Import replaces the
   table (exact duplicate rows dropped). Values kept exactly as typed.
   Used by pricing since 2026-10-08 (pos-price-api slab_match). Excel read/write via SheetJS,
   loaded from cdnjs only when Import/Export is clicked. */
const SX_COLS = [["category","Category"],["material_type","Material Type"],["g2d","G2D"],["making_discount","Making Discount"],
  ["diamond_discount","Diamond Discount"],["making_charges","Making Charges"],["price_range","Price Range"],["free","Free"]];
const SX_STATE = { rows:null, updated_at:null, error:null, msg:"", msgCls:"" };
let sxFetchStarted = false;
async function fetchSlabExcel(){
  try{
    const res = await fetch(`${PP_API}/slab-excel`, {cache:"no-store"});
    const data = await res.json();
    if(data.error) throw new Error(data.error);
    SX_STATE.rows = data.rows || []; SX_STATE.updated_at = data.updated_at || null; SX_STATE.error = null;
  }catch(e){ SX_STATE.error = e.message || "network error"; SX_STATE.rows = SX_STATE.rows || []; sxFetchStarted = false; }
  if(STATE.tab==="overview") renderSlabExcel();
}
function loadSheetJS(){
  if(window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((ok, fail)=>{
    const sc = document.createElement("script");
    sc.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    sc.onload = ()=>window.XLSX ? ok(window.XLSX) : fail(new Error("Excel library didn't load"));
    sc.onerror = ()=>fail(new Error("Couldn't load the Excel library (cdnjs)"));
    document.head.appendChild(sc);
  });
}
function sxSetMsg(text, cls){ SX_STATE.msg = text; SX_STATE.msgCls = cls||""; const el = $("#sxMsg"); if(el){ el.textContent = text; el.className = "split-savemsg" + (cls?(" "+cls):""); } }
function renderSlabExcel(){
  const body = $("#sxBody");
  if(!body) return;
  const rows = SX_STATE.rows;
  const cnt = $("#sxCount");
  if(cnt) cnt.textContent = rows ? `${int(rows.length)} rows${SX_STATE.updated_at?` · last import ${new Date(SX_STATE.updated_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})} IST`:""}` : "";
  if(rows==null){ body.innerHTML = `<tr><td colspan="${SX_COLS.length}" class="muted">Loading…</td></tr>`; return; }
  body.innerHTML = rows.length ? rows.map(r=>`<tr>${SX_COLS.map(([k])=>`<td class="${["category","material_type","free"].includes(k)?"":"num"}">${r[k]==null?`<span class="muted">—</span>`:esc(r[k])}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${SX_COLS.length}" class="muted">${SX_STATE.error?`Couldn't load: ${esc(SX_STATE.error)}`:"No rows yet — click Export Excel for a blank template, fill it in, then Import Excel."}</td></tr>`;
  if(SX_STATE.msg) sxSetMsg(SX_STATE.msg, SX_STATE.msgCls);
}
function sxNorm(h){ return String(h==null?"":h).toLowerCase().replace(/[^a-z0-9]/g,""); }
async function sxImport(file){
  if(!file) return;
  if(!/\.xlsx$/i.test(file.name)){ sxSetMsg("Please choose an .xlsx Excel file.", "err"); return; }
  sxSetMsg("Reading the Excel file…");
  try{
    const XLSX = await loadSheetJS();
    const wb = XLSX.read(await file.arrayBuffer(), {type:"array"});
    const ws = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:null, blankrows:false});
    if(!grid.length) throw new Error("The first sheet is empty.");
    const header = grid[0].map(sxNorm);
    const idx = {}, missing = [];
    SX_COLS.forEach(([k,l])=>{ const i = header.indexOf(sxNorm(l)); if(i<0) missing.push(l); else idx[k]=i; });
    if(missing.length) throw new Error(`Missing column(s): ${missing.join(", ")}. The first row must have: ${SX_COLS.map(c=>c[1]).join(", ")}.`);
    const rows = grid.slice(1).map(line=>{
      const o = {};
      SX_COLS.forEach(([k])=>{ const v = line[idx[k]]; o[k] = (v==null || String(v).trim()==="") ? null : String(v).trim(); });
      return o;
    });
    if(!confirm(`Replace the Slab Excel table with ${rows.length} row(s) from "${file.name}"?`)){ sxSetMsg("Import cancelled — nothing changed."); return; }
    sxSetMsg("Saving…");
    const res = await fetch(`${PP_API}/slab-excel`, {method:"POST", headers:editHeaders(), body:JSON.stringify({rows})});
    editRefused(res);
    const data = await res.json();
    if(data.error) throw new Error(data.error);
    SX_STATE.rows = data.rows; SX_STATE.updated_at = data.updated_at;
    sxSetMsg(`✓ Imported ${int(data.imported)} row(s)${data.skipped?` — ${int(data.skipped)} blank or duplicate row(s) skipped`:""}. Now click 🚀 Deploy to Dashboard to apply it to prices.`, "ok");
    renderSlabExcel();
  }catch(e){ sxSetMsg(`✕ Import failed: ${e.message}`, "err"); }
}
async function sxExport(){
  try{
    const XLSX = await loadSheetJS();
    const num = v=>{ if(v==null) return null; const s = String(v).trim(); return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s; };
    const aoa = [SX_COLS.map(c=>c[1])].concat((SX_STATE.rows||[]).map(r=>SX_COLS.map(([k])=>["category","material_type","free"].includes(k) ? r[k] : num(r[k]))));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = SX_COLS.map(([,l])=>({wch: Math.max(12, l.length+2)}));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Slab");
    XLSX.writeFile(wb, `slab_table_${new Date().toISOString().slice(0,10)}.xlsx`);
    sxSetMsg(`✓ Exported ${int((SX_STATE.rows||[]).length)} row(s). Edit the file and use Import Excel to load it back.`, "ok");
  }catch(e){ sxSetMsg(`✕ Export failed: ${e.message}`, "err"); }
}
// Deploy: rebuild every published dataset with the saved slab (pos-price-api
// /slab-excel/deploy -> refresh_snapshots + spot-check + config_deployments row).
let SX_DEPLOYING = false;
async function sxDeploy(){
  if(SX_DEPLOYING) return;
  if(!confirm("Apply the saved Slab Excel Table to every price on the dashboard now? This recalculates all tabs and takes about 10 minutes.")) return;
  SX_DEPLOYING = true;
  const btn = $("#sxDeployBtn"); if(btn){ btn.disabled = true; btn.textContent = "Deploying…"; }
  const t0 = Date.now();
  sxSetMsg("Deploying… recalculating every price with the slab (about 10 minutes). You can keep using the dashboard — don't close this tab.");
  const tick = setInterval(()=>{ if(SX_DEPLOYING) sxSetMsg(`Deploying… ${Math.round((Date.now()-t0)/60000)} min so far — recalculating every price with the slab.`); }, 30000);
  try{
    const res = await fetch(`${PP_API}/slab-excel/deploy`, {method:"POST", headers:editHeaders(), body:"{}"});
    editRefused(res);
    const d = await res.json();
    if(d.error) throw new Error(d.error);
    const sm = d.summary || {};
    const txt = `${d.version}: ${int(sm.applied||0)} products got slab pricing (${int(sm.kept_existing||0)} kept some existing values), ${int(sm.no_match||0)} no match, ${int(sm.errors||0)} errors, ${int(sm.with_coin||0)} with a Free Gold Coin.`;
    if(d.status==="SUCCESS") sxSetMsg(`✓ Deployed ${txt}`, "ok");
    else sxSetMsg(`✕ Deploy ${d.version} FAILED: ${d.error_message||"see Daily Check"}`, "err");
    // drop every cached dataset so all tabs reload with the new prices
    if(typeof invalidateVariantSnapshot==="function") invalidateVariantSnapshot();
    SH_STATE.allRows = null; SH_STATE.error = null;
    IG_STATE.rows = null; IG_STATE.allRows = null; IG_STATE.error = null;
    if(typeof fetchGoldStrip==="function") fetchGoldStrip();
  }catch(e){ sxSetMsg(`✕ Deploy failed: ${e.message}`, "err"); }
  finally{
    clearInterval(tick); SX_DEPLOYING = false;
    const b = $("#sxDeployBtn"); if(b){ b.disabled = false; b.textContent = "🚀 Deploy to Dashboard"; }
  }
}
function wireSlabExcel(){
  const dep = $("#sxDeployBtn");
  if(dep){ dep.addEventListener("click", sxDeploy); if(SX_DEPLOYING){ dep.disabled = true; dep.textContent = "Deploying…"; } }
  const f = $("#sxFile"), imp = $("#sxImportBtn"), exp = $("#sxExportBtn");
  if(imp) imp.addEventListener("click",()=>f.click());
  if(f) f.addEventListener("change",()=>{ const file = f.files[0]; f.value = ""; sxImport(file); });
  if(exp) exp.addEventListener("click",sxExport);
  renderSlabExcel();
  if(!sxFetchStarted){ sxFetchStarted = true; fetchSlabExcel(); }
}

/* ── Inventory Margin: full Live_inventory grid ───────────────────────────
   Every Live_inventory column + every Variant Level calculation column for
   that Item Code (calc_*) + Purchase / Selling / Margin, from pos-price-api
   /inventory-full (column-wise gzip blob, refreshed every 10 min).
   Same ▾ sort / filter per column as Variant Level. */
const IG_STATE = { cols:null, rows:null, loading:false, error:null, snapshot:null, page:1, pageSize:50, sort:null, view:"list" };
const IG_FILTERS = {};
const IG_DERIVED = {purchase_amount:"Purchase Amount (CP = item_cost + 3% GST)", selling_amount:"Actual SP × Pcs", margin_amount:"Final Margin Amount", margin_pct:"Final Margin %", margin2_pct:"Margin 2% (incl. GST)"};
const IG_KEY = ["company_code","Store_name","location_name","item_code","item_name","style_code","item_group_name","type_name",
  "pieces","net_weight","diamond_weight","karat_name","metal_color_name","document_date","item_cost",
  "calc_final_after_gst_overall","calc_total_cp_cost","purchase_amount","selling_amount","margin_amount","margin_pct","margin2_pct"];
// The user's column list (2026-10-09), in this exact order -- the default view.
const IG_LIST = ["location_name","company_code","item_code","half_code","item_name","collection_name","Vendor",
  "item_group_name","type_name","sub_category_1","sub_category_2","calc_main_shape","attribute","metal_name","karat_name",
  "purity","weight","pure_weight","net_weight","diamond_pieces","diamond_weight","color_stone_pieces","color_stone_weight",
  "stone_pieces","stone_weight","other_pieces","other_weight","item_rate","item_labour","metal_amount","diamond_amount",
  "color_stone_amount","stone_amount","other_amount","item_cost","gender",
  "calc_g2d","calc_g2d_band","calc_net_weight","calc_weight","calc_metal_amount","calc_diamond_weight","calc_diamond_amount",
  "calc_gemstone_type","calc_gemstone_pieces","calc_gemstone_weight","calc_gemstone_amount","calc_gemstone_cp",
  "calc_making_charge_per_g","calc_making_amount","calc_before_gst_overall","calc_before_gst_value",
  "calc_original_after_gst_overall","calc_margin1_pct","calc_making_discount_pct","calc_making_discount_amount",
  "calc_net_making_amount","calc_diamond_disc_pct","calc_diamond_discount_amount","calc_net_diamond_amount",
  "calc_total_discount","calc_final_after_gst_overall","calc_margin_pct",
  "calc_free_gold_coin","calc_free_coin_qty","calc_free_coin_cp",
  "calc_actual_sp","calc_net_margin","calc_net_margin_pct","calc_material_type","calc_slab_status","calc_after_discount",
  "calc_gst","calc_cash_back_pct","calc_margin2_pct",
  "purchase_amount","selling_amount","margin_amount","margin_pct","margin2_pct"];
// Not shown / exported on any view (user, 2026-10-23) -- still calculated.
const IG_HIDDEN = new Set(["calc_final_amount_post_discount","calc_amount_ex_gst","calc_overall_selling_price","calc_product_composition"]);
const IG_VIEWS = {
  list: {label:"My columns (sheet order)", pick:c=>IG_LIST.includes(c)},
  all: {label:"All columns", pick:c=>true},
  inv: {label:"Live inventory columns", pick:c=>!c.startsWith("calc_")},
  calc: {label:"Calculation columns", pick:c=>c.startsWith("calc_") || IG_DERIVED[c] || ["company_code","item_code","item_name","pieces","item_cost"].includes(c)},
  key: {label:"Key columns", pick:c=>IG_KEY.includes(c)},
};
let IG_NUMERIC = new Set();
function igLabel(c){
  if(IG_DERIVED[c]) return IG_DERIVED[c];
  if(c.startsWith("calc_")){ const k = c.slice(5); return VL_LABEL[k] || k; }
  return c;
}
function igCols(){
  const v = IG_VIEWS[IG_STATE.view] || IG_VIEWS.all;
  const cols = (IG_STATE.cols||[]).filter(c=>v.pick(c) && !IG_HIDDEN.has(c));
  if(IG_STATE.view==="key") return IG_KEY.filter(c=>cols.includes(c));
  if(IG_STATE.view==="list") return IG_LIST.filter(c=>cols.includes(c));
  return cols;
}
async function fetchInventoryFull(force){
  IG_STATE.loading = true; IG_STATE.error = null;
  if(STATE.tab==="invmargin") renderInvGrid();
  try{
    const env = await (await fetch(`${PP_API}/inventory-full${force?"?refresh=1":""}`, {cache:"no-store"})).json();
    if(env.error) throw new Error(env.error);
    const ver = (env.snapshot && env.snapshot.snapshot_created_at) || Date.now();
    const data = await (await fetch(`${env.snapshot_url}?v=${encodeURIComponent(ver)}`)).json();
    const cols = data.columns;
    IG_STATE.cols = cols;
    IG_STATE.rows = data.data.map(a=>{ const o = {}; cols.forEach((c,i)=>{ o[c] = a[i]; }); return o; });
    IG_STATE.allRows = IG_STATE.rows;  // sortedAllRows() reads .allRows
    IG_NUMERIC = new Set(cols.filter(c=>{ let seen=false; for(const r of IG_STATE.rows){ const v=r[c]; if(v==null||v==="") continue; if(typeof v!=="number") return false; seen=true; } return seen; }));
    IG_STATE.snapshot = data.snapshot || env.snapshot; IG_STATE._sortCache = null; _igUniqueCache.clear();
  }catch(e){ IG_STATE.error = e.message || "network error"; }
  IG_STATE.loading = false;
  if(STATE.tab==="invmargin") renderInvMargin();
}
function igFiltered(){
  let rows = sortedAllRows(IG_STATE, IG_NUMERIC);
  const q = STATE.search.trim().toLowerCase();
  if(q) rows = rows.filter(r=>`${r.item_code||""} ${r.item_name||""} ${r.company_code||""} ${r.location_name||""}`.toLowerCase().includes(q));
  const keys = Object.keys(IG_FILTERS).filter(k=>vlFilterActive(IG_FILTERS[k]));
  if(keys.length) rows = rows.filter(r=>keys.every(k=>vlPassesFilter(r,k,IG_FILTERS[k])));
  return rows;
}
const _igUniqueCache = new Map();
function igUniqueValuesFor(k){
  if(_igUniqueCache.has(k)) return _igUniqueCache.get(k);
  const set = new Set();
  (IG_STATE.rows||[]).forEach(r=>{ const v = vlRawStr(r,k); if(v) set.add(v); });
  const vals = [...set].sort((a,b)=>a.localeCompare(b, undefined, {numeric:true})).slice(0, 2000);
  _igUniqueCache.set(k, vals);
  return vals;
}
function igCell(r,c){
  const v = r[c];
  if(v==null || v==="") return `<span class="muted">—</span>`;
  if(c==="margin_pct"||c==="margin2_pct"||c==="calc_margin_pct"||c==="calc_margin2_pct") return mgPct(Number(v));
  if(typeof v==="number") return Number.isInteger(v) ? int(v) : dec(v, Math.abs(v)<10 ? 3 : 2);
  const s = String(v);
  return s.length>60 ? `<span title="${esc(s)}">${esc(s.slice(0,60))}…</span>` : esc(s);
}
function closeIgFilterPopover(){ const pop = $("#igFilterPop"); if(pop){ pop.style.display="none"; pop.innerHTML=""; } document.removeEventListener("click", _igPopOutsideHandler, true); }
function _igPopOutsideHandler(e){ const pop = $("#igFilterPop"); if(pop && !pop.contains(e.target) && !e.target.classList.contains("ig-filter-btn")) closeIgFilterPopover(); }
function openIgFilterPopover(colKey, anchorEl){
  const pop = $("#igFilterPop"); if(!pop) return;
  const same = pop.style.display!=="none" && pop.dataset.col===colKey;
  closeIgFilterPopover(); if(same) return;
  const isNumeric = IG_NUMERIC.has(colKey);
  const existing = IG_FILTERS[colKey] || (isNumeric ? {type:"number",min:null,max:null} : {type:"text",search:"",selected:new Set()});
  let html = `<div class="vl-fp-head">${esc(igLabel(colKey))}</div>` + sortButtonsHtml("ig", IG_STATE, colKey, isNumeric);
  if(isNumeric){
    html += `<div class="vl-fp-row"><label>Min<input type="number" id="igFpMin" step="any" value="${existing.min!=null?existing.min:""}"></label></div>
      <div class="vl-fp-row"><label>Max<input type="number" id="igFpMax" step="any" value="${existing.max!=null?existing.max:""}"></label></div>
      <div class="vl-fp-hint">Leave Min blank for "≤ Max" only, Max blank for "≥ Min" only, or set both equal for an exact match.</div>`;
  }else{
    const values = igUniqueValuesFor(colKey);
    html += `<input type="text" id="igFpSearch" placeholder="Search…" value="${esc(existing.search||"")}">
      <div class="vl-fp-actions"><a href="#" id="igFpSelectAll">Select all shown</a><a href="#" id="igFpClearSel">Clear selection</a></div>
      <div class="chklist vl-fp-list" id="igFpList">${values.map(v=>`<label data-v="${esc(v)}"><input type="checkbox" value="${esc(v)}" ${existing.selected.has(v)?"checked":""}> ${esc(v.length>60?v.slice(0,60)+"…":v)}</label>`).join("")}</div>`;
  }
  html += `<div class="vl-fp-foot"><button class="btn sm" id="igFpClear">Clear Filter</button><span style="flex:1"></span><button class="btn sm" id="igFpCancel">Cancel</button><button class="btn sm primary" id="igFpApply">Apply</button></div>`;
  pop.innerHTML = html; pop.dataset.col = colKey;
  const rc = anchorEl.getBoundingClientRect(); pop.style.display = "block";
  let left = rc.left + window.scrollX;
  if(left + 260 > window.scrollX + document.documentElement.clientWidth - 8) left = window.scrollX + document.documentElement.clientWidth - 268;
  pop.style.left = `${Math.max(8,left)}px`; pop.style.top = `${rc.bottom + window.scrollY + 4}px`;
  if(!isNumeric){
    const search = $("#igFpSearch"), list = $("#igFpList");
    search.addEventListener("input",()=>{ const q = search.value.trim().toLowerCase(); $$("label",list).forEach(lb=>{ lb.style.display = lb.dataset.v.toLowerCase().includes(q) ? "" : "none"; }); });
    search.focus();
    $("#igFpSelectAll").addEventListener("click",e=>{ e.preventDefault(); $$("label",list).forEach(lb=>{ if(lb.style.display!=="none") lb.querySelector("input").checked=true; }); });
    $("#igFpClearSel").addEventListener("click",e=>{ e.preventDefault(); $$("input[type=checkbox]",list).forEach(cb=>cb.checked=false); });
  }
  wireSortButtons("ig", IG_STATE, colKey, closeIgFilterPopover, renderInvGrid);
  $("#igFpCancel").addEventListener("click",closeIgFilterPopover);
  $("#igFpClear").addEventListener("click",()=>{ delete IG_FILTERS[colKey]; closeIgFilterPopover(); IG_STATE.page=1; renderInvGrid(); });
  $("#igFpApply").addEventListener("click",()=>{
    let f;
    if(isNumeric){ const a=$("#igFpMin").value.trim(), b=$("#igFpMax").value.trim(); f={type:"number", min:a===""?null:Number(a), max:b===""?null:Number(b)}; }
    else f = {type:"text", search:$("#igFpSearch").value.trim(), selected:new Set($$("#igFpList input[type=checkbox]:checked").map(cb=>cb.value))};
    if(vlFilterActive(f)) IG_FILTERS[colKey]=f; else delete IG_FILTERS[colKey];
    closeIgFilterPopover(); IG_STATE.page=1; renderInvGrid();
  });
  setTimeout(()=>document.addEventListener("click", _igPopOutsideHandler, true), 0);
}
function renderInvGrid(){
  const el = $("#invGrid");
  if(!el) return;
  const head = `<div class="h2" style="display:flex;align-items:center;gap:12px;margin-top:18px">All Live Inventory + Calculation Columns
      <button class="btn sm" id="igReload" style="margin-left:auto" ${IG_STATE.loading?"disabled":""}>${IG_STATE.loading?"Loading…":"↻ Reload"}</button>
      <button class="btn sm" id="igCsv" ${IG_STATE.rows?"":"disabled"}>⭳ Download (CSV)</button>
    </div>
    <div class="sub">One row per Live_inventory stock line. <b>Mauve</b> columns are the Ornaverse Variant calculation run on <b>this piece's own weights</b> (its net / diamond weight and karat) at <b>today's</b> gold rate, diamond rate, making and slab — that's the <b>SP</b>. <b>CP = the inventory's item_cost</b> (the price it was actually received at), and every margin uses it: Margin 1% = (With GST SP − CP) ÷ With GST SP; Margin 2% with discount = (Final After GST − CP) ÷ Final After GST; <b>Actual SP</b> = Final After GST − free coin value; <b>Final Margin %</b> = (Actual SP − CP) ÷ Actual SP. <b>Gold</b> columns: Purchase Amount (= item_cost), Selling Amount (= Final After GST × pieces), Margin. Click any column's ▾ to sort or filter — same as Variant Level. Use <b>View</b> to narrow the columns.</div>`;
  const wire = ()=>{
    const r = $("#igReload"); if(r) r.addEventListener("click",()=>fetchInventoryFull(true));
    const c = $("#igCsv"); if(c) c.addEventListener("click",()=>{
      const cols = igCols(), rows = igFiltered();
      const cell = v=>{ if(v==null) return ""; const s=String(v); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; };
      const csv = [cols.map(c=>cell(igLabel(c))).join(",")].concat(rows.map(r=>cols.map(c=>cell(r[c])).join(","))).join("\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"})); a.download = "live_inventory_margin.csv";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    });
  };
  if(!IG_STATE.rows){
    el.innerHTML = head + `<div class="card muted" style="text-align:center;padding:30px">${IG_STATE.error?`Couldn't load: ${esc(IG_STATE.error)}`:"Loading every Live_inventory column…"}</div>`;
    wire();
    if(!IG_STATE.loading && !IG_STATE.error) fetchInventoryFull(false);
    return;
  }
  const cols = igCols(), rows = igFiltered(), all = IG_STATE.rows;
  const totalPages = Math.max(1, Math.ceil(rows.length/IG_STATE.pageSize));
  IG_STATE.page = Math.min(Math.max(1, IG_STATE.page), totalPages);
  const start = (IG_STATE.page-1)*IG_STATE.pageSize;
  const keys = Object.keys(IG_FILTERS).filter(k=>vlFilterActive(IG_FILTERS[k]));
  const chips = keys.length ? `<div class="vl-chipbar">${keys.map(k=>{ const f=IG_FILTERS[k]; const txt = f.type==="number" ? [f.min!=null?`≥ ${f.min}`:"", f.max!=null?`≤ ${f.max}`:""].filter(Boolean).join(" and ") : (f.selected&&f.selected.size ? [...f.selected].slice(0,3).join(", ")+(f.selected.size>3?` +${f.selected.size-3}`:"") : `"${f.search}"`); return `<span class="vl-chip">${esc(igLabel(k))}: ${esc(txt)}<button class="vl-chip-x ig-chip-x" data-col="${esc(k)}">✕</button></span>`; }).join("")}<button class="btn sm" id="igClearAll">Clear All Filters</button></div>` : "";
  // Header colour = column group: grey = Live_inventory as-is, mauve = Variant Level
  // calculation (calc_*), gold = Purchase / Selling / Margin worked out here.
  const grp = c=>IG_DERIVED[c] ? "margin" : (c.startsWith("calc_") ? "calc" : "inv");
  const GRP_STYLE = {calc:"background:#7d3f4a;color:#fff", margin:"background:#8a6516;color:#fff", inv:""};  // solid: sticky headers must not be see-through
  const counts = {inv:0, calc:0, margin:0}; cols.forEach(c=>counts[grp(c)]++);
  const allCounts = {inv:0, calc:0, margin:0}; (IG_STATE.cols||[]).forEach(c=>allCounts[grp(c)]++);
  const legend = `<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:12px;margin:2px 0 10px">
      <span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid var(--border);vertical-align:-2px;margin-right:5px"></span><b>${int(counts.inv)}</b> Live inventory columns${counts.inv!==allCounts.inv?` <span class="muted">(of ${int(allCounts.inv)})</span>`:""}</span>
      <span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;${GRP_STYLE.calc};vertical-align:-2px;margin-right:5px"></span><b>${int(counts.calc)}</b> calculation columns (today's rates on this piece's weights; CP = item_cost)${counts.calc!==allCounts.calc?` <span class="muted">(of ${int(allCounts.calc)})</span>`:""}</span>
      <span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;${GRP_STYLE.margin};vertical-align:-2px;margin-right:5px"></span><b>${int(counts.margin)}</b> margin columns (Purchase / Selling / Margin)${counts.margin!==allCounts.margin?` <span class="muted">(of ${int(allCounts.margin)})</span>`:""}</span>
    </div>`;
  const th = cols.map(c=>{ const active = IG_FILTERS[c] && vlFilterActive(IG_FILTERS[c]), sorted = IG_STATE.sort && IG_STATE.sort.col===c;
    return `<th data-col="${esc(c)}" style="${GRP_STYLE[grp(c)]}" class="${IG_NUMERIC.has(c)?"num":""}${sorted?" sorted":""}">${esc(igLabel(c))}${sortArrow(IG_STATE,c)}<button class="vl-filter-btn ig-filter-btn${active||sorted?" on":""}" data-col="${esc(c)}">▾</button></th>`; }).join("");
  const built = IG_STATE.snapshot && IG_STATE.snapshot.snapshot_created_at ? new Date(IG_STATE.snapshot.snapshot_created_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "—";
  el.innerHTML = head + `
    <div class="toolbar" style="margin-bottom:8px">
      <select class="search" id="igView" style="min-width:220px">${Object.entries(IG_VIEWS).map(([k,v])=>`<option value="${k}" ${k===IG_STATE.view?"selected":""}>View: ${esc(v.label)}</option>`).join("")}</select>
      <span class="muted" style="font-size:11.5px">${int(cols.length)} of ${int((IG_STATE.cols||[]).length)} columns · inventory read ${esc(built)} IST</span>
    </div>
    ${legend}
    ${chips}
    <div class="pager" style="justify-content:space-between;margin-bottom:8px">
      <span>${rows.length?`Showing ${int(start+1)}–${int(Math.min(start+IG_STATE.pageSize, rows.length))} of ${int(rows.length)}${rows.length!==all.length?` (filtered from ${int(all.length)})`:""}`:"No matches"}</span>
      <span><button id="igPrev" ${IG_STATE.page<=1?"disabled":""}>‹ Prev</button> Page ${int(IG_STATE.page)} of ${int(totalPages)} <button id="igNext" ${IG_STATE.page>=totalPages?"disabled":""}>Next ›</button></span>
    </div>
    <div class="tbl-wrap" style="max-height:65vh"><table><thead><tr>${th}</tr></thead><tbody>
      ${rows.slice(start, start+IG_STATE.pageSize).map(r=>`<tr>${cols.map(c=>`<td class="${IG_NUMERIC.has(c)?"num":""}">${igCell(r,c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length}" class="muted" style="text-align:center;padding:20px">No stock lines match</td></tr>`}
    </tbody></table></div>
    <div id="igFilterPop" class="vl-filterpop" style="display:none"></div>`;
  wire();
  $("#igView").addEventListener("change",e=>{ IG_STATE.view = e.target.value; renderInvGrid(); });
  $("#igPrev").addEventListener("click",()=>{ IG_STATE.page--; renderInvGrid(); });
  $("#igNext").addEventListener("click",()=>{ IG_STATE.page++; renderInvGrid(); });
  $$("#invGrid .ig-filter-btn").forEach(b=>b.addEventListener("click",e=>{ e.stopPropagation(); openIgFilterPopover(b.dataset.col, b); }));
  $$("#invGrid .ig-chip-x").forEach(x=>x.addEventListener("click",()=>{ delete IG_FILTERS[x.dataset.col]; IG_STATE.page=1; renderInvGrid(); }));
  const ca = $("#igClearAll"); if(ca) ca.addEventListener("click",()=>{ Object.keys(IG_FILTERS).forEach(k=>delete IG_FILTERS[k]); IG_STATE.page=1; renderInvGrid(); });
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
   Every MTO + Online_MTO order line booked in marketing_sale (cancel_order
   never counts), from pos-price-api /mto-margin (column-wise gzip blob,
   rebuilt every 30 min). CP = the Ornaverse Variant calculation on the
   order's own weights with the gold rate of the day it was punched; SP =
   the MTO order rate (net_sale, GST incl.). Margin 1 / Margin 2 / Final
   Margin as on the Variant tab. Top filters + per-column ▾ sort / filter
   (same as Inventory). Lines with incomplete CP stay blank, never guessed.
   Extra Discount (2026-10-30): typed in per line by an editor, saved live to
   /mto-extra-discount and taken off the sale price before Final Margin only:
   Actual SP = Order Rate − free coin − Extra Discount. */
const MTO_STATE = { cols:null, rows:null, loading:false, error:null, snapshot:null, page:1, pageSize:50, sort:null, view:"key",
  from:"", to:"", type:"", store:"", category:"", karat:"", band:"", group:"order_month" };
const MTO_FILTERS = {};
const MTO_LABELS = {
  order_date:"Order Date", order_month:"Month", order_type:"Type", document_no:"Order No.", item_line_no:"Line No.", company_code:"Store",
  channel:"Channel", item_code:"SKU", product_name:"Product", item_group_name:"Material", category:"Category",
  karat_name:"Karat", metal_color_name:"Metal Colour", pieces:"Pcs", net_weight:"Net Wt (g)", diamond_weight:"Diamond Wt (ct)",
  gold_rate_date:"Gold Rate Date", gold_rate_24k:"Gold 24K /g (that day)", karat_rate:"Karat Rate /g (that day)",
  metal_value:"Metal (wt × day rate)", diamond_cp:"Diamond CP", gemstone_cp:"Other BOM CP", labour_cp:"Labour CP",
  total_cp:"Total CP (incl. GST)", gross_amount:"Gross (before discount)", discount:"Discount",
  net_sale:"MTO Order Rate (incl. GST)", order_ex_gst:"Order Rate ex GST", dashboard_price:"Dashboard Price (that day)",
  price_vs_dashboard_pct:"Order vs Dashboard %", margin1_pct:"Margin 1% (without discount)", margin2_amount:"Margin 2 (₹)",
  margin2_pct:"Margin 2% with discount", free_coin_qty:"Free Coin Qty", free_coin_value:"Free Coin Value",
  extra_discount:"Extra Discount (₹)",
  actual_sp:"Actual SP", final_margin:"Final Margin (SP − CP)", final_margin_pct:"Final Margin %", cp_basis:"CP Basis",
};
const MTO_KEY = ["order_date","order_type","document_no","company_code","item_code","product_name","category","karat_name",
  "net_weight","diamond_weight","gold_rate_24k","karat_rate","total_cp","gross_amount","discount","net_sale",
  "margin1_pct","margin2_pct","free_coin_value","extra_discount","actual_sp","final_margin","final_margin_pct","cp_basis"];
const MTO_VIEWS = {key:{label:"Key columns"}, all:{label:"All columns"}};
const MTO_RATE_COLS = new Set(["gold_rate_date","gold_rate_24k","karat_rate","metal_value","diamond_cp","gemstone_cp","labour_cp","total_cp","dashboard_price"]);
const MTO_MARGIN_COLS = new Set(["margin1_pct","margin2_amount","margin2_pct","free_coin_qty","free_coin_value","extra_discount","actual_sp","final_margin","final_margin_pct"]);
// Always numeric, even while every Extra Discount is still blank.
const MTO_ALWAYS_NUMERIC = ["extra_discount","actual_sp","final_margin","final_margin_pct"];
let MTO_EXTRA = {}; // {"document_no|item_line_no": {amount, by, at}}
const mtoKey = r=>`${r.document_no}|${r.item_line_no}`;
const round2 = v=>Math.round(v*100)/100;
// Final Margin after the line's Extra Discount (Margin 1 / 2 never change).
function mtoApplyExtra(r){
  const x = MTO_EXTRA[mtoKey(r)];
  r.extra_discount = x ? x.amount : null;
  if(r.total_cp==null) return;
  const sp = (r.net_sale||0) - (r.free_coin_value||0) - (r.extra_discount||0);
  r.actual_sp = round2(sp);
  r.final_margin = round2(sp - r.total_cp);
  r.final_margin_pct = sp ? round2((sp - r.total_cp)/sp*100) : null;
}
async function mtoSaveExtra(r, input){
  const raw = input.value.trim(), amount = raw==="" ? null : Number(raw);
  if(amount!=null && !(amount>=0)){ alert("Extra Discount must be a number of 0 or more."); input.value = r.extra_discount ?? ""; return; }
  input.disabled = true;
  try{
    const res = await fetch(`${PP_API}/mto-extra-discount`, {method:"POST", headers:editHeaders(),
      body:JSON.stringify({document_no:r.document_no, item_line_no:r.item_line_no, item_code:r.item_code, extra_discount:amount})});
    const d = await res.json();
    if(editRefused(res) || d.error) throw new Error(d.error || "not saved");
    if(d.amount) MTO_EXTRA[d.key] = {amount:d.amount, by:d.by, at:new Date().toISOString()}; else delete MTO_EXTRA[d.key];
    mtoApplyExtra(r);
    MTO_STATE._sortCache = null; _mtoUniqueCache.clear();
  }catch(e){ alert(`Extra Discount not saved: ${e.message}`); }
  renderMTO();
}
const MTO_PCT_COLS = new Set(["margin1_pct","margin2_pct","final_margin_pct"]);
// Final Margin % bands for the top filter; "na" = CP incomplete / not priced.
const MTO_BANDS = [["loss","Loss (below 0%)",p=>p<0],["0-10","0 – 10%",p=>p>=0&&p<10],["10-20","10 – 20%",p=>p>=10&&p<20],
  ["20-30","20 – 30%",p=>p>=20&&p<30],["30+","30% and above",p=>p>=30],["na","CP missing (—)",null]];
const MTO_GROUPS = {order_month:"Month", order_date:"Day", order_type:"Type", company_code:"Store", category:"Category",
  karat_name:"Karat", item_group_name:"Material"};
let MTO_NUMERIC = new Set();
function mtoLabel(c){ return MTO_LABELS[c] || c; }
function mtoCols(){
  const cols = MTO_STATE.cols || [];
  return MTO_STATE.view==="key" ? MTO_KEY.filter(c=>cols.includes(c)) : cols;
}
function mtoFmtDateLong(iso){
  if(!iso) return "";
  const [y,m,d] = iso.split("-");
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${parseInt(d,10)} ${months[parseInt(m,10)-1]} ${y}`;
}
async function fetchMTO(force){
  MTO_STATE.loading = true; MTO_STATE.error = null;
  if(STATE.tab==="mto") renderMTO();
  try{
    const env = await (await fetch(`${PP_API}/mto-margin${force?"?refresh=1":""}`, {cache:"no-store"})).json();
    if(env.error) throw new Error(env.error);
    const ver = (env.snapshot && env.snapshot.snapshot_created_at) || Date.now();
    const data = await (await fetch(`${env.snapshot_url}?v=${encodeURIComponent(ver)}`)).json();
    const cols = data.columns;
    MTO_STATE.cols = cols;
    MTO_STATE.rows = data.data.map(a=>{ const o = {}; cols.forEach((c,i)=>{ o[c] = a[i]; }); return o; });
    MTO_STATE.allRows = MTO_STATE.rows;  // sortedAllRows() reads .allRows
    MTO_NUMERIC = new Set(cols.filter(c=>{ let seen=false; for(const r of MTO_STATE.rows){ const v=r[c]; if(v==null||v==="") continue; if(typeof v!=="number") return false; seen=true; } return seen; }).concat(MTO_ALWAYS_NUMERIC));
    try{
      const x = await (await fetch(`${PP_API}/mto-extra-discounts`, {cache:"no-store"})).json();
      MTO_EXTRA = x.rows || {};
    }catch(_){ MTO_EXTRA = {}; }
    MTO_STATE.rows.forEach(mtoApplyExtra);
    MTO_STATE.snapshot = data.snapshot || env.snapshot; MTO_STATE._sortCache = null; _mtoUniqueCache.clear();
  }catch(e){ MTO_STATE.error = e.message || "network error"; }
  MTO_STATE.loading = false;
  if(STATE.tab==="mto") renderMTO();
}
function mtoFiltered(){
  const s = MTO_STATE;
  let rows = sortedAllRows(s, MTO_NUMERIC);
  if(s.from) rows = rows.filter(r=>r.order_date && r.order_date>=s.from);
  if(s.to) rows = rows.filter(r=>r.order_date && r.order_date<=s.to);
  if(s.type) rows = rows.filter(r=>r.order_type===s.type);
  if(s.store) rows = rows.filter(r=>r.company_code===s.store);
  if(s.category) rows = rows.filter(r=>r.category===s.category);
  if(s.karat) rows = rows.filter(r=>r.karat_name===s.karat);
  if(s.band){
    const b = MTO_BANDS.find(x=>x[0]===s.band);
    if(b) rows = rows.filter(r=>b[2] ? (r.final_margin_pct!=null && b[2](r.final_margin_pct)) : r.final_margin_pct==null);
  }
  const q = STATE.search.trim().toLowerCase();
  if(q) rows = rows.filter(r=>`${r.document_no||""} ${r.item_code||""} ${r.product_name||""}`.toLowerCase().includes(q));
  const keys = Object.keys(MTO_FILTERS).filter(k=>vlFilterActive(MTO_FILTERS[k]));
  if(keys.length) rows = rows.filter(r=>keys.every(k=>vlPassesFilter(r,k,MTO_FILTERS[k])));
  return rows;
}
// Value-weighted margins over the lines that have a complete CP.
function mtoAgg(rows){
  let gross=0, net=0, cp=0, sp=0, coin=0, extra=0, sale=0, rate=0, nRate=0, loss=0, noCp=0;
  const docs = new Set();
  for(const r of rows){
    docs.add(r.document_no); sale += r.net_sale||0;
    if(r.gold_rate_24k!=null){ rate += r.gold_rate_24k; nRate++; }
    if(r.total_cp==null){ noCp++; continue; }
    gross += r.gross_amount||0; net += r.net_sale||0; cp += r.total_cp; sp += r.actual_sp||0; coin += r.free_coin_value||0; extra += r.extra_discount||0;
    if(r.final_margin_pct!=null && r.final_margin_pct<0) loss++;
  }
  return { orders:docs.size, lines:rows.length, sale, gross, net, cp, sp, coin, extra, loss, noCp,
    m1: gross ? (gross-cp)/gross*100 : null, m2: net ? (net-cp)/net*100 : null, fin: sp ? (sp-cp)/sp*100 : null,
    finAmt: sp-cp, rate: nRate ? rate/nRate : null };
}
const _mtoUniqueCache = new Map();
function mtoUniqueValuesFor(k){
  if(_mtoUniqueCache.has(k)) return _mtoUniqueCache.get(k);
  const set = new Set();
  (MTO_STATE.rows||[]).forEach(r=>{ const v = vlRawStr(r,k); if(v) set.add(v); });
  const vals = [...set].sort((a,b)=>a.localeCompare(b, undefined, {numeric:true})).slice(0, 2000);
  _mtoUniqueCache.set(k, vals);
  return vals;
}
function mtoCell(r,c){
  const v = r[c];
  if(c==="extra_discount" && canEdit()){
    const x = MTO_EXTRA[mtoKey(r)];
    return `<input type="number" min="0" step="1" class="search mto-xd" data-key="${esc(mtoKey(r))}" value="${v==null?"":v}" placeholder="0"${x?` title="Saved by ${esc(x.by||"")}"`:""}>`;
  }
  if(v==null || v==="") return `<span class="muted">—</span>`;
  if(MTO_PCT_COLS.has(c)) return mgPct(Number(v));
  if(c==="price_vs_dashboard_pct") return `<span${v<-25?` style="color:var(--crit)"`:""}>${dec(v,1)}%</span>`;
  if(c==="net_weight"||c==="diamond_weight") return dec(v,3);
  if(c==="final_margin"||c==="margin2_amount") return `<span${v<0?` style="color:var(--crit)"`:""}>${dec(v,2)}</span>`;
  if(typeof v==="number") return Number.isInteger(v) ? int(v) : dec(v,2);
  const s = String(v);
  return s.length>60 ? `<span title="${esc(s)}">${esc(s.slice(0,60))}…</span>` : esc(s);
}
function closeMtoFilterPopover(){ const pop = $("#mtoFilterPop"); if(pop){ pop.style.display="none"; pop.innerHTML=""; } document.removeEventListener("click", _mtoPopOutsideHandler, true); }
function _mtoPopOutsideHandler(e){ const pop = $("#mtoFilterPop"); if(pop && !pop.contains(e.target) && !e.target.classList.contains("mto-filter-btn")) closeMtoFilterPopover(); }
function openMtoFilterPopover(colKey, anchorEl){
  const pop = $("#mtoFilterPop"); if(!pop) return;
  const same = pop.style.display!=="none" && pop.dataset.col===colKey;
  closeMtoFilterPopover(); if(same) return;
  const isNumeric = MTO_NUMERIC.has(colKey);
  const existing = MTO_FILTERS[colKey] || (isNumeric ? {type:"number",min:null,max:null} : {type:"text",search:"",selected:new Set()});
  let html = `<div class="vl-fp-head">${esc(mtoLabel(colKey))}</div>` + sortButtonsHtml("mto", MTO_STATE, colKey, isNumeric);
  if(isNumeric){
    html += `<div class="vl-fp-row"><label>Min<input type="number" id="mtoFpMin" step="any" value="${existing.min!=null?existing.min:""}"></label></div>
      <div class="vl-fp-row"><label>Max<input type="number" id="mtoFpMax" step="any" value="${existing.max!=null?existing.max:""}"></label></div>
      <div class="vl-fp-hint">Leave Min blank for "≤ Max" only, Max blank for "≥ Min" only, or set both equal for an exact match.</div>`;
  }else{
    const values = mtoUniqueValuesFor(colKey);
    html += `<input type="text" id="mtoFpSearch" placeholder="Search…" value="${esc(existing.search||"")}">
      <div class="vl-fp-actions"><a href="#" id="mtoFpSelectAll">Select all shown</a><a href="#" id="mtoFpClearSel">Clear selection</a></div>
      <div class="chklist vl-fp-list" id="mtoFpList">${values.map(v=>`<label data-v="${esc(v)}"><input type="checkbox" value="${esc(v)}" ${existing.selected.has(v)?"checked":""}> ${esc(v.length>60?v.slice(0,60)+"…":v)}</label>`).join("")}</div>`;
  }
  html += `<div class="vl-fp-foot"><button class="btn sm" id="mtoFpClear">Clear Filter</button><span style="flex:1"></span><button class="btn sm" id="mtoFpCancel">Cancel</button><button class="btn sm primary" id="mtoFpApply">Apply</button></div>`;
  pop.innerHTML = html; pop.dataset.col = colKey;
  const rc = anchorEl.getBoundingClientRect(); pop.style.display = "block";
  let left = rc.left + window.scrollX;
  if(left + 260 > window.scrollX + document.documentElement.clientWidth - 8) left = window.scrollX + document.documentElement.clientWidth - 268;
  pop.style.left = `${Math.max(8,left)}px`; pop.style.top = `${rc.bottom + window.scrollY + 4}px`;
  if(!isNumeric){
    const search = $("#mtoFpSearch"), list = $("#mtoFpList");
    search.addEventListener("input",()=>{ const q = search.value.trim().toLowerCase(); $$("label",list).forEach(lb=>{ lb.style.display = lb.dataset.v.toLowerCase().includes(q) ? "" : "none"; }); });
    search.focus();
    $("#mtoFpSelectAll").addEventListener("click",e=>{ e.preventDefault(); $$("label",list).forEach(lb=>{ if(lb.style.display!=="none") lb.querySelector("input").checked=true; }); });
    $("#mtoFpClearSel").addEventListener("click",e=>{ e.preventDefault(); $$("input[type=checkbox]",list).forEach(cb=>cb.checked=false); });
  }
  wireSortButtons("mto", MTO_STATE, colKey, closeMtoFilterPopover, renderMTO);
  $("#mtoFpCancel").addEventListener("click",closeMtoFilterPopover);
  $("#mtoFpClear").addEventListener("click",()=>{ delete MTO_FILTERS[colKey]; closeMtoFilterPopover(); MTO_STATE.page=1; renderMTO(); });
  $("#mtoFpApply").addEventListener("click",()=>{
    let f;
    if(isNumeric){ const a=$("#mtoFpMin").value.trim(), b=$("#mtoFpMax").value.trim(); f={type:"number", min:a===""?null:Number(a), max:b===""?null:Number(b)}; }
    else f = {type:"text", search:$("#mtoFpSearch").value.trim(), selected:new Set($$("#mtoFpList input[type=checkbox]:checked").map(cb=>cb.value))};
    if(vlFilterActive(f)) MTO_FILTERS[colKey]=f; else delete MTO_FILTERS[colKey];
    closeMtoFilterPopover(); MTO_STATE.page=1; renderMTO();
  });
  setTimeout(()=>document.addEventListener("click", _mtoPopOutsideHandler, true), 0);
}
function mtoIso(d){ return d.toLocaleDateString("en-CA"); }  // YYYY-MM-DD in the browser's (IST) date
function mtoQuickRange(k){
  const t = new Date(), y = t.getFullYear(), m = t.getMonth();
  if(k==="today") return [mtoIso(t), mtoIso(t)];
  if(k==="yesterday"){ const d = new Date(t); d.setDate(d.getDate()-1); return [mtoIso(d), mtoIso(d)]; }
  if(k==="month") return [mtoIso(new Date(y, m, 1)), mtoIso(t)];
  if(k==="lastmonth") return [mtoIso(new Date(y, m-1, 1)), mtoIso(new Date(y, m, 0))];
  if(k==="30d"){ const d = new Date(t); d.setDate(d.getDate()-29); return [mtoIso(d), mtoIso(t)]; }
  return ["", ""];
}
function mtoSelectHtml(id, label, cur, values){
  return `<label style="font-size:12px;font-weight:700;color:var(--ink-2)">${label}
    <select class="search" id="${id}" style="min-width:110px;margin-left:6px"><option value="">All</option>${values.map(v=>`<option value="${esc(v)}" ${v===cur?"selected":""}>${esc(v)}</option>`).join("")}</select></label>`;
}
function mtoGroupTableHtml(rows){
  const k = MTO_STATE.group;
  const m = new Map();
  for(const r of rows){ const g = r[k]==null||r[k]==="" ? "—" : r[k]; if(!m.has(g)) m.set(g, []); m.get(g).push(r); }
  const groups = [...m.entries()].map(([g, rs])=>({key:g, ...mtoAgg(rs)}));
  if(k==="order_month" || k==="order_date") groups.sort((a,b)=>String(b.key).localeCompare(String(a.key)));
  else groups.sort((a,b)=>b.sale-a.sale);
  const pctCell = p=>`<td class="num">${mgPct(p)}</td>`;
  return `<div class="card" style="margin-bottom:14px">
    <h3>Margin by <select class="search no-print" id="mtoGroup" style="min-width:110px;margin-left:6px">${Object.entries(MTO_GROUPS).map(([g,l])=>`<option value="${g}" ${g===k?"selected":""}>${l}</option>`).join("")}</select>
      <span class="rt">${int(groups.length)} groups · margins over lines with a complete CP</span></h3>
    <div class="tbl-wrap" style="max-height:420px"><table><thead><tr>
      <th>${esc(MTO_GROUPS[k])}</th><th class="num">Orders</th><th class="num">Lines</th>
      <th class="num">${k==="order_date"?"Gold 24K /g":"Avg Gold 24K /g"}</th><th class="num">MTO Order Value</th><th class="num">Total CP</th>
      <th class="num">Margin 1%</th><th class="num">Margin 2%</th><th class="num">Free Coin</th><th class="num">Extra Discount</th><th class="num">Final Margin ₹</th><th class="num">Final Margin %</th><th class="num">Loss Lines</th><th class="num">CP Missing</th>
    </tr></thead><tbody>${groups.map(g=>`<tr>
      <td><b>${esc(g.key)}</b></td><td class="num">${int(g.orders)}</td><td class="num">${int(g.lines)}</td>
      <td class="num">${g.rate==null?"—":rupee(Math.round(g.rate))}</td><td class="num">${money(g.sale)}</td><td class="num">${money(g.cp)}</td>
      ${pctCell(g.m1)}${pctCell(g.m2)}<td class="num">${g.coin?money(g.coin):"—"}</td><td class="num">${g.extra?money(g.extra):"—"}</td>
      <td class="num"${g.finAmt<0?` style="color:var(--crit)"`:""}>${money(g.finAmt)}</td>${pctCell(g.fin)}
      <td class="num"${g.loss?` style="color:var(--crit)"`:""}>${int(g.loss)}</td><td class="num">${g.noCp?int(g.noCp):"—"}</td>
    </tr>`).join("") || `<tr><td colspan="14" class="muted" style="text-align:center;padding:20px">No MTO orders match</td></tr>`}</tbody></table></div></div>`;
}
function mtoCsv(){
  const cols = mtoCols(), rows = mtoFiltered();
  const cell = v=>{ if(v==null) return ""; const s=String(v); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; };
  const csv = [cols.map(c=>cell(mtoLabel(c))).join(",")].concat(rows.map(r=>cols.map(c=>cell(r[c])).join(","))).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download = `mto_margin${MTO_STATE.from?"_"+MTO_STATE.from:""}${MTO_STATE.to&&MTO_STATE.to!==MTO_STATE.from?"_to_"+MTO_STATE.to:""}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function renderMTO(){
  const el = $("#page-mto");
  const s = MTO_STATE;
  const grid0 = $("#mtoGrid"), scroll = grid0 ? [grid0.scrollTop, grid0.scrollLeft] : null;
  const head = `<div class="h2 no-print" style="display:flex;align-items:center;gap:12px">MTO Daily Margin
      <button class="btn sm" id="mtoReload" style="margin-left:auto" ${s.loading?"disabled":""}>${s.loading?"Loading…":"↻ Reload"}</button>
      <button class="btn sm" id="mtoCsv" ${s.rows?"":"disabled"}>⭳ Download (CSV)</button>
      <button class="btn sm primary" id="mtoPrintBtn" type="button" ${s.rows?"":"disabled"}>🖨 Print</button>
    </div>
    <div class="sub no-print">Every <b>MTO</b> (store) and <b>Online_MTO</b> order line booked in <b>marketing_sale</b> — <b>cancel_order lines are excluded</b>. Each line is costed on the <b>day it was punched</b>: <b>Total CP</b> = the Ornaverse Variant calculation on the order's own net / diamond weight and karat with <b>that day's gold rate</b> (metal), plus diamond, other BOM (colour stone / CZ / accessories) and labour CP (current rate cards), incl. 3% GST. <b>Selling rate = the MTO order rate</b> (net_sale, GST incl.). <b>Margin 1%</b> = (Gross before discount − CP) ÷ Gross; <b>Margin 2% with discount</b> = (Order Rate − CP) ÷ Order Rate; <b>Final Margin %</b> = (Actual SP − CP) ÷ Actual SP, Actual SP = Order Rate − free coin (Slab rule, ₹1,600 a coin; none when the order already bills a gold coin) − <b>Extra Discount</b> (any extra discount given to the customer, typed in per line by an editor — saved at once). Lines whose CP is incomplete (no metal value / no diamond CP) show — and are left out of the margins. The top search box searches Order No. / SKU / Product.</div>`;
  const wire = ()=>{
    const r = $("#mtoReload"); if(r) r.addEventListener("click",()=>fetchMTO(true));
    const c = $("#mtoCsv"); if(c) c.addEventListener("click",mtoCsv);
    const p = $("#mtoPrintBtn"); if(p) p.addEventListener("click",()=>window.print());
  };
  if(!s.rows){
    el.innerHTML = head + `<div class="card muted" style="text-align:center;padding:30px">${s.error?`Couldn't load: ${esc(s.error)}`:"Costing every MTO order on its punch-day gold rate… (the first build after a refresh takes ~3–4 min)"}</div>`;
    wire();
    if(!s.loading && !s.error) fetchMTO(false);
    return;
  }
  const all = s.rows, rows = mtoFiltered(), a = mtoAgg(rows), cols = mtoCols();
  const uniq = k=>[...new Set(all.map(r=>r[k]).filter(v=>v!=null&&v!==""))].sort((x,y)=>String(x).localeCompare(String(y), undefined, {numeric:true}));
  const totalPages = Math.max(1, Math.ceil(rows.length/s.pageSize));
  s.page = Math.min(Math.max(1, s.page), totalPages);
  const start = (s.page-1)*s.pageSize;
  const keys = Object.keys(MTO_FILTERS).filter(k=>vlFilterActive(MTO_FILTERS[k]));
  const chips = keys.length ? `<div class="vl-chipbar no-print">${keys.map(k=>{ const f=MTO_FILTERS[k]; const txt = f.type==="number" ? [f.min!=null?`≥ ${f.min}`:"", f.max!=null?`≤ ${f.max}`:""].filter(Boolean).join(" and ") : (f.selected&&f.selected.size ? [...f.selected].slice(0,3).join(", ")+(f.selected.size>3?` +${f.selected.size-3}`:"") : `"${f.search}"`); return `<span class="vl-chip">${esc(mtoLabel(k))}: ${esc(txt)}<button class="vl-chip-x mto-chip-x" data-col="${esc(k)}">✕</button></span>`; }).join("")}<button class="btn sm" id="mtoClearAll">Clear All Filters</button></div>` : "";
  // Header colour = column group: plain = order as booked, mauve = punch-day rate + CP, gold = margins.
  const grpStyle = c=>MTO_RATE_COLS.has(c) ? "background:#7d3f4a;color:#fff" : (MTO_MARGIN_COLS.has(c) ? "background:#8a6516;color:#fff" : "");
  const th = cols.map(c=>{ const active = MTO_FILTERS[c] && vlFilterActive(MTO_FILTERS[c]), sorted = s.sort && s.sort.col===c;
    return `<th data-col="${esc(c)}" style="${grpStyle(c)}" class="${MTO_NUMERIC.has(c)?"num":""}${sorted?" sorted":""}">${esc(mtoLabel(c))}${sortArrow(s,c)}<button class="vl-filter-btn mto-filter-btn no-print${active||sorted?" on":""}" data-col="${esc(c)}">▾</button></th>`; }).join("");
  const built = s.snapshot && s.snapshot.snapshot_created_at ? new Date(s.snapshot.snapshot_created_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "—";
  const range = s.from||s.to ? (s.from===s.to ? mtoFmtDateLong(s.from) : `${s.from?mtoFmtDateLong(s.from):"start"} – ${s.to?mtoFmtDateLong(s.to):"today"}`) : "All orders to date";
  const oneDay = s.from && s.from===s.to ? rows.find(r=>r.gold_rate_24k!=null) : null;
  const kpi = (lbl, val, sub, cls)=>`<div class="card kpi"><div class="lbl">${lbl}</div><div class="val${cls?" "+cls:""}">${val}</div>${sub?`<div class="muted" style="font-size:11.5px;margin-top:4px">${sub}</div>`:""}</div>`;
  const tone = p=>p==null ? "" : mgTone(p);
  el.innerHTML = head + `
    <div id="mtoPrintHead">
      <h2>MTO Margin Report — ${esc(range)}</h2>
      <div class="sub">Lucira Jewelry — Made-To-Order (store + online) order rate vs cost on the punch-day gold rate</div>
    </div>
    <div class="card no-print" style="margin:12px 0 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <label style="font-size:12px;font-weight:700;color:var(--ink-2)">From <input type="date" class="search" id="mtoFrom" style="min-width:0;margin-left:6px" value="${esc(s.from)}"></label>
      <label style="font-size:12px;font-weight:700;color:var(--ink-2)">To <input type="date" class="search" id="mtoTo" style="min-width:0;margin-left:6px" value="${esc(s.to)}"></label>
      <span style="display:flex;gap:6px;flex-wrap:wrap">${[["today","Today"],["yesterday","Yesterday"],["30d","Last 30 days"],["month","This month"],["lastmonth","Last month"],["all","All"]].map(([k,l])=>`<button class="btn sm mto-quick" data-k="${k}" type="button">${l}</button>`).join("")}</span>
      ${mtoSelectHtml("mtoType","Type",s.type,uniq("order_type"))}
      ${mtoSelectHtml("mtoStore","Store",s.store,uniq("company_code"))}
      ${mtoSelectHtml("mtoCategory","Category",s.category,uniq("category"))}
      ${mtoSelectHtml("mtoKarat","Karat",s.karat,uniq("karat_name"))}
      <label style="font-size:12px;font-weight:700;color:var(--ink-2)">Final Margin
        <select class="search" id="mtoBand" style="min-width:110px;margin-left:6px"><option value="">All</option>${MTO_BANDS.map(([k,l])=>`<option value="${k}" ${k===s.band?"selected":""}>${esc(l)}</option>`).join("")}</select></label>
      <button class="btn sm" id="mtoResetTop" type="button">Reset</button>
      <span class="muted" style="font-size:11.5px;margin-left:auto">${int(all.length)} lines · built ${esc(built)} IST</span>
    </div>
    ${oneDay?`<div class="card" style="margin-bottom:14px"><h3>Gold rate on ${esc(mtoFmtDateLong(s.from))} <span class="rt">Pos.metal_rates, rate dated ${esc(oneDay.gold_rate_date)}</span></h3>
      <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:13px">${[["24K",1],["22K",.92],["18K",.76],["14K",.59],["9K",.40]].map(([k,m])=>`<span><b>${k}</b> ${rupee(Math.round(oneDay.gold_rate_24k*m*100)/100)}/g</span>`).join("")}</div></div>`:""}
    <div class="grid kpis" style="margin-bottom:14px">
      ${kpi("MTO Orders", int(a.orders), `${int(a.lines)} lines · ${esc(range)}`)}
      ${kpi("MTO Order Value", money(a.sale), "net_sale, GST incl. (booked)")}
      ${kpi("Total CP", money(a.cp), a.noCp?`${int(a.noCp)} line(s) with CP missing left out`:"punch-day gold rate, incl. GST")}
      ${kpi("Margin 1% (without discount)", a.m1==null?"—":pct(a.m1), `on Gross ${money(a.gross)}`, tone(a.m1))}
      ${kpi("Margin 2% with discount", a.m2==null?"—":pct(a.m2), `on Order Rate ${money(a.net)}`, tone(a.m2))}
      ${kpi("Final Margin %", a.fin==null?"—":pct(a.fin), `${money(a.finAmt)} after ${money(a.coin)} free coin${a.extra?` + ${money(a.extra)} extra discount`:""}`, tone(a.fin))}
      ${kpi("Loss Lines", int(a.loss), "Final Margin below 0%", a.loss?"crit":"")}
    </div>
    ${mtoGroupTableHtml(rows)}
    <div class="toolbar no-print" style="margin-bottom:8px">
      <select class="search" id="mtoView" style="min-width:200px">${Object.entries(MTO_VIEWS).map(([k,v])=>`<option value="${k}" ${k===s.view?"selected":""}>View: ${esc(v.label)}</option>`).join("")}</select>
      <span style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:12px">
        <span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid var(--border);vertical-align:-2px;margin-right:5px"></span>order as booked</span>
        <span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:#7d3f4a;vertical-align:-2px;margin-right:5px"></span>punch-day gold rate + CP</span>
        <span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:#8a6516;vertical-align:-2px;margin-right:5px"></span>margins</span>
      </span>
    </div>
    ${chips}
    <div class="pager no-print" style="justify-content:space-between;margin-bottom:8px">
      <span>${rows.length?`Showing ${int(start+1)}–${int(Math.min(start+s.pageSize, rows.length))} of ${int(rows.length)} lines${rows.length!==all.length?` (filtered from ${int(all.length)})`:""}`:"No matches"}</span>
      <span><button id="mtoPrev" ${s.page<=1?"disabled":""}>‹ Prev</button> Page ${int(s.page)} of ${int(totalPages)} <button id="mtoNext" ${s.page>=totalPages?"disabled":""}>Next ›</button></span>
    </div>
    <div class="tbl-wrap" id="mtoGrid" style="max-height:65vh"><table><thead><tr>${th}</tr></thead><tbody>
      ${rows.slice(start, start+s.pageSize).map(r=>`<tr>${cols.map(c=>`<td class="${MTO_NUMERIC.has(c)?"num":""}">${mtoCell(r,c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length}" class="muted" style="text-align:center;padding:20px">No MTO order lines match</td></tr>`}
    </tbody></table></div>
    <div id="mtoFilterPop" class="vl-filterpop" style="display:none"></div>`;
  wire();
  const grid = $("#mtoGrid");
  if(grid && scroll){ grid.scrollTop = scroll[0]; grid.scrollLeft = scroll[1]; }
  const byKey = new Map(rows.slice(start, start+s.pageSize).map(r=>[mtoKey(r), r]));
  $$("#page-mto .mto-xd").forEach(inp=>{
    inp.addEventListener("change",()=>{ const r = byKey.get(inp.dataset.key); if(r) mtoSaveExtra(r, inp); });
    inp.addEventListener("keydown",e=>{ if(e.key==="Enter") inp.blur(); });
  });
  const rerender = ()=>{ s.page = 1; renderMTO(); };
  $("#mtoFrom").addEventListener("change",e=>{ s.from = e.target.value; rerender(); });
  $("#mtoTo").addEventListener("change",e=>{ s.to = e.target.value; rerender(); });
  $$("#page-mto .mto-quick").forEach(b=>b.addEventListener("click",()=>{ [s.from, s.to] = mtoQuickRange(b.dataset.k); rerender(); }));
  [["mtoType","type"],["mtoStore","store"],["mtoCategory","category"],["mtoKarat","karat"],["mtoBand","band"]].forEach(([id,k])=>
    $("#"+id).addEventListener("change",e=>{ s[k] = e.target.value; rerender(); }));
  $("#mtoResetTop").addEventListener("click",()=>{ ["from","to","type","store","category","karat","band"].forEach(k=>{ s[k] = ""; }); rerender(); });
  $("#mtoGroup").addEventListener("change",e=>{ s.group = e.target.value; renderMTO(); });
  $("#mtoView").addEventListener("change",e=>{ s.view = e.target.value; renderMTO(); });
  $("#mtoPrev").addEventListener("click",()=>{ s.page--; renderMTO(); });
  $("#mtoNext").addEventListener("click",()=>{ s.page++; renderMTO(); });
  $$("#page-mto .mto-filter-btn").forEach(b=>b.addEventListener("click",e=>{ e.stopPropagation(); openMtoFilterPopover(b.dataset.col, b); }));
  $$("#page-mto .mto-chip-x").forEach(x=>x.addEventListener("click",()=>{ delete MTO_FILTERS[x.dataset.col]; rerender(); }));
  const ca = $("#mtoClearAll"); if(ca) ca.addEventListener("click",()=>{ Object.keys(MTO_FILTERS).forEach(k=>delete MTO_FILTERS[k]); rerender(); });
}

const RENDERERS = { overview:renderOverview, details:renderDetails, metal:renderMetal, purity:renderPurity, rate:renderRate, weight:renderWeight, making:renderMaking, stones:renderStones, discounts:renderDiscounts, posprice:renderPosPrice, variant:renderVariantLevel, style:renderStyleLevel, shopify:renderShopify, company:renderCompany, invmargin:renderInvMargin, margin:renderMargin, health:renderHealth, mto:renderMTO };
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
  $("#editorBtn").addEventListener("click", openEditorLogin);
  initEditor();
  renderGoldStrip(); fetchGoldStrip();
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
      if(STATE.tab==="style"){ SL_STATE.page=1; }
      if(STATE.tab==="shopify"){ SH_STATE.page=1; }
      if(STATE.tab==="company"){ CO_STATE.page=1; }
      if(STATE.tab==="mto"){ MTO_STATE.page=1; }
      renderActive();
    }, 300);
  });
  $("#themeBtn").addEventListener("click",()=>{
    document.body.classList.toggle("light");
    try{ localStorage.setItem("lj_ppi_theme", document.body.classList.contains("light")?"light":"dark"); }catch(e){}
  });
  try{ if(localStorage.getItem("lj_ppi_theme")==="light") document.body.classList.add("light"); }catch(e){}
});
