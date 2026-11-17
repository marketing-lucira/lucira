/* Meeting -> Call -> Walk-in -> Sale Intelligence
   All data comes live from /api/journey (BigQuery view ds_imputed_reporting.zoho_meeting_journey_v).
   1 row = 1 Zoho CRM meeting. Every timestamp string from the API is already IST wall-clock
   ("YYYY-MM-DDTHH:MM:SS"); nothing here converts time zones again. */
(function(){
'use strict';

/* ---------------- helpers ---------------- */
var MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function $(id){ return document.getElementById(id); }
function esc(s){ return (s==null?'':''+s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function fmtInt(n){ return (n==null||isNaN(n))?'—':Math.round(n).toLocaleString('en-IN'); }
function fmtMoney(n){ if(n==null||isNaN(n)) return '—'; var a=Math.abs(n),s=n<0?'-':'';
  if(a>=1e7) return s+'₹'+(a/1e7).toFixed(2)+' Cr'; if(a>=1e5) return s+'₹'+(a/1e5).toFixed(2)+' L'; return s+'₹'+Math.round(a).toLocaleString('en-IN'); }
function fmtMoneyFull(n){ return (n==null||isNaN(n))?'—':'₹'+Math.round(n).toLocaleString('en-IN'); }
function pct(a,b){ return b?100*a/b:null; }
function fmtPct(p){ return p==null?'—':p.toFixed(1)+'%'; }
function fmtDate(d){ if(!d) return '—'; var p=d.slice(0,10).split('-'); return (+p[2])+' '+MON[+p[1]-1]+' '+p[0]; }
function fmtTime(ts){ if(!ts||ts.length<16) return '—'; var h=+ts.slice(11,13), m=ts.slice(14,16), ap=h>=12?'PM':'AM'; h=h%12||12; return h+':'+m+' '+ap; }
function fmtDT(ts){ return ts?fmtDate(ts)+', '+fmtTime(ts):'—'; }
function fmtDur(sec){ if(!sec) return '0s'; var h=Math.floor(sec/3600), m=Math.floor(sec%3600/60), s=sec%60;
  return (h?h+'h ':'')+(h||m?m+'m ':'')+s+'s'; }
function dash(v){ return (v==null||v==='')?'—':v; }
function num(v){ return v==null?0:+v; }

/* IST calendar helpers (browser clock -> IST, independent of the viewer's own time zone) */
function istNow(){ return new Date(Date.now()+5.5*3600e3); }           // read with getUTC*
function isoDay(d){ return d.toISOString().slice(0,10); }
function todayIST(){ return isoDay(istNow()); }
function addDays(s,n){ var d=new Date(s+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return isoDay(d); }
function weekStart(s){ var d=new Date(s+'T00:00:00Z'); var wd=(d.getUTCDay()+6)%7; return addDays(s,-wd); } // Monday
function presetRange(p){
  var t=todayIST();
  switch(p){
    case 'today': return [t,t];
    case 'yesterday': var y=addDays(t,-1); return [y,y];
    case 'thisweek': return [weekStart(t),t];
    case 'lastweek': var ws=addDays(weekStart(t),-7); return [ws,addDays(ws,6)];
    case 'thismonth': return [t.slice(0,8)+'01',t];
    case 'last30': return [addDays(t,-29),t];
    case 'all': return ['2000-01-01','2100-12-31'];
  }
  return null;
}
var PRESETS=[['today','Today'],['yesterday','Yesterday'],['thisweek','This Week'],['lastweek','Last Week'],['thismonth','This Month'],['last30','Last 30 Days'],['all','All'],['custom','Custom']];

/* ---------------- state ---------------- */
var DATA=null, ROWS=[], STORE_LABEL={};
var TAB='created';
/* Every filter is MULTI-SELECT (user 2026-11-04): a filter value is an array of chosen options, [] = All.
   Several values in one filter = OR (row matches any of them); different filters = AND. */
function newFilter(preset){ var r=presetRange(preset); return {preset:preset, from:r[0], to:r[1], jc:[], city:[], store:[], stage:[], trigger:[], prob:[], mtype:[], call:[], conf:[], walk:[], sale:[]}; }
function msHas(vals,v){ return !vals || !vals.length || vals.indexOf(v)>=0; }   // [] = All
var F={ created:newFilter('thismonth'), from:newFilter('today') };
var TBL={ created:{q:'',sort:'created_date',dir:-1,page:1}, from:{q:'',sort:'from_date',dir:1,page:1} };
var BD={ created:'jc', from:'jc' };
var PAGE_SIZE=25;

/* ---------------- store link + store access (user request 2026-11-12) ----------------
   The Store filter lives in the URL: choosing MAL + PN1 + N18 turns the address into /MAL-PN1-N18,
   and opening that address applies the same Store filter (one Store filter for ALL tabs).
   Key of a store = its code ("MAL - Malleshwaram" -> MAL), else the label without spaces / symbols
   ("Hyderabad Kondapur" -> HYDERABADKONDAPUR) -- same rule as _store_key() in main.py.
   ME = /api/me. A "store" login (an email of the access list) only ever receives its own stores'
   data from the server and its address is always the link of its stores, so nothing is locked here
   in the page -- the server simply never sends another store. */
var ME=null, URL_APPLIED=false;
/* A signed store link (/MAL-PN1-N18?k=signature) needs no login: the page passes the link on every
   API call and the server answers with those stores only. */
var LINK=(function(){ try{ var k=new URLSearchParams(location.search).get('k'), p=location.pathname.replace(/^\/+|\/+$/g,''); return k&&p?p+'.'+k:null; }catch(e){ return null; } })();
/* USER RULE 2026-11-12: a page OPENED on a store address (/MAL-LPN-BO1, with or without ?k=) is locked
   to those stores for everyone, the password login too: no Store filter, the address never changes,
   and the server sends only those stores (X-Store-Lock). Stores are chosen only on the plain "/" page
   -- there the address follows the Store filter so it can be copied and sent. */
var LOCK=(function(){ var p=location.pathname.replace(/^\/+|\/+$/g,''); return /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/.test(p)?p.toUpperCase():null; })();
var FETCH_OPTS={credentials:'same-origin',cache:'no-store',headers:{}};
if(LINK) FETCH_OPTS.headers['X-Store-Link']=LINK;
if(LOCK) FETCH_OPTS.headers['X-Store-Lock']=LOCK;
function storeKeyOf(label){ var m=/^([A-Z0-9]{2,6}) - /.exec(label||''); return m?m[1]:(label||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }
function pathKeys(){ var p=location.pathname.replace(/^\/+|\/+$/g,''); return /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/.test(p)?p.toUpperCase().split('-'):[]; }
function restricted(){ return !!(ME && ME.role==='store'); }
function labelOfKey(k){
  var all=opts('k_store'); for(var i=0;i<all.length;i++) if(storeKeyOf(all[i])===k) return all[i];
  return STORE_LABEL[k] || STORE_FALLBACK[k] || k;
}
function syncUrl(){
  if(restricted() || !window.history || !history.replaceState) return;
  var seen={}, keys=[]; F.created.store.forEach(function(l){ var k=storeKeyOf(l); if(k && !seen[k]){ seen[k]=1; keys.push(k); } });
  var path='/'+keys.join('-');
  if(location.pathname!==path || location.search) try{ history.replaceState(null,'',path); }catch(e){}
  renderMe();
}
function setStores(vals){   // ONE Store filter for every tab + the address bar
  // stores already chosen keep their place, a newly ticked one goes to the end: /MAL-PN1-N18 + LPN = /MAL-PN1-N18-LPN
  var prev=F.created.store;
  vals=prev.filter(function(v){ return vals.indexOf(v)>=0; }).concat(vals.filter(function(v){ return prev.indexOf(v)<0; }));
  F.created.store=vals.slice(); F.from.store=vals.slice(); FD.store=vals.slice();
  TBL.created.page=1; TBL.from.page=1; syncUrl();
}
function applyUrlStores(){   // once, after the first data load (labels are known only then)
  if(URL_APPLIED) return; URL_APPLIED=true;
  if(restricted()) return;
  var keys=pathKeys(); if(keys.length) setStores(keys.map(labelOfKey));
}
function renderAll(){ if(DATA){ renderTab('created'); renderTab('from'); } if(TAB==='deals') renderDeals(); if(TAB==='mji') renderMJI(); }
function renderMe(){
  var box=$('meInfo'), share=$('btnShare'), acc=$('btnAccess'); if(!box) return;
  if(restricted()){
    box.hidden=false; box.innerHTML='This link shows only<br><b>'+esc((ME.stores||[]).join(' · '))+'</b>';
    share.hidden=true; acc.hidden=true; return;
  }
  if(ME && ME.email){ box.hidden=false; box.innerHTML='Signed in<br><b>'+esc(ME.email)+'</b>'; } else box.hidden=true;
  share.hidden=!F.created.store.length;
  acc.hidden=!(ME && ME.role==='admin');
}

/* City = store-city group (user rule 2026-11-03): every spelling / locality of a city where Lucira has
   a store folds into that city (Central / West / South Delhi -> Delhi / Gurgaon, Thane / Chembur /
   Borivali -> Mumbai ...); every city WITHOUT a store is one row "Other cities (no store)". The regex
   list is the SAME as store_city_group in sql/deal_store_funnel_view.sql (keep the two in step), so a
   store-city row's Store City Deals = its Total Deals. Blank city -> the meeting's store city (the
   view does the same for deals), else "Not Captured". */
var OTHER_CITY='Other cities (no store)';
var CITY_RE=[['Mumbai',/\b(mumbai|bombay|thane|borivali|andheri|bandra|kandivali|malad|goregaon|dadar|kurla|ghatkopar|mulund|chembur|powai|kalyan|dombivli|bhiwandi|mira road|bhayandar|vasai|virar|panvel|kharghar|vashi|airoli|ulhasnagar|ambernath|badlapur)\b/],
  ['Pune',/\b(pune|poona|pimpri|chinchwad)\b/],
  ['Noida / Ghaziabad',/\b(noida|gautam buddha nagar|ghaziabad|gaziabad)\b/],
  ['Delhi / Gurgaon',/\b(delhi|karawal nagar|faridabad|gurgaon|gurugram)\b/],
  ['Bangalore',/\b(bangalore|bengaluru)\b/],
  // Hyderabad (user 2026-11-03: store opening there). Not in the funnel view's list yet, so main.py
  // (HYD_RE, same words) adds it for deals and prepDeal() for the Deals Funnel -- keep the three in step.
  ['Hyderabad',/\b(hyderabad|hydrabad|hyderbad|secunderabad|cyberabad|rangareddy|ranga reddy|medchal|malkajgiri|gachibowli|kukatpally|madhapur|kondapur|hitech city|banjara hills|jubilee hills|ameerpet|begumpet|miyapur|lb nagar|dilsukhnagar|kompally|manikonda|shamshabad)\b/]];
var STORE_CITY={BO1:'Mumbai',CS1:'Mumbai',FCS:'Mumbai',PN1:'Pune',N18:'Noida / Ghaziabad',PV1:'Delhi / Gurgaon',LPN:'Delhi / Gurgaon',MAL:'Bangalore'};
function cityGroup(s){
  var cn=(s||'').toLowerCase().replace(/[^a-z ]/g,' ').replace(/\s+/g,' ').trim();
  if(!cn) return null;
  for(var i=0;i<CITY_RE.length;i++) if(CITY_RE[i][1].test(cn)) return CITY_RE[i][0];
  return OTHER_CITY;
}
function meetingCityGroup(r){
  return cityGroup(r.deal_city) || STORE_CITY[r.meeting_store_code] ||
    (/^Mumbai/.test(r.store||'')?'Mumbai':/^Delhi/.test(r.store||'')?'Delhi / Gurgaon':
     /hyderabad|kondapur/i.test(r.store||'')?'Hyderabad':null) || 'Not Captured';   // Zoho Store - Name "Hyderabad Kondapur"
}
/* 7 km rule (user 2026-11-03, replaces 5 km): a customer pincode is "Within 7 km" when its area centre
   is within 7 km of ANY Lucira store (STORE_PINS below lists every such pincode); a pincode not on
   the list = "7 km & above"; no pincode on record = "Pincode Not Available". */
function pinBand(pin){ pin=(pin==null?'':''+pin).trim(); return !pin?'na':(NEAR7[pin]?'in':'out'); }

/* derived per-row dimension values (bucketed, never guessed) */
function prep(r){
  r.k_jc = r.jc || 'Unassigned';
  r.k_city = meetingCityGroup(r);
  r.k_store = r.store || 'Not Captured';
  r.k_stage = r.deal_stage || (r.deal_id?'Not Set':'No Deal linked');
  r.k_trigger = r.deal_trigger || (r.deal_id?'Not Set':'No Deal linked');
  r.k_prob = r.probability!=null ? r.probability+'%' : (r.deal_id?'Not Set':'No Deal linked');
  r.k_mstatus = r.meeting_status || 'Not Set';
  // Meeting Type folded from the free-text Event_Title in the view (23 raw spellings of
  // "Store Visit" collapse to one). This is the dimension worth filtering on -- Zoho's
  // Check_In_Status (k_mstatus) reads PLANNED on every record and carries no information.
  r.k_mtype = r.meeting_type_norm || 'Not Set';
  // Source of the linked Deal, exactly as in Zoho (Lead_Source picklist / UTM_Source text).
  r.k_lsrc = r.lead_source || (r.deal_id?'Not Set':'No Deal linked');
  r.k_usrc = r.utm_source || (r.deal_id?'Not Set':'No Deal linked');
  r.cust_key = r.mobile || (r.deal_id?'d:'+r.deal_id:(r.contact_id?'c:'+r.contact_id:'m:'+r.meeting_id));
  r.calls_after=num(r.calls_after); r.connected_calls=num(r.connected_calls); r.missed_calls=num(r.missed_calls);
  r.walkins_after=num(r.walkins_after); r.sales_after=num(r.sales_after); r.sales_amount_after=num(r.sales_amount_after);
  r.talk_time_sec=num(r.talk_time_sec);
  // Zoho meeting picklist "Confirmation" (Confirmed / Not Confirmed / Not Connected; blank = not marked).
  r.confirmation = r.confirmation || null; r.confirmed = r.confirmation==='Confirmed';
  CONF_BY[r.meeting_id] = r.confirmation;
  // Customer pincode vs the meeting's store: null = no customer pincode on record (neither bucket).
  r.km_to_store = r.km_to_store==null ? null : +r.km_to_store;
  // Pincode used for the 7 km columns (USER RULE 3 Nov 2026): ONLY the Zoho Deal "Address - Zip / Postal
  // Code" -- the meeting's own deal, else the customer's latest deal with one (added by main.py). The Zoho
  // meeting Pincode / customer-record pincode are shown in the journey panel for reference only.
  // User rule 4 Nov 2026: Zoho CONTACT address pincode first (typed pincode in the contact's address,
  // else its Mailing Zip -- main.py add_contact_pins), else the Deal zip as before.
  r.pin_used = r.contact_pin || r.deal_zip || null;
  r.pin_used_src = r.contact_pin ? r.contact_pin_source : (r.deal_zip ? r.deal_zip_source : null);
  r.pin_used_tag = r.contact_pin ? 'Contact' : (r.deal_zip ? 'Deal' : null);
  r.pin7 = pinBand(r.pin_used);                          // 'in' | 'out' | 'na'
  r.near7 = r.pin7==='in' ? NEAR7[(''+r.pin_used).trim()] : null;   // {store, km} nearest store
  r.pin7_sort = r.pin7==='in' ? r.near7.km : (r.pin7==='out' ? 99 : null);
  // Walked in (Tabs 1-2) = customer_walkin record after creation OR Zoho meeting Show_Status = Show.
  r.walked_in = r.walked_in===true || r.walked_in==='true';
  r.prev_walkin = r.prev_walkin===true || r.prev_walkin==='true';
  r.all_day = r.all_day===true || r.all_day==='true';
  r.from_sort = (r.from_date||'')+'T'+(r.from_ist?r.from_ist.slice(11):'00:00:00');
  if(r.meeting_store_code && r.store) STORE_LABEL[r.meeting_store_code]=r.store;
  r.calls=r.calls||[]; r.walkins=r.walkins||[]; r.sales=r.sales||[];
  return r;
}
var CONF_BY={};   // meeting_id -> Zoho Confirmation (also used by the Deals Funnel tab)
function confLabel(r){ return r.confirmation || 'Not marked'; }
function confHtml(r){ return r.confirmed?'<span class="yes">Confirmed</span>':(r.confirmation?'<span class="no">'+esc(r.confirmation)+'</span>':'<span class="muted">Not marked</span>'); }
var TIP_CONF='Meetings whose Zoho meeting field “Confirmation” = Confirmed (the agent spoke to the customer and the customer confirmed the store visit). The field has three values — Confirmed / Not Confirmed / Not Connected — and blank = not marked by the team. % = Confirmed ÷ Connected (meetings with a call of ≥ 30 s). The field exists in Zoho only since 30 Oct 2026, so older meetings are all “Not marked”.';
function confSplit(m){ return 'Confirmed: '+fmtInt(m.confirmed)+'<br>Not Confirmed: '+fmtInt(m.notConf)+'<br>Not Connected: '+fmtInt(m.confNC)+'<br>Not marked in Zoho: '+fmtInt(m.confBlank); }
function storeName(code){ return code ? (STORE_LABEL[code] || code) : '—'; }

/* Agreed to Reschedule / Cancelled by Customer (user request 2026-11-11).
   Zoho has no "Rescheduled" or "Cancelled" value on meetings (Show_Status = Show / No Show only), so
   both are derived from what the agent records on the meeting. Only meetings with NO visit (no
   walk-in register record after creation and not Zoho Show) can be either; never both.
   - Agreed to Reschedule = the customer has a NEW Zoho meeting booked later (same customer, created
     after this one, later From Date), OR the agent reached the customer (Connection Status =
     Connected) and set a Follow Up date after the meeting's From Date, or the Description says when
     they will come ("will visit on 14th", "tomorrow", "postpone" ...) -- unless the Description says
     the customer is not interested / bought elsewhere.
   - Cancelled by Customer = Zoho Show Status = No Show, the agent reached the customer (Connected),
     and no new date was agreed -- or the Description says not interested / no plan / bought elsewhere
     / cancelled. A No Show that was never connected is neither (the customer just did not turn up).
   If Zoho ever gets explicit "Rescheduled" / "Cancelled" values (Show Status or Meeting Status), they
   win over the rules. */
var RESCHED_TXT=/resch|re-sch|postpon|pospone|prepone|will (come|visit)|visit (on|in|after|next|tomorrow|when)|tom+or+ow|next (week|month|sunday|saturday|monday|tuesday|wednesday|thursday|friday)|after diwa|call me (after|tomorrow|later)/i;
var CANCEL_TXT=/cancel|not +int+e?r?e?s?t|no plan|already (purchas|parch|bought)|purchas\w* (in|from) other|other brand|bought (from|else)/i;
function markOutcomes(){
  var byCust={}, today=todayIST();
  ROWS.forEach(function(r){ (byCust[r.cust_key]=byCust[r.cust_key]||[]).push(r); });
  ROWS.forEach(function(r){
    r.resched=false; r.cancelled=false; r.outcome_why=null;
    var st=((r.show_status||'')+' '+(r.zoho_meeting_status||'')).toLowerCase(), desc=r.meeting_description||'';
    var later=(byCust[r.cust_key]||[]).filter(function(x){ return x!==r && x.meeting_created_ist>r.meeting_created_ist && x.from_date && r.from_date && x.from_date>r.from_date; })
      .sort(function(a,b){ return a.from_date<b.from_date?-1:1; })[0];
    r.resched_to=later?later.from_date:null;
    if(r.walked_in) return;
    var conn=r.connection_status==='Connected', fu=r.follow_up && r.from_date && r.follow_up>r.from_date, noInt=CANCEL_TXT.test(desc);
    if(/resch/.test(st)){ r.resched=true; r.outcome_why='Zoho status: Rescheduled'; return; }
    if(/cancel/.test(st)){ r.cancelled=true; r.outcome_why='Zoho status: Cancelled'; return; }
    if(later){ r.resched=true; r.outcome_why='New meeting booked for '+fmtDate(later.from_date); return; }
    if(conn && !noInt && fu){ r.resched=true; r.outcome_why='Connected · Follow Up set for '+fmtDate(r.follow_up); return; }
    if(conn && !noInt && RESCHED_TXT.test(desc)){ r.resched=true; r.outcome_why='Connected · Description: “'+desc.trim().slice(0,80)+'”'; return; }
    if(noInt && (conn || r.show_status==='No Show')){ r.cancelled=true; r.outcome_why='Description: “'+desc.trim().slice(0,80)+'”'; return; }
    if(r.show_status==='No Show' && conn){ r.cancelled=true; r.outcome_why='No Show · Connected · no new date agreed'; }
  });
}
function outcomeLabel(r){ return r.resched?'Agreed to Reschedule':(r.cancelled?'Cancelled by Customer':''); }

function dateField(tab){ return tab==='created' ? 'meeting_created_date' : 'from_date'; }
/* status filters: each choice is a test; a row passes when ANY chosen test is true */
var STATUS_TESTS={
  call:{called:function(r){ return !!r.calls_after; }, notcalled:function(r){ return !r.calls_after; },
        connected:function(r){ return !!r.connected_calls; }, notconnected:function(r){ return !!r.calls_after && !r.connected_calls; }},
  conf:{confirmed:function(r){ return r.confirmed; }, notconfirmed:function(r){ return r.confirmation==='Not Confirmed'; },
        notconnected:function(r){ return r.confirmation==='Not Connected'; }, blank:function(r){ return !r.confirmation; }},
  walk:{yes:function(r){ return r.walked_in; }, no:function(r){ return !r.walked_in; }, prev:function(r){ return r.prev_walkin; }},
  sale:{yes:function(r){ return !!r.sales_after; }, no:function(r){ return !r.sales_after; }}
};
function passStatus(k,vals,r){ return !vals.length || vals.some(function(v){ var t=STATUS_TESTS[k][v]; return t && t(r); }); }
function passNonDate(r,f){
  return msHas(f.jc,r.k_jc) && msHas(f.city,r.k_city) && msHas(f.store,r.k_store) &&
    msHas(f.stage,r.k_stage) && msHas(f.trigger,r.k_trigger) && msHas(f.prob,r.k_prob) && msHas(f.mtype,r.k_mtype) &&
    passStatus('call',f.call,r) && passStatus('conf',f.conf,r) && passStatus('walk',f.walk,r) && passStatus('sale',f.sale,r);
}
function filtered(tab){
  var f=F[tab], df=dateField(tab);
  return ROWS.filter(function(r){ var d=r[df]; return d && d>=f.from && d<=f.to && passNonDate(r,f); });
}

/* ---------------- metrics (deduped across meetings) ---------------- */
function metrics(rows){
  var m={meetings:rows.length, called:0, connected:0, confirmed:0, notConf:0, confNC:0, confBlank:0, show:0, conv:0, walk:0, sale:0, near:0, far:0, noPin:0, cust:{}, custWalk:{}, custSale:{}, callIds:{}, connIds:{}, docs:{}, notCalled:0, notWalked:0, act:0, resched:0, cancel:0};
  rows.forEach(function(r){
    m.cust[r.cust_key]=1;
    if(r.resched) m.resched++; else if(r.cancelled) m.cancel++;
    // Within 7 km / 7 km & above need a customer pincode; no pincode = Pincode Not Available.
    if(r.pin7==='in') m.near++; else if(r.pin7==='out') m.far++; else m.noPin++;
    if(r.calls_after){ m.called++; } else m.notCalled++;
    m.act+=r.calls_after||0;   // Call Activity = Σ calls after creation per meeting (= sum of the Meetings-table column)
    if(r.connected_calls) m.connected++;
    if(r.confirmed) m.confirmed++; else if(r.confirmation==='Not Confirmed') m.notConf++; else if(r.confirmation==='Not Connected') m.confNC++; else m.confBlank++;
    if(r.show_status==='Show') m.show++;
    if(r.conversion_status==='Converted') m.conv++;
    if(r.walked_in){ m.walk++; m.custWalk[r.cust_key]=1; } else m.notWalked++;
    if(r.sales_after){ m.sale++; m.custSale[r.cust_key]=1; }
    r.calls.forEach(function(c){ if(c.type!=='Missed'){ m.callIds[c.id]=1; if(+c.dur>=30) m.connIds[c.id]=1; } });
    r.sales.forEach(function(s){ m.docs[s.doc]=+s.amount||0; });
  });
  m.uniqueCust=Object.keys(m.cust).length;
  m.custWalkN=Object.keys(m.custWalk).length; m.custSaleN=Object.keys(m.custSale).length;
  m.callsN=Object.keys(m.callIds).length; m.connCallsN=Object.keys(m.connIds).length;
  m.salesN=Object.keys(m.docs).length;
  m.salesAmt=Object.keys(m.docs).reduce(function(a,k){return a+m.docs[k];},0);
  return m;
}

/* ---------------- store visits by VISIT date ----------------
   User rule 2026-10-26: a customer who visits on day D counts as a walk-in on day D, even when the
   meeting was raised last week. Each visit is mapped to the customer's latest meeting created
   before it (that meeting gives JC / Store / Source ...). Sources: customer_walkin records
   (r.walkins = every walk-in of the customer) and Zoho meetings marked Show (visit day = the
   meeting's From Date, mapped to that meeting). One visit per customer per IST day; a walk-in with
   no meeting before it is not meeting-led and is skipped. */
var VISITS=[];
function buildVisits(){
  var byCust={}, out=[], today=todayIST();
  ROWS.forEach(function(r){ (byCust[r.cust_key]=byCust[r.cust_key]||[]).push(r); });
  Object.keys(byCust).forEach(function(k){
    // Since 2026-11-13 an invoice is attached to ONE meeting of the customer (no duplicate invoice on
    // two meeting rows). Visit sales need every invoice of the customer -> cust_sales (each once).
    var cs=[], sd={}; byCust[k].forEach(function(r){ r.sales.forEach(function(x){ if(!sd[x.doc]){ sd[x.doc]=1; cs.push(x); } }); });
    cs.sort(function(a,b){ return (a.ts||'')<(b.ts||'')?-1:1; });
    byCust[k].forEach(function(r){ r.cust_sales=cs; });
    var ms=byCust[k].slice().sort(function(a,b){ return a.meeting_created_ist<b.meeting_created_ist?-1:1; }), days={}, seen={};
    ms.forEach(function(r){
      if(r.show_status!=='Show' || !r.from_date || r.from_date>today) return;
      var v=days[r.from_date]; if(!v) v=days[r.from_date]={day:r.from_date, reg:false};
      v.show=true; v.m=r;                       // the Show meeting is the meeting of that visit
    });
    ms.forEach(function(r){ r.walkins.forEach(function(w){
      if(!w.ts || seen[w.ts+'|'+w.store]) return; seen[w.ts+'|'+w.store]=1;
      var prior=null; ms.forEach(function(x){ if(x.meeting_created_ist<w.ts) prior=x; });
      if(!prior) return;
      var d=w.ts.slice(0,10), v=days[d];
      if(!v) v=days[d]={day:d, show:false, m:prior};
      v.reg=true;
      if(!v.ts || w.ts<v.ts){ v.ts=w.ts; v.store=w.store; }   // first register walk-in of that day
    }); });
    Object.keys(days).forEach(function(d){ out.push(days[d]); });
  });
  VISITS=out;
}
function visitsIn(tab){ var f=F[tab]; return VISITS.filter(function(v){ return v.day>=f.from && v.day<=f.to && passNonDate(v.m,f); }); }
/* Walk-in sales of visits: invoices of the mapped meeting's customer dated on/after the visit day
   and within the selected range; each invoice counted once. */
function visitMetrics(vs,to){
  // invN / amt = Invoice Qty / Walk-in Sale Value (user rule 2026-11-03: the ONLY sale figure on
  // the KPIs, funnel and breakdown); visitors / buyers = unique visiting customers / those who bought.
  var o={n:vs.length, reg:0, showOnly:0, docs:{}, cust:{}, buy:{}};
  vs.forEach(function(v){
    if(v.reg) o.reg++; else o.showOnly++;
    var k=v.m.cust_key; o.cust[k]=1;
    (v.m.cust_sales||v.m.sales).forEach(function(s){ var d=(s.ts||'').slice(0,10); if(d>=v.day && d<=to){ o.docs[s.doc]=+s.amount||0; o.buy[k]=1; } });
  });
  o.invN=Object.keys(o.docs).length;
  o.amt=Object.keys(o.docs).reduce(function(a,k){return a+o.docs[k];},0);
  o.visitors=Object.keys(o.cust).length; o.buyers=Object.keys(o.buy).length;
  return o;
}

/* ---------------- ALL store walk-ins (user 2026-11-10: "many visits not showing") ----------------
   VISITS above are MEETING-LED only (the customer had a Zoho meeting before the visit, or the meeting
   is marked Show). Most POS walk-in register records are customers with NO Zoho meeting (1-9 Nov 2026:
   426 register walk-ins, 59 meeting-led), so they never showed anywhere. /api/all-walkins serves the
   whole register (1 row per customer per IST day); every customer-day already counted as a
   meeting-led visit (same mobile or email, same day) is dropped here, so the two never double count.
   The rest = "walk-ins without a Zoho meeting": shown in the Store visits list, the All Store
   Walk-ins KPI and Store Performance. Funnel / Convert / Invoice Qty stay meeting-led. */
var AW=null, AW_LOADING=false, AW_ERR=null, awLoadedAt=0, AW_MEMO=null;
var STORE_FALLBACK={FCS:'FCS - FCS (Chembur address)'};   // store with walk-ins but (so far) no meetings
function storeLabelOf(code){ return code ? (STORE_LABEL[code] || STORE_FALLBACK[code] || code) : 'Not Captured'; }
function loadAW(force){
  if(AW_LOADING) return; AW_LOADING=true;
  fetch('api/all-walkins'+(force?'?refresh=1':''),FETCH_OPTS)
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
    .then(function(x){
      if(!x.ok || !x.j.ok){ AW_ERR=(x.j&&x.j.error)||'Unknown error'; return; }
      var c={}; x.j.cols.forEach(function(k,i){ c[k]=i; });
      AW=x.j.rows.map(function(a){ var o={}; Object.keys(c).forEach(function(k){ o[k]=a[c[k]]; }); o.sales=o.sales||[]; return o; });
      AW_ERR=null; awLoadedAt=Date.now(); AW_MEMO=null;
    })
    .catch(function(e){ AW_ERR=String(e); })
    .then(function(){ AW_LOADING=false; if(DATA && ROWS.length){ renderTab('created'); renderTab('from'); } });
}
/* register source of a day (Store Walkin / Sales / Receipt ...) for meeting-led register visits too */
function awSourceOf(mobile,email,day){ var x=nomtgAll(); return x ? (x.src[(mobile||'-')+'|'+day] || x.src[(email||'-')+'|'+day] || '') : ''; }
function nomtgAll(){
  if(!AW) return null;
  if(AW_MEMO && AW_MEMO.aw===AW && AW_MEMO.vis===VISITS) return AW_MEMO;
  var seen={}, src={}, list=[];
  VISITS.forEach(function(v){ var m=v.m; if(m.mobile) seen[m.mobile+'|'+v.day]=1; if(m.email) seen[m.email+'|'+v.day]=1; seen[m.cust_key+'|'+v.day]=1; });
  AW.forEach(function(w){
    if(w.mobile) src[w.mobile+'|'+w.day]=w.sources||''; if(w.email) src[w.email+'|'+w.day]=w.sources||'';
    if((w.mobile && seen[w.mobile+'|'+w.day]) || (w.email && seen[w.email+'|'+w.day])) return;   // already a meeting-led visit
    var pin7=pinBand(w.pin), deal=!!w.deal_id;
    w.zoho = !deal ? 'Not in Zoho CRM (no deal)' : (+w.deal_after ? 'Zoho deal created after the visit' : 'Zoho deal, no meeting');
    w.m={ meeting_id:'', nm:true, customer_name:w.name, mobile:w.mobile, email:w.email, cust_key:w.mobile||w.email||'',
      k_jc:w.deal_owner||'No Zoho deal', k_city:STORE_CITY[w.store_code]||'Not Captured', k_store:storeLabelOf(w.store_code),
      k_stage:w.deal_stage||'No Deal linked', k_trigger:w.deal_trigger||'No Deal linked', k_prob:w.deal_prob!=null?w.deal_prob+'%':'No Deal linked',
      k_mtype:'—', show_status:null, conversion_status:null, pin_used:w.pin, pin_used_src:'Walk-in register pincode', pin_used_tag:'Register',
      pin7:pin7, near7:pin7==='in'?NEAR7[w.pin]:null, meeting_created_ist:null, meeting_created_date:null, from_date:null,
      deal_id:w.deal_id, deal_name:w.deal_name, sales:w.sales };
    list.push(w);
  });
  AW_MEMO={aw:AW, vis:VISITS, list:list, src:src};
  return AW_MEMO;
}
/* the meeting filters apply where a walk-in has the value (store / city / deal owner / deal stage /
   trigger / probability); Meeting Type / Call / Confirmation / Walk-in / Sale filters exist only on meetings, so a
   walk-in without a meeting is left out while one of them is on. */
function passWalkin(m,f){
  return msHas(f.jc,m.k_jc) && msHas(f.city,m.k_city) && msHas(f.store,m.k_store) && msHas(f.stage,m.k_stage) &&
    msHas(f.trigger,m.k_trigger) && msHas(f.prob,m.k_prob) && !f.mtype.length && !f.call.length && !f.conf.length && !f.walk.length && !f.sale.length;
}
function nomtgIn(tab){   // null = register not loaded yet (or failed)
  if(!AW && !AW_ERR) loadAW(false);
  var x=nomtgAll(); if(!x) return null;
  var f=F[tab]; return x.list.filter(function(w){ return w.day>=f.from && w.day<=f.to && passWalkin(w.m,f); });
}

/* ---------------- tooltip ---------------- */
var tip=null;
function showTip(html,e){ tip.innerHTML=html; tip.style.display='block'; moveTip(e); }
function moveTip(e){ var x=e.clientX+14, y=e.clientY+14, w=tip.offsetWidth, h=tip.offsetHeight;
  if(x+w>innerWidth-8) x=e.clientX-w-14; if(y+h>innerHeight-8) y=e.clientY-h-14; tip.style.left=x+'px'; tip.style.top=y+'px'; }
function hideTip(){ tip.style.display='none'; }
function bindTips(root){
  root.querySelectorAll('[data-tip]').forEach(function(el){
    el.addEventListener('mouseenter',function(e){ showTip(el.getAttribute('data-tip'),e); });
    el.addEventListener('mousemove',moveTip);
    el.addEventListener('mouseleave',hideTip);
  });
}

/* ---------------- header: refresh + health ---------------- */
function renderHeader(){
  var h=DATA.health||[], hb=$('health'), bn=$('banners');
  $('refreshInfo').innerHTML='Last Refresh: <b>'+fmtDT(DATA.refreshed_at_ist)+' IST</b><br><span style="opacity:.8">'+fmtInt(ROWS.length)+' meetings · auto-refresh every '+Math.round((DATA.cache_ttl_sec||600)/60)+' min</span>';
  hb.innerHTML='<span class="small muted" style="font-weight:600">SOURCE HEALTH</span>'+h.map(function(s){
    var cls=s.status==='OK'?'ok':(s.status==='STALE'?'stale':'err');
    var t='<b>'+esc(s.source)+'</b> · '+esc(s.status)+'<br>'+(s.table?'<code>'+esc(s.table)+'</code><br>':'')+
      (s.last_sync_ist?'Last write: '+fmtDT(s.last_sync_ist)+' IST'+(s.age_min!=null?' ('+fmtAge(s.age_min)+' ago)':'')+'<br>':'')+
      (s.latest_record_ist?'Newest record: '+fmtDT(s.latest_record_ist)+'<br>':'')+(s.cadence?'Cadence: '+esc(s.cadence):'')+(s.error?'<br>'+esc(s.error):'');
    return '<span class="pill '+cls+'" data-tip="'+esc(t)+'"><span class="dot"></span>'+esc(s.source)+' <span class="muted">'+(s.status==='OK'?esc(fmtAge(s.age_min))+' ago':esc(s.status))+'</span></span>';
  }).join('');
  bindTips(hb);
  var warn=h.filter(function(s){return s.status!=='OK';});
  var html='';
  if(DATA.refresh_error) html+='<div class="banner err"><b>Latest refresh failed</b> — showing the previous successful load from '+fmtDT(DATA.refreshed_at_ist)+' IST. Error: '+esc(DATA.refresh_error)+'</div>';
  if(warn.length) html+='<div class="banner warn"><b>Source warning:</b> '+warn.map(function(s){return esc(s.source)+' is '+esc(s.status)+(s.last_sync_ist?' (last write '+fmtDT(s.last_sync_ist)+' IST)':'')+(s.error?' — '+esc(s.error):'');}).join('; ')+'. Numbers that depend on this source may be incomplete for recent meetings.</div>';
  bn.innerHTML=html;
}
function fmtAge(m){ if(m==null) return '—'; if(m<60) return m+' min'; if(m<48*60) return Math.round(m/60)+' h'; return Math.round(m/1440)+' d'; }

/* ---------------- filter bar ---------------- */
function opts(key){ var s={}; ROWS.forEach(function(r){ s[r[key]]=(s[r[key]]||0)+1; });
  return Object.keys(s).sort(function(a,b){ return s[b]-s[a] || a.localeCompare(b); }); }
/* Multi-select filter box: a button showing All / the one value / "N selected", opening a checklist
   (search when > 8 options, Select all = every option currently visible, Clear = All). The choice is
   applied on "Apply", Enter or a click outside the box; Esc cancels. Ticking every option = All. */
function msBox(id,label,key,vals,choices){   // choices = [[value,label],...]
  vals=vals||[];
  var known={}, lbl={}; choices.forEach(function(c){ known[c[0]]=1; lbl[c[0]]=c[1]; });
  vals.forEach(function(v){ if(!known[v]){ choices=choices.concat([[v,v]]); lbl[v]=v; } });   // keep a chosen value that left the data
  var shown=!vals.length?'All':(vals.length===1?lbl[vals[0]]:vals.length+' selected');
  var title=vals.length>1?' title="'+esc(vals.map(function(v){ return lbl[v]; }).join(', '))+'"':'';
  return '<div class="fld"><label for="'+id+'">'+label+'</label><div class="ms" data-k="'+key+'">'+
    '<button type="button" class="ms-btn'+(vals.length?' on':'')+'" id="'+id+'" aria-haspopup="true" aria-expanded="false"'+title+'>'+
      '<span class="ms-val">'+esc(shown)+'</span><span class="ms-car" aria-hidden="true">▾</span></button>'+
    '<div class="ms-pop" hidden>'+
      (choices.length>8?'<input type="search" class="ms-q" placeholder="Search '+esc(label)+'…" aria-label="Search '+esc(label)+'">':'')+
      '<div class="ms-acts"><button type="button" data-msa="all">Select all</button><button type="button" data-msa="none">Clear</button></div>'+
      '<div class="ms-list">'+choices.map(function(c){ return '<label class="ms-opt"><input type="checkbox" value="'+esc(c[0])+'"'+(vals.indexOf(c[0])>=0?' checked':'')+'><span>'+esc(c[1])+'</span></label>'; }).join('')+'</div>'+
      '<div class="ms-foot"><span class="ms-cnt"></span><button type="button" class="btn ms-apply">Apply</button></div>'+
    '</div></div></div>';
}
function sel(id,label,key,vals){ return msBox(id,label,key,vals,opts('k_'+key).map(function(o){ return [o,o]; })); }
var MS=null;   // the open popup: {box, initial, apply}
function msChecked(box){ return [].slice.call(box.querySelectorAll('.ms-opt input')).filter(function(c){ return c.checked; }).map(function(c){ return c.value; }); }
function msClose(commit){
  if(!MS) return false;
  var m=MS; MS=null;
  m.box.querySelector('.ms-pop').hidden=true; m.box.querySelector('.ms-btn').setAttribute('aria-expanded','false');
  if(!commit) return false;
  var v=msChecked(m.box);
  if(v.length===m.box.querySelectorAll('.ms-opt input').length) v=[];          // everything ticked = All
  if(v.join('\u0001')===m.initial) return false;
  m.apply(m.box.getAttribute('data-k'), v);
  return true;
}
function msWire(root,apply){   // apply(key, values) re-renders with the new filter
  root.querySelectorAll('.ms').forEach(function(box){
    var btn=box.querySelector('.ms-btn'), pop=box.querySelector('.ms-pop'), q=box.querySelector('.ms-q'), cnt=box.querySelector('.ms-cnt');
    function inputs(){ return [].slice.call(pop.querySelectorAll('.ms-opt input')); }
    function count(){ var n=msChecked(box).length; cnt.textContent=n?n+' selected':'None ticked = All'; }
    btn.onclick=function(){
      if(MS && MS.box===box){ msClose(true); return; }
      if(msClose(true) || !document.body.contains(box)) return;                  // another box applied -> page re-rendered
      if(q){ q.value=''; inputs().forEach(function(c){ c.parentNode.hidden=false; }); }
      pop.hidden=false; btn.setAttribute('aria-expanded','true');
      pop.style.left='0'; var r=pop.getBoundingClientRect();
      if(r.right>innerWidth-8) pop.style.left=Math.min(0,innerWidth-8-r.right)+'px';
      MS={box:box, initial:msChecked(box).join('\u0001'), apply:apply};
      count(); if(q) q.focus();
    };
    if(q){
      q.oninput=function(){ var s=q.value.trim().toLowerCase(); inputs().forEach(function(c){ c.parentNode.hidden=!!s && c.parentNode.textContent.toLowerCase().indexOf(s)<0; }); };
      q.onkeydown=function(e){ if(e.key==='Enter'){ e.preventDefault(); msClose(true); } };
    }
    pop.querySelectorAll('[data-msa]').forEach(function(b){ b.onclick=function(){ var all=b.getAttribute('data-msa')==='all';
      inputs().forEach(function(c){ if(!all) c.checked=false; else if(!c.parentNode.hidden) c.checked=true; }); count(); }; });
    pop.querySelectorAll('.ms-opt input').forEach(function(c){ c.onchange=count; });
    pop.querySelector('.ms-apply').onclick=function(){ msClose(true); };
  });
}
// click anywhere outside the open box applies it (capture phase, so the click that closed it still works); Esc cancels
document.addEventListener('click',function(e){ if(MS && !MS.box.contains(e.target)) msClose(true); },true);
document.addEventListener('keydown',function(e){ if(e.key==='Escape' && MS) msClose(false); });
function filterBar(tab,pfx){   // pfx: render the SAME filter state (F[tab]) inside another tab
  var f=F[tab], p=(pfx||tab)+'_';
  var dlabel = tab==='created' ? 'Meeting Created Date' : 'From Date';
  return '<div class="filters"><div class="datebadge">Date Filter: '+dlabel+'</div><div class="row">'+
    '<div class="fld" style="min-width:auto"><label>Range</label><div class="presets">'+PRESETS.map(function(x){return '<button data-p="'+x[0]+'" class="'+(f.preset===x[0]?'on':'')+'">'+x[1]+'</button>';}).join('')+'</div></div>'+
    '<div class="fld" style="min-width:120px"><label for="'+p+'dfrom">From</label><input type="date" id="'+p+'dfrom" value="'+(f.preset==='all'?'':f.from)+'"></div>'+
    '<div class="fld" style="min-width:120px"><label for="'+p+'dto">To</label><input type="date" id="'+p+'dto" value="'+(f.preset==='all'?'':f.to)+'"></div>'+
    '</div><div class="row" style="margin-top:10px">'+
    sel(p+'jc','JC','jc',f.jc)+sel(p+'city','City','city',f.city)+(restricted()?'':sel(p+'store','Store','store',f.store))+
    sel(p+'stage','Deal Stage','stage',f.stage)+sel(p+'trigger','Deal Trigger','trigger',f.trigger)+sel(p+'prob','Probability','prob',f.prob)+
    sel(p+'mtype','Meeting Type','mtype',f.mtype)+
    msBox(p+'call','Call Status','call',f.call,[['called','Called after creation'],['notcalled','Not called'],['connected','Connected (≥30s)'],['notconnected','Called, not connected']])+
    msBox(p+'conf','Confirmation','conf',f.conf,[['confirmed','Confirmed'],['notconfirmed','Not Confirmed'],['notconnected','Not Connected'],['blank','Not marked']])+
    msBox(p+'walk','Walk-in Status','walk',f.walk,[['yes','Walked in (register or Zoho Show)'],['no','Not walked in'],['prev','Had previous walk-in']])+
    msBox(p+'sale','Sale Status','sale',f.sale,[['yes','Sale after creation'],['no','No sale after creation']])+
    '<button class="linkbtn" data-reset="1">Reset filters</button></div><div class="scope" id="'+p+'scope"></div></div>';
}
function wireFilters(tab,root,pfx){
  var f=F[tab], id=pfx||tab;
  function rr(){ renderTab(tab); if(pfx) renderTab(pfx); }
  root.querySelectorAll('.presets button').forEach(function(b){ b.onclick=function(){
    var p=b.getAttribute('data-p'); f.preset=p;
    if(p!=='custom'){ var r=presetRange(p); f.from=r[0]; f.to=r[1]; }
    TBL[tab].page=1; rr(); }; });
  [['dfrom','from'],['dto','to']].forEach(function(x){ var el=$(id+'_'+x[0]); el.onchange=function(){
    f.preset='custom'; f[x[1]]=el.value||(x[1]==='from'?'2000-01-01':'2100-12-31');
    if(f.from>f.to){ var t=f.from; f.from=f.to; f.to=t; }   // reversed range (From 6 Nov, To 1 Oct) = swap, never an empty 0 page
    TBL[tab].page=1; rr(); }; });
  msWire(root.querySelector('.filters'),function(k,v){
    if(k==='store'){ setStores(v); renderAll(); return; }   // Store = one filter for all tabs + the URL
    f[k]=v; TBL[tab].page=1; rr(); });
  root.querySelector('[data-reset]').onclick=function(){ F[tab]=newFilter(tab==='created'?'thismonth':'today'); setStores([]); renderAll(); };
}

/* ---------------- KPI cards ---------------- */
function kpi(l,v,s,t){ return '<div class="kpi"'+(t?' data-tip="'+esc(t)+'"':'')+'>'+(KD[l]?'<button type="button" class="kinfo" data-kinfo="'+esc(l)+'" aria-label="Logic and data behind '+esc(l)+'">i</button>':'')+'<div class="l">'+l+'</div><div class="v">'+v+'</div><div class="s">'+(s||'&nbsp;')+'</div></div>'; }
/* Deals + actual store visits for the tab's date filter (shared by the KPIs, the Funnel and the
   breakdown): x.dl = deal counts (null while loading / with a meeting-only filter on), x.vm = store
   visits whose VISIT date is in the range (= "Walk-ins (visit date)" Total of the breakdown). */
function scopeExtra(tab){
  if(!DD && !DD_ERR) loadDD(false);
  var deals=dealsForTab(tab);
  return {deals:deals, dl:deals?dealCount(deals):null, vm:visitMetrics(visitsIn(tab),F[tab].to), nm:nomtgIn(tab)};
}
/* All Store Walk-ins = meeting-led store visits + walk-ins without a Zoho meeting (register). */
function kpiAllWalk(x){
  var v=x.vm, nm=x.nm, tip='Every customer who came to a store in the selected range (one per customer per day): the meeting-led Store Visits PLUS the POS walk-in register records (Lucira_Prod.customer_walkin) of customers who had NO Zoho meeting before the visit. Those are listed in the Store visits list (“Without Zoho meeting”). Funnel, Convert and Invoice Qty stay meeting-led.';
  if(!nm) return kpi('All Store Walk-ins',AW_ERR?'—':'…',AW_ERR?'walk-in register could not be loaded':'loading walk-in register…',tip);
  var deal=nm.filter(function(w){ return !!w.deal_id; }).length;
  return kpi('All Store Walk-ins',fmtInt(v.n+nm.length),fmtInt(v.n)+' meeting-led + <b>'+fmtInt(nm.length)+'</b> without Zoho meeting ('+fmtInt(deal)+' have a Zoho deal)',tip);
}
var TIP_VISITS='Actual store visits whose VISIT date is in the selected range (same number as the Total of “Walk-ins (visit date)” in Analysis by dimension, and of the Store visits list): a Lucira_Prod.customer_walkin record (mobile or email match) or a Zoho meeting marked Show (visit day = its From Date), mapped to the customer’s latest meeting created before the visit. One visit per customer per day. A meeting raised earlier with a visit in this range counts here.';
var TIP_ORDERS='Invoice Qty = number of invoices: unique invoices (marketing_sale document_no) of the customers who VISITED a store in the selected range, dated on or after their visit day and within the range — the same number as “Invoice Qty” in Analysis by dimension and the Store visits list. Each invoice counted once. The meeting can be older than the range (e.g. meeting 26 Sep, visit and purchase yesterday = counted under Yesterday).';
var TIP_VALUE='Walk-in Sale Value = SUM(net_sale) of the invoices counted in Invoice Qty — the same as “Walk-in Sale Value” in Analysis by dimension.';
function kpiOrders(v){ return kpi('Invoice Qty',fmtInt(v.invN),v.buyers?'by '+fmtInt(v.buyers)+' converted customer'+(v.buyers===1?'':'s')+' · '+(v.invN/v.buyers).toFixed(1)+' per customer':(v.visitors?'no invoices yet':'no store visits'),TIP_ORDERS); }
function kpiValue(v){ return kpi('Walk-in Sale Value',fmtMoney(v.amt),fmtMoneyFull(v.amt)+(v.invN?' · avg '+fmtMoney(v.amt/v.invN)+' per invoice':''),TIP_VALUE); }
/* Convert (user rule 2026-11-03) = CUSTOMERS converted: unique customers who visited a store in the
   range and bought (≥1 order on/after the visit day, within the range). The Zoho Conversion_Status
   count of the meetings is only shown in the hover. */
function kpiConvert(m,v){ return kpi('Convert',fmtInt(v.buyers),fmtPct(pct(v.buyers,v.visitors))+' of '+fmtInt(v.visitors)+' store visitors',
  'Customers converted = unique customers who visited a store in the selected range and placed at least one order (invoice) on or after the visit day, within the range. Their invoices = Invoice Qty. % = Converted ÷ unique store visitors. (Zoho meeting Conversion_Status = Converted on the meetings in scope: '+fmtInt(m.conv)+'; Zoho Show: '+fmtInt(m.show)+'.)'); }
var TIP_RESCHED='Meetings with NO store visit where the customer agreed to a new date. Zoho has no “Rescheduled” value, so it is read from the meeting: a NEW Zoho meeting booked later for the same customer (later From Date), OR the agent reached the customer (Connection Status = Connected) and set a Follow Up date after the From Date, or wrote when they will come in the Description (“will visit on 14th”, “tomorrow”, “postpone” …). Not counted when the Description says not interested / bought elsewhere. % = of meetings.';
var TIP_CANCEL='Meetings with NO store visit that the customer called off: Zoho Show Status = No Show AND the agent reached the customer (Connection Status = Connected) AND no new date was agreed (no later meeting, no Follow Up after the From Date) — or the Description says not interested / no plan / already bought / cancelled. A No Show that was never connected is not counted (customer simply did not turn up). Never also counted as Rescheduled. % = of meetings.';
function kpiResched(m){ return kpi('Agreed to Reschedule',fmtInt(m.resched),fmtPct(pct(m.resched,m.meetings))+' of meetings · no visit yet',TIP_RESCHED); }
function kpiCancel(m){ return kpi('Cancelled by Customer',fmtInt(m.cancel),fmtPct(pct(m.cancel,m.meetings))+' of meetings',TIP_CANCEL); }
function kpiConfirmed(m){ return kpi('Confirmed',fmtInt(m.confirmed),fmtPct(pct(m.confirmed,m.connected))+' of connected · '+fmtInt(m.notConf)+' not confirmed · '+fmtInt(m.confNC)+' not connected · '+fmtInt(m.confBlank)+' not marked',TIP_CONF); }
function kpisCreated(m,x){
  var v=x.vm, sc=x.dl?x.dl.sc:null;
  return '<div class="kpis">'+
    kpi('Meetings Created',fmtInt(m.meetings),x.dl?fmtPct(pct(m.meetings,sc))+' of '+fmtInt(sc)+' store city deals':'in selected range','Zoho CRM meetings whose Created_Time (IST) falls in the selected range and filters. % = Meetings ÷ Store City Deals created in the same range.')+
    kpi('Unique Customers',fmtInt(m.uniqueCust),fmtPct(pct(m.uniqueCust,m.meetings))+' of meetings · by mobile','Distinct customers: normalised 10-digit mobile, else Deal ID / Contact ID.')+
    kpi('Meetings Called',fmtInt(m.called),fmtPct(pct(m.called,m.meetings))+' of meetings · '+fmtInt(m.callsN)+' calls','Meetings with ≥1 call (Outbound/Inbound, not Missed) whose Call_Start_Time > Meeting Created_Time. % = Called ÷ Meetings.')+
    kpi('Connected',fmtInt(m.connected),fmtPct(pct(m.connected,m.called))+' of called · '+fmtPct(pct(m.connected,m.meetings))+' of meetings','Meetings with ≥1 call of duration ≥ 30 seconds after meeting creation. % = Connected ÷ Called (dialled).')+
    kpiConfirmed(m)+
    kpi('Store Visits',fmtInt(v.n),fmtPct(pct(v.n,m.meetings))+' of meetings · '+fmtInt(v.reg)+' register + '+fmtInt(v.showOnly)+' Zoho Show',TIP_VISITS)+
    kpiConvert(m,v)+
    kpi('Customers With Walk-in',fmtInt(m.custWalkN),fmtPct(pct(m.custWalkN,m.uniqueCust))+' of customers · after creation','Unique customers OF THESE MEETINGS who walked in after Meeting Created_Time: a customer_walkin record OR the Zoho meeting Show_Status = Show.')+
    kpi('Customers Without Walk-in',fmtInt(m.uniqueCust-m.custWalkN),fmtPct(pct(m.uniqueCust-m.custWalkN,m.uniqueCust))+' of customers')+
    kpiResched(m)+kpiCancel(m)+
    kpiOrders(v)+
    kpi('Visitors Not Converted',fmtInt(v.visitors-v.buyers),fmtPct(pct(v.visitors-v.buyers,v.visitors))+' of store visitors','Customers who visited a store in the range but have no order (invoice) on or after the visit day, within the range. Convert + Visitors Not Converted = unique store visitors.')+
    kpiValue(v)+
  '</div>';
}
function kpisToday(m,x){
  var v=x.vm, sc=x.dl?x.dl.sc:null;
  return '<div class="kpis">'+
    kpi('Expected Meetings',fmtInt(m.meetings),(x.dl?fmtPct(pct(m.meetings,sc))+' of store city deals · ':'')+fmtInt(m.uniqueCust)+' customers','Meetings whose From Date is in the selected range. % = Meetings ÷ Store City Deals created in the same range ('+fmtInt(sc)+').')+
    kpi('Called',fmtInt(m.called),fmtPct(pct(m.called,m.meetings))+' of meetings · after creation','% = Called ÷ Meetings.')+
    kpi('Not Called',fmtInt(m.notCalled),fmtPct(pct(m.notCalled,m.meetings))+' of meetings')+
    kpi('Connected',fmtInt(m.connected),fmtPct(pct(m.connected,m.called))+' of called · '+fmtPct(pct(m.connected,m.meetings))+' of meetings','Meetings with ≥1 call of ≥ 30 s after creation. % = Connected ÷ Called (dialled).')+
    kpiConfirmed(m)+
    kpi('Store Visits',fmtInt(v.n),fmtPct(pct(v.n,m.meetings))+' of meetings · '+fmtInt(v.reg)+' register + '+fmtInt(v.showOnly)+' Zoho Show',TIP_VISITS)+
    kpiConvert(m,v)+
    kpi('Meetings With Walk-in',fmtInt(m.walk),fmtPct(pct(m.walk,m.meetings))+' of meetings · after creation','THESE meetings whose customer walked in after the meeting was created (customer_walkin record or Zoho Show). Store Visits counts every visit dated in the range instead.')+
    kpi('Not Walked-in',fmtInt(m.notWalked),fmtPct(pct(m.notWalked,m.meetings))+' of meetings')+
    kpiResched(m)+kpiCancel(m)+
    kpiOrders(v)+
    kpiValue(v)+
  '</div>';
}

/* ---------------- KPI (i) button: logic + dump (user request 2026-11-16) ----------------
   Every KPI card of Tabs 1-2 has an (i) button. Click = a popup with (1) the logic of the number
   and (2) the dump: the exact rows behind it for the current date range + filters, with CSV.
   k: 'm' = 1 row per meeting (Meetings-table columns), 'c' = 1 row per customer, 'v' = 1 row per
   store visit (Store-visits-list columns), 'i' = 1 row per invoice. t = which rows count. */
var KD={
  'Meetings Created':{k:'m'}, 'Expected Meetings':{k:'m'},
  'Meetings Called':{k:'m',t:function(r){ return !!r.calls_after; }}, 'Called':{k:'m',t:function(r){ return !!r.calls_after; },logic:'Meetings with at least one call (Outbound / Inbound, not Missed) counted for them. Called + Not Called = meetings. % = Called ÷ Meetings.'},
  'Not Called':{k:'m',t:function(r){ return !r.calls_after; },logic:'Meetings with no call counted for them (no Outbound / Inbound Zoho call; Missed calls do not count). Called + Not Called = meetings. % = Not Called ÷ meetings.'},
  'Connected':{k:'m',t:function(r){ return !!r.connected_calls; }},
  'Confirmed':{k:'m',t:function(r){ return r.confirmed; }},
  'Meetings With Walk-in':{k:'m',t:function(r){ return r.walked_in; }},
  'Not Walked-in':{k:'m',t:function(r){ return !r.walked_in; },logic:'Meetings whose customer has NOT walked in after the meeting was created: no customer_walkin (POS walk-in register) record and the Zoho meeting is not marked Show. Meetings With Walk-in + Not Walked-in = meetings.'},
  'Agreed to Reschedule':{k:'m',t:function(r){ return r.resched; }},
  'Cancelled by Customer':{k:'m',t:function(r){ return !r.resched && r.cancelled; }},
  'Unique Customers':{k:'c'},
  'Customers With Walk-in':{k:'c',t:function(c){ return c.walk; }},
  'Customers Without Walk-in':{k:'c',t:function(c){ return !c.walk; },logic:'Unique customers of these meetings with NO walk-in after the meeting was created (no customer_walkin record and no Zoho meeting marked Show). = Unique Customers − Customers With Walk-in.'},
  'Store Visits':{k:'v'},
  'Convert':{k:'v',buy:true},
  'Visitors Not Converted':{k:'v',buy:false},
  'Invoice Qty':{k:'i'}, 'Walk-in Sale Value':{k:'i'}
};
var KD_CUR=null;
function kdBuild(tab,label){
  var d=KD[label], rows=filtered(tab), to=F[tab].to, heads=[], out=[], note='';
  function invOf(v){ return (v.m.cust_sales||v.m.sales).filter(function(x){ var t=(x.ts||'').slice(0,10); return t>=v.day && t<=to; }); }
  if(d.k==='m'){
    var cols=COLS[tab]; heads=cols.map(function(c){ return C[c].l; });
    rows.filter(function(r){ return !d.t || d.t(r); })
      .sort(function(a,b){ return (a.meeting_created_ist||'')<(b.meeting_created_ist||'')?1:-1; })
      .forEach(function(r){ out.push({mid:r.meeting_id,
        h:cols.map(function(c){ var x=C[c]; return x.f?x.f(r):esc(dash(x.v(r))); }),
        c:cols.map(function(c){ var x=C[c]; return x.csv?x.csv(r):x.v(r); })}); });
    note=fmtInt(out.length)+' meetings · 1 row = 1 meeting · click a row for the full customer journey';
  } else if(d.k==='c'){
    var by={}, list=[];
    rows.forEach(function(r){
      var c=by[r.cust_key]; if(!c){ c=by[r.cust_key]={r:r, n:0, walk:false, wd:null, wt:'', docs:{}}; list.push(c); }
      c.n++; if((r.meeting_created_ist||'')>(c.r.meeting_created_ist||'')) c.r=r;
      if(r.walked_in){ c.walk=true;
        var raw=r.first_walkin_ist||r.from_date||'', txt=r.first_walkin_ist?fmtDT(r.first_walkin_ist):(r.from_date?fmtDate(r.from_date)+' (Zoho Show)':'');
        if(raw && (!c.wd || raw<c.wd)){ c.wd=raw; c.wt=txt; } }
      r.sales.forEach(function(s){ c.docs[s.doc]=+s.amount||0; });
    });
    heads=['Customer','Mobile','Email','Meetings','JC','Store','City','Latest Meeting Created','Latest From Date','Walked In After Creation','First Walk-in','Invoices After Creation','Sale Amount'];
    list.filter(function(c){ return !d.t || d.t(c); })
      .sort(function(a,b){ return (a.r.meeting_created_ist||'')<(b.r.meeting_created_ist||'')?1:-1; })
      .forEach(function(c){ var r=c.r, dn=Object.keys(c.docs), amt=dn.reduce(function(a,k){ return a+c.docs[k]; },0);
        var v=[dash(r.customer_name),dash(r.mobile),dash(r.email),c.n,r.k_jc,r.k_store,r.k_city,fmtDT(r.meeting_created_ist),fmtDate(r.from_date),c.walk?'YES':'NO',c.wt||'—',dn.length,dn.length?Math.round(amt):''];
        var h=v.map(function(x){ return esc(x); }); h[9]=yn(c.walk); h[12]=dn.length?fmtMoneyFull(amt):'—';
        out.push({mid:r.meeting_id, h:h, c:v}); });
    note=fmtInt(out.length)+' customers · 1 row = 1 customer (mobile, else Deal / Contact ID) · the row shows the customer’s latest meeting in scope';
  } else if(d.k==='v'){
    var buy={}, items=visitsIn(tab).map(function(v){ var inv=invOf(v); if(inv.length) buy[v.m.cust_key]=1;
      return {v:v, m:v.m, inv:inv, amt:inv.reduce(function(a,x){ return a+(+x.amount||0); },0)}; });
    if(d.buy!=null) items=items.filter(function(x){ return !!buy[x.m.cust_key]===d.buy; });
    items.sort(function(a,b){ return a.v.day!==b.v.day ? (a.v.day<b.v.day?1:-1) : ((a.v.ts||'')<(b.v.ts||'')?1:-1); });
    var cu={}; items.forEach(function(x){ cu[x.m.cust_key]=1; });
    heads=WV_COLS.map(function(c){ return c[0]; }).concat(['Meeting ID','Deal ID']);
    items.forEach(function(x){ out.push({mid:x.m.meeting_id,
      h:WV_COLS.map(function(c){ return c[3]?c[3](x):esc(c[1](x)); }).concat([esc(dash(x.m.meeting_id)),esc(dash(x.m.deal_id))]),
      c:WV_COLS.map(function(c){ return (c[2]||c[1])(x); }).concat([x.m.meeting_id||'',x.m.deal_id||''])}); });
    note=d.buy!=null ? '<b>'+fmtInt(Object.keys(cu).length)+'</b> customers · '+fmtInt(out.length)+' store visits · 1 row = 1 customer visit (the KPI counts unique customers, so a customer with two visit days has two rows)' : '<b>'+fmtInt(out.length)+'</b> store visits by '+fmtInt(Object.keys(cu).length)+' customers · 1 row = 1 customer visit (customer × day)';
  } else {
    var docs={};
    visitsIn(tab).forEach(function(v){ invOf(v).forEach(function(s){ if(!docs[s.doc] || v.day<docs[s.doc].v.day) docs[s.doc]={s:s, v:v}; }); });
    var tot=0;
    heads=['Invoice No','Invoice Date','Amount','Sale Store','Channel','Category | Qty | Amount','SKUs','Customer','Mobile','JC','Meeting Store','Visit Date','Meeting From Date','Meeting ID'];
    Object.keys(docs).map(function(k){ return docs[k]; })
      .sort(function(a,b){ return (a.s.ts||'')<(b.s.ts||'')?1:-1; })
      .forEach(function(o){ var s=o.s, m=o.v.m, a=+s.amount||0; tot+=a;
        var v=[s.doc,fmtDT(s.ts),Math.round(a),storeName(s.store),dash(s.channel),s.cats?String(s.cats).split(';').join('  ·  '):'—',dash(s.skus),dash(m.customer_name),dash(m.mobile),m.k_jc,m.k_store,fmtDate(o.v.day),fmtDate(m.from_date),m.meeting_id||''];
        var h=v.map(function(x){ return esc(x); }); h[2]=fmtMoneyFull(a);
        out.push({mid:m.meeting_id, h:h, c:v}); });
    note='<b>'+fmtInt(out.length)+'</b> invoices · total <b>'+fmtMoneyFull(tot)+'</b> · 1 row = 1 invoice (each invoice once, cancelled orders left out)';
  }
  return {heads:heads, rows:out, note:note};
}
function openKpi(tab,label,tipHtml,valText){
  var d=KD[label]; if(!d) return;
  var el=$('kd'); if(!el){
    var bg=document.createElement('div'); bg.id='kdBg'; document.body.appendChild(bg);
    el=document.createElement('div'); el.id='kd'; el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true'); document.body.appendChild(el);
    bg.onclick=closeKpi;
    el.addEventListener('click',function(e){
      if(e.target.closest('[data-kdclose]')){ closeKpi(); return; }
      if(e.target.closest('[data-kdcsv]')){ if(KD_CUR) download(KD_CUR.file, csvOf([KD_CUR.dump.heads].concat(KD_CUR.dump.rows.map(function(r){ return r.c; })))); return; }
      var tr=e.target.closest('tr[data-mid]'); if(tr) openJourney(tr.getAttribute('data-mid'));
    });
  }
  hideTip();
  var f=F[tab], dump=kdBuild(tab,label), rng=f.preset==='all'?'all dates':fmtDate(f.from)+' – '+fmtDate(f.to);
  KD_CUR={dump:dump, file:'meeting-journey-'+tab+'-'+label.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'-'+f.from+'_to_'+f.to+'.csv'};
  el.innerHTML='<div class="kh"><div style="flex:1"><h3>'+esc(label)+' <span class="kv">'+esc(valText||'')+'</span></h3>'+
      '<div class="small muted">'+(tab==='created'?'Meeting Created Date':'From Date')+': '+rng+' (IST) · current filters applied</div></div>'+
      '<button class="btn" data-kdclose="1" aria-label="Close">✕ Close</button></div>'+
    '<div class="kb"><div class="klogic"><div class="kt">Logic</div>'+((d.logic && (!tipHtml || tipHtml.length<40)) ? d.logic : (tipHtml||''))+'</div>'+
      '<div class="tbltools"><div class="kt" style="margin:0">Data behind this number</div><span class="muted small">'+dump.note+'</span><span style="flex:1"></span><button class="btn" data-kdcsv="1">⬇ CSV ('+fmtInt(dump.rows.length)+')</button></div>'+
      '<div class="tblwrap"><table class="t"><thead><tr>'+dump.heads.map(function(h){ return '<th>'+esc(h)+'</th>'; }).join('')+'</tr></thead><tbody>'+
      (dump.rows.length?dump.rows.map(function(r){ return '<tr'+(r.mid?' class="click" data-mid="'+esc(r.mid)+'"':'')+'>'+r.h.map(function(x){ return '<td>'+x+'</td>'; }).join('')+'</tr>'; }).join('')
        :'<tr><td colspan="'+dump.heads.length+'" class="muted">No rows for the selected dates and filters.</td></tr>')+
      '</tbody></table></div></div>';
  el.classList.add('open'); $('kdBg').style.display='block';
}
function closeKpi(){ var el=$('kd'); if(el){ el.classList.remove('open'); $('kdBg').style.display='none'; } KD_CUR=null; }
document.addEventListener('click',function(e){
  var b=e.target.closest && e.target.closest('[data-kinfo]'); if(!b) return;
  var sec=b.closest('section'), card=b.closest('.kpi'), tab=sec&&sec.id==='tab-created'?'created':(sec&&sec.id==='tab-from'?'from':null);
  if(!tab || !card) return;
  e.stopPropagation();
  openKpi(tab, b.getAttribute('data-kinfo'), card.getAttribute('data-tip'), card.querySelector('.v').textContent);
});
document.addEventListener('keydown',function(e){ if(e.key==='Escape' && $('kd') && $('kd').classList.contains('open') && !$('drawer').classList.contains('open')) closeKpi(); });

/* ---------------- funnel + status + trend ---------------- */
function hbars(items,denLabel){   // item.base (optional) = that bar's own "% of …" label
  var max=Math.max.apply(null,items.map(function(i){return i.v;}).concat([1]));
  return items.map(function(i){
    var w=100*i.v/max, dl=i.base||denLabel;
    return '<div class="hbar" data-tip="'+esc('<b>'+i.l+'</b><br>'+fmtInt(i.v)+(i.p!=null?' · '+fmtPct(i.p)+' '+dl:'')+(i.p2!=null?'<br>'+fmtPct(i.p2)+' of previous stage':'')+(i.note?'<br>'+i.note:''))+'">'+
      '<div class="lab">'+esc(i.l)+(i.base?'<div class="small muted">'+esc(i.base)+'</div>':'')+'</div><div class="track"><div class="fill" style="width:'+w.toFixed(2)+'%"></div></div>'+
      '<div class="val"><b>'+fmtInt(i.v)+'</b>'+(i.p!=null?' <span class="muted">'+fmtPct(i.p)+'</span>':'')+'</div></div>';
  }).join('');
}
/* Funnel (user rule 2026-11-03): Deals Created (count) → Store City Deals = 100% → Meetings ÷ Store
   City Deals → Called ÷ Meetings → Connected ÷ Called (dialled) → Walk-in (actual store visits in the
   range) ÷ Meetings → Sale = Invoice Qty (invoices of those visitors) ÷ Walk-ins. Deals, visits and meetings are counted by their own
   dates in the same range, so a step can in rare cases exceed 100%. */
function funnelCard(m,title,tab,x){
  var dl=x.dl, v=x.vm, st=[], dnote='';
  if(dl){
    st.push({l:'Deals Created',v:dl.total,note:'Zoho deals created in this date range (Deal Created Date, IST) — same as Total Deals in the table below.'});
    st.push({l:'Store City Deals',v:dl.sc,p:100,base:'base = 100%',note:fmtPct(pct(dl.sc,dl.total))+' of deals created. Deal city in a city with a Lucira store (Mumbai region, Pune, Delhi / Gurgaon, Noida / Ghaziabad, Bangalore) — same as Store City Deals in the table below.'});
  } else {
    dnote='<div class="small muted" style="margin-top:6px">Deals Created / Store City Deals: '+(x.deals===false?'hidden while a Meeting Type / Call / Confirmation / Walk-in / Sale filter is on (those filters exist only on meetings).':DD_ERR?'could not be loaded — '+esc(DD_ERR):'loading…')+'</div>';
  }
  st.push({l:title,v:m.meetings,p:dl?pct(m.meetings,dl.sc):100,base:dl?'% of store city deals':'base = 100%'});
  st.push({l:'Called',v:m.called,p:pct(m.called,m.meetings),base:'% of meetings',note:'Meetings with ≥1 call (not Missed) after creation.'});
  st.push({l:'Connected',v:m.connected,p:pct(m.connected,m.called),base:'% of called',note:'Meetings with a call of ≥ 30 s after creation ÷ meetings called (dialled).'});
  st.push({l:'Confirmed',v:m.confirmed,p:pct(m.confirmed,m.connected),base:'% of connected',note:'Zoho meeting Confirmation = Confirmed ÷ Connected meetings.<br>'+confSplit(m)});
  st.push({l:'Walk-in',v:v.n,p:pct(v.n,m.meetings),base:'% of meetings',note:'Actual store visits dated in the range (register or Zoho Show) — same as Store Visits above and Walk-ins (visit date) below.'});
  st.push({l:'Sale (Invoice Qty)',v:v.invN,p:pct(v.invN,v.n),base:'% of walk-ins',note:'Invoice Qty: invoices of those visitors on or after the visit day — same as Invoice Qty above and in the table below. '+fmtInt(v.buyers)+' of '+fmtInt(v.visitors)+' visitors bought · '+fmtMoneyFull(v.amt)+'.'});
  return '<div class="card"><h3>Funnel</h3><div class="desc"><b>Deals Created</b> and <b>Store City Deals</b> = Zoho deals created in the selected date range (select <b>Yesterday</b> for yesterday’s deals). Store City Deals = 100%; '+esc(title)+' ÷ Store City Deals; Called ÷ '+esc(title)+'; Connected ÷ Called; Confirmed (Zoho Confirmation = Confirmed) ÷ Connected; Walk-in (actual store visits in the range) ÷ '+esc(title)+'; Sale = Invoice Qty (invoices of those visitors) ÷ Walk-in. Deals, meetings and visits are each counted by their own date in the range, so this is not a strict subset funnel.</div>'+hbars(st,'')+dnote+'</div>';
}
var STATUS_ORDER=['No Activity','Called','Connected','Walk-in - No Sale','Walk-in - Sale','Sale (No Walk-in)','Not Trackable (no customer ID)'];
function statusCard(rows){
  var c={}; rows.forEach(function(r){ c[r.journey_status]=(c[r.journey_status]||0)+1; });
  var items=STATUS_ORDER.filter(function(s){return c[s];}).map(function(s){ return {l:s, v:c[s], p:pct(c[s],rows.length)}; });
  return '<div class="card"><h3>Journey Status</h3><div class="desc">One status per meeting (highest stage reached after creation). % of meetings in scope.</div>'+(items.length?hbars(items,'of meetings'):'<div class="muted">No meetings in scope.</div>')+'</div>';
}
var TREND_SERIES=[['n','Meetings','#2a78d6'],['called','Called','#8a8983'],['conn','Connected','#e08a1e'],['conf','Confirmed','#c2408b'],['walk','Walk-in','#7b4fc9'],['sale','Sale','#1d9a5b']];
var TREND_OFF={};   // series switched off by the user (legend click)
function trendCard(rows,field,title){
  // TREND LINES (user request 2026-11-13): one line per stage, by day (or ISO week if range > 62 days)
  var days=rows.map(function(r){return r[field];}).filter(Boolean).sort();
  if(!days.length) return '<div class="card trend"><h3>'+esc(title)+'</h3><div class="muted">No meetings in scope.</div></div>';
  var f=days[0], l=days[days.length-1], span=(new Date(l)-new Date(f))/864e5+1, weekly=span>62;
  var key=function(d){ return weekly?weekStart(d):d; };
  var b={}; rows.forEach(function(r){ var d=r[field]; if(!d) return; var k=key(d); var o=b[k]=b[k]||{n:0,called:0,conn:0,conf:0,walk:0,sale:0,docs:{}};
    o.n++; if(r.calls_after) o.called++; if(r.connected_calls) o.conn++; if(r.confirmed) o.conf++; if(r.walked_in) o.walk++; if(r.sales_after) o.sale++;
    r.sales.forEach(function(x){ o.docs[x.doc]=+x.amount||0; }); });
  var keys=[], k=key(f); while(k<=l){ keys.push(k); k=addDays(k,weekly?7:1); }
  var on=TREND_SERIES.filter(function(s){ return !TREND_OFF[s[0]]; });
  var W=900,H=240,pl=34,pr=12,pt=12,pb=26, iw=W-pl-pr, ih=H-pt-pb;
  var max=1; keys.forEach(function(k){ var o=b[k]; if(o) on.forEach(function(s){ if(o[s[0]]>max) max=o[s[0]]; }); });
  var step=niceStep(max), top=Math.ceil(max/step)*step, bw=iw/keys.length;
  var X=function(i){ return pl+bw*i+bw/2; }, Y=function(v){ return pt+ih-ih*v/top; };
  var svg='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="'+esc(title)+'"><g class="grid">';
  for(var v=0; v<=top; v+=step){ svg+='<line x1="'+pl+'" x2="'+(W-pr)+'" y1="'+Y(v)+'" y2="'+Y(v)+'"/>'; }
  svg+='</g><g class="axis">';
  for(v=0; v<=top; v+=step){ svg+='<text x="'+(pl-6)+'" y="'+(Y(v)+3)+'" text-anchor="end">'+v+'</text>'; }
  var every=Math.ceil(keys.length/10);
  keys.forEach(function(k,i){ if(i%every===0) svg+='<text x="'+X(i)+'" y="'+(H-8)+'" text-anchor="middle">'+fmtDate(k).replace(/ \d{4}$/,'')+'</text>'; });
  svg+='</g>';
  on.forEach(function(s){
    var pts=keys.map(function(k,i){ return X(i).toFixed(1)+','+Y(b[k]?b[k][s[0]]:0).toFixed(1); });
    svg+='<polyline class="tl" points="'+pts.join(' ')+'" style="stroke:'+s[2]+(s[0]==='n'?';stroke-width:2.6':'')+'"/>';
  });
  keys.forEach(function(k,i){ var o=b[k]||{n:0,called:0,conn:0,conf:0,walk:0,sale:0,docs:{}};
    var dn=Object.keys(o.docs), amt=dn.reduce(function(a,d){ return a+o.docs[d]; },0);
    var t='<b>'+(weekly?'Week of ':'')+fmtDate(k)+'</b>'+TREND_SERIES.map(function(s){ return '<br><span style="color:'+s[2]+'">●</span> '+s[1]+': <b>'+o[s[0]]+'</b>'+(s[0]!=='n'&&o.n?' <span class="muted">'+fmtPct(pct(o[s[0]],o.n))+'</span>':''); }).join('')+
      '<br>Invoices: <b>'+dn.length+'</b> · '+fmtMoneyFull(amt);
    svg+='<g class="b" data-tip="'+esc(t)+'"><rect class="hit" x="'+(pl+bw*i)+'" y="'+pt+'" width="'+bw+'" height="'+ih+'"/><line class="guide" x1="'+X(i)+'" x2="'+X(i)+'" y1="'+pt+'" y2="'+(pt+ih)+'"/></g>'; });
  svg+='</svg>';
  var legend='<div class="tlegend">'+TREND_SERIES.map(function(s){ return '<button type="button" class="tleg'+(TREND_OFF[s[0]]?' off':'')+'" data-tser="'+s[0]+'"><i style="background:'+s[2]+'"></i>'+s[1]+'</button>'; }).join('')+'</div>';
  return '<div class="card trend"><h3>'+esc(title)+' — trend lines</h3><div class="desc">Per '+(weekly?'week (Mon start)':'day')+': Meetings, and how many of those meetings were Called / Connected / Confirmed / Walked in / got a Sale. Click a name to hide or show its line; hover a day for the numbers, invoices and sale value.</div>'+legend+svg+'</div>';
}
function niceStep(max){ var raw=max/4, p=Math.pow(10,Math.floor(Math.log10(raw||1))), n=raw/p; return Math.max(1,(n<=1?1:n<=2?2:n<=5?5:10)*p); }

/* Every pincode whose polygon centre is within 7 km of each store pin: [pincode, km] (user rule
   2026-11-03: 7 km replaces 5 km). Area-weighted centre of the data.gov.in pincode polygon, Haversine
   -- the same method and km as near_pin (<= 6 km) in sql/meeting_journey_view.sql, extended to 7 km.
   A pincode on ANY store's list = Within 7 km; a real pincode not on any list = 7 km & above. */
var STORE_PINS={BO1:[['400092',1.66],['400101',2.72],['400103',3.31],['400068',3.56],['400067',4.07],['400097',4.71],['400066',4.79],['400064',4.92],['400091',5.97],['400063',6.56],['401107',6.86],['400095',6.95]],
 CS1:[['400071',0.50],['400089',1.10],['400024',1.78],['400077',2.12],['400070',2.75],['400075',3.09],['400094',3.27],['400022',3.38],['400086',3.64],['400074',3.91],['400084',4.33],['400043',4.34],['400029',4.36],['400098',4.38],['400088',4.66],['400017',5.02],['400051',5.03],['400085',5.07],['400037',5.14],['400079',5.54],['400019',5.88],['400072',5.88],['400099',5.89],['400055',6.01],['400016',6.53],['400059',6.64],['400031',6.71]],
 PN1:[['411005',1.06],['411011',1.25],['411004',1.78],['411002',2.00],['411030',2.12],['411016',2.58],['411042',2.59],['411009',3.85],['411001',3.94],['411020',4.07],['411007',4.11],['411003',4.13],['411052',4.65],['411008',4.72],['411038',4.96],['411037',5.05],['411040',5.47],['411006',5.54],['411043',5.86],['411051',5.90],['411067',6.02],['411022',6.97]],
 N18:[['201301',0.91],['201303',2.85],['201313',3.22],['110025',3.71],['201307',3.88],['110096',4.67],['110091',4.70],['110076',4.82],['110020',5.96],['110014',6.33],['110065',6.53],['201020',6.66],['110013',6.80]],
 PV1:[['110087',0.90],['110063',1.10],['110056',2.46],['110083',2.63],['110018',2.94],['110027',3.05],['110026',3.64],['110034',4.84],['110086',5.04],['110064',5.06],['110058',5.09],['110015',5.11],['110085',5.54],['110028',5.97],['110035',6.28],['110059',6.53],['110046',6.95]],
 LPN:[['110024',0.41],['110065',1.33],['110014',2.03],['110049',2.56],['110013',2.77],['110048',2.96],['110003',3.01],['110019',4.05],['110029',4.27],['110025',4.28],['110023',4.39],['110069',4.66],['110020',4.90],['110017',4.92],['110011',5.26],['110016',5.34],['110062',5.57],['110066',5.92],['110091',6.22],['110001',6.51],['110022',6.69],['110021',6.72]],
 MAL:[['560055',0.76],['560003',0.98],['560012',1.38],['560080',1.50],['560021',1.61],['560020',2.07],['560010',2.31],['560086',2.77],['560006',3.17],['560054',3.31],['560022',3.36],['560009',3.42],['560096',3.58],['560094',3.65],['560023',3.77],['560032',4.11],['560001',4.12],['560053',4.20],['560079',4.24],['560051',4.38],['560002',5.04],['560018',5.31],['560024',5.52],['560040',5.56],['560005',5.61],['560104',5.81],['560013',5.84],['560042',6.14],['560027',6.21],['560045',6.26],['560058',6.28],['560025',6.33],['560092',6.43],['560084',6.62],['560004',6.81]]};
var NEAR7={};   // pincode -> nearest store within 7 km {store, km}
Object.keys(STORE_PINS).forEach(function(c){ STORE_PINS[c].forEach(function(p){ var o=NEAR7[p[0]]; if(!o||p[1]<o.km) NEAR7[p[0]]={store:c, km:p[1]}; }); });
var PINCHK_OPEN=false;
function pinCheckBlock(){
  function chips(list){ return list.length?list.map(function(p){ return '<span class="pchip in" title="'+p[0]+' · '+p[1].toFixed(2)+' km">'+p[0]+' <span class="muted">'+p[1].toFixed(2)+' km</span></span>'; }).join(''):'<span class="muted">—</span>'; }
  var rows=Object.keys(STORE_PINS).map(function(c){ var l=STORE_PINS[c];
    return '<tr><td><b>'+esc(storeName(c))+'</b>'+(c==='MAL'?' <span class="muted small">(provisional pin)</span>':'')+'<div class="muted small">'+l.length+' pincodes</div></td><td>'+chips(l.filter(function(p){return p[1]<=5;}))+'</td><td>'+chips(l.filter(function(p){return p[1]>5;}))+'</td></tr>'; }).join('');
  return '<details class="pinchk"'+(PINCHK_OPEN?' open':'')+'><summary>Store pincode check — which customer pincodes count as <b>Within 7 km</b> ('+Object.keys(NEAR7).length+' pincodes)</summary>'+
    '<div class="desc">km = straight line from the store pin to the pincode-area centre (data.gov.in pincode polygons). Every pincode within 7 km of each store is listed; all of them count as <b>Within 7 km</b> (a pincode near two stores counts once, for the nearer store). A real pincode not on this list = <b>7 km &amp; above</b>.</div>'+
    '<div class="tblwrap"><table class="t"><thead><tr><th>Store</th><th>✓ 0–5 km</th><th>✓ 5–7 km</th></tr></thead><tbody>'+rows+'</tbody></table></div></details>';
}

/* ---------------- store visits list ----------------
   The raw list behind "Walk-ins (visit date)": 1 line = 1 visit (customer x IST day), with the
   meeting it is mapped to and that visit's invoices (on/after the visit day, within the date filter).
   Its own card above the Meetings table, listing every visit in the date filter; the "Walk-in Dump"
   column of the breakdown narrows it to one row: WV[tab] = {dim, key}, null = every visit. */
var WV={created:null, from:null};
var WVM={created:'all', from:'all'};   // Store visits list: 'all' | 'meet' (meeting-led) | 'nm' (without Zoho meeting)
function visitEvidence(v){ return v.reg&&v.show?'Walk-in register + Zoho Show':(v.reg?'Walk-in register':'Zoho Show'); }
function dayGap(a,b){ return (a&&b)?Math.round((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/864e5):null; }
function visitDump(tab){
  var s=WV[tab]&&WV[tab].dim===BD[tab]?WV[tab]:null;
  var d=DIMS.filter(function(x){return x[0]===BD[tab];})[0], to=F[tab].to;
  var meet=visitsIn(tab).filter(function(v){ return !s || v.m[d[2]]===s.key; }).map(function(v){
    var inv=(v.m.cust_sales||v.m.sales).filter(function(x){ var t=(x.ts||'').slice(0,10); return t>=v.day && t<=to; });
    return {v:v, m:v.m, inv:inv, amt:inv.reduce(function(a,x){ return a+(+x.amount||0); },0)};
  });
  // walk-ins without a Zoho meeting (register); not split by the breakdown's dimensions, so a
  // breakdown "View ▸" (s) keeps the list meeting-led, exactly like the breakdown's own numbers
  var nmAll=s?[]:nomtgIn(tab), nm=(nmAll||[]).map(function(w){
    var inv=w.sales.filter(function(x){ var t=(x.ts||'').slice(0,10); return t>=w.day && t<=to; });
    return {v:{day:w.day, ts:w.ts, store:w.store_code, reg:true, show:false}, m:w.m, nm:w, inv:inv, amt:inv.reduce(function(a,x){ return a+(+x.amount||0); },0)};
  });
  var mode=s?'meet':WVM[tab];
  var rs=(mode==='nm'?[]:meet).concat(mode==='meet'?[]:nm)
    .sort(function(a,b){ return a.v.day!==b.v.day ? (a.v.day<b.v.day?1:-1) : ((a.v.ts||'')<(b.v.ts||'')?1:-1); });
  return {title:s?d[1]+': '+s.key:'', key:s?s.key:'', rows:rs, mode:mode, nMeet:meet.length, nNm:nm.length, nmReady:!!nmAll};
}
var WV_COLS=[
  ['Visit Date',function(x){ return fmtDate(x.v.day); },function(x){ return x.v.day; }],
  ['Visit Time',function(x){ return x.v.ts?fmtTime(x.v.ts):'—'; }],
  ['Evidence',function(x){ return visitEvidence(x.v); }],
  ['Visit Type',function(x){ return x.nm ? 'Without Zoho meeting · '+x.nm.zoho : 'Meeting-led'; }],
  // Zoho meeting fields of the meeting the visit is mapped to, as the team marked them
  ['Zoho Confirmation',function(x){ return x.nm ? '—' : confLabel(x.m); }],
  ['Zoho Show Status',function(x){ return x.nm ? '—' : (x.m.show_status||'Not marked'); }],
  ['Zoho Conversion Status',function(x){ return x.nm ? '—' : (x.m.conversion_status||'Not marked'); }],
  ['Walk-in Store',function(x){ return x.v.store?storeLabelOf(x.v.store):'—'; }],
  // what the POS logged the walk-in for (Store Walkin / Sales / Receipt / Order / Enquiry ...)
  ['Register Source',function(x){ return x.nm ? (x.nm.sources||'—') : (x.v.reg ? (awSourceOf(x.m.mobile,x.m.email,x.v.day)||'—') : '—'); }],
  // same pincode + 7 km rule + format as the Meetings table (pincode of the mapped meeting's customer)
  ['Customer Pincode',function(x){ return x.m.pin_used||'—'; },function(x){ return x.m.pin_used?x.m.pin_used+' ('+x.m.pin_used_src+')':''; },
    function(x){ var m=x.m; return m.pin_used?'<span title="'+esc(m.pin_used_src||'')+'">'+esc(m.pin_used)+'</span>'+(m.pin_used_tag?' <span class="muted">'+esc(m.pin_used_tag)+'</span>':''):'—'; }],
  ['Within 7 km of Store',function(x){ var m=x.m; return m.pin7==='in'?'≤7 km '+m.near7.km.toFixed(1)+' km · '+m.near7.store:(m.pin7==='out'?'7 km+':'—'); },
    function(x){ var m=x.m; return (m.pin7==='in'?'Within 7 km ('+m.near7.km.toFixed(1)+' km to '+storeName(m.near7.store)+')':m.pin7==='out'?'7 km & above':'Pincode not available')+(m.pin_used?' · pincode '+m.pin_used:''); },
    function(x){ var m=x.m, t=m.pin_used?' title="Pincode '+esc(m.pin_used)+'"':'';
      return m.pin7==='in'?'<span class="yes"'+t+'>≤7 km</span> <span class="muted">'+m.near7.km.toFixed(1)+' km · '+esc(m.near7.store)+'</span>':(m.pin7==='out'?'<span class="no"'+t+'>7 km+</span>':'—'); }],
  ['Customer',function(x){ return dash(x.m.customer_name); }],
  ['Mobile',function(x){ return dash(x.m.mobile); }],
  ['Email',function(x){ return dash(x.m.email); }],
  ['JC',function(x){ return x.nm ? (x.nm.deal_owner ? x.nm.deal_owner+' (deal owner)' : '—') : x.m.k_jc; }],
  ['Meeting Store',function(x){ return x.nm ? '—' : x.m.k_store; }],
  ['Meeting Created',function(x){ return fmtDT(x.m.meeting_created_ist); },function(x){ return x.m.meeting_created_ist; }],
  ['Meeting From Date',function(x){ return fmtDate(x.m.from_date); },function(x){ return x.m.from_date; }],
  ['Meeting Type',function(x){ return x.nm ? '—' : x.m.k_mtype; }],
  ['Days Meeting → Visit',function(x){ var g=dayGap(x.m.meeting_created_date,x.v.day); return g==null?'—':g; }],
  ['Invoices',function(x){ return x.inv.length; }],
  ['Invoice Value',function(x){ return x.inv.length?fmtMoneyFull(x.amt):'—'; },function(x){ return x.inv.length?Math.round(x.amt):''; }],
  ['Invoice Nos',function(x){ return x.inv.map(function(i){ return i.doc; }).join(', ')||'—'; }]
];
function visitDumpBlock(tab){
  var dmp=visitDump(tab), f=F[tab], rng=f.preset==='all'?'all dates':fmtDate(f.from)+' – '+fmtDate(f.to);
  var mb=dmp.title?'':'<div class="tabsm" style="margin:2px 0 8px">'+[['all','All store walk-ins ('+(dmp.nmReady?fmtInt(dmp.nMeet+dmp.nNm):'…')+')'],['meet','Meeting-led ('+fmtInt(dmp.nMeet)+')'],['nm','Without Zoho meeting ('+(dmp.nmReady?fmtInt(dmp.nNm):(AW_ERR?'—':'…'))+')']]
    .map(function(b){ return '<button data-wvm="'+b[0]+'" class="'+(dmp.mode===b[0]?'on':'')+'">'+b[1]+'</button>'; }).join('')+'</div>';
  return '<div class="card" id="'+tab+'_wvd"><h3>Store visits (1 row = 1 customer visit)</h3>'+mb+
    '<div class="tbltools"><span class="muted small"><b>'+fmtInt(dmp.rows.length)+'</b> visits · visit date '+rng+(dmp.title?' · <b>'+esc(dmp.title)+'</b>':(dmp.mode==='meet'?' · same count as the Total of “Walk-ins (visit date)”':(dmp.mode==='nm'?' · POS walk-in register, customer had no Zoho meeting before the visit':' · meeting-led + without Zoho meeting = the “All Store Walk-ins” KPI')))+'</span>'+
    (AW_ERR&&!dmp.title?'<span class="small" style="color:#b42318">Walk-in register could not be loaded: '+esc(AW_ERR)+'</span>':'')+
    (dmp.title?'<button class="btn" data-wvclose="1">✕ Show all visits</button>':'')+'<span style="flex:1"></span><button class="btn" data-wvcsv="1">⬇ CSV</button></div>'+
    '<div class="desc">Only customers who actually came to a store. One line per store visit (customer × day). <b>Meeting-led</b> = counted in “Walk-ins (visit date)” (the customer had a Zoho meeting before the visit, or the meeting is marked Show). <b>Without Zoho meeting</b> = every other POS walk-in register record (Lucira_Prod.customer_walkin) — the customer had no Zoho meeting before the visit; Visit Type says whether a Zoho deal exists; JC = that deal’s owner; pincode = the one typed in the walk-in register; these rows are not in the funnel / Convert / Invoice Qty. Register Source = what the POS logged the walk-in for (Store Walkin, Sales, Receipt, Order …). Evidence = walk-in register record and/or Zoho meeting marked Show; Zoho Show / Conversion Status = what the team marked on the mapped meeting (a register walk-in can still read No Show there); JC / Meeting Store come from the meeting the visit is mapped to (the customer’s latest meeting created before the visit). Customer Pincode / Within 7 km of Store = same rule as the Meetings table: pincode from the Zoho Contact address first, else the Zoho Deal zip (the tag says which); Within 7 km = within 7 km of any Lucira store (km + nearest store shown); 7 km+ = pincode farther away; — = no pincode. Invoices = that customer’s invoices on or after the visit day, within the date filter (the dimension table counts each invoice once, so a customer with two visit days can show the same invoice twice here). Use “View ▸” in the Walk-in Dump column above to see one row’s visits. Click a line for the full journey.</div>'+
    '<div class="tblwrap" style="max-height:480px"><table class="t"><thead><tr>'+WV_COLS.map(function(c){ return '<th>'+c[0]+'</th>'; }).join('')+'</tr></thead><tbody>'+
    (dmp.rows.length?dmp.rows.map(function(x){ return (x.nm?'<tr title="Walk-in without a Zoho meeting (POS walk-in register)">':'<tr data-mid="'+esc(x.m.meeting_id)+'" style="cursor:pointer">')+WV_COLS.map(function(c){ return '<td>'+(c[3]?c[3](x):esc(c[1](x)))+'</td>'; }).join('')+'</tr>'; }).join('')
      :'<tr><td colspan="'+WV_COLS.length+'" class="muted">No store visits for the selected dates.</td></tr>')+
    '</tbody></table></div></div>';
}
function exportVisitDump(tab){
  var dmp=visitDump(tab);
  var h=WV_COLS.map(function(c){ return c[0]; }).concat(['Meeting ID','Deal ID','Deal Name']);
  var out=[h].concat(dmp.rows.map(function(x){ return WV_COLS.map(function(c){ return (c[2]||c[1])(x); }).concat([x.m.meeting_id||'',x.m.deal_id||'',x.m.deal_name||'']); }));
  download('store-visits-'+tab+'-'+(dmp.key?dmp.key.replace(/[^\w-]+/g,'_'):({all:'all-walkins',meet:'meeting-led',nm:'without-meeting'})[dmp.mode])+'-'+F[tab].from+'_to_'+F[tab].to+'.csv', csvOf(out));
}

/* ---------------- breakdown tables ---------------- */
var DIMS=[['jc','JC','k_jc'],['city','City','k_city'],['stage','Deal Stage','k_stage'],['trigger','Deal Trigger','k_trigger'],['prob','Probability','k_prob'],['store','Store','k_store'],['mtype','Meeting Type','k_mtype'],['lsrc','Lead Source','k_lsrc'],['usrc','UTM Source','k_usrc']];
/* Total Deals / Store City Deals = Zoho deals CREATED in the date filter (the Deals Funnel's deals,
   slim copy from /api/deal-dims), grouped by the deal's own value of the dimension. Meeting Type has
   no deal equivalent; the Meeting Type / Call / Confirmation / Walk-in / Sale filters are meeting-only. */
var DD=null, DD_LOADING=false, DD_ERR=null, ddLoadedAt=0;
function loadDD(force){
  if(DD_LOADING) return; DD_LOADING=true;
  fetch('api/deal-dims'+(force?'?refresh=1':''),FETCH_OPTS)
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
    .then(function(x){
      if(!x.ok || !x.j.ok){ DD_ERR=(x.j&&x.j.error)||'Unknown error'; return; }
      var c={}; x.j.cols.forEach(function(k,i){ c[k]=i; });
      // same bucket keys as the meeting rows (prep)
      // City = the view's store-city group ('Other' = city with no store, null = no city at all), so
      // the City rows line up with Store City Deals; pin7 = the deal customer's pincode vs the 7 km list.
      DD=x.j.rows.map(function(a){ var cg=a[c.city_group]; return {created_date:a[c.created_date], k_jc:a[c.agent]||'Unassigned',
        k_city:cg==='Other'?OTHER_CITY:(cg||'Not Captured'), k_stage:a[c.deal_stage]||'Not Set', k_trigger:a[c.deal_trigger]||'Not Set',
        k_prob:a[c.probability]!=null?a[c.probability]+'%':'Not Set', k_lsrc:a[c.lead_source]||'Not Set', k_usrc:a[c.utm_source]||'Not Set',
        is_store_city:bool(a[c.is_store_city]), store_code:a[c.store_code], k_store:a[c.store]||'Non-Store City', pin7:pinBand(a[c.pin])}; });
      DD_ERR=null; ddLoadedAt=Date.now();
    })
    .catch(function(e){ DD_ERR=String(e); })
    .then(function(){ DD_LOADING=false; if(DATA && ROWS.length){ renderTab('created'); renderTab('from'); } });
}
function dealStoreKey(x){ return (x.store_code && STORE_LABEL[x.store_code]) || x.k_store; }
function dealKey(x,dim){ return dim==='store' ? dealStoreKey(x) : x['k_'+dim]; }
function dealsForTab(tab){   // null = not loaded (or failed), false = a meeting-only filter is on
  if(!DD) return null;
  var f=F[tab]; if(f.mtype.length||f.call.length||f.conf.length||f.walk.length||f.sale.length) return false;
  return DD.filter(function(x){ var c=x.created_date; return c && c>=f.from && c<=f.to &&
    msHas(f.jc,x.k_jc) && msHas(f.city,x.k_city) && msHas(f.store,dealStoreKey(x)) &&
    msHas(f.stage,x.k_stage) && msHas(f.trigger,x.k_trigger) && msHas(f.prob,x.k_prob); });
}
/* Deals Within 7 km / 7 km & Above / No Pincode split ONLY the Store City Deals (user rule 2026-11-04),
   so near + far + noPin = sc. Deals in cities without a store are not split. */
function dealCount(list){ var o={total:0, sc:0, near:0, far:0, noPin:0}; (list||[]).forEach(function(x){ o.total++; if(!x.is_store_city) return; o.sc++;
  if(x.pin7==='in') o.near++; else if(x.pin7==='out') o.far++; else o.noPin++; }); return o; }
function breakdownCard(tab,rows){
  var cur=BD[tab], d=DIMS.filter(function(x){return x[0]===cur;})[0], mlabel=tab==='created'?'Meetings':'Expected Meetings';
  // Meeting columns come from meetings in the date filter; Walk-in columns from VISITS whose visit
  // day is in the date filter (the meeting may be older), grouped by the mapped meeting's value.
  var to=F[tab].to, g={}, gv={}, gd={}, vis=visitsIn(tab);
  if(!DD && !DD_ERR) loadDD(false);
  var deals=dealsForTab(tab), dealDim=!!deals && cur!=='mtype';
  rows.forEach(function(r){ (g[r[d[2]]]=g[r[d[2]]]||[]).push(r); });
  vis.forEach(function(v){ (gv[v.m[d[2]]]=gv[v.m[d[2]]]||[]).push(v); });
  if(dealDim) deals.forEach(function(x){ var k=dealKey(x,cur); (gd[k]=gd[k]||[]).push(x); });
  var keys=Object.keys(g); Object.keys(gv).concat(Object.keys(gd)).forEach(function(k){ if(!g[k] && keys.indexOf(k)<0) keys.push(k); });
  var list=keys.map(function(k){ return {k:k, m:metrics(g[k]||[]), v:visitMetrics(gv[k]||[],to), dl:dealDim?dealCount(gd[k]):null}; });
  list.sort(function(a,b){ return b.m.meetings-a.m.meetings || b.v.n-a.v.n || (b.dl?b.dl.total:0)-(a.dl?a.dl.total:0) || a.k.localeCompare(b.k); }); // by volume only -- no ranking/scoring
  var tot=metrics(rows), totV=visitMetrics(vis,to), totD=deals?dealCount(deals):null;
  var naTip=deals===false ? 'Deal columns are blank while a Meeting Type / Call / Confirmation / Walk-in / Sale filter is on — those filters exist only on meetings.'
          : deals ? 'Deals have no Meeting Type, so they are not split by it — see the Total row.'
          : DD_ERR ? 'Deals could not be loaded: '+DD_ERR : 'Loading deals…';
  function dcell(n,t){ return '<td class="num"'+(t?' data-tip="'+esc(t)+'"':'')+'>'+n+'</td>'; }
  function dcells(k,dl){ if(!dl){ var s=!DD&&!DD_ERR?'…':'—'; return dcell(s,naTip)+dcell(s,naTip)+dcell(s,naTip)+dcell(s,naTip)+dcell(s,naTip); }
    var kt='<b>'+esc(k)+'</b> — '+fmtInt(dl.sc)+' store city deals<br>Within 7 km: '+fmtInt(dl.near)+' ('+fmtPct(pct(dl.near,dl.sc))+')<br>7 km &amp; above: '+fmtInt(dl.far)+' ('+fmtPct(pct(dl.far,dl.sc))+')<br>Pincode not available: '+fmtInt(dl.noPin)+' ('+fmtPct(pct(dl.noPin,dl.sc))+')';
    return dcell(fmtInt(dl.total))+dcell(fmtInt(dl.sc),'<b>'+esc(k)+'</b><br>'+fmtPct(pct(dl.sc,dl.total))+' of these deals are in a store city')+
      dcell(fmtInt(dl.near),kt)+dcell(fmtInt(dl.far),kt)+dcell(fmtInt(dl.noPin),kt); }
  var wv=WV[tab]&&WV[tab].dim===cur?WV[tab].key:'__ALL__';
  function dumpCell(key,n){ return '<td class="noexp">'+(n?'<button class="lnk'+(wv===key?' on':'')+'" data-wv="'+esc(key)+'">'+(wv===key?'Showing ▾':'View ▸')+'</button>':'')+'</td>'; }
  function tr(k,m,v,foot,dl){ var pt=' data-tip="'+esc('<b>'+esc(k)+'</b> — meetings<br>Within 7 km: '+fmtInt(m.near)+' ('+fmtPct(pct(m.near,m.meetings))+')<br>7 km &amp; above: '+fmtInt(m.far)+' ('+fmtPct(pct(m.far,m.meetings))+')<br>Pincode not available: '+fmtInt(m.noPin)+' ('+fmtPct(pct(m.noPin,m.meetings))+')')+'"',
      wt=' data-tip="'+esc('<b>'+esc(k)+'</b><br>Store visits in this date range: '+fmtInt(v.n)+'<br>· walk-in register: '+fmtInt(v.reg)+'<br>· Zoho Show only: '+fmtInt(v.showOnly))+'"';
    return '<tr>'+(foot?'<td>':'<td title="'+esc(k)+'">')+esc(k)+'</td>'+dcells(k,dl)+'<td class="num">'+fmtInt(m.meetings)+'</td><td class="num"'+pt+'>'+fmtInt(m.near)+'</td><td class="num"'+pt+'>'+fmtInt(m.far)+'</td><td class="num"'+pt+'>'+fmtInt(m.noPin)+'</td><td class="num">'+fmtInt(m.called)+'</td><td class="num">'+fmtInt(m.connected)+'</td><td class="num" data-tip="'+esc('<b>'+esc(k)+'</b> — Zoho Confirmation<br>'+confSplit(m))+'">'+fmtInt(m.confirmed)+'</td><td class="num">'+fmtInt(m.resched)+'</td><td class="num">'+fmtInt(m.cancel)+'</td><td class="num"'+wt+'>'+fmtInt(v.n)+'</td>'+dumpCell(foot?'__ALL__':k,v.n)+'<td class="num">'+fmtInt(v.invN)+'</td><td class="num">'+fmtMoneyFull(v.amt)+'</td></tr>'; }
  var kmTip='Meetings: Within 7 km = the customer pincode is within 7 km of ANY Lucira store (see “Store pincode check” below the table — every such pincode is listed). 7 km & Above = the customer has a real pincode that is not on that list. Pincode (user rule 4 Nov 2026) = the Zoho CONTACT address first (a pincode typed in the contact’s address, else its Mailing Zip), else the Zoho Deal Address - Zip / Postal Code (the meeting’s deal, else the customer’s latest deal with one). Pincode Not Available = neither has a 6-digit pincode.';
  var dkmTip='Only the <b>Store City Deals</b> (user rule 4 Nov 2026), so Deals Within 7 km + Deals 7 km & Above + Deals No Pincode = Store City Deals. Pincode = the deal’s Zoho <b>Contact</b> address first (pincode typed in the address, else Mailing Zip), else the deal’s <b>Address - Zip / Postal Code</b>. Within 7 km = that pincode is within 7 km of any Lucira store; 7 km & Above = a 6-digit pincode farther away; No Pincode = neither has a 6-digit pincode.';
  var walkTip='Store visits whose VISIT date is in the selected date range, even when the meeting was raised earlier. A visit = a Lucira_Prod.customer_walkin record (mobile or email match) or a Zoho meeting marked Show (visit date = its From Date). Each visit is mapped to the customer\'s latest meeting created before it, which gives the row. One visit per customer per day; a walk-in with no meeting before it is not counted.';
  var dealTip='Total Deals = Zoho deals CREATED in the selected date range (Deal Created Date, IST) — the same count as Total Deals on the Deals Funnel tab — grouped by the deal’s own JC (Deal Owner) / City / Stage / Trigger / Probability / Lead Source / UTM Source. Store = the deal’s store from the Deals Funnel rule (its Zoho meeting’s Store - Name, else walk-in / sale / scheme store, else the only store in its city). Includes deals with no meeting.',
      scTip='Store City Deals = those deals whose city (Deal Address_City, else Contact Mailing_City, else the store on the deal’s Zoho meeting) is a city with a Lucira store: Mumbai region (incl. Thane, Navi Mumbai, Chembur, Borivali …), Pune, Delhi / Gurgaon (all Delhi districts, Faridabad, Gurgaon), Noida / Ghaziabad or Bangalore — same rule as the Deals Funnel tab. A deal from a city with no store (e.g. Chennai) is not a Store City Deal. On the City view every store-city row has Store City Deals = Total Deals.';
  var wsTip='Invoice Qty = unique invoices (marketing_sale document_no) of the customers who visited a store in the selected date range, dated on or after the visit day and within the range; Walk-in Sale Value = SUM(net_sale) of those invoices. Each invoice is counted once. Same numbers as the Invoice Qty / Walk-in Sale Value KPIs.';
  return '<div class="card breakdowns"><h3>Analysis by dimension</h3><div class="desc">Actual counts only (no ranking or scoring; ordered by meeting volume). <b>Total Deals / Store City Deals</b> = Zoho deals created in the date filter (all deals, with or without a meeting; Deal Created Date), by the deal’s own value of the dimension; <b>Deals Within 7 km / Deals 7 km &amp; Above / Deals No Pincode</b> split the <b>Store City Deals</b> (they add up to Store City Deals) by the customer’s pincode. <b>City</b> = store city (all Delhi / Mumbai / … spellings and localities merged into the store city; every city without a store = “Other cities (no store)”). '+esc(mlabel)+' / Within 7 km / 7 km &amp; Above / Pincode Not Available / Called / Connected / Confirmed = meetings in the date filter (calls after meeting creation; <b>Confirmed</b> = Zoho meeting Confirmation = Confirmed). <b>Walk-ins</b> = store visits that HAPPENED in the date filter (walk-in register or Zoho Show), mapped to the customer\'s latest earlier meeting — a meeting raised last week with a visit yesterday counts under Yesterday. <b>Invoice Qty / Walk-in Sale Value</b> = invoices of those visitors on or after the visit day, within the date filter — the only sale figure on this page (same as the KPIs and the Funnel). <b>Within 7 km / 7 km &amp; Above</b> = the customer\'s pincode (Zoho Contact address first, else the Zoho Deal zip) is / is not within 7 km of any Lucira store (list under “Store pincode check”); <b>Pincode Not Available</b> = neither has a pincode.</div>'+
    '<div class="tabsm">'+DIMS.map(function(x){return '<button data-bd="'+x[0]+'" class="'+(x[0]===cur?'on':'')+'">'+x[1]+'</button>';}).join('')+'<span style="flex:1"></span><button class="btn" data-bdcsv="1">⬇ CSV</button></div>'+
    '<div class="tblwrap" style="max-height:420px"><table class="t" id="'+tab+'_bd"><thead><tr><th>'+d[1]+'</th><th class="num" data-tip="'+esc(dealTip)+'">Total Deals</th><th class="num" data-tip="'+esc(scTip)+'">Store City Deals</th><th class="num" data-tip="'+esc(dkmTip)+'">Deals Within 7 km</th><th class="num" data-tip="'+esc(dkmTip)+'">Deals 7 km &amp; Above</th><th class="num" data-tip="'+esc(dkmTip)+'">Deals No Pincode</th><th class="num">'+mlabel+'</th><th class="num" data-tip="'+esc(kmTip)+'">Within 7 km</th><th class="num" data-tip="'+esc(kmTip)+'">7 km &amp; Above</th><th class="num" data-tip="'+esc(kmTip)+'">Pincode Not Available</th><th class="num">Called</th><th class="num">Connected</th><th class="num" data-tip="'+esc(TIP_CONF)+'">Confirmed</th><th class="num" data-tip="'+esc(TIP_RESCHED)+'">Agreed to Reschedule</th><th class="num" data-tip="'+esc(TIP_CANCEL)+'">Cancelled by Customer</th><th class="num" data-tip="'+esc(walkTip)+'">Walk-ins (visit date)</th><th class="noexp" data-tip="'+esc('Shows that row’s visits in the “Store visits (1 row = 1 customer visit)” list just above the Meetings table (CSV there). Total row = every visit.')+'">Walk-in Dump</th><th class="num" data-tip="'+esc(wsTip)+'">Invoice Qty</th><th class="num" data-tip="'+esc(wsTip)+'">Walk-in Sale Value</th></tr></thead><tbody>'+
    list.map(function(x){return tr(x.k,x.m,x.v,false,x.dl);}).join('')+'</tbody><tfoot>'+tr('Total',tot,totV,true,totD)+'</tfoot></table></div>'+pinCheckBlock()+'</div>';
}

/* ---------------- Store Performance (user request 2026-11-07) ----------------
   One row per meeting store, right under Analysis by dimension, same date filter + filters.
   Every meeting column (Meetings / Deals Within 7 km / 7 km & Above / Not Dialled / Dialled /
   Connected / Call Activity) = the meetings RAISED in the date filter, grouped by the meeting's store
   (= Store view of Analysis by dimension). Deals Within 7 km / 7 km & Above (user rule 2026-11-07:
   "jo raised huwa hai") = those raised meetings by their deal customer's pincode; Above also takes
   the meetings with no pincode, so Within + Above = Meetings. Walk-ins (Show) / Orders Converted =
   store visits dated in the range and their invoices (same as the Store Visits / Invoice Qty KPIs).
   Call Activity = Σ calls after meeting creation (not Missed) = sum of the "Call Activity" column of
   the Meetings table; Avg = Call Activity ÷ Dialled meetings.
   Rows that are not a store name (Head Office, "… store not assigned", Not Captured / Non-Store City)
   are left out (user rule 2026-11-07); Total = the stores shown, the left-out counts are noted below. */
var SP_NOT_STORE=/^HO\b|head office|store not assigned|^not captured$|non-store city/i;
function storePerfCard(tab,rows){
  var to=F[tab].to, g={}, gv={}, gn={}, vis=visitsIn(tab), nmAll=nomtgIn(tab), mlabel=tab==='created'?'Meetings Raised':'Expected Meetings';
  rows.forEach(function(r){ (g[r.k_store]=g[r.k_store]||[]).push(r); });
  vis.forEach(function(v){ (gv[v.m.k_store]=gv[v.m.k_store]||[]).push(v); });
  (nmAll||[]).forEach(function(w){ (gn[w.m.k_store]=gn[w.m.k_store]||[]).push(w); });   // walk-ins without a Zoho meeting, by walk-in store
  var keys=Object.keys(g); Object.keys(gv).concat(Object.keys(gn)).forEach(function(k){ if(keys.indexOf(k)<0) keys.push(k); });
  var keep=[], drop=[], inRows=[], inVis=[], inNm=0;
  keys.forEach(function(k){
    if(SP_NOT_STORE.test(k)){ drop.push(esc(k)+' — '+fmtInt((g[k]||[]).length)+' meetings · '+fmtInt((gv[k]||[]).length)+' visits'+((gn[k]||[]).length?' · '+fmtInt(gn[k].length)+' walk-ins without meeting':'')); return; }
    keep.push(k); inRows=inRows.concat(g[k]||[]); inVis=inVis.concat(gv[k]||[]); inNm+=(gn[k]||[]).length;
  });
  var list=keep.map(function(k){ return {k:k, m:metrics(g[k]||[]), v:visitMetrics(gv[k]||[],to), nm:nmAll?(gn[k]||[]):null}; });
  list.sort(function(a,b){ return b.m.meetings-a.m.meetings || b.v.n-a.v.n || (b.nm?b.nm.length:0)-(a.nm?a.nm.length:0) || a.k.localeCompare(b.k); });
  var tot={k:'Total', m:metrics(inRows), v:visitMetrics(inVis,to), nm:nmAll?{length:inNm, deal:keep.reduce(function(a,k){ return a+(gn[k]||[]).filter(function(w){ return !!w.deal_id; }).length; },0)}:null};
  function td(v,t){ return '<td class="num"'+(t?' data-tip="'+esc(t)+'"':'')+'>'+v+'</td>'; }
  function tr(x,foot){
    var m=x.m, v=x.v, k=esc(x.k), above=m.far+m.noPin;
    var kt='<b>'+k+'</b> — '+fmtInt(m.meetings)+' meetings raised<br>Within 7 km: '+fmtInt(m.near)+' ('+fmtPct(pct(m.near,m.meetings))+')<br>7 km &amp; above: '+fmtInt(above)+' ('+fmtPct(pct(above,m.meetings))+')<br>· pincode farther than 7 km: '+fmtInt(m.far)+'<br>· no pincode: '+fmtInt(m.noPin);
    var ct='<b>'+k+'</b><br>Dialled: '+fmtInt(m.called)+' of '+fmtInt(m.meetings)+' meetings ('+fmtPct(pct(m.called,m.meetings))+')<br>Not dialled: '+fmtInt(m.notCalled)+' ('+fmtPct(pct(m.notCalled,m.meetings))+')<br>Connected: '+fmtInt(m.connected)+' ('+fmtPct(pct(m.connected,m.called))+' of dialled)';
    var wt='<b>'+k+'</b><br>Store visits in this date range: '+fmtInt(v.n)+'<br>· walk-in register: '+fmtInt(v.reg)+'<br>· Zoho Show only: '+fmtInt(v.showOnly)+'<br>Orders converted: '+fmtInt(v.invN)+' invoices by '+fmtInt(v.buyers)+' of '+fmtInt(v.visitors)+' visitors · '+fmtMoneyFull(v.amt);
    var at='<b>'+k+'</b><br>Call Activity: '+fmtInt(m.act)+' calls after meeting creation<br>÷ '+fmtInt(m.called)+' dialled meetings = '+(m.called?(m.act/m.called).toFixed(1):'—')+' calls per dialled meeting';
    var nmN=x.nm?x.nm.length:null, nmDeal=x.nm?(x.nm.deal!=null?x.nm.deal:x.nm.filter(function(w){ return !!w.deal_id; }).length):0;
    var nt=x.nm?'<b>'+k+'</b><br>Walk-ins without a Zoho meeting: '+fmtInt(nmN)+'<br>· with a Zoho deal: '+fmtInt(nmDeal)+'<br>· not in Zoho CRM: '+fmtInt(nmN-nmDeal)+'<br>All store walk-ins = '+fmtInt(v.n)+' + '+fmtInt(nmN)+' = '+fmtInt(v.n+nmN):(AW_ERR?'Walk-in register could not be loaded: '+esc(AW_ERR):'Loading walk-in register…');
    return '<tr>'+(foot?'<td>':'<td title="'+k+'">')+k+'</td>'+td(fmtInt(m.meetings))+td(fmtInt(m.near),kt)+td(fmtInt(above),kt)+
      td(fmtInt(m.notCalled),ct)+td(fmtInt(m.called),ct)+td(fmtInt(m.connected),ct)+td(fmtInt(m.confirmed),'<b>'+k+'</b> — Zoho Confirmation<br>'+confSplit(m)+'<br>'+fmtPct(pct(m.confirmed,m.connected))+' of connected')+
      td(fmtInt(m.resched))+td(fmtInt(m.cancel))+
      td(fmtInt(v.n),wt)+td(x.nm?fmtInt(nmN):(AW_ERR?'—':'…'),nt)+td(fmtInt(v.invN),wt)+td(fmtInt(m.act),at)+td(m.called?(m.act/m.called).toFixed(1):'—',at)+'</tr>';
  }
  var H=[
    ['Store','Meeting store = the Zoho meeting “Store - Name” (else the Venue keyword), same as the Store view of Analysis by dimension. Head Office, “… store not assigned” and Not Captured are not store names and are left out.'],
    [mlabel,tab==='created'?'Zoho meetings CREATED in the selected date range (Created_Time, IST) for this store.':'Zoho meetings whose From Date is in the selected date range for this store.'],
    ['Deals Within 7 km','Of the meetings raised for this store: the ones whose deal customer pincode (Zoho Contact address first, else the Deal Address - Zip) is within 7 km of any Lucira store. Counted per raised meeting.'],
    ['Deals 7 km &amp; Above','All the other meetings raised for this store: pincode farther than 7 km PLUS no pincode. Deals Within 7 km + Deals 7 km &amp; Above = '+mlabel+'. Hover a cell for the split.'],
    ['Not Dialled','Meetings with no call after the meeting was created (no Outbound / Inbound Zoho call; Missed calls do not count). Same rule as the “Not Called” KPI.'],
    ['Dialled','Meetings with at least one call (Outbound / Inbound, any duration, not Missed) after the meeting was created. Not Dialled + Dialled = Meetings.'],
    ['Connected','Dialled meetings with at least one call of 30 seconds or more after the meeting was created.'],
    ['Confirmed',TIP_CONF],
    ['Agreed to Reschedule',TIP_RESCHED],
    ['Cancelled by Customer',TIP_CANCEL],
    ['Walk-ins (Show)','Store visits that HAPPENED in the selected date range: a customer_walkin record or a Zoho meeting marked Show (visit date = its From Date), mapped to the customer’s latest earlier meeting, which gives the store. One visit per customer per day — same rule as the Store Visits KPI.'],
    ['Walk-ins Without Meeting','Other store walk-ins in the selected date range: POS walk-in register records (Lucira_Prod.customer_walkin) of customers who had NO Zoho meeting before the visit, by the walk-in store, one per customer per day. Walk-ins (Show) + this = all store walk-ins. Listed in the Store visits list under “Without Zoho meeting”. Not in Orders Converted.'],
    ['Orders Converted','Invoices (marketing_sale document_no, each counted once) of those visitors, dated on or after the visit day and within the date range — same rule as the Invoice Qty KPI.'],
    ['Call Activity','Total calls made after meeting creation on this store’s meetings (Outbound / Inbound, not Missed; every dial counts, also 0-second ones). Equals the sum of the “Call Activity” column in the Meetings table / CSV dump.'],
    ['Avg Activity per Dialled','Call Activity ÷ Dialled meetings = how many calls on average each dialled customer meeting got.']];
  return '<div class="card"><h3>Store Performance</h3><div class="desc">One row per store for the selected date range and filters (ordered by meeting volume). Every column up to Confirmed, and Call Activity, is counted on the meetings raised in the date filter (calls after meeting creation); <b>Deals Within 7 km + Deals 7 km &amp; Above = '+esc(mlabel)+'</b>. Walk-ins (Show) / Orders Converted = meeting-led visits that happened in the range; <b>Walk-ins Without Meeting</b> = the other register walk-ins of the store (no Zoho meeting). Hover any header or cell for the logic.</div>'+
    '<div class="tbltools"><span style="flex:1"></span><button class="btn" data-spcsv="1">⬇ CSV</button></div>'+
    '<div class="tblwrap" style="max-height:420px"><table class="t" id="'+tab+'_sp"><thead><tr>'+H.map(function(h,i){ return '<th'+(i?' class="num"':'')+' data-tip="'+esc(h[1])+'">'+h[0]+'</th>'; }).join('')+'</tr></thead><tbody>'+
    (list.length?list.map(function(x){ return tr(x,false); }).join(''):'<tr><td colspan="'+H.length+'" class="muted">No store meetings match the current filters.</td></tr>')+
    '</tbody><tfoot>'+tr(tot,true)+'</tfoot></table></div>'+
    (drop.length?'<div class="small muted" style="margin-top:8px">Not shown (not a store name), so not in the Total: '+drop.join('; ')+'.</div>':'')+'</div>';
}
/* ---------------- Sales by category (From Date tab, last card; user request 2026-11-14) ----------------
   Category | Qty Sold | Revenue for the SAME invoices as the Invoice Qty / Walk-in Sale Value KPIs:
   invoices of the store visitors of the date range, dated on/after the visit day and within the range,
   each invoice once. Category = marketing_sale type_name (Rings, Earrings, ...), Qty = pieces,
   Revenue = net_sale; cancelled orders are already left out by the server. */
function categoryCard(tab){
  var to=F[tab].to, docs={}, g={}, tq=0, ta=0, tinv=0;
  visitsIn(tab).forEach(function(v){ (v.m.cust_sales||v.m.sales).forEach(function(s){ var d=(s.ts||'').slice(0,10); if(d>=v.day && d<=to) docs[s.doc]=s; }); });
  Object.keys(docs).forEach(function(k){
    var s=docs[k], parts=s.cats?String(s.cats).split(';'):['Not Captured|0|'+(+s.amount||0)]; tinv++;
    parts.forEach(function(p){ var a=p.split('|'), o=g[a[0]]=g[a[0]]||{c:a[0], q:0, a:0, inv:0}; o.q+=+a[1]||0; o.a+=+a[2]||0; o.inv++; tq+=+a[1]||0; ta+=+a[2]||0; });
  });
  var list=Object.keys(g).map(function(k){ return g[k]; }).sort(function(a,b){ return b.a-a.a || b.q-a.q || a.c.localeCompare(b.c); });
  function tr(c,q,a,inv){ return '<tr><td>'+c+'</td><td class="num">'+fmtInt(q)+'</td><td class="num">'+fmtMoneyFull(a)+'</td><td class="num">'+fmtPct(pct(a,ta))+'</td><td class="num">'+fmtInt(inv)+'</td></tr>'; }
  var H=[['Category','Product category of the sold item = marketing_sale type_name (Rings, Earrings, Necklaces, Pendants, Gold Coin …).'],
    ['Qty Sold','Pieces sold in this category (marketing_sale pieces), cancelled orders left out.'],
    ['Revenue','Sale value of this category (marketing_sale net_sale, GST inclusive). The Total equals the Walk-in Sale Value KPI.'],
    ['% of Revenue','This category’s revenue ÷ total revenue of the table.'],
    ['Invoices','Invoices that contain this category. One invoice with two categories is counted in both rows; the Total is the unique invoice count = Invoice Qty KPI.']];
  return '<div class="card"><h3>Sales by category</h3><div class="desc">Category-wise quantity sold and revenue for the selected date range and filters. Same invoices as the <b>Invoice Qty / Walk-in Sale Value</b> KPIs: orders of the customers who visited a store in the range, dated on or after the visit day (each invoice once, cancelled orders left out).</div>'+
    '<div class="tbltools"><span style="flex:1"></span><button class="btn" data-catcsv="1">⬇ CSV</button></div>'+
    '<div class="tblwrap" style="max-height:420px"><table class="t" id="'+tab+'_cat"><thead><tr>'+H.map(function(h,i){ return '<th'+(i?' class="num"':'')+' data-tip="'+esc(h[1])+'">'+h[0]+'</th>'; }).join('')+'</tr></thead><tbody>'+
    (list.length?list.map(function(x){ return tr(esc(x.c),x.q,x.a,x.inv); }).join(''):'<tr><td colspan="'+H.length+'" class="muted">No sale in the selected date range and filters.</td></tr>')+
    '</tbody><tfoot>'+tr('Total',tq,ta,tinv)+'</tfoot></table></div></div>';
}
function exportCategory(tab){
  var t=$(tab+'_cat'); if(!t) return; var out=[]; t.querySelectorAll('tr').forEach(function(tr){ var r=[]; tr.querySelectorAll('th,td').forEach(function(td){ r.push(td.textContent.trim()); }); if(r.length>1) out.push(r); });
  download('meeting-journey-'+tab+'-sales-by-category-'+F[tab].from+'_to_'+F[tab].to+'.csv', csvOf(out));
}
function exportStorePerf(tab){
  var t=$(tab+'_sp'); if(!t) return; var out=[]; t.querySelectorAll('tr').forEach(function(tr){ var r=[]; tr.querySelectorAll('th,td').forEach(function(td){ r.push(td.textContent.trim()); }); if(r.length>1) out.push(r); });
  download('meeting-journey-'+tab+'-store-performance-'+F[tab].from+'_to_'+F[tab].to+'.csv', csvOf(out));
}

/* ---------------- main table ---------------- */
function yn(b){ return b?'<span class="yes">YES</span>':'<span class="no">NO</span>'; }
function stBadge(s){ var c={'Walk-in - Sale':'s-sale','Sale (No Walk-in)':'s-sale','Walk-in - No Sale':'s-walk','Connected':'s-conn','Called':'s-call','No Activity':'s-none'}[s]||'s-na'; return '<span class="st '+c+'">'+esc(s)+'</span>'; }
var C={
  created_date:{l:'Meeting Created Date',v:function(r){return r.meeting_created_date;},s:'meeting_created_ist',f:function(r){return fmtDate(r.meeting_created_date);}},
  created_time:{l:'Meeting Created Time',v:function(r){return fmtTime(r.meeting_created_ist);},s:'meeting_created_ist'},
  from_date:{l:'From Date',v:function(r){return r.from_date;},s:'from_sort',f:function(r){return fmtDate(r.from_date)+(r.all_day?' <span class="muted">(all day)</span>':(r.from_ist?' <span class="muted">'+fmtTime(r.from_ist)+'</span>':''));},csv:function(r){return r.from_date+(r.all_day?' (all day)':(r.from_ist?' '+fmtTime(r.from_ist):''));}},
  customer:{l:'Customer',v:function(r){return r.customer_name;}},
  mobile:{l:'Mobile',v:function(r){return r.mobile;}},
  email:{l:'Email',v:function(r){return r.email;}},
  meeting_id:{l:'Meeting ID',v:function(r){return r.meeting_id;}},
  deal_id:{l:'Deal ID',v:function(r){return r.deal_id;}},
  deal_name:{l:'Deal Name',v:function(r){return r.deal_name;}},
  jc:{l:'JC',v:function(r){return r.k_jc;}},
  city:{l:'City',v:function(r){return r.k_city;},f:function(r){ var raw=(r.deal_city||'').trim(); return esc(r.k_city)+(raw&&raw!==r.k_city?' <span class="muted">('+esc(raw)+')</span>':''); },
        csv:function(r){ var raw=(r.deal_city||'').trim(); return r.k_city+(raw&&raw!==r.k_city?' ('+raw+')':''); }},
  store:{l:'Store',v:function(r){return r.k_store;}},
  stage:{l:'Deal Stage',v:function(r){return r.k_stage;}},
  trigger:{l:'Deal Trigger',v:function(r){return r.k_trigger;}},
  prob:{l:'Probability',v:function(r){return r.k_prob;},s:'probability'},
  mtype:{l:'Meeting Type',v:function(r){return r.k_mtype;}},
  cust_pin:{l:'Customer Pincode',v:function(r){return r.pin_used;},f:function(r){ return r.pin_used?'<span title="'+esc(r.pin_used_src||'')+'">'+esc(r.pin_used)+'</span> <span class="muted">'+esc(r.pin_used_tag)+'</span>':'—'; },
            csv:function(r){ return r.pin_used?r.pin_used+' ('+r.pin_used_src+')':''; }},
  km:{l:'Within 7 km of Store',v:function(r){return r.pin7==='in'?'Within 7 km ('+r.near7.km.toFixed(1)+' km to '+storeName(r.near7.store)+')':r.pin7==='out'?'7 km & above':'Pincode not available';},s:'pin7_sort',
      f:function(r){return r.pin7==='in'?'<span class="yes">≤7 km</span> <span class="muted">'+r.near7.km.toFixed(1)+' km · '+esc(r.near7.store)+'</span>':r.pin7==='out'?'<span class="no">7 km+</span>':'—';}},
  calls:{l:'Call Activity (Calls After Creation)',v:function(r){return r.calls_after;},n:1},
  conn:{l:'Connected Calls',v:function(r){return r.connected_calls;},n:1},
  confirm:{l:'Zoho Confirmation',v:function(r){return confLabel(r);},f:function(r){return confHtml(r);}},
  first_call:{l:'First Call',v:function(r){return fmtDT(r.first_call_ist);},s:'first_call_ist'},
  last_call:{l:'Last Call',v:function(r){return fmtDT(r.last_call_ist);},s:'last_call_ist'},
  talk:{l:'Total Talk Time',v:function(r){return fmtDur(r.talk_time_sec);},s:'talk_time_sec',n:1},
  prev_walk:{l:'Previous Walk-in Before Meeting',v:function(r){return r.prev_walkin?'YES':'NO';},f:function(r){return yn(r.prev_walkin);}},
  prev_walk_date:{l:'Previous Walk-in Date',v:function(r){return fmtDT(r.prev_walkin_ist);},s:'prev_walkin_ist'},
  walk:{l:'Walk-in After Creation',v:function(r){return r.walked_in?'YES':'NO';},f:function(r){return yn(r.walked_in)+(r.walkins_after>1?' <span class="muted">×'+r.walkins_after+'</span>':'')+(r.walkin_evidence==='Zoho Show'?' <span class="muted">(Zoho Show)</span>':'');},s:'walked_in',csv:function(r){return r.walked_in?'YES ('+r.walkin_evidence+')':'NO';}},
  walk_date:{l:'Walk-in Date',v:function(r){return fmtDT(r.first_walkin_ist);},s:'first_walkin_ist'},
  walk_store:{l:'Walk-in Store',v:function(r){return r.first_walkin_store_code?storeName(r.first_walkin_store_code):'—';}},
  sale:{l:'Sale After Creation',v:function(r){return r.sales_after?'YES':'NO';},f:function(r){return yn(r.sales_after)+(r.sales_after>1?' <span class="muted">×'+r.sales_after+'</span>':'');},s:'sales_after'},
  sale_date:{l:'Sale Date',v:function(r){return fmtDT(r.first_sale_ist);},s:'first_sale_ist'},
  sale_amt:{l:'Sale Amount',v:function(r){return r.sales_after?r.sales_amount_after:null;},f:function(r){return r.sales_after?fmtMoneyFull(r.sales_amount_after):'—';},s:'sales_amount_after',n:1},
  outcome:{l:'Reschedule / Cancel',v:function(r){return outcomeLabel(r);},
    f:function(r){ var l=outcomeLabel(r); return l?'<span class="'+(r.resched?'yes':'no')+'" title="'+esc(r.outcome_why||'')+'">'+(r.resched?'Rescheduled':'Cancelled')+'</span>':'—'; },
    csv:function(r){ var l=outcomeLabel(r); return l?l+' ('+r.outcome_why+')':''; }},
  status:{l:'Journey Status',v:function(r){return r.journey_status;},f:function(r){return stBadge(r.journey_status);}}
};
var COLS={
  created:['created_date','created_time','from_date','customer','mobile','email','meeting_id','deal_id','deal_name','jc','city','store','cust_pin','km','stage','trigger','prob','mtype','calls','conn','confirm','first_call','last_call','talk','prev_walk','prev_walk_date','walk','walk_date','walk_store','outcome','sale','sale_date','sale_amt','status'],
  from:['from_date','created_date','created_time','customer','mobile','email','meeting_id','deal_id','jc','city','store','cust_pin','km','stage','trigger','prob','mtype','calls','conn','confirm','last_call','prev_walk','walk','walk_date','outcome','sale','sale_date','sale_amt','status']
};
function sortVal(r,c){ var s=C[c].s; if(s) return r[s]; return C[c].v(r); }
function tableRows(tab,rows){
  var t=TBL[tab], q=t.q.toLowerCase();
  if(q) rows=rows.filter(function(r){ return [r.customer_name,r.mobile,r.email,r.meeting_id,r.deal_id,r.deal_name,r.k_jc,r.k_city,r.k_store,r.pin_used,r.customer_pincode,r.k_stage,r.k_trigger,r.meeting_title,r.venue,r.journey_status].join(' ').toLowerCase().indexOf(q)>=0; });
  var cdef=COLS[tab].indexOf(t.sort)>=0 ? t.sort : COLS[tab][0];
  rows=rows.slice().sort(function(a,b){ var x=sortVal(a,cdef), y=sortVal(b,cdef);
    if(x==null||x==='') return 1; if(y==null||y==='') return -1; return (x<y?-1:x>y?1:0)*t.dir; });
  return rows;
}
function tableCard(tab,rows){
  var t=TBL[tab], all=tableRows(tab,rows), pages=Math.max(1,Math.ceil(all.length/PAGE_SIZE)); if(t.page>pages) t.page=pages;
  var pr=all.slice((t.page-1)*PAGE_SIZE, t.page*PAGE_SIZE);
  var head=COLS[tab].map(function(c){ return '<th data-sort="'+c+'" class="'+(C[c].n?'num':'')+'">'+esc(C[c].l)+(t.sort===c?'<span class="arr">'+(t.dir>0?'▲':'▼')+'</span>':'')+'</th>'; }).join('');
  var body=pr.map(function(r){ return '<tr class="click" data-mid="'+esc(r.meeting_id)+'">'+COLS[tab].map(function(c){ var d=C[c], h=d.f?d.f(r):esc(dash(d.v(r))); return '<td class="'+(d.n?'num':'')+'">'+h+'</td>'; }).join('')+'</tr>'; }).join('');
  if(!pr.length) body='<tr><td colspan="'+COLS[tab].length+'" class="muted">No meetings match the current filters.</td></tr>';
  return '<div class="card"><h3>'+(tab==='created'?'Meetings (1 row = 1 meeting)':'Expected meetings by From Date (1 row = 1 meeting)')+'</h3><div class="desc">Click any row for the full customer journey. Sorted by '+esc((C[t.sort]||{}).l||'')+' (click a header to sort).</div>'+
    '<div class="tbltools"><input type="search" id="'+tab+'_q" placeholder="Search customer, mobile, meeting / deal ID, JC, store…" value="'+esc(t.q)+'"><span class="muted small">'+fmtInt(all.length)+' meetings</span><span style="flex:1"></span><button class="btn" data-csv="1">⬇ Export CSV ('+fmtInt(all.length)+')</button></div>'+
    '<div class="tblwrap"><table class="t"><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table></div>'+
    '<div class="pager"><button class="btn" data-pg="-1"'+(t.page<=1?' disabled':'')+'>‹ Prev</button><span>Page '+t.page+' of '+pages+'</span><button class="btn" data-pg="1"'+(t.page>=pages?' disabled':'')+'>Next ›</button><span class="muted">'+PAGE_SIZE+' per page</span></div></div>';
}
function csvOf(rows){ return rows.map(function(r){ return r.map(function(v){ v=v==null?'':''+v; return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }).join(','); }).join('\n'); }
function download(name,text){ var b=new Blob(['﻿'+text],{type:'text/csv;charset=utf-8'}), a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download=name; document.body.appendChild(a); a.click(); setTimeout(function(){URL.revokeObjectURL(a.href); a.remove();},500); }
function exportTable(tab,rows){
  var all=tableRows(tab,rows), cols=COLS[tab];
  var out=[cols.map(function(c){return C[c].l;})].concat(all.map(function(r){ return cols.map(function(c){ var d=C[c]; return d.csv?d.csv(r):d.v(r); }); }));
  download('meeting-journey-'+tab+'-'+F[tab].from+'_to_'+F[tab].to+'.csv', csvOf(out));
}
function exportBreakdown(tab){
  var t=$(tab+'_bd'); if(!t) return; var out=[]; t.querySelectorAll('tr').forEach(function(tr){ var r=[]; tr.querySelectorAll('th:not(.noexp),td:not(.noexp)').forEach(function(td){ r.push(td.textContent.trim()); }); out.push(r); });
  download('meeting-journey-'+tab+'-by-'+BD[tab]+'.csv', csvOf(out));
}

/* ---------------- drawer: customer journey ---------------- */
function openJourney(mid){
  var r=ROWS.filter(function(x){return x.meeting_id===mid;})[0]; if(!r) return;
  $('dTitle').textContent=r.customer_name||'Customer';
  $('dSub').innerHTML=esc(r.mobile||'no mobile')+' · Meeting '+esc(r.meeting_id)+(r.deal_id?' · Deal '+esc(r.deal_id):'')+'<br>'+stBadge(r.journey_status);
  function kv(pairs){ return '<div class="kv">'+pairs.map(function(p){return '<div>'+p[0]+'</div><div>'+p[1]+'</div>';}).join('')+'</div>'; }
  var calls=r.calls.map(function(c){ return '<tr><td>'+fmtDT(c.ts)+'</td><td>'+esc(c.type)+'</td><td>'+fmtDur(+c.dur)+(+c.dur>=30&&c.type!=='Missed'?' <span class="yes">✓</span>':'')+'</td><td>'+esc(c.owner||'')+'</td><td class="muted">'+esc(c.mk)+'</td></tr>'; }).join('');
  var walks=r.walkins.map(function(w){ var after=w.after===true||w.after==='true'; return '<tr><td>'+fmtDT(w.ts)+'</td><td>'+esc(storeName(w.store))+'</td><td>'+(after?'<span class="yes">After creation</span>':'<span class="muted">Before (history)</span>')+'</td></tr>'; }).join('');
  var sales=r.sales.map(function(s){ return '<tr><td>'+fmtDT(s.ts)+'</td><td>'+esc(s.doc)+(s.pre?' <span class="muted small">(same day, before meeting was raised)</span>':'')+'</td><td>'+esc(storeName(s.store))+' · '+esc(s.channel||'')+'</td><td class="num">'+fmtMoneyFull(+s.amount)+'</td></tr><tr><td colspan="4" class="muted small">SKU: '+esc(s.skus||'—')+'</td></tr>'; }).join('');
  $('dBody').innerHTML=
    '<div class="step"><h4>Meeting Created</h4>'+kv([
      ['Created',fmtDT(r.meeting_created_ist)+' IST'],['From Date',fmtDate(r.from_date)+(r.all_day?' (all day)':' '+fmtTime(r.from_ist))],
      ['Title (raw)',esc(dash(r.meeting_title))],['Meeting Type',esc(r.k_mtype)],['Check-in status',esc(r.k_mstatus)+' <span class="muted small">(Zoho check-in is unused &mdash; always PLANNED)</span>'],['Location',esc(dash(r.meeting_location))],
      ['Store',esc(r.k_store)+(r.store_source?' <span class="muted">('+esc(r.store_source)+')</span>':'')],
      ['Zoho Store Name',esc(dash(r.zoho_store_name))],['Venue (raw)',esc(dash(r.venue))],
      ['Meeting Owner',esc(dash(r.meeting_owner))],['Created By',esc(dash(r.meeting_created_by))],['Related To',esc(dash(r.related_module))],
      ['JC',esc(r.k_jc)+' <span class="muted">('+esc(r.jc_source)+')</span>'],['Deal',esc(dash(r.deal_name))+(r.deal_id?' <span class="muted">'+esc(r.deal_id)+'</span>':'')],
      ['Deal Stage / Trigger',esc(r.k_stage)+' · '+esc(r.k_trigger)],['Probability',esc(r.k_prob)],['City',esc(r.k_city)+' <span class="muted">(Deal Address_City: '+esc(dash(r.deal_city))+')</span>'],
      ['Customer pincode',r.pin_used?esc(r.pin_used)+' <span class="muted">('+esc(r.pin_used_src)+')</span>'+
        (r.contact_pin&&r.deal_zip&&r.deal_zip!==r.pin_used?'<br><span class="muted small">Not used — Zoho Deal zip: '+esc(r.deal_zip)+' (Contact address comes first)</span>':'')+
        (r.zoho_pincode&&r.zoho_pincode!==r.pin_used?'<br><span class="muted small">Not used — Zoho meeting Pincode: '+esc(r.zoho_pincode)+'</span>':'')+
        (r.customer_pincode&&r.customer_pincode!==r.pin_used?'<br><span class="muted small">Not used — customer record: '+esc(r.customer_pincode)+' ('+esc(r.customer_pincode_source)+')</span>':''):
        '— <span class="muted small">(Zoho Contact address and Deal Address - Zip / Postal Code are both blank)</span>'+
        (r.zoho_pincode?'<br><span class="muted small">Not used — Zoho meeting Pincode: '+esc(r.zoho_pincode)+'</span>':'')],
      ['Within 7 km of a store',r.pin7==='na'?'<span class="no">Pincode not available</span> <span class="muted small">(no Contact / Deal pincode)</span>':
        (r.pin7==='in'?'<span class="yes">Within 7 km</span> · '+r.near7.km.toFixed(2)+' km to '+esc(storeName(r.near7.store)):'<span class="no">7 km &amp; above</span> <span class="muted small">(no Lucira store within 7 km)</span>')+
        (r.km_to_store!=null?'<br><span class="muted small">Meeting store: '+r.km_to_store.toFixed(1)+' km to '+esc(storeName(r.km_store_code))+' ('+esc(r.km_store_rule)+'; '+esc(r.km_basis)+')</span>':'')],
      ['Lead Source / Campaign',esc(dash(r.lead_source))+' · '+esc(dash(r.campaign_source||r.utm_campaign))],['Deal Created',fmtDT(r.deal_created_ist)],
      ['Mobile source',esc(dash(r.mobile_source))],
      ['Email',esc(dash(r.email))]])+'</div>'+
    '<div class="arrow">↓</div>'+
    '<div class="step"><h4>Call</h4>'+kv([
      ['Called',r.calls_after?'<span class="yes">Called</span>':'<span class="no">Not Called</span>'],
      ['Connected (≥30s)',r.connected_calls?'<span class="yes">Connected</span>':'<span class="no">Not Connected</span>'],
      ['Zoho Confirmation',confHtml(r)+' <span class="muted small">(meeting field “Confirmation”)</span>'],
      ['Call count',fmtInt(r.calls_after)+' calls · '+fmtInt(r.connected_calls)+' connected'+(r.missed_calls?' · '+r.missed_calls+' missed':'')],
      ['Talk time',fmtDur(r.talk_time_sec)],['First / Last call',fmtDT(r.first_call_ist)+' → '+fmtDT(r.last_call_ist)]])+
      (calls?'<table class="mini"><tr><th>When (IST)</th><th>Type</th><th>Duration</th><th>By</th><th>Matched on</th></tr>'+calls+'</table>':'<div class="small muted" style="margin-top:6px">No calls after meeting creation.</div>')+'</div>'+
    '<div class="arrow">↓</div>'+
    '<div class="step"><h4>Walk-in</h4>'+kv([
      ['Previous walk-in',r.prev_walkin?'<span class="yes">YES</span> · '+fmtDT(r.prev_walkin_ist)+' · '+esc(storeName(r.prev_walkin_store_code)):'<span class="no">NO</span>'],
      ['Walked in',r.walked_in?'<span class="yes">YES</span> <span class="muted">('+esc(r.walkin_evidence)+')</span>':'<span class="no">NO</span>'+(r.show_status==='No Show'?' <span class="muted">(Zoho: No Show)</span>':'')],
      ['Zoho Show status',esc(dash(r.show_status))],
      ['Zoho Connection / Follow Up',esc(dash(r.connection_status))+' · Follow Up '+(r.follow_up?fmtDate(r.follow_up):'—')+' · Meeting Status '+esc(dash(r.zoho_meeting_status))],
      ['Reschedule / Cancel',outcomeLabel(r)?'<span class="'+(r.resched?'yes':'no')+'">'+outcomeLabel(r)+'</span> <span class="muted small">('+esc(r.outcome_why)+')</span>':'—'],
      ['Walk-in register after creation',r.walkins_after?'<span class="yes">YES</span> ('+r.walkins_after+')':'<span class="no">NO</span>'],
      ['Walk-in date',fmtDT(r.first_walkin_ist)],['Store',r.first_walkin_store_code?esc(storeName(r.first_walkin_store_code)):'—'],
      ['Days meeting → walk-in',r.days_to_walkin!=null?r.days_to_walkin+' d':'—']])+
      (walks?'<table class="mini"><tr><th>When (IST)</th><th>Store</th><th></th></tr>'+walks+'</table>':'')+'</div>'+
    '<div class="arrow">↓</div>'+
    '<div class="step"><h4>Sale</h4>'+kv([
      ['Sale after creation',r.sales_after?'<span class="yes">YES</span> ('+r.sales_after+' invoice'+(r.sales_after>1?'s':'')+')':'<span class="no">NO</span>'],
      ['First sale date',fmtDT(r.first_sale_ist)],['First sale amount',r.sales_after?fmtMoneyFull(+r.first_sale_amount):'—'],
      ['Total after creation',r.sales_after?fmtMoneyFull(r.sales_amount_after):'—'],
      ['Store / Channel',r.sales_after?esc(storeName(r.first_sale_store_code))+' · '+esc(dash(r.first_sale_channel)):'—'],
      ['Days meeting → sale',r.days_to_sale!=null?r.days_to_sale+' d':'—']])+
      (sales?'<table class="mini"><tr><th>When (IST)</th><th>Invoice</th><th>Store · Channel</th><th class="num">Amount</th></tr>'+sales+'</table>':'')+'</div>';
  $('drawer').classList.add('open'); $('drawer').setAttribute('aria-hidden','false'); $('drawerBg').style.display='block';
}
function closeJourney(){ $('drawer').classList.remove('open'); $('drawer').setAttribute('aria-hidden','true'); $('drawerBg').style.display='none'; }

/* ---------------- tab renderers ---------------- */
function scopeText(tab,rows){
  var f=F[tab]; var r=f.preset==='all'?'all dates':fmtDate(f.from)+' – '+fmtDate(f.to);
  return 'Showing <b>'+fmtInt(rows.length)+'</b> of '+fmtInt(ROWS.length)+' meetings · '+(tab==='created'?'Meeting Created Date':'From Date')+': '+r+' (IST)';
}
function renderCreated(){
  var root=$('tab-created'), rows=filtered('created'), m=metrics(rows), x=scopeExtra('created');
  root.innerHTML=filterBar('created')+
    '<h2 class="sec">Key metrics <span class="muted">· calls and sales counted strictly after Meeting Created Time; Store Visits by visit date</span></h2>'+kpisCreated(m,x)+
    '<div class="grid2" style="margin-top:14px">'+funnelCard(m,'Meetings Created','created',x)+statusCard(rows)+'</div>'+
    '<div style="margin-top:14px">'+trendCard(rows,'meeting_created_date','Meetings created over time')+'</div>'+
    '<div style="margin-top:14px">'+breakdownCard('created',rows)+'</div>'+
    '<div style="margin-top:14px">'+storePerfCard('created',rows)+'</div>'+
    '<div style="margin-top:14px">'+visitDumpBlock('created')+'</div>'+
    '<div style="margin-top:14px">'+tableCard('created',rows)+'</div>';
  wireCommon('created',root,rows);
}
function renderFrom(){
  var root=$('tab-from'), rows=filtered('from'), m=metrics(rows), x=scopeExtra('from');
  root.innerHTML=
    filterBar('from')+
    '<h2 class="sec">Selected From Date range</h2>'+kpisToday(m,x)+
    '<div class="grid2" style="margin-top:14px">'+funnelCard(m,'Expected Meetings','from',x)+statusCard(rows)+'</div>'+
    '<div style="margin-top:14px">'+trendCard(rows,'from_date','Expected meetings by From Date')+'</div>'+
    '<div style="margin-top:14px">'+breakdownCard('from',rows)+'</div>'+
    '<div style="margin-top:14px">'+storePerfCard('from',rows)+'</div>'+
    '<div style="margin-top:14px">'+visitDumpBlock('from')+'</div>'+
    '<div style="margin-top:14px">'+tableCard('from',rows)+'</div>'+
    '<div style="margin-top:14px">'+categoryCard('from')+'</div>';
  wireCommon('from',root,rows);
  var cb=root.querySelector('[data-catcsv]'); if(cb) cb.onclick=function(){ exportCategory('from'); };
}
function wireCommon(tab,root,rows){
  wireFilters(tab,root);
  $(tab+'_scope').innerHTML=scopeText(tab,rows);
  root.querySelectorAll('[data-bd]').forEach(function(b){ b.onclick=function(){ BD[tab]=b.getAttribute('data-bd'); renderTab(tab); }; });
  root.querySelector('[data-bdcsv]').onclick=function(){ exportBreakdown(tab); };
  root.querySelector('[data-spcsv]').onclick=function(){ exportStorePerf(tab); };
  root.querySelectorAll('[data-wv]').forEach(function(b){ b.onclick=function(){ var k=b.getAttribute('data-wv'); WV[tab]=k==='__ALL__'?null:{dim:BD[tab], key:k}; renderTab(tab); var el=$(tab+'_wvd'); if(el) el.scrollIntoView({block:'start', behavior:'smooth'}); }; });
  var wvc=root.querySelector('[data-wvclose]'); if(wvc) wvc.onclick=function(){ WV[tab]=null; renderTab(tab); };
  root.querySelectorAll('[data-wvm]').forEach(function(b){ b.onclick=function(){ WVM[tab]=b.getAttribute('data-wvm'); renderTab(tab); var el=$(tab+'_wvd'); if(el) el.scrollIntoView({block:'start'}); }; });
  root.querySelector('[data-wvcsv]').onclick=function(){ exportVisitDump(tab); };
  root.querySelectorAll('[data-tser]').forEach(function(b){ b.onclick=function(){ var k=b.getAttribute('data-tser'); TREND_OFF[k]=!TREND_OFF[k]; renderTab(tab); }; });
  root.querySelectorAll('details.pinchk').forEach(function(d){ d.ontoggle=function(){ PINCHK_OPEN=d.open; }; });
  root.querySelector('[data-csv]').onclick=function(){ exportTable(tab,rows); };
  root.querySelectorAll('th[data-sort]').forEach(function(th){ th.onclick=function(){ var k=th.getAttribute('data-sort'), t=TBL[tab]; if(t.sort===k) t.dir*=-1; else { t.sort=k; t.dir=1; } renderTab(tab); }; });
  root.querySelectorAll('[data-pg]').forEach(function(b){ b.onclick=function(){ TBL[tab].page+=+b.getAttribute('data-pg'); renderTab(tab); }; });
  var q=$(tab+'_q'); q.oninput=function(){ TBL[tab].q=q.value; TBL[tab].page=1; var pos=q.selectionStart; renderTab(tab); var q2=$(tab+'_q'); q2.focus(); try{q2.setSelectionRange(pos,pos);}catch(e){} };
  root.querySelectorAll('tr[data-mid]').forEach(function(tr){ tr.onclick=function(){ openJourney(tr.getAttribute('data-mid')); }; });
  bindTips(root);
}
function renderTab(tab){ if(tab==='created') renderCreated(); else if(tab==='from') renderFrom(); else if(tab==='deals') renderDeals(); else if(tab==='mji') renderMJI(); }

/* ---------------- Meeting Journey Intelligence tab ----------------
   Cohort = meetings whose FROM DATE is in the dashboard's From Date filter (the same filter state
   as Tab 2, F.from -- not a separate filter). Grain = 1 customer (cust_key: normalised mobile, else
   Deal / Contact / Meeting ID) per Agent / Store group. Calls, walk-ins and sales are the per-meeting
   aggregates already built by zoho_meeting_journey_v (all strictly AFTER Meeting Created Time).
   /api/meeting-outcomes adds, each pre-aggregated on its own: invoice -> SKU line count, scheme
   enrolments, and the "Share Case" sheet rows with Status = Connected. */
var MO=null, MO_LOADING=false, MO_ERR=null, moLoadedAt=0;
var MSORT={agent:{k:'sched',dir:-1}, store:{k:'sched',dir:-1}};
function loadMO(force){
  if(MO_LOADING) return; MO_LOADING=true;
  fetch('api/meeting-outcomes'+(force?'?refresh=1':''),FETCH_OPTS)
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
    .then(function(x){
      if(!x.ok || !x.j.ok){ MO_ERR=(x.j&&x.j.error)||'Unknown error'; return; }
      MO=x.j; MO_ERR=null; moLoadedAt=Date.now();
      MO.schemeBy={}; (MO.schemes||[]).forEach(function(s){ (MO.schemeBy[s.mobile]=MO.schemeBy[s.mobile]||[]).push(s); });
      MO.shareBy={}; (MO.share_case||[]).forEach(function(s){ (MO.shareBy[s.mobile]=MO.shareBy[s.mobile]||[]).push(s); });
    })
    .catch(function(e){ MO_ERR=String(e); })
    .then(function(){ MO_LOADING=false; if(TAB==='mji') renderMJI(); else if(TAB==='deals' && DF) renderDeals(); });
}
/* Share Case "Connected" counts as a walk-in for a meeting when the mobile matches, the sheet DATE is
   on/after the meeting's created date (same "after creation" window as system walk-ins) and is not
   a future date (a visit dated after today cannot have happened yet). Rows the same sheet marks
   "No Show" in the Show / No Show column are NOT counted: 213 of the 758 Connected rows say No Show,
   i.e. Connected there means the call connected, not that the customer came. */
function shareCaseHit(r){
  return null;                       // walk-ins come ONLY from Lucira_Prod.customer_walkin (user rule 2026-10-21)
  if(!r.mobile || !MO) return null;
  var today=todayIST(), c=r.meeting_created_date;
  return (MO.shareBy[r.mobile]||[]).filter(function(s){ return s.date && s.date>=c && s.date<=today && String(s.show||'').toLowerCase()!=='no show'; })[0]||null;
}
/* One record per scheduled MEETING (same count as Tab 2's "Expected Meetings": a customer with two
   meetings in the range is two scheduled meetings). Calls / invoices are de-duplicated by id when
   minutes, SKUs and revenue are summed (mjiAgg), so a customer's second meeting never re-adds them. */
function mjiCustomers(rows){
  var by={};
  rows.forEach(function(r){
    var c=by[r.meeting_id]; if(!c) c=by[r.meeting_id]={key:r.cust_key, mobile:r.mobile, name:r.customer_name, meetings:[], callIds:{}, callSecBy:{}, callSec:0, sysWalk:false, share:null, docs:{}, schemeIds:{}, show:false, conv:false, confirmed:false};
    c.meetings.push(r.meeting_id);
    r.calls.forEach(function(k){ if(k.type!=='Missed' && !c.callIds[k.id]){ c.callIds[k.id]=1; c.callSecBy[k.id]=(+k.dur||0); c.callSec+=(+k.dur||0); } });
    if(r.confirmed) c.confirmed=true;
    if(r.show_status==='Show') c.show=true;
    if(r.conversion_status==='Converted') c.conv=true;
    if(r.walkins_after) c.sysWalk=true;
    var sh=shareCaseHit(r); if(sh && !c.share) c.share=sh;
    r.sales.forEach(function(s){ c.docs[s.doc]=+s.amount||0; });
    if(r.mobile && MO) (MO.schemeBy[r.mobile]||[]).forEach(function(s){ if(s.ts>r.meeting_created_ist) c.schemeIds[s.id]=1; });
  });
  return Object.keys(by).map(function(k){
    var c=by[k];
    c.called=Object.keys(c.callIds).length>0;
    c.walk=c.sysWalk || !!c.share;                                   // UNION, one per customer
    var docs=Object.keys(c.docs);
    c.sale=c.walk && docs.length>0;                                  // sale only for actual visitors
    c.revenue=c.sale?docs.reduce(function(a,d){return a+c.docs[d];},0):0;
    c.sku=c.sale?docs.reduce(function(a,d){return a+(+(MO&&MO.doc_lines[d])||0);},0):0;
    c.scheme=c.sale && Object.keys(c.schemeIds).length>0;            // no sale -> no scheme
    c.saleDocs=c.sale?docs:[];
    return c;
  });
}
function mjiAgg(rows){
  var cs=mjiCustomers(rows), a={sched:cs.length, called:0, mins:0, confirmed:0, show:0, convert:0, walk:0, sysWalk:0, shareOnly:0, sale:0, scheme:0, sku:0, rev:0}, seenCall={}, seenDoc={};
  cs.forEach(function(c){
    if(c.called) a.called++;
    Object.keys(c.callIds).forEach(function(id){ if(!seenCall[id]){ seenCall[id]=1; a.mins+=c.callSecBy[id]; } });   // seconds, each call once
    if(c.confirmed) a.confirmed++;
    if(c.show) a.show++;
    if(c.conv) a.convert++;
    if(c.walk){ a.walk++; if(c.sysWalk) a.sysWalk++; else a.shareOnly++; }
    if(c.sale){ a.sale++; c.saleDocs.forEach(function(d){ if(!seenDoc[d]){ seenDoc[d]=1; a.sku+=(+(MO&&MO.doc_lines[d])||0); a.rev+=c.docs[d]; } }); }
    if(c.scheme) a.scheme++;
  });
  a.conv=a.sched?100*a.sale/a.sched:0;                               // from aggregated counts, never averaged
  a.custs=cs;
  return a;
}
var MCOLS=[
  ['sched','Total Scheduled','Meetings whose From Date is in the selected range — the same count as Tab 2 (Expected Meetings). A customer with two meetings = 2.'],
  ['called','Called Customers','Scheduled meetings whose customer got ≥1 call (Outbound / Inbound, not Missed) after the meeting was created. 3 calls = 1.'],
  ['mins','Total Call Time','Sum of the durations of every valid call to those customers (each call once), shown as HH:MM:SS.'],
  ['confirmed','Confirmed','Scheduled meetings whose Zoho meeting field Confirmation = Confirmed (customer confirmed the visit on call), as marked by the team. Field exists since 30 Oct 2026.'],
  ['show','Show','Scheduled meetings whose Zoho meeting field Show_Status = Show (customer walked in), as marked by the team.'],
  ['convert','Convert','Scheduled meetings whose Zoho meeting field Conversion_Status = Converted (order converted), as marked by the team.'],
  ['walk','Store Walk-ins','Scheduled meetings whose customer has a walk-in in customer_walkin (POS walk-in register) matched on mobile (digits only, last 10) OR email, after meeting creation.'],
  ['sale','Customers With Sale','Walk-in meetings whose customer has a Marketing Sales invoice after meeting creation.'],
  ['conv','Sale / Meeting %','Customers With Sale ÷ Total Scheduled × 100 (from the totals, not an average of percentages).'],
  ['scheme','Scheme Enrolled','Meetings with a sale AND an ERP scheme enrolment (not cancelled) after meeting creation. No sale = not counted.'],
  ['sku','SKU Sold','Item lines on those customers’ invoices (marketing_sale is line-item grain; each invoice counted once even if the customer has two meetings).'],
  ['rev','Revenue','SUM(net_sale) of those invoices, each invoice counted once.']
];
function mcell(a,k){
  if(k==='conv') return a.conv.toFixed(1)+'%';
  if(k==='rev') return fmtMoneyFull(a.rev);
  if(k==='mins'){ var t=Math.round(a.mins), h=Math.floor(t/3600), m=Math.floor(t%3600/60), x=t%60; return (h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(x<10?'0':'')+x; }
  return fmtInt(a[k]);
}
function mjiTable(id,label,key,rows){
  var g={}; rows.forEach(function(r){ (g[r[key]]=g[r[key]]||[]).push(r); });
  var list=Object.keys(g).map(function(k){ return {k:k, a:mjiAgg(g[k])}; }), st=MSORT[id];
  list.sort(function(x,y){ if(st.k==='name') return x.k.localeCompare(y.k)*st.dir; return (x.a[st.k]-y.a[st.k])*st.dir || x.k.localeCompare(y.k); });
  var tot=mjiAgg(rows);
  function arr(k){ return st.k===k?'<span class="arr">'+(st.dir>0?'▲':'▼')+'</span>':''; }
  var head='<th data-msort="'+id+':name">'+label+arr('name')+'</th>'+MCOLS.map(function(c){ return '<th class="num" data-msort="'+id+':'+c[0]+'" data-tip="'+esc('<b>'+c[1]+'</b><br>'+c[2])+'">'+c[1]+arr(c[0])+'</th>'; }).join('');
  function tr(k,a){ return '<tr><td class="name" title="'+esc(k)+'">'+esc(k)+'</td>'+MCOLS.map(function(c){ return '<td class="num">'+mcell(a,c[0])+'</td>'; }).join('')+'</tr>'; }
  return '<h2 class="sec">'+label.toUpperCase()+'-WISE MEETING JOURNEY</h2><div class="card">'+
    '<div class="tbltools"><span class="muted small">'+fmtInt(list.length)+' rows · 1 unit = 1 scheduled meeting (same as Tab 2); call time, SKUs and revenue count each call / invoice once</span><span style="flex:1"></span><button class="btn" data-mcsv="'+id+'">⬇ CSV</button></div>'+
    '<div class="tblwrap" style="max-height:560px"><table class="t" id="mt_'+id+'"><thead><tr>'+head+'</tr></thead><tbody>'+
    (list.length?list.map(function(x){return tr(x.k,x.a);}).join(''):'<tr><td colspan="'+(MCOLS.length+1)+'" class="muted">No meetings scheduled in the selected range.</td></tr>')+
    '</tbody><tfoot>'+tr('Grand Total',tot)+'</tfoot></table></div></div>';
}
function mjiRows(){ return filtered('from'); }                         // same From Date + filters as Tab 2
function renderMJI(){
  var root=$('tab-mji');
  if(!DATA){ root.innerHTML='<div id="boot">Loading live data from BigQuery…</div>'; return; }
  if(!MO && !MO_ERR){ if(!MO_LOADING) loadMO(false); root.innerHTML='<div id="boot">Loading sales and scheme data…</div>'; return; }
  if(!MO){ root.innerHTML='<div class="banner err"><b>Sale / scheme data could not be loaded — no numbers are shown.</b><br>'+esc(MO_ERR)+'</div>'; return; }
  var rows=mjiRows(), f=F.from;
  var warn='';
  root.innerHTML='<h2 class="sec" style="margin-top:14px">MEETING JOURNEY INTELLIGENCE <span class="muted">· cohort = meetings whose <b>From Date</b> is in the selected range; everything after is what happened to those customers</span></h2>'+
    filterBar('from','mji')+warn+
    mjiTable('agent','Agent','k_jc',rows)+
    mjiTable('store','Store','k_store',rows)+
    '<div class="small muted" style="margin-top:10px">Sources: Zoho Meetings / Calls (CDC, 30 min) · customer_walkin (mobile or email) · marketing_sale · Pos.scheme_enrollment. Agent = JC (Deal Owner, else Meeting Created By). Store = meeting Store - Name (Zoho). Definitions in Help.</div>';
  wireFilters('from',root,'mji');
  $('mji_scope').innerHTML='Showing <b>'+fmtInt(rows.length)+'</b> meetings scheduled · From Date: '+(f.preset==='all'?'all dates':fmtDate(f.from)+' – '+fmtDate(f.to))+' (IST) · <span class="muted">shared with Tab 2</span>';
  root.querySelectorAll('[data-msort]').forEach(function(th){ th.onclick=function(){ var p=th.getAttribute('data-msort').split(':'), s=MSORT[p[0]]; if(s.k===p[1]) s.dir*=-1; else { s.k=p[1]; s.dir=p[1]==='name'?1:-1; } renderMJI(); }; });
  root.querySelectorAll('[data-mcsv]').forEach(function(b){ b.onclick=function(){
    var t=$('mt_'+b.getAttribute('data-mcsv')), out=[]; t.querySelectorAll('tr').forEach(function(tr){ var r=[]; tr.querySelectorAll('th,td').forEach(function(td){ r.push(td.textContent.replace(/[▲▼]/g,'').trim()); }); out.push(r); });
    download('meeting-journey-intelligence-'+b.getAttribute('data-mcsv')+'-wise-'+f.from+'_to_'+f.to+'.csv', csvOf(out)); }; });
  bindTips(root);
}
window.__mji=function(){ return {rows:mjiRows(), agg:mjiAgg(mjiRows()), shareHit:shareCaseHit}; };   // test hook

/* ---------------- Deals Funnel tab ----------------
   Data: /api/deal-funnel (view ds_imputed_reporting.zoho_deal_store_funnel_v), 1 row = 1 Zoho deal,
   loaded only when this tab is first opened. Every event counts only AFTER the deal's Created_Time. */
var DF=null, DF_LOADING=false, DF_ERR=null, dfLoadedAt=0;
function newDealFilter(){ var r=presetRange('thismonth'); return {preset:'thismonth', from:r[0], to:r[1], agent:[], scity:[], store:[], base:'connected'}; }   // multi-select: [] = All
var FD=newDealFilter();
var DSORT={agent:{k:'total',dir:-1}, store:{k:'total',dir:-1}};
function bool(v){ return v===true || v==='true'; }
function prepDeal(r){
  r.is_store_city=bool(r.is_store_city);
  // Hyderabad = store city from 3 Nov 2026 (store opening); the view's list does not have it yet.
  if(!r.store_city_group && cityGroup(r.city)==='Hyderabad'){ r.store_city_group='Hyderabad'; r.is_store_city=true; }
  r.k_agent=r.agent||'Unassigned';
  r.k_scity=r.store_city_group||'Non-Store City';
  r.k_store=r.store||'Non-Store City';
  r.connected_calls=num(r.connected_calls); r.calls_after=num(r.calls_after); r.walkins_after=num(r.walkins_after); r.store_visit_meetings=num(r.store_visit_meetings);
  r.sales_after=num(r.sales_after); r.sales_amount_after=num(r.sales_amount_after); r.schemes_after=num(r.schemes_after);
  r.sale_docs=r.sale_docs||[]; r.scheme_ids=r.scheme_ids||[];
  return r;
}
/* Store Visit = every Zoho meeting RAISED (Created_Time) in the date range, any meeting type.
   Agent / Store / Store City come from the linked deal; without a deal, from the meeting itself. */
var VENUE_CITY={BO1:'Mumbai',CS1:'Mumbai',LPN:'Delhi / Gurgaon',PV1:'Delhi / Gurgaon',N18:'Noida / Ghaziabad',PN1:'Pune',MAL:'Bangalore'};
function prepMeeting(m){
  if(!DF._byId){ DF._byId={}; DF._lbl={}; DF.rows.forEach(function(r){ DF._byId[r.deal_id]=r; if(r.store_code) DF._lbl[r.store_code]=r.store; }); }
  var d=m.deal_id?DF._byId[m.deal_id]:null;
  m.k_agent = d ? d.k_agent : (m.created_by||'Unassigned');
  m.k_store = m.venue_store ? (DF._lbl[m.venue_store]||m.venue_store) : (d ? d.k_store : 'Non-Store City');
  m.store_city_group = (d && d.store_city_group) || VENUE_CITY[m.venue_store] || null;
  m.k_scity = m.store_city_group || 'Non-Store City';
  m.is_store_city = !!m.store_city_group;
  return m;
}
function loadDeals(force){
  if(DF_LOADING) return; DF_LOADING=true;
  if(!DF){ $('tab-deals').innerHTML='<div id="boot">Loading deals from BigQuery…</div>'; }
  fetch('api/deal-funnel'+(force?'?refresh=1':''),FETCH_OPTS)
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
    .then(function(x){
      if(!x.ok || !x.j.ok){ DF_ERR=(x.j&&x.j.error)||'Unknown error'; }
      else { DF_ERR=x.j.refresh_error?('Latest refresh failed, showing previous load: '+x.j.refresh_error):null; DF=x.j; DF.rows=DF.rows.map(prepDeal); DF.meetings=(DF.meetings||[]).map(prepMeeting); dfLoadedAt=Date.now(); }
    })
    .catch(function(e){ DF_ERR=String(e); })
    .then(function(){ DF_LOADING=false; if(TAB==='deals') renderDeals(); });
}
/* Store City choices: '__store' / '__non' = the two groups, else one city; several = any of them */
function scityHit(r){ return !FD.scity.length || FD.scity.some(function(v){ return v==='__store'?r.is_store_city:(v==='__non'?!r.is_store_city:r.k_scity===v); }); }
function passDealFilters(r){
  var d=r.created_date; if(!d || d<FD.from || d>FD.to) return false;
  return msHas(FD.agent,r.k_agent) && scityHit(r) && msHas(FD.store,r.k_store);
}
function meetingsFiltered(){ return DF.meetings.filter(passDealFilters); }   // created_date = meeting raised date
function dealsFiltered(){ return DF.rows.filter(passDealFilters); }
/* Store Walk-in for a deal = the Meeting Journey Intelligence rule (Tab 4) with the deal as anchor:
   a walk-in in customer_walkin (mobile OR email) after deal creation. */
function dealShareHit(r){
  return null;                       // walk-ins come ONLY from Lucira_Prod.customer_walkin (user rule 2026-10-21)
  if(!r.mobile || !MO) return null;
  var today=todayIST(), c=r.created_date;
  return (MO.shareBy[r.mobile]||[]).filter(function(s){ return s.date && s.date>=c && s.date<=today && String(s.show||'').toLowerCase()!=='no show'; })[0]||null;
}
/* Funnel for a group of deals. Walk-in / Sale / Scheme are counted on the chosen base:
   'connected' = Store City deals with a connected call (>30s); 'store' = all Store City deals. */
function dealAgg(rows,mtgs){
  var a={total:rows.length, sc:0, conn:0, base:0, visit:(mtgs||[]).length, vconf:(mtgs||[]).filter(function(m){ return CONF_BY[m.meeting_id]==='Confirmed'; }).length, walk:0, sysWalk:0, shareOnly:0, sale:0, scheme:0, docs:{}, schemeIds:{}};
  rows.forEach(function(r){
    if(!r.is_store_city) return;
    a.sc++;
    var c=r.connected_calls>0; if(c) a.conn++;
    if(FD.base==='connected' && !c) return;
    a.base++;
    if(r.walkins_after){ a.walk++; a.sysWalk++; } else if(dealShareHit(r)){ a.walk++; a.shareOnly++; }   // UNION, one per deal
    if(r.sales_after){ a.sale++; r.sale_docs.forEach(function(s){ a.docs[s.doc]=+s.amt||0; }); }
    if(r.schemes_after){ a.scheme++; r.scheme_ids.forEach(function(id){ a.schemeIds[id]=1; }); }
  });
  a.connPct=pct(a.conn,a.sc); a.visitPct=pct(a.visit,a.conn); a.walkPct=pct(a.walk,a.base); a.salePct=pct(a.sale,a.base); a.schemePct=pct(a.scheme,a.base);
  a.invoices=Object.keys(a.docs).length;
  a.amount=Object.keys(a.docs).reduce(function(s,k){return s+a.docs[k];},0);
  a.schemesN=Object.keys(a.schemeIds).length;
  return a;
}
var DCOLS=[
  ['total','Total Deals','Every Zoho deal created in the range (after the Agent / Store filters).'],
  ['sc','Store City Deals','Deal city (Deal Address_City, else Contact Mailing_City) is Mumbai region, Pune, Delhi / Gurgaon, Noida / Ghaziabad or Bangalore.'],
  ['conn','Store Deals Connected','Store City deals with at least one call longer than 30 seconds after the deal was created.'],
  ['connPct','Connect %','Store Deals Connected ÷ Store City Deals.'],
  ['visit','Store Visit','Zoho CRM meetings RAISED in the selected date range (meeting Created Time, IST), every meeting type. Agent / store from the linked deal (store = the meeting’s Zoho Store - Name when filled).'],
  ['vconf','Visit Confirmed','Of those Store Visit meetings: the ones whose Zoho meeting field Confirmation = Confirmed (customer confirmed the visit on call). Field exists since 30 Oct 2026.'],
  ['walk','Store Walk-in','Deals in the base (connected store deals, or all store city deals per the toggle) whose customer has a walk-in in customer_walkin (POS walk-in register) matched on mobile (digits only, last 10) OR email, after deal creation — same rule as Meeting Journey Intelligence.'],
  ['sale','Sale','Deals in the base with an invoice (any channel) after deal creation.'],
  ['amount','Sale Amount','SUM(net_sale) of those invoices, each invoice counted once.'],
  ['scheme','Scheme Enrolled','Deals in the base whose customer enrolled in a scheme (ERP, not cancelled) after deal creation.'],
  ['schemePct','Scheme %','Scheme Enrolled ÷ base.']
];
function dcell(a,k){
  if(/Pct$/.test(k)) return fmtPct(a[k]);
  if(k==='amount') return fmtMoneyFull(a.amount);
  return fmtInt(a[k]);
}
function dealTable(id,label,groupKey,rows,mtgs){
  var g={}, gm={}; rows.forEach(function(r){ (g[r[groupKey]]=g[r[groupKey]]||[]).push(r); });
  mtgs.forEach(function(m){ (gm[m[groupKey]]=gm[m[groupKey]]||[]).push(m); if(!g[m[groupKey]]) g[m[groupKey]]=[]; });
  var list=Object.keys(g).map(function(k){ return {k:k, a:dealAgg(g[k],gm[k])}; });
  var st=DSORT[id], tail=function(k){ return /not assigned|^Non-Store|^Unassigned$/.test(k)?1:0; };
  list.sort(function(x,y){
    if(st.k==='name') return x.k.localeCompare(y.k)*st.dir;
    if(id==='store' && tail(x.k)!==tail(y.k)) return tail(x.k)-tail(y.k);   // real stores first
    var p=x.a[st.k], q=y.a[st.k]; if(p==null) p=-1; if(q==null) q=-1;
    return (p-q)*st.dir || x.k.localeCompare(y.k);
  });
  var tot=dealAgg(rows,mtgs), baseLbl=FD.base==='connected'?'connected store deals':'store city deals';
  function arr(k){ return st.k===k?'<span class="arr">'+(st.dir>0?'▲':'▼')+'</span>':''; }
  var head='<th data-dsort="'+id+':name">'+label+arr('name')+'</th>'+DCOLS.map(function(c){ return '<th class="num" data-dsort="'+id+':'+c[0]+'" data-tip="'+esc('<b>'+c[1]+'</b><br>'+c[2])+'">'+c[1]+arr(c[0])+'</th>'; }).join('');
  function tr(k,a){ return '<tr><td class="name" title="'+esc(k)+'">'+esc(k)+'</td>'+DCOLS.map(function(c){ var t=c[0]==='walk'&&a.walk?' data-tip="'+esc(fmtPct(a.walkPct)+' of base')+'"':''; return '<td class="num"'+t+'>'+dcell(a,c[0])+'</td>'; }).join('')+'</tr>'; }
  return '<div class="card" style="margin-top:14px"><h3>'+label+'-wise</h3><div class="desc">Store Visit = Zoho meetings raised in the date range. Sale / Scheme are counted on <b>'+baseLbl+'</b> (base = '+fmtInt(tot.base)+'). Click a header to sort.'+(id==='store'?' Deals with no store evidence in Mumbai / Delhi (two stores each) stay “not assigned” rather than being guessed; see Help for the store rule.':'')+'</div>'+
    '<div class="tbltools"><span class="muted small">'+fmtInt(list.length)+' '+label.toLowerCase()+'s</span><span style="flex:1"></span><button class="btn" data-dcsv="'+id+'">⬇ CSV</button></div>'+
    '<div class="tblwrap" style="max-height:520px"><table class="t" id="dt_'+id+'"><thead><tr>'+head+'</tr></thead><tbody>'+
    (list.length?list.map(function(x){return tr(x.k,x.a);}).join(''):'<tr><td colspan="'+(DCOLS.length+1)+'" class="muted">No deals in scope.</td></tr>')+
    '</tbody><tfoot>'+tr('Total',tot)+'</tfoot></table></div></div>';
}
function dOpts(key){ var s={}; DF.rows.forEach(function(r){ s[r[key]]=(s[r[key]]||0)+1; }); return Object.keys(s).sort(function(a,b){ return s[b]-s[a]||a.localeCompare(b); }); }
function renderDeals(){
  var root=$('tab-deals');
  if(!DF){
    if(DF_ERR){ root.innerHTML='<div class="banner err"><b>Deals could not be loaded — no numbers are shown.</b><br>'+esc(DF_ERR)+'</div>'; }
    else if(!DF_LOADING) loadDeals(false);
    return;
  }
  if(!MO && !MO_ERR && !MO_LOADING) loadMO(false);                    // Share Case rows for Store Walk-in
  var rows=dealsFiltered(), mtgs=meetingsFiltered(), a=dealAgg(rows,mtgs), baseLbl=FD.base==='connected'?'of connected':'of store deals';
  var moWarn='';
  var scityOpts=[['__store','Store City only'],['__non','Non-Store City only']].concat(['Mumbai','Pune','Delhi / Gurgaon','Noida / Ghaziabad','Bangalore','Hyderabad'].map(function(c){return [c,c];}));
  root.innerHTML=(DF_ERR?'<div class="banner err">'+esc(DF_ERR)+'</div>':'')+moWarn+
    '<div class="filters"><div class="datebadge">Date Filter: Deal Created Date (Store Visit: Meeting Raised Date)</div><div class="row">'+
    '<div class="fld" style="min-width:auto"><label>Range</label><div class="presets">'+PRESETS.map(function(x){return '<button data-dp="'+x[0]+'" class="'+(FD.preset===x[0]?'on':'')+'">'+x[1]+'</button>';}).join('')+'</div></div>'+
    '<div class="fld" style="min-width:120px"><label for="d_dfrom">From</label><input type="date" id="d_dfrom" value="'+(FD.preset==='all'?'':FD.from)+'"></div>'+
    '<div class="fld" style="min-width:120px"><label for="d_dto">To</label><input type="date" id="d_dto" value="'+(FD.preset==='all'?'':FD.to)+'"></div>'+
    '</div><div class="row" style="margin-top:10px">'+
    msBox('d_agent','Agent','agent',FD.agent,dOpts('k_agent').map(function(o){ return [o,o]; }))+
    msBox('d_scity','Store City','scity',FD.scity,scityOpts)+
    (restricted()?'':msBox('d_store','Store','store',FD.store,dOpts('k_store').map(function(o){ return [o,o]; })))+
    '<div class="fld" style="min-width:auto"><label>Sale / Scheme counted on</label><div class="seg"><button data-base="connected" class="'+(FD.base==='connected'?'on':'')+'">Connected store deals</button><button data-base="store" class="'+(FD.base==='store'?'on':'')+'">All store city deals</button></div></div>'+
    '<button class="linkbtn" data-dreset="1">Reset filters</button></div>'+
    '<div class="scope">Showing <b>'+fmtInt(rows.length)+'</b> of '+fmtInt(DF.rows.length)+' deals and <b>'+fmtInt(mtgs.length)+'</b> meetings · Deal Created Date / Meeting Raised Date: '+(FD.preset==='all'?'all dates':fmtDate(FD.from)+' – '+fmtDate(FD.to))+' (IST) · data refreshed '+fmtDT(DF.refreshed_at_ist)+' IST</div></div>'+
    '<h2 class="sec">Deals funnel <span class="muted">· every event counted strictly after the Deal Created Time</span></h2><div class="kpis">'+
      kpi('Total Deals',fmtInt(a.total),'created in range')+
      kpi('Store City Deals',fmtInt(a.sc),fmtPct(pct(a.sc,a.total))+' of total deals',DCOLS[1][2])+
      kpi('Store Deals Connected',fmtInt(a.conn),'call > 30 sec',DCOLS[2][2])+
      kpi('Connect %',fmtPct(a.connPct),'connected ÷ store city deals')+
      kpi('Store Visit',fmtInt(a.visit),'Zoho meetings raised in range (all types)',DCOLS[4][2])+
      kpi('Visit Confirmed',fmtInt(a.vconf),fmtPct(pct(a.vconf,a.visit))+' of store visit meetings · Zoho Confirmation',DCOLS[5][2])+
      kpi('Store Walk-in',fmtInt(a.walk),fmtPct(a.walkPct)+' '+baseLbl+' · customer_walkin',DCOLS[6][2])+
      kpi('Sale',fmtInt(a.sale),fmtPct(a.salePct)+' '+baseLbl+' · '+fmtInt(a.invoices)+' invoices',DCOLS[7][2])+
      kpi('Sale Amount',fmtMoney(a.amount),fmtMoneyFull(a.amount),DCOLS[8][2])+
      kpi('Scheme Enrolled',fmtInt(a.scheme),fmtPct(a.schemePct)+' '+baseLbl,DCOLS[9][2])+
    '</div>'+
    dealTable('agent','Agent','k_agent',rows,mtgs)+
    dealTable('store','Store','k_store',rows,mtgs)+
    '<div class="card" style="margin-top:14px"><h3>Deal-level data</h3><div class="desc">One row per deal in the current filters, with the call / Store Visit meeting / sale / scheme evidence behind every number above.</div><button class="btn" data-dcsv="deals">⬇ Export deals CSV ('+fmtInt(rows.length)+')</button></div>';
  root.querySelectorAll('[data-dp]').forEach(function(b){ b.onclick=function(){ var p=b.getAttribute('data-dp'); FD.preset=p; if(p!=='custom'){ var r=presetRange(p); FD.from=r[0]; FD.to=r[1]; } renderDeals(); }; });
  [['d_dfrom','from'],['d_dto','to']].forEach(function(x){ var el=$(x[0]); el.onchange=function(){ FD.preset='custom'; FD[x[1]]=el.value||(x[1]==='from'?'2000-01-01':'2100-12-31'); if(FD.from>FD.to){ var t=FD.from; FD.from=FD.to; FD.to=t; } renderDeals(); }; });
  msWire(root.querySelector('.filters'),function(k,v){ if(k==='store'){ setStores(v); renderAll(); } else { FD[k]=v; renderDeals(); } });
  root.querySelectorAll('[data-base]').forEach(function(b){ b.onclick=function(){ FD.base=b.getAttribute('data-base'); renderDeals(); }; });
  root.querySelector('[data-dreset]').onclick=function(){ FD=newDealFilter(); setStores([]); renderAll(); };
  root.querySelectorAll('[data-dsort]').forEach(function(th){ th.onclick=function(){ var p=th.getAttribute('data-dsort').split(':'), s=DSORT[p[0]]; if(s.k===p[1]) s.dir*=-1; else { s.k=p[1]; s.dir=p[1]==='name'?1:-1; } renderDeals(); }; });
  root.querySelectorAll('[data-dcsv]').forEach(function(b){ b.onclick=function(){ var w=b.getAttribute('data-dcsv'); if(w==='deals') exportDeals(rows); else exportDealTable(w); }; });
  bindTips(root);
}
function exportDealTable(id){
  var t=$('dt_'+id); if(!t) return; var out=[]; t.querySelectorAll('tr').forEach(function(tr){ var r=[]; tr.querySelectorAll('th,td').forEach(function(td){ r.push(td.textContent.replace(/[▲▼]/g,'').trim()); }); out.push(r); });
  download('deals-funnel-'+id+'-wise-'+FD.from+'_to_'+FD.to+'.csv', csvOf(out));
}
function exportDeals(rows){
  var h=['Deal ID','Deal Name','Deal Created (IST)','Agent','Stage','Customer','Mobile','City','City Source','Store City','Store City Group','Store','Store Source',
         'Calls After Creation','Connected Calls (>30s)','First Connected Call','Store Visit Meetings','First Store Visit Meeting Created','Store Visit Date','Walk-ins After (customer_walkin)','First Walk-in','Walk-in Store','Store Walk-in','Invoices After','Sale Amount','First Sale','Schemes After','Scheme Monthly Amount','First Scheme'];
  var out=[h].concat(rows.map(function(r){ return [r.deal_id,r.deal_name,r.created_ist,r.k_agent,r.deal_stage,r.customer_name,r.mobile,r.city,r.city_source,r.is_store_city?'YES':'NO',r.store_city_group,r.k_store,r.store_source,
    r.calls_after,r.connected_calls,r.first_connected_ist,r.store_visit_meetings,r.first_sv_created_ist,r.first_sv_date,r.walkins_after,r.first_walkin_ist,r.walkin_store,r.walkins_after?'YES':'NO',r.sales_after,r.sales_amount_after,r.first_sale_ist,r.schemes_after,r.scheme_monthly_amount,r.first_scheme_ist]; }));
  download('deals-funnel-deals-'+FD.from+'_to_'+FD.to+'.csv', csvOf(out));
}

/* ---------------- help tab (static + live figures) ---------------- */
function renderHelp(){
  var h=(DATA&&DATA.health)||[];
  function hrow(s){ return '<tr><td><b>'+esc(s.source)+'</b></td><td><code>'+esc(s.table||'')+'</code></td><td>'+esc(s.cadence||'')+'</td><td>'+(s.last_sync_ist?fmtDT(s.last_sync_ist)+' IST':'—')+'</td><td>'+esc(s.status)+'</td></tr>'; }
  $('tab-help').innerHTML='<div class="help">'+
  '<h2>1. Dashboard purpose</h2><p>This dashboard tracks the journey of every <b>Zoho CRM meeting</b> from the moment it is created: <b>Meeting Created → Call after creation? → Walk-in after creation? → Sale after creation?</b> Nothing else. Tab 1 groups meetings by <b>Meeting Created Date</b>; Tab 2 groups the same meetings by <b>From Date</b> (the date the customer is expected). In both tabs, calls / walk-ins / sales are always counted from the meeting’s <b>Created Time</b>.</p>'+
  '<p><b>Filters are multi-select.</b> Tick any number of values in a filter and press Apply (or click outside the list). Several values in one filter = rows matching <b>any</b> of them; different filters together = rows matching <b>all</b> of them. Nothing ticked (or everything ticked) = All.</p>'+
  '<h2>2. Data sources</h2><table><tr><th>Source</th><th>BigQuery table</th><th>Refresh cadence</th><th>Last write (live)</th><th>Status</th></tr>'+
    (h.length?h.map(hrow).join(''):'<tr><td colspan="5">Loading…</td></tr>')+
    '<tr><td><b>Zoho Contacts</b></td><td><code>zoho_crm.cdc_contacts</code></td><td>CDC sync every 30 min</td><td colspan="2">customer name + mobile fallback only</td></tr>'+
    '<tr><td><b>Zoho Leads</b></td><td><code>zoho_crm.zoho_leads</code></td><td>periodic load</td><td colspan="2">mobile fallback for Lead-linked meetings only</td></tr>'+
    '<tr><td><b>Store master</b></td><td><code>ornaverse_erp_master.company</code></td><td>ERP reference</td><td colspan="2">store code → store name</td></tr></table>'+
    '<p>All five are combined in one BigQuery view, <code>'+esc((DATA&&DATA.view)||'ds_imputed_reporting.zoho_meeting_journey_v')+'</code> (source SQL: <code>store-visit-intelligence-app/sql/meeting_journey_view.sql</code>). The Zoho tables are the same 30-minute CDC tables already used by the Hourly Deals vs Orders API; walk-ins come from the POS walk-in register <code>Lucira_Prod.customer_walkin</code>; sales follow the Hourly Deals vs Orders rule for <code>marketing_sale</code>.</p>'+
  '<div class="callout"><b>Deliberately NOT used.</b> This dashboard is intentionally simple: it reads Zoho CRM + store walk-ins + POS sales only. <b>GA4 — not used. PDP / product-view events — not used. Product views — not used. Website &amp; Shopify browsing data — not used. Website analytics — not used.</b> No web/behavioural source feeds any number on this page; if a metric is not derivable from the five sources above, it is not shown.</div>'+
  '<h2>3. KPI definitions</h2><table><tr><th>Metric</th><th>Definition</th></tr>'+
    '<tr><td>Meeting Created</td><td>Zoho Meeting <code>Created_Time</code> (stored with +05:30 offset) shown in IST. Meeting Created Date = its IST calendar date.</td></tr>'+
    '<tr><td>From Date</td><td>Zoho Meeting <code>Start_DateTime</code> in IST. All-day meetings (stored as 00:00 UTC) use their calendar date.</td></tr>'+
    '<tr><td>Call After Creation</td><td><code>Call_Start_Time &gt; Meeting Created_Time</code>. Counts Outbound + Inbound call logs. <b>Excluded:</b> planned CRM calls with status Scheduled / Overdue (never happened) and Missed calls (shown separately in the journey panel). Calls before creation are never counted.</td></tr>'+
    '<tr><td>Connected Call</td><td>A call after creation with <code>Call_Duration_in_seconds ≥ 30</code>.</td></tr>'+
    '<tr><td>Confirmed</td><td>Zoho meeting field <code>Confirmation</code> = <b>Confirmed</b> (picklist: Confirmed / Not Confirmed / Not Connected; blank = not marked by the team). Shown as a KPI and funnel step right after Connected (% = Confirmed ÷ Connected), a trend line, a column in Analysis by dimension, Store Performance, the Meetings table, the Store visits list, Meeting Journey Intelligence and (as Visit Confirmed) the Deals Funnel, plus a Confirmation filter. The field exists in Zoho only since 30 Oct 2026; the latest Zoho value always wins.</td></tr>'+
    '<tr><td>Total Talk Time</td><td>Sum of call durations after creation.</td></tr>'+
    '<tr><td>Previous Walk-in</td><td>Walk-in timestamp <code>&lt;</code> Meeting Created_Time. History only — never counted as a walk-in after creation.</td></tr>'+
    '<tr><td>Walk-in After Creation (Tabs 1–2)</td><td>The customer walked in if EITHER a <code>Lucira_Prod.customer_walkin</code> record (mobile or email match) has a timestamp <code>&gt;</code> Meeting Created_Time, OR the team marked the Zoho meeting <code>Show_Status</code> = <b>Show</b>. Zoho <b>No Show</b> with no walk-in-register record = not walked in; a walk-in-register record is kept even if Zoho says No Show. First walk-in date / store come from the register; register walk-ins shown as ×N.</td></tr>'+
    '<tr><td>Walk-ins (visit date) — Analysis by dimension</td><td>Store visits that <b>happened</b> in the selected date range, even when the meeting was raised earlier (meeting last week, visit yesterday = a walk-in under Yesterday). A visit = a <code>customer_walkin</code> record (mobile or email match) or a Zoho meeting marked <b>Show</b> (visit date = that meeting’s From Date). Each visit is mapped to the customer’s latest meeting created before it — that meeting’s JC / Store / Source decide the row. One visit per customer per day; a walk-in with no meeting before it is not counted.</td></tr>'+
    '<tr><td>Store visits list / Walk-in Dump</td><td>The “Store visits (1 row = 1 customer visit)” table above the Meetings table is the raw list behind Walk-ins (visit date): only customers who actually came to a store, so its row count = the Total of Walk-ins (visit date). Columns: visit date and time, evidence (walk-in register / Zoho Show), Zoho Show Status (Show / No Show / Not marked) and Zoho Conversion Status (Converted / Non-Converted / Not marked) of the mapped meeting, walk-in store, customer, the mapped meeting (JC, store, created, From Date, type), days from meeting to visit, and that visit’s invoices; the CSV adds Meeting ID / Deal ID. “View ▸” in the Walk-in Dump column of the Analysis-by-dimension table narrows the list to that row; “View ▸” on the Total row (or “Show all visits”) shows every visit again.</td></tr>'+
    '<tr><td>Invoice Qty / Walk-in Sale Value</td><td><b>The only sale figure on the KPIs, the Funnel and Analysis by dimension</b> (user rule 3 Nov 2026). Invoice Qty = unique <code>marketing_sale</code> invoices of the customers who <b>visited</b> a store in the selected range, dated on or after their visit day and within the range; Walk-in Sale Value = <code>SUM(net_sale)</code> of those invoices. Each invoice counted once. The meeting can be older than the range — e.g. a customer whose meeting was on 26 Sep, who visited and bought yesterday, counts under Yesterday. KPI sub-line: visitors who bought ÷ unique store visitors. The old meeting-based Sales / Sales Amount (invoices after creation of the meetings in the range) were removed from the KPIs and the table; the per-meeting Sale After Creation columns of the Meetings table are unchanged.</td></tr>'+
    '<tr><td>Sale After Creation</td><td><code>marketing_sale</code> invoices of the customer (mobile match) dated on or after the <b>day</b> the meeting was created — an order placed the same day a few minutes before the meeting was raised counts too. <b>Cancelled orders</b> (<code>Fullfillment = cancel_order</code>) are never counted. Invoice = distinct <code>document_no</code>; amount = <code>SUM(net_sale)</code> of its lines. <b>One invoice is shown on ONE meeting only</b>: when a customer has several meetings, the invoice goes to the meeting whose From Date is the latest one on or before the sale day (if every From Date is later, the earliest one; ties → the meeting created last). The other meeting shows no sale. Several different invoices of one customer can sit on the same meeting (×N).</td></tr>'+
    '<tr><td>Unique Customers</td><td>Distinct normalised mobile; if none, Deal ID; else Contact ID.</td></tr>'+
    '<tr><td>Store Visits (KPI)</td><td>Actual store visits whose <b>visit date</b> is in the selected range — the same number as the Total of “Walk-ins (visit date)” in Analysis by dimension and the row count of the Store visits list. A visit = a <code>customer_walkin</code> record (mobile or email match) or a Zoho meeting marked <b>Show</b> (visit day = its From Date), mapped to the customer’s latest meeting created before it; one per customer per day. Replaces the old “Show” KPI, which only counted meetings in the range marked Show in Zoho (that count is now in the Convert KPI’s hover). % under it = Store Visits ÷ Meetings.</td></tr>'+
    '<tr><td>Agreed to Reschedule</td><td>'+esc(TIP_RESCHED)+'</td></tr>'+
    '<tr><td>Cancelled by Customer</td><td>'+esc(TIP_CANCEL)+'</td></tr>'+
    '<tr><td>% under the KPIs</td><td>Meetings ÷ Store City Deals; Unique Customers ÷ Meetings; Called ÷ Meetings; Connected ÷ Called (and ÷ Meetings); Store Visits ÷ Meetings; walk-in customer KPIs ÷ Unique Customers; Convert and Visitors Not Converted ÷ unique store visitors.</td></tr>'+
    '<tr><td>Convert (KPI, Tabs 1–2)</td><td><b>Customers converted</b> (user rule 3 Nov 2026): unique customers who visited a store in the selected range (Store Visits) and placed at least one order — a <code>marketing_sale</code> invoice on or after the visit day, within the range. Their invoices = <b>Invoice Qty</b>, their value = <b>Walk-in Sale Value</b>. % = Convert ÷ unique store visitors. The Zoho meeting <code>Conversion_Status</code> = Converted count is only shown in the hover (on Tab 4 “Convert” is still that Zoho field).</td></tr>'+
    '<tr><td>Probability</td><td>Zoho Deal <b>Probability %</b> field (<code>Probability_Score</code>: 60 / 70 / 80 / 90 / 100 / 0) of the linked deal, from the 30-minute CDC feed, else the one-time backfill <code>zoho_crm.deals_probability_score_patch</code>. Zoho’s stage <code>Probability</code> field is not used — it is blank on every deal.</td></tr>'+
    '<tr><td>Journey Status</td><td>Priority order: <b>Walk-in - Sale</b> (walk-in and sale after creation) → <b>Walk-in - No Sale</b> → <b>Sale (No Walk-in)</b> → <b>Connected</b> (connected call, no walk-in/sale) → <b>Called</b> → <b>No Activity</b>. Meetings with no mobile, Deal ID or Contact ID are <b>Not Trackable (no customer ID)</b> rather than forced into “No Activity”.</td></tr>'+
    '<tr><td>Funnel</td><td><b>Deals Created</b> (count) → <b>Store City Deals</b> = 100% → <b>Meetings</b> ÷ Store City Deals → <b>Called</b> ÷ Meetings → <b>Connected</b> ÷ Called (dialled) → <b>Walk-in</b> (actual store visits in the range, = Store Visits KPI) ÷ Meetings → <b>Sale</b> (= Invoice Qty KPI: invoices of those visitors) ÷ Walk-in. Each bar shows its own base under the label. Deals and Store City Deals = Zoho deals whose Deal Created Date (IST) is in the range with the JC / City / Store / Stage / Trigger / Probability filters applied — the same numbers as the Total row of “Analysis by dimension”; hidden while a Meeting Type / Call / Confirmation / Walk-in / Sale filter is on. Deals, meetings and visits are each counted by their own date in the range (a meeting can be on an older deal, a visit on an older meeting), so the funnel is not a strict subset and a step can in rare cases exceed 100%.</td></tr>'+
    '<tr><td>JC</td><td>Deal Owner of the linked Deal. Meetings without a Deal use Meeting Created By (marked “Meeting Created By” in the journey panel).</td></tr>'+
    '<tr><td>City</td><td><b>Store city</b>, not the raw Zoho text: Deal <code>Address_City</code> is folded into the city of a Lucira store when it names that city or one of its areas — <b>Mumbai</b> (Mumbai, Thane, Navi Mumbai, Chembur, Borivali, Andheri, Kalyan, Vasai, Panvel …), <b>Pune</b> (incl. Pimpri-Chinchwad), <b>Noida / Ghaziabad</b>, <b>Delhi / Gurgaon</b> (Central / South / West / … Delhi, New Delhi, Faridabad, Gurgaon), <b>Bangalore</b> (Bengaluru, Bangalore Rural) and <b>Hyderabad</b> (Secunderabad, Rangareddy, Medchal, Gachibowli, Kukatpally … — added 3 Nov 2026, store opening; its deals count as Store City Deals). Every other city = <b>Other cities (no store)</b>. Same list as the Store City Deals rule. Blank Address_City = the city of the meeting’s store, else “Not Captured”. For deals the city is Address_City, else Contact Mailing_City, else the store on the deal’s Zoho meeting. The raw Address_City is shown in brackets in the Meetings table and the journey panel.</td></tr>'+
    '<tr><td>Store</td><td>The meeting’s own Zoho <b>Store - Name</b> field (<code>Store_Name</code>), exactly as the team selected it (e.g. “Malleshwaram Store” → MAL - Malleshwaram, “Chembur Store” → CS1 - Chembur, “Head Office” → HO). Only when Store - Name is blank — meetings raised before the field was in use (~22 Sep 2026) — is the free-text <code>Venue</code> used instead, matched by keyword (e.g. “Chembur”, “Borivali store”, “Bangalore” → MAL); a blank-Store-Name venue naming only Mumbai or Delhi shows as “Mumbai - store not assigned” / “Delhi / Gurgaon - store not assigned”. Nothing to go on = “Not Captured”. The journey panel shows which one was used, plus the raw Store - Name and Venue.</td></tr>'+
    '<tr><td>Total Deals / Store City Deals (Analysis by dimension)</td><td>Zoho deals created in the selected date range (Deal Created Date, IST) — the same deals as the Deals Funnel tab’s Total Deals — grouped by the deal’s own JC (Deal Owner), City (store city, see City), Stage, Trigger, Probability, Lead Source, UTM Source, or store (Deals Funnel store rule). All deals count, with or without a meeting. Store City Deals = deal city (Address_City, else Contact Mailing_City, else its meeting’s store) is a city where Lucira has a store — e.g. a Chembur or Borivali deal is a Mumbai deal and a Store City Deal, a Pune deal is a Store City Deal, a Chennai deal is not. <b>Deals Within 7 km / Deals 7 km &amp; Above / Deals No Pincode</b> = the <b>Store City Deals only</b> (user rule 4 Nov 2026 — the three add up to Store City Deals), split by the customer pincode (see Customer pincode below). Not split by Meeting Type (deals have none), and blank while a Meeting Type / Call / Confirmation / Walk-in / Sale filter is on (meeting-only filters).</td></tr>'+
    '<tr><td>All Store Walk-ins / Without Zoho meeting</td><td>Store Visits (KPI, Walk-ins column, Funnel) count only <b>meeting-led</b> visits. <b>All Store Walk-ins</b> adds every other POS walk-in register record (<code>Lucira_Prod.customer_walkin</code>) dated in the selected range: customers who had <b>no Zoho meeting</b> before the visit (one per customer per day; a customer-day already counted as a meeting-led visit — same mobile or email — is never counted twice). Each is tagged “Zoho deal, no meeting”, “Zoho deal created after the visit” (e.g. the deal the POS creates at billing) or “Not in Zoho CRM”. They are listed in the Store visits list (button “Without Zoho meeting”) and counted in Store Performance → Walk-ins Without Meeting, but not in the funnel, Convert or Invoice Qty. Register walk-ins land in BigQuery the next morning (03:30–07:30 IST), so today’s visits appear tomorrow.</td></tr>'+
    '<tr><td>Store Performance (table under Analysis by dimension)</td><td>One row per meeting store (Zoho meeting “Store - Name”), same date range and filters. <b>Meetings Raised</b> (Created tab) / <b>Expected Meetings</b> (From Date tab) = meetings of the store in the date filter. <b>Deals Within 7 km</b> = of those raised meetings, the ones whose deal customer pincode is within 7 km of any Lucira store; <b>Deals 7 km &amp; Above</b> = the other raised meetings (pincode farther than 7 km <b>plus</b> no pincode), so Within + Above = Meetings Raised. Head Office, “… store not assigned” and Not Captured rows are left out (not store names); Total = the stores shown. <b>Not Dialled</b> = meetings with no Outbound / Inbound call after the meeting was created (= Not Called KPI); <b>Dialled</b> = at least one such call (any duration); <b>Connected</b> = a call of 30 s or more. <b>Walk-ins (Show)</b> = store visits that happened in the range (walk-in register or Zoho Show), <b>Orders Converted</b> = their invoices (= Store Visits / Invoice Qty KPIs). <b>Call Activity</b> = total calls after meeting creation on the store’s meetings (every dial, not Missed) = sum of the “Call Activity” column of the Meetings table / CSV; <b>Avg Activity per Dialled</b> = Call Activity ÷ Dialled.</td></tr>'+
    '<tr><td>Deal Stage / Trigger / Probability</td><td>Zoho Deal <code>Stage</code>, <code>Deal_Trigger_Event</code> and <b>Probability %</b> (<code>Probability_Score</code>, see Probability) as-is. Blank = “Not Set”; meetings not linked to a Deal = “No Deal linked”.</td></tr>'+
    '<tr><td>Meeting Status</td><td>Zoho Meeting <code>Check_In_Status</code> (currently every meeting is PLANNED in Zoho).</td></tr>'+
    '<tr><td>Lead Source / UTM Source</td><td>Linked Deal’s <code>Lead_Source</code> and <code>UTM_Source</code> exactly as in Zoho (e.g. “facebook” and “FB” stay separate). Blank = “Not Set”; meetings not linked to a Deal = “No Deal linked”.</td></tr>'+
    '<tr><td>Within 7 km / 7 km &amp; Above / Pincode Not Available</td><td>(User rule 3 Nov 2026: 7 km replaces the old 5 km.) A meeting or deal is <b>Within 7 km</b> when the customer’s pincode is within 7 km of <b>any</b> Lucira store, <b>7 km &amp; Above</b> when the customer has a real pincode farther than that. <b>Customer pincode</b> (user rule 4 Nov 2026) = <b>first the Zoho Contact address</b>: a 6-digit pincode typed in the contact’s Mailing Flat / Street text (a Lucira store’s own address pasted there is skipped), else the contact’s <code>Mailing_Zip</code> — the meeting’s contact, else the deal’s contact, else a contact with the same mobile. <b>Only when the contact has none</b>: the Zoho Deal field <code>Address - Zip / Postal Code</code> (<code>Address_Zip_Postal_Code</code>, the same column as the Zoho Deals export) of the meeting’s deal, else of the customer’s latest deal (same mobile) that has one. (Zoho’s “Full Address” text field exists only on Deals / Leads, not Contacts, and is not in the CDC feed.) Every row shows which one was used (Contact / Deal). Digits only; a value that is not a 6-digit pincode (e.g. “20101”) counts as not available. The Zoho meeting <code>Pincode</code> and the customer’s sale / Shopify / walk-in record are shown in the journey panel for reference but not used. Note: this zip is filled automatically from the website visit, so a few city-level values (e.g. 400017 Mumbai, 110020 / 110001 Delhi, 562130 Bengaluru) are very common. <b>Km</b>: straight line from the store-locator pin to the pincode-area centre (area-weighted centre of the data.gov.in pincode polygon). Every pincode within 7 km of each store is listed with its km under “Store pincode check”; a pincode not on that list is more than 7 km from every store. Malleshwaram’s store pin is provisional. Customers with no pincode on record are <b>Pincode Not Available</b>, never 7 km &amp; Above, so Within + 7 km &amp; Above + Pincode Not Available = Meetings (or Deals). Caveat: the walk-in register sometimes holds the store’s own pincode instead of the customer’s.</td></tr>'+
  '</table>'+
  '<h2>3b. Deals Funnel tab (Tab 3)</h2><p>1 row = 1 Zoho deal (view <code>ds_imputed_reporting.zoho_deal_store_funnel_v</code>, source SQL <code>sql/deal_store_funnel_view.sql</code>). Date filter = Deal <code>Created_Time</code> (IST). Calls, walk-ins, sales and scheme enrolments count only when they happened <b>after</b> the deal was created.</p><table><tr><th>Metric</th><th>Definition</th></tr>'+
    '<tr><td>Total Deals</td><td>All deals created in the range.</td></tr>'+
    '<tr><td>Store City Deals</td><td>Deal <code>Address_City</code> (when blank: the linked Contact’s <code>Mailing_City</code>) in Mumbai region (incl. Thane, Navi Mumbai, suburbs), Pune, Delhi (incl. Faridabad, Gurgaon), Noida / Ghaziabad, Bangalore. When both are blank, the city of the store on the deal’s Zoho meeting (Store - Name) is used. Same city list as the Zoho Login dashboard’s “Store City Deals”. No city = Non-Store City.</td></tr>'+
    '<tr><td>Store Deals Connected</td><td>Store City deals with ≥1 call (not Missed, not Scheduled/Overdue) of duration <b>more than 30 seconds</b> after deal creation. Calls are matched by Deal ID, Contact ID or customer mobile.</td></tr>'+
    '<tr><td>Connect %</td><td>Store Deals Connected ÷ Store City Deals.</td></tr>'+
    '<tr><td>Store Visit / Sale / Scheme Enrolled</td><td>Sale and Scheme are counted on the base chosen in the filter bar: <b>Connected store deals</b> (default) or <b>All store city deals</b>. <b>Store Visit = every Zoho CRM Meeting (<code>zoho_crm.cdc_meetings</code>, any meeting type) RAISED in the selected date range</b> — by the meeting’s <code>Created_Time</code> (IST), not the deal’s, so “Yesterday” = meetings raised yesterday (e.g. 24 on 29 Sep 2026). It is not limited by the Sale / Scheme base. Agent, Store and Store City come from the linked deal (<code>What_Id</code>, or the contact’s latest deal for Contact-linked meetings); Store = the meeting’s Zoho Store - Name when filled. No Visit % is shown: visits are counted by meeting date and deals by deal date, so a ratio of the two would be misleading (it can exceed 100%). Zoho has no “visit done” flag in this feed, so a meeting booked for a future date also counts; Sale = invoice in <code>marketing_sale</code> after creation (any channel, Store + Online); Scheme Enrolled = <code>Pos.scheme_enrollment</code> (not cancelled) after creation, customer matched via ERP party mobile. Sale and Scheme are mobile matches.</td></tr>'+
    '<tr><td>Store Walk-in</td><td>Same rule as the Meeting Journey Intelligence tab, anchored on the deal: deals in the Sale / Scheme base whose customer has a walk-in in <code>Lucira_Prod.customer_walkin</code> (Head Office / Amazon excluded) after deal creation, matched on mobile OR email. No other walk-in source is used.</td></tr>'+
    '<tr><td>Agent</td><td>Deal Owner.</td></tr>'+
    '<tr><td>Store (Store-wise table)</td><td>Zoho <code>Store_Assigned</code> is empty, so the store is taken from evidence, strongest first: Store - Name of the deal’s Zoho meeting (Venue only if Store - Name is blank) → store of the first walk-in after creation → store of the first in-store sale → scheme store → the only store in the deal’s city (Pune → PN1, Bangalore → MAL, Noida / Ghaziabad → N18). Mumbai and Delhi have two stores each, so a deal there with no evidence is shown as “not assigned” instead of guessed.</td></tr></table>'+
  '<h2>3c. Meeting Journey Intelligence tab (Tab 4)</h2><p>Uses the <b>same From Date filter as Tab 2</b> (one shared filter state — changing it in either tab changes both). Cohort = meetings whose <b>Meeting From Date</b> is in the range; the tables show what happened to those customers afterwards. Grain = one scheduled meeting, so Total Scheduled always equals Tab 2’s Expected Meetings (a customer with two meetings in the range counts twice). Call time, SKUs and revenue count each call / invoice only once, even across a customer’s repeat meetings. Calls, walk-ins and sales come from the same per-meeting aggregates as Tabs 1–2 (strictly after Meeting Created Time), so nothing is joined raw and nothing multiplies.</p><table><tr><th>Column</th><th>Definition</th></tr>'+
    '<tr><td>Total Scheduled</td><td>Meetings with a From Date in range (= Tab 2 Expected Meetings).</td></tr>'+
    '<tr><td>Called Customers</td><td>Scheduled meetings whose customer had ≥1 call (Outbound / Inbound, not Missed, not Scheduled / Overdue) after the meeting was created — matched by Deal ID, Contact ID or mobile. Three calls = 1.</td></tr>'+
    '<tr><td>Total Call Time</td><td>Sum of all those calls’ durations, each call counted once per customer, shown as HH:MM:SS (hours can exceed 24).</td></tr>'+
    '<tr><td>Show</td><td>Meetings whose Zoho meeting field <code>Show_Status</code> = <b>Show</b> (customer walked in). Entered manually by the team on the meeting; blank / No Show = not counted. Older meetings read this field from the one-time backfill <code>zoho_crm.meetings_status_patch</code>.</td></tr>'+
    '<tr><td>Convert</td><td>Meetings whose Zoho meeting field <code>Conversion_Status</code> = <b>Converted</b> (order converted). Entered manually by the team on the meeting; independent of the <code>marketing_sale</code> invoice match used by the Sale KPIs.</td></tr>'+
    '<tr><td>Store Walk-ins</td><td>Scheduled meetings whose customer has a walk-in in <code>Lucira_Prod.customer_walkin</code> after meeting creation, matched on mobile OR email. No other walk-in source (no Share Case sheet) is used.</td></tr>'+
    '<tr><td>Customers With Sale</td><td><b>Walk-in</b> meetings whose customer has a <code>marketing_sale</code> invoice after meeting creation (mobile match). Sales without a walk-in are not counted.</td></tr>'+
    '<tr><td>Sale / Meeting %</td><td>Customers With Sale ÷ Total Scheduled × 100, computed from each row’s own totals (the Grand Total too) — never an average of percentages.</td></tr>'+
    '<tr><td>Scheme Enrolled</td><td>Meetings with a sale (above) <b>and</b> a <code>Pos.scheme_enrollment</code> record (not cancelled) after meeting creation, matched on the ERP party mobile. No sale → 0.</td></tr>'+
    '<tr><td>SKU Sold</td><td>Item lines on those customers’ invoices (<code>marketing_sale</code> is line-item grain; the table has no negative / return lines).</td></tr>'+
    '<tr><td>Revenue</td><td><code>SUM(net_sale)</code> of those invoices, each invoice once.</td></tr>'+
    '<tr><td>Agent</td><td>JC — the Deal Owner of the meeting’s deal, else Meeting Created By (the same Agent field as Tabs 1–2). Never changed by who made a call.</td></tr>'+
    '<tr><td>Store</td><td>Meeting’s Zoho Store - Name (same rule as Tabs 1–2). Never changed by where the sale was billed.</td></tr></table>'+
  '<h2>4. Join logic (no fan-out)</h2><ol><li>Build the <b>meeting base</b> (1 row per <code>cdc_meetings.id</code>) with its Deal, Contact and customer mobile.</li><li><b>Aggregate calls</b> per meeting (DISTINCT call id, so a call matched on two keys counts once).</li><li><b>Aggregate walk-ins</b> per meeting.</li><li><b>Aggregate sales</b> to invoice level, then per meeting.</li><li>LEFT JOIN the three aggregates back to the meeting base on <code>meeting_id</code>.</li></ol><p>Meeting × Calls × Walk-ins × Sales is never joined directly. Verified: the view returns exactly one row per meeting.</p>'+
  '<h2>5. Customer matching</h2><table><tr><th>Event</th><th>Match rule (strongest first)</th></tr>'+
    '<tr><td>Meeting → Deal</td><td><code>What_Id.id</code> when <code>$se_module = Deals</code>.</td></tr>'+
    '<tr><td>Customer mobile</td><td>First valid of: Deal.Mobile → Contact.Mobile → Contact.Phone → Lead.Mobile → Lead.Phone → meeting Who_Id name (when it is a phone number). Normalised to the last 10 digits and must be a valid Indian mobile (<code>^[6-9]\\d{9}$</code>).</td></tr>'+
    '<tr><td>Calls</td><td>Call <code>What_Id</code> = Deal ID, <b>or</b> call <code>Who_Id</code> = meeting/deal Contact ID, <b>or</b> normalised To / From / Dialled number = customer mobile. Most Zoho calls are logged against the Contact, not the Deal, so Deal ID alone would miss them. The key used is shown per call in the journey panel.</td></tr>'+
    '<tr><td>Walk-ins</td><td><code>customer_walkin.mobile</code> (spaces / +91 / dashes removed, last 10 digits) = customer mobile (Deal → Contact → Lead), <b>OR</b> <code>customer_walkin.email</code> (lower-case, trimmed; test@ and @lucirajewelry.com dropped) = customer email (Deal → Contact → Lead). A walk-in matched on both counts once. The table has no CRM ID.</td></tr>'+
    '<tr><td>Sales</td><td>Normalised <code>marketing_sale.Cus_mobile</code> (else <code>mobile1</code>) = customer mobile (the table has no Deal ID).</td></tr></table><p>Customer name is never used for matching.</p>'+
  '<h2>6. Date / time</h2><p>All comparisons use absolute timestamps; all display is IST (<code>Asia/Kolkata</code>), e.g. <b>'+fmtDT('2026-09-26T10:30:00')+'</b>. Zoho timestamps carry an explicit offset; <code>marketing_sale.document_date</code> is IST wall-clock. <b>Data correction:</b> <code>customer_walkin.date</code> is IST wall-clock, except legacy rows with <code>visit_type = 3</code> (imported history up to Jul 2026), which are 5 h 30 min ahead and are corrected by −5:30 (verified against matching POS invoice times). Date presets (Today, This Week = Monday start, etc.) use today’s IST date.</p>'+
  '<h2>7. Live data &amp; refresh</h2><p>The page reads <code>/api/journey</code> on this same service (login-protected). The server queries BigQuery and caches the result for '+Math.round(((DATA&&DATA.cache_ttl_sec)||600)/60)+' minutes; the page re-fetches automatically on that interval and the ↻ Refresh button forces a re-query (at most once a minute). “Last Refresh” in the header is when BigQuery was last queried. The Source Health pills show when each source was last written; a source older than its expected cadence turns amber and a warning banner appears. If the query fails, an error is shown instead of numbers.</p>'+
  '<h2>8. Performance</h2><p>One aggregated query per cache window (~240 MB scanned; the source tables are not partitioned, so no partition filter is possible). The browser never queries BigQuery; filtering of the ~'+fmtInt(ROWS.length)+' meeting rows happens in the page. No <code>SELECT *</code> and no cross joins.</p>'+
  '<h2>9. Known limitations</h2><ul>'+
    '<li><b>Walk-in source:</b> <code>Lucira_Prod.customer_walkin</code> (POS walk-in register; store = ERP company master code, Head Office / Amazon rows excluded). Loaded hourly (:30 past each hour), so walk-ins appear within about an hour. The previous dashboard’s <code>meetings_sheet_sync</code> sheet is not used: it has only 2 confirmed “Show” visits, none after April 2026, and only a date (no time), so it cannot answer “walk-in after meeting created”.</li>'+
    '<li>Walk-in and sale matching are mobile-only (no CRM ID exists in those tables).</li>'+
    '<li>Deal <code>Address_City</code> is blank for most meeting deals → large “Not Captured” city bucket.</li>'+
    '<li>Deal <code>Probability</code> is blank for most meeting deals → “Not Set”.</li>'+
    '<li>Calls, walk-ins and sales are counted from creation onward with no end date; a customer with several meetings can have the same later event attributed to each of those meetings (KPI invoice totals are de-duplicated).</li>'+
    '<li>Walk-ins at non-store codes <code>Amazon</code> and <code>HO</code> (head office) are excluded as not physical store visits.</li>'+
    '<li><b>Meeting Status is not available.</b> Zoho’s <code>Check_In_Status</code> reads <code>PLANNED</code> on every record in the module (check-in is never used), so it carries no information and is shown only in the journey panel, labelled as such. Zoho does have a real <code>Meeting_Status</code> picklist, but it is ~3% populated and is not carried in the CDC feed, so no Meeting Status filter or KPI is offered rather than showing a field that never changes.</li>'+
    '<li><b>Meeting Type is derived, not a picklist.</b> It is folded from the free-text meeting title, where the same intent appears in many spellings (“Store Visit”, “store visit”, “store vist”, “store viist”, “STORE VISIT” — 23 raw variants collapse to one). Rows whose title mentions “test” are grouped as <b>Test / Internal</b> so they are not counted as real store visits. The raw title is kept in the table and journey panel.</li></ul>'+
  '</div>';
}

/* ---------------- load ---------------- */
var loading=false;
function load(force){
  if(loading) return; loading=true; $('btnRefresh').disabled=true;
  fetch('api/journey'+(force?'?refresh=1':''),FETCH_OPTS)
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
    .then(function(x){
      if(!x.ok || !x.j.ok){ showFatal(x.j); return; }
      DATA=x.j; STORE_LABEL={}; ROWS=DATA.rows.map(prep); buildVisits(); markOutcomes();
      applyUrlStores();
      $('boot').hidden=true;
      renderHeader(); renderHelp(); renderTab('created'); renderTab('from'); showTab(TAB);
      if(DF && (force || Date.now()-dfLoadedAt>9*60*1000)) loadDeals(force);
      if(DD && (force || Date.now()-ddLoadedAt>9*60*1000)) loadDD(force);
      if(AW && (force || Date.now()-awLoadedAt>9*60*1000)) loadAW(force);
      if(MO && (force || Date.now()-moLoadedAt>9*60*1000)) loadMO(force);
      if(TAB==='mji') renderMJI();
    })
    .catch(function(e){ showFatal({error:String(e)}); })
    .then(function(){ loading=false; $('btnRefresh').disabled=false; });
}
function showFatal(j){
  $('boot').hidden=false;
  $('boot').innerHTML='<div class="banner err" style="text-align:left"><b>Live data could not be loaded — no numbers are shown to avoid misleading figures.</b><br>'+esc((j&&j.error)||'Unknown error')+'</div>';
  if(j&&j.health){ DATA=DATA||{}; DATA.health=j.health; DATA.refreshed_at_ist=j.refreshed_at_ist; renderHeader(); }
  ['created','from'].forEach(function(t){ $('tab-'+t).hidden=true; });
}
function showTab(t){
  TAB=t;
  document.querySelectorAll('#tabs button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-tab')===t); });
  ['created','from','help'].forEach(function(x){ $('tab-'+x).hidden = (x!==t) || (!DATA && x!=='help'); });
  $('tab-deals').hidden = t!=='deals';   // independent of /api/journey: has its own loader
  if(t==='deals') renderDeals();
  $('tab-mji').hidden = t!=='mji';
  if(t==='mji') renderMJI();
  try{ localStorage.setItem('mj_tab',t); }catch(e){}
}

document.addEventListener('DOMContentLoaded',function(){
  tip=$('tip');
  try{ var th=localStorage.getItem('mj_theme'); if(th) document.documentElement.setAttribute('data-theme',th); var st=localStorage.getItem('mj_tab'); if(st) TAB=st; }catch(e){}
  document.querySelectorAll('#tabs button').forEach(function(b){ b.onclick=function(){ showTab(b.getAttribute('data-tab')); }; });
  $('btnRefresh').onclick=function(){ load(true); };
  $('btnTheme').onclick=function(){
    var cur=document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
    var nx=cur==='dark'?'light':'dark'; document.documentElement.setAttribute('data-theme',nx); try{ localStorage.setItem('mj_theme',nx); }catch(e){} };
  $('dClose').onclick=closeJourney; $('drawerBg').onclick=closeJourney;
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') closeJourney(); });
  $('btnShare').onclick=function(){
    // the server signs the link for exactly the stores in the Store filter; the person who opens it
    // needs no login and sees only those stores
    var b=$('btnShare'), done=function(){ b.textContent='✓ Link copied'; setTimeout(function(){ b.textContent='🔗 Copy store link'; },1800); };
    fetch('api/store-link?stores='+encodeURIComponent(location.pathname.replace(/^\/+|\/+$/g,'')),FETCH_OPTS)
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(!j.ok){ alert(j.error||'Link could not be made.'); return; }
        var url=location.origin+j.path; window.__lastStoreLink=url;
        if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done,function(){ prompt('Copy this link',url); });
        else prompt('Copy this link',url);
      })
      .catch(function(e){ alert('Link could not be made: '+e); });
  };
  $('btnAccess').onclick=function(){ location.href='/access'; };
  renderHelp(); showTab(TAB);
  // who is logged in (store access) first, then the data -- a failed /api/me never blocks the page
  fetch('api/me',FETCH_OPTS).then(function(r){ return r.ok?r.json():null; }).catch(function(){ return null; })
    .then(function(me){ ME=me; renderMe(); load(false); });
  setInterval(function(){ load(false); }, 10*60*1000);
});
})();
