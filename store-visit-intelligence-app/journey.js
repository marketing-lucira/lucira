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
function newFilter(preset){ var r=presetRange(preset); return {preset:preset, from:r[0], to:r[1], jc:'', city:'', store:'', stage:'', trigger:'', prob:'', mtype:'', call:'', walk:'', sale:''}; }
var F={ created:newFilter('thismonth'), from:newFilter('today') };
var TBL={ created:{q:'',sort:'created_date',dir:-1,page:1}, from:{q:'',sort:'from_date',dir:1,page:1} };
var BD={ created:'jc', from:'jc' };
var PAGE_SIZE=25;

/* derived per-row dimension values (bucketed, never guessed) */
function prep(r){
  r.k_jc = r.jc || 'Unassigned';
  r.k_city = r.deal_city || 'Not Captured';
  r.k_store = r.store || 'Not Captured';
  r.k_stage = r.deal_stage || (r.deal_id?'Not Set':'No Deal linked');
  r.k_trigger = r.deal_trigger || (r.deal_id?'Not Set':'No Deal linked');
  r.k_prob = r.probability!=null ? r.probability+'%' : (r.deal_id?'Not Set':'No Deal linked');
  r.k_mstatus = r.meeting_status || 'Not Set';
  // Meeting Type folded from the free-text Event_Title in the view (23 raw spellings of
  // "Store Visit" collapse to one). This is the dimension worth filtering on -- Zoho's
  // Check_In_Status (k_mstatus) reads PLANNED on every record and carries no information.
  r.k_mtype = r.meeting_type_norm || 'Not Set';
  r.cust_key = r.mobile || (r.deal_id?'d:'+r.deal_id:(r.contact_id?'c:'+r.contact_id:'m:'+r.meeting_id));
  r.calls_after=num(r.calls_after); r.connected_calls=num(r.connected_calls); r.missed_calls=num(r.missed_calls);
  r.walkins_after=num(r.walkins_after); r.sales_after=num(r.sales_after); r.sales_amount_after=num(r.sales_amount_after);
  r.talk_time_sec=num(r.talk_time_sec);
  r.prev_walkin = r.prev_walkin===true || r.prev_walkin==='true';
  r.all_day = r.all_day===true || r.all_day==='true';
  r.from_sort = (r.from_date||'')+'T'+(r.from_ist?r.from_ist.slice(11):'00:00:00');
  if(r.meeting_store_code && r.store) STORE_LABEL[r.meeting_store_code]=r.store;
  r.calls=r.calls||[]; r.walkins=r.walkins||[]; r.sales=r.sales||[];
  return r;
}
function storeName(code){ return code ? (STORE_LABEL[code] || code) : '—'; }

function dateField(tab){ return tab==='created' ? 'meeting_created_date' : 'from_date'; }
function passNonDate(r,f){
  if(f.jc && r.k_jc!==f.jc) return false;
  if(f.city && r.k_city!==f.city) return false;
  if(f.store && r.k_store!==f.store) return false;
  if(f.stage && r.k_stage!==f.stage) return false;
  if(f.trigger && r.k_trigger!==f.trigger) return false;
  if(f.prob && r.k_prob!==f.prob) return false;
  if(f.mtype && r.k_mtype!==f.mtype) return false;
  if(f.call==='called' && !r.calls_after) return false;
  if(f.call==='notcalled' && r.calls_after) return false;
  if(f.call==='connected' && !r.connected_calls) return false;
  if(f.call==='notconnected' && (!r.calls_after || r.connected_calls)) return false;
  if(f.walk==='yes' && !r.walkins_after) return false;
  if(f.walk==='no' && r.walkins_after) return false;
  if(f.walk==='prev' && !r.prev_walkin) return false;
  if(f.sale==='yes' && !r.sales_after) return false;
  if(f.sale==='no' && r.sales_after) return false;
  return true;
}
function filtered(tab){
  var f=F[tab], df=dateField(tab);
  return ROWS.filter(function(r){ var d=r[df]; return d && d>=f.from && d<=f.to && passNonDate(r,f); });
}

/* ---------------- metrics (deduped across meetings) ---------------- */
function metrics(rows){
  var m={meetings:rows.length, called:0, connected:0, walk:0, sale:0, cust:{}, custWalk:{}, custSale:{}, callIds:{}, connIds:{}, docs:{}, notCalled:0, notWalked:0};
  rows.forEach(function(r){
    m.cust[r.cust_key]=1;
    if(r.calls_after){ m.called++; } else m.notCalled++;
    if(r.connected_calls) m.connected++;
    if(r.walkins_after){ m.walk++; m.custWalk[r.cust_key]=1; } else m.notWalked++;
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
function sel(id,label,key,val){
  return '<div class="fld"><label for="'+id+'">'+label+'</label><select id="'+id+'" data-k="'+key+'"><option value="">All</option>'+
    opts('k_'+key).map(function(o){return '<option'+(o===val?' selected':'')+'>'+esc(o)+'</option>';}).join('')+'</select></div>';
}
function sel2(id,label,key,val,choices){
  return '<div class="fld"><label for="'+id+'">'+label+'</label><select id="'+id+'" data-k="'+key+'">'+
    choices.map(function(c){return '<option value="'+c[0]+'"'+(c[0]===val?' selected':'')+'>'+c[1]+'</option>';}).join('')+'</select></div>';
}
function filterBar(tab){
  var f=F[tab], p=tab+'_';
  var dlabel = tab==='created' ? 'Meeting Created Date' : 'From Date';
  return '<div class="filters"><div class="datebadge">Date Filter: '+dlabel+'</div><div class="row">'+
    '<div class="fld" style="min-width:auto"><label>Range</label><div class="presets">'+PRESETS.map(function(x){return '<button data-p="'+x[0]+'" class="'+(f.preset===x[0]?'on':'')+'">'+x[1]+'</button>';}).join('')+'</div></div>'+
    '<div class="fld" style="min-width:120px"><label for="'+p+'dfrom">From</label><input type="date" id="'+p+'dfrom" value="'+(f.preset==='all'?'':f.from)+'"></div>'+
    '<div class="fld" style="min-width:120px"><label for="'+p+'dto">To</label><input type="date" id="'+p+'dto" value="'+(f.preset==='all'?'':f.to)+'"></div>'+
    '</div><div class="row" style="margin-top:10px">'+
    sel(p+'jc','JC','jc',f.jc)+sel(p+'city','City','city',f.city)+sel(p+'store','Store','store',f.store)+
    sel(p+'stage','Deal Stage','stage',f.stage)+sel(p+'trigger','Deal Trigger','trigger',f.trigger)+sel(p+'prob','Probability','prob',f.prob)+
    sel(p+'mtype','Meeting Type','mtype',f.mtype)+
    sel2(p+'call','Call Status','call',f.call,[['','All'],['called','Called after creation'],['notcalled','Not called'],['connected','Connected (≥30s)'],['notconnected','Called, not connected']])+
    sel2(p+'walk','Walk-in Status','walk',f.walk,[['','All'],['yes','Walk-in after creation'],['no','No walk-in after creation'],['prev','Had previous walk-in']])+
    sel2(p+'sale','Sale Status','sale',f.sale,[['','All'],['yes','Sale after creation'],['no','No sale after creation']])+
    '<button class="linkbtn" data-reset="1">Reset filters</button></div><div class="scope" id="'+p+'scope"></div></div>';
}
function wireFilters(tab,root){
  var f=F[tab];
  root.querySelectorAll('.presets button').forEach(function(b){ b.onclick=function(){
    var p=b.getAttribute('data-p'); f.preset=p;
    if(p!=='custom'){ var r=presetRange(p); f.from=r[0]; f.to=r[1]; }
    TBL[tab].page=1; renderTab(tab); }; });
  [['dfrom','from'],['dto','to']].forEach(function(x){ var el=$(tab+'_'+x[0]); el.onchange=function(){
    f.preset='custom'; f[x[1]]=el.value||(x[1]==='from'?'2000-01-01':'2100-12-31'); TBL[tab].page=1; renderTab(tab); }; });
  root.querySelectorAll('.filters select').forEach(function(s){ s.onchange=function(){ f[s.getAttribute('data-k')]=s.value; TBL[tab].page=1; renderTab(tab); }; });
  root.querySelector('[data-reset]').onclick=function(){ F[tab]=newFilter(tab==='created'?'thismonth':'today'); TBL[tab].page=1; renderTab(tab); };
}

/* ---------------- KPI cards ---------------- */
function kpi(l,v,s,t){ return '<div class="kpi"'+(t?' data-tip="'+esc(t)+'"':'')+'><div class="l">'+l+'</div><div class="v">'+v+'</div><div class="s">'+(s||'&nbsp;')+'</div></div>'; }
function kpisCreated(m){
  return '<div class="kpis">'+
    kpi('Meetings Created',fmtInt(m.meetings),'in selected range','Zoho CRM meetings whose Created_Time (IST) falls in the selected range and filters.')+
    kpi('Unique Customers',fmtInt(m.uniqueCust),'by normalised mobile','Distinct customers: normalised 10-digit mobile, else Deal ID / Contact ID.')+
    kpi('Meetings Called',fmtInt(m.called),fmtPct(pct(m.called,m.meetings))+' of meetings · '+fmtInt(m.callsN)+' calls','Meetings with ≥1 call (Outbound/Inbound, not Missed) whose Call_Start_Time > Meeting Created_Time.')+
    kpi('Connected',fmtInt(m.connected),fmtPct(pct(m.connected,m.meetings))+' of meetings · '+fmtInt(m.connCallsN)+' calls ≥30s','Meetings with ≥1 call of duration ≥ 30 seconds after meeting creation.')+
    kpi('Customers With Walk-in',fmtInt(m.custWalkN),fmtPct(pct(m.custWalkN,m.uniqueCust))+' of customers · after creation','Unique customers with a store walk-in timestamp > Meeting Created_Time.')+
    kpi('Customers Without Walk-in',fmtInt(m.uniqueCust-m.custWalkN),fmtPct(pct(m.uniqueCust-m.custWalkN,m.uniqueCust))+' of customers')+
    kpi('Customers With Sale',fmtInt(m.custSaleN),fmtPct(pct(m.custSaleN,m.uniqueCust))+' of customers · after creation','Unique customers with a marketing_sale invoice timestamp > Meeting Created_Time.')+
    kpi('Customers Without Sale',fmtInt(m.uniqueCust-m.custSaleN),fmtPct(pct(m.uniqueCust-m.custSaleN,m.uniqueCust))+' of customers')+
    kpi('Total Sales',fmtInt(m.salesN),'unique invoices after creation','Distinct marketing_sale document_no, counted once even if the customer has several meetings.')+
    kpi('Total Sales Amount',fmtMoney(m.salesAmt),fmtMoneyFull(m.salesAmt),'SUM(net_sale) over the unique invoices above.')+
  '</div>';
}
function kpisToday(m){
  return '<div class="kpis">'+
    kpi('Expected Today',fmtInt(m.meetings),fmtInt(m.uniqueCust)+' customers')+
    kpi('Called',fmtInt(m.called),fmtPct(pct(m.called,m.meetings))+' · after creation')+
    kpi('Not Called',fmtInt(m.notCalled),fmtPct(pct(m.notCalled,m.meetings)))+
    kpi('Connected',fmtInt(m.connected),fmtPct(pct(m.connected,m.meetings))+' · ≥30s')+
    kpi('Walk-in',fmtInt(m.walk),fmtPct(pct(m.walk,m.meetings))+' · after creation')+
    kpi('Not Walked-in',fmtInt(m.notWalked),fmtPct(pct(m.notWalked,m.meetings)))+
    kpi('Sale',fmtInt(m.sale),fmtInt(m.salesN)+' invoices')+
    kpi('Sales Amount',fmtMoney(m.salesAmt),fmtMoneyFull(m.salesAmt))+
  '</div>';
}

/* ---------------- funnel + status + trend ---------------- */
function hbars(items,denLabel){
  var max=Math.max.apply(null,items.map(function(i){return i.v;}).concat([1]));
  return items.map(function(i){
    var w=100*i.v/max;
    return '<div class="hbar" data-tip="'+esc('<b>'+i.l+'</b><br>'+fmtInt(i.v)+(i.p!=null?' · '+fmtPct(i.p)+' '+denLabel:'')+(i.p2!=null?'<br>'+fmtPct(i.p2)+' of previous stage':'')+(i.note?'<br>'+i.note:''))+'">'+
      '<div class="lab">'+esc(i.l)+'</div><div class="track"><div class="fill" style="width:'+w.toFixed(2)+'%"></div></div>'+
      '<div class="val"><b>'+fmtInt(i.v)+'</b>'+(i.p!=null?' <span class="muted">'+fmtPct(i.p)+'</span>':'')+'</div></div>';
  }).join('');
}
function funnelCard(m,title){
  var st=[{l:title,v:m.meetings},{l:'Called',v:m.called},{l:'Connected',v:m.connected},{l:'Walk-in',v:m.walk},{l:'Sale',v:m.sale}];
  st.forEach(function(s,i){ s.p=pct(s.v,m.meetings); if(i) s.p2=pct(s.v,st[i-1].v); });
  return '<div class="card"><h3>Funnel</h3><div class="desc">Count of meetings reaching each stage <b>after meeting creation</b>. % = share of <b>'+esc(title)+'</b> (denominator = '+fmtInt(m.meetings)+'). Stages are independent flags (a customer can walk in without a logged call), so this is not a strict subset funnel.</div>'+hbars(st,'of '+title.toLowerCase())+'</div>';
}
var STATUS_ORDER=['No Activity','Called','Connected','Walk-in - No Sale','Walk-in - Sale','Sale (No Walk-in)','Not Trackable (no customer ID)'];
function statusCard(rows){
  var c={}; rows.forEach(function(r){ c[r.journey_status]=(c[r.journey_status]||0)+1; });
  var items=STATUS_ORDER.filter(function(s){return c[s];}).map(function(s){ return {l:s, v:c[s], p:pct(c[s],rows.length)}; });
  return '<div class="card"><h3>Journey Status</h3><div class="desc">One status per meeting (highest stage reached after creation). % of meetings in scope.</div>'+(items.length?hbars(items,'of meetings'):'<div class="muted">No meetings in scope.</div>')+'</div>';
}
function trendCard(rows,field,title){
  // group by day (or ISO week if range > 62 days)
  var days=rows.map(function(r){return r[field];}).filter(Boolean).sort();
  if(!days.length) return '<div class="card trend"><h3>'+esc(title)+'</h3><div class="muted">No meetings in scope.</div></div>';
  var f=days[0], l=days[days.length-1], span=(new Date(l)-new Date(f))/864e5+1, weekly=span>62;
  var key=function(d){ return weekly?weekStart(d):d; };
  var b={}; rows.forEach(function(r){ var d=r[field]; if(!d) return; var k=key(d); var o=b[k]=b[k]||{n:0,called:0,conn:0,walk:0,sale:0};
    o.n++; if(r.calls_after) o.called++; if(r.connected_calls) o.conn++; if(r.walkins_after) o.walk++; if(r.sales_after) o.sale++; });
  var keys=[], k=key(f); while(k<=l){ keys.push(k); k=addDays(k,weekly?7:1); }
  var W=900,H=220,pl=34,pr=8,pt=10,pb=26, iw=W-pl-pr, ih=H-pt-pb, max=Math.max.apply(null,keys.map(function(k){return b[k]?b[k].n:0;}).concat([1]));
  var step=niceStep(max), top=Math.ceil(max/step)*step, bw=iw/keys.length, gap=Math.min(2,bw*0.2);
  var svg='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="'+esc(title)+'"><g class="grid">';
  for(var v=0; v<=top; v+=step){ var y=pt+ih-ih*v/top; svg+='<line x1="'+pl+'" x2="'+(W-pr)+'" y1="'+y+'" y2="'+y+'"/>'; }
  svg+='</g><g class="axis">';
  for(v=0; v<=top; v+=step){ svg+='<text x="'+(pl-6)+'" y="'+(pt+ih-ih*v/top+3)+'" text-anchor="end">'+v+'</text>'; }
  var every=Math.ceil(keys.length/10);
  keys.forEach(function(k,i){ if(i%every===0) svg+='<text x="'+(pl+bw*i+bw/2)+'" y="'+(H-8)+'" text-anchor="middle">'+fmtDate(k).replace(/ \d{4}$/,'')+'</text>'; });
  svg+='</g>';
  keys.forEach(function(k,i){ var o=b[k]||{n:0,called:0,conn:0,walk:0,sale:0}, h=ih*o.n/top, x=pl+bw*i+gap/2, y=pt+ih-h;
    var t='<b>'+(weekly?'Week of ':'')+fmtDate(k)+'</b><br>Meetings: <b>'+o.n+'</b><br>Called: '+o.called+'<br>Connected: '+o.conn+'<br>Walk-in: '+o.walk+'<br>Sale: '+o.sale;
    svg+='<g class="b" data-tip="'+esc(t)+'"><rect class="hit" x="'+(pl+bw*i)+'" y="'+pt+'" width="'+bw+'" height="'+ih+'"/>'+
      (o.n?'<rect class="bar" x="'+x+'" y="'+y+'" width="'+Math.max(1,bw-gap)+'" height="'+h+'" rx="'+Math.min(4,(bw-gap)/2)+'"/>':'')+'</g>'; });
  svg+='</svg>';
  return '<div class="card trend"><h3>'+esc(title)+'</h3><div class="desc">Meetings per '+(weekly?'week (Mon start)':'day')+'. Hover a bar for Called / Connected / Walk-in / Sale counts.</div>'+svg+'</div>';
}
function niceStep(max){ var raw=max/4, p=Math.pow(10,Math.floor(Math.log10(raw||1))), n=raw/p; return Math.max(1,(n<=1?1:n<=2?2:n<=5?5:10)*p); }

/* ---------------- breakdown tables ---------------- */
var DIMS=[['jc','JC','k_jc'],['city','City','k_city'],['stage','Deal Stage','k_stage'],['trigger','Deal Trigger','k_trigger'],['prob','Probability','k_prob'],['store','Store','k_store'],['mtype','Meeting Type','k_mtype']];
function breakdownCard(tab,rows){
  var cur=BD[tab], d=DIMS.filter(function(x){return x[0]===cur;})[0], mlabel=tab==='created'?'Meetings':'Expected Meetings';
  var g={}; rows.forEach(function(r){ (g[r[d[2]]]=g[r[d[2]]]||[]).push(r); });
  var list=Object.keys(g).map(function(k){ var m=metrics(g[k]); return {k:k,m:m}; });
  list.sort(function(a,b){ return b.m.meetings-a.m.meetings || a.k.localeCompare(b.k); }); // by volume only -- no ranking/scoring
  var tot=metrics(rows);
  function tr(k,m,foot){ return '<tr>'+(foot?'<td>':'<td title="'+esc(k)+'">')+esc(k)+'</td><td class="num">'+fmtInt(m.meetings)+'</td><td class="num">'+fmtInt(m.called)+'</td><td class="num">'+fmtInt(m.connected)+'</td><td class="num">'+fmtInt(m.walk)+'</td><td class="num">'+fmtInt(m.salesN)+'</td><td class="num">'+fmtMoneyFull(m.salesAmt)+'</td></tr>'; }
  return '<div class="card breakdowns"><h3>Analysis by dimension</h3><div class="desc">Actual counts only (no ranking or scoring; ordered by meeting volume). Called / Connected / Walk-ins = meetings with that event after creation. Sales = unique invoices after creation; Sales Amount = SUM(net_sale) of those invoices.</div>'+
    '<div class="tabsm">'+DIMS.map(function(x){return '<button data-bd="'+x[0]+'" class="'+(x[0]===cur?'on':'')+'">'+x[1]+'</button>';}).join('')+'<span style="flex:1"></span><button class="btn" data-bdcsv="1">⬇ CSV</button></div>'+
    '<div class="tblwrap" style="max-height:420px"><table class="t" id="'+tab+'_bd"><thead><tr><th>'+d[1]+'</th><th class="num">'+mlabel+'</th><th class="num">Called</th><th class="num">Connected</th><th class="num">Walk-ins</th><th class="num">Sales</th><th class="num">Sales Amount</th></tr></thead><tbody>'+
    list.map(function(x){return tr(x.k,x.m);}).join('')+'</tbody><tfoot>'+tr('Total',tot,true)+'</tfoot></table></div></div>';
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
  meeting_id:{l:'Meeting ID',v:function(r){return r.meeting_id;}},
  deal_id:{l:'Deal ID',v:function(r){return r.deal_id;}},
  deal_name:{l:'Deal Name',v:function(r){return r.deal_name;}},
  jc:{l:'JC',v:function(r){return r.k_jc;}},
  city:{l:'City',v:function(r){return r.k_city;}},
  store:{l:'Store',v:function(r){return r.k_store;}},
  stage:{l:'Deal Stage',v:function(r){return r.k_stage;}},
  trigger:{l:'Deal Trigger',v:function(r){return r.k_trigger;}},
  prob:{l:'Probability',v:function(r){return r.k_prob;},s:'probability'},
  mtype:{l:'Meeting Type',v:function(r){return r.k_mtype;}},
  calls:{l:'Calls After Creation',v:function(r){return r.calls_after;},n:1},
  conn:{l:'Connected Calls',v:function(r){return r.connected_calls;},n:1},
  first_call:{l:'First Call',v:function(r){return fmtDT(r.first_call_ist);},s:'first_call_ist'},
  last_call:{l:'Last Call',v:function(r){return fmtDT(r.last_call_ist);},s:'last_call_ist'},
  talk:{l:'Total Talk Time',v:function(r){return fmtDur(r.talk_time_sec);},s:'talk_time_sec',n:1},
  prev_walk:{l:'Previous Walk-in Before Meeting',v:function(r){return r.prev_walkin?'YES':'NO';},f:function(r){return yn(r.prev_walkin);}},
  prev_walk_date:{l:'Previous Walk-in Date',v:function(r){return fmtDT(r.prev_walkin_ist);},s:'prev_walkin_ist'},
  walk:{l:'Walk-in After Creation',v:function(r){return r.walkins_after?'YES':'NO';},f:function(r){return yn(r.walkins_after)+(r.walkins_after>1?' <span class="muted">×'+r.walkins_after+'</span>':'');},s:'walkins_after'},
  walk_date:{l:'Walk-in Date',v:function(r){return fmtDT(r.first_walkin_ist);},s:'first_walkin_ist'},
  walk_store:{l:'Walk-in Store',v:function(r){return r.first_walkin_store_code?storeName(r.first_walkin_store_code):'—';}},
  sale:{l:'Sale After Creation',v:function(r){return r.sales_after?'YES':'NO';},f:function(r){return yn(r.sales_after)+(r.sales_after>1?' <span class="muted">×'+r.sales_after+'</span>':'');},s:'sales_after'},
  sale_date:{l:'Sale Date',v:function(r){return fmtDT(r.first_sale_ist);},s:'first_sale_ist'},
  sale_amt:{l:'Sale Amount',v:function(r){return r.sales_after?r.sales_amount_after:null;},f:function(r){return r.sales_after?fmtMoneyFull(r.sales_amount_after):'—';},s:'sales_amount_after',n:1},
  status:{l:'Journey Status',v:function(r){return r.journey_status;},f:function(r){return stBadge(r.journey_status);}}
};
var COLS={
  created:['created_date','created_time','from_date','customer','mobile','meeting_id','deal_id','deal_name','jc','city','store','stage','trigger','prob','mtype','calls','conn','first_call','last_call','talk','prev_walk','prev_walk_date','walk','walk_date','walk_store','sale','sale_date','sale_amt','status'],
  from:['from_date','created_date','created_time','customer','mobile','meeting_id','deal_id','jc','city','store','stage','trigger','prob','mtype','calls','conn','last_call','prev_walk','walk','walk_date','sale','sale_date','sale_amt','status']
};
function sortVal(r,c){ var s=C[c].s; if(s) return r[s]; return C[c].v(r); }
function tableRows(tab,rows){
  var t=TBL[tab], q=t.q.toLowerCase();
  if(q) rows=rows.filter(function(r){ return [r.customer_name,r.mobile,r.meeting_id,r.deal_id,r.deal_name,r.k_jc,r.k_city,r.k_store,r.k_stage,r.k_trigger,r.meeting_title,r.venue,r.journey_status].join(' ').toLowerCase().indexOf(q)>=0; });
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
  var t=$(tab+'_bd'); if(!t) return; var out=[]; t.querySelectorAll('tr').forEach(function(tr){ var r=[]; tr.querySelectorAll('th,td').forEach(function(td){ r.push(td.textContent.trim()); }); out.push(r); });
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
  var sales=r.sales.map(function(s){ return '<tr><td>'+fmtDT(s.ts)+'</td><td>'+esc(s.doc)+'</td><td>'+esc(storeName(s.store))+' · '+esc(s.channel||'')+'</td><td class="num">'+fmtMoneyFull(+s.amount)+'</td></tr><tr><td colspan="4" class="muted small">SKU: '+esc(s.skus||'—')+'</td></tr>'; }).join('');
  $('dBody').innerHTML=
    '<div class="step"><h4>Meeting Created</h4>'+kv([
      ['Created',fmtDT(r.meeting_created_ist)+' IST'],['From Date',fmtDate(r.from_date)+(r.all_day?' (all day)':' '+fmtTime(r.from_ist))],
      ['Title (raw)',esc(dash(r.meeting_title))],['Meeting Type',esc(r.k_mtype)],['Check-in status',esc(r.k_mstatus)+' <span class="muted small">(Zoho check-in is unused &mdash; always PLANNED)</span>'],['Location',esc(dash(r.meeting_location))],
      ['Store (Venue)',esc(r.k_store)+(r.venue&&r.store&&r.store.indexOf('Unmapped')<0?' <span class="muted">(“'+esc(r.venue)+'”)</span>':'')],
      ['Meeting Owner',esc(dash(r.meeting_owner))],['Created By',esc(dash(r.meeting_created_by))],['Related To',esc(dash(r.related_module))],
      ['JC',esc(r.k_jc)+' <span class="muted">('+esc(r.jc_source)+')</span>'],['Deal',esc(dash(r.deal_name))+(r.deal_id?' <span class="muted">'+esc(r.deal_id)+'</span>':'')],
      ['Deal Stage / Trigger',esc(r.k_stage)+' · '+esc(r.k_trigger)],['Probability',esc(r.k_prob)],['City',esc(r.k_city)],
      ['Lead Source / Campaign',esc(dash(r.lead_source))+' · '+esc(dash(r.campaign_source||r.utm_campaign))],['Deal Created',fmtDT(r.deal_created_ist)],
      ['Mobile source',esc(dash(r.mobile_source))]])+'</div>'+
    '<div class="arrow">↓</div>'+
    '<div class="step"><h4>Call</h4>'+kv([
      ['Called',r.calls_after?'<span class="yes">Called</span>':'<span class="no">Not Called</span>'],
      ['Connected (≥30s)',r.connected_calls?'<span class="yes">Connected</span>':'<span class="no">Not Connected</span>'],
      ['Call count',fmtInt(r.calls_after)+' calls · '+fmtInt(r.connected_calls)+' connected'+(r.missed_calls?' · '+r.missed_calls+' missed':'')],
      ['Talk time',fmtDur(r.talk_time_sec)],['First / Last call',fmtDT(r.first_call_ist)+' → '+fmtDT(r.last_call_ist)]])+
      (calls?'<table class="mini"><tr><th>When (IST)</th><th>Type</th><th>Duration</th><th>By</th><th>Matched on</th></tr>'+calls+'</table>':'<div class="small muted" style="margin-top:6px">No calls after meeting creation.</div>')+'</div>'+
    '<div class="arrow">↓</div>'+
    '<div class="step"><h4>Walk-in</h4>'+kv([
      ['Previous walk-in',r.prev_walkin?'<span class="yes">YES</span> · '+fmtDT(r.prev_walkin_ist)+' · '+esc(storeName(r.prev_walkin_store_code)):'<span class="no">NO</span>'],
      ['Walk-in after creation',r.walkins_after?'<span class="yes">YES</span> ('+r.walkins_after+')':'<span class="no">NO</span>'],
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
  var root=$('tab-created'), rows=filtered('created'), m=metrics(rows);
  root.innerHTML=filterBar('created')+
    '<h2 class="sec">Key metrics <span class="muted">· everything counted strictly after Meeting Created Time</span></h2>'+kpisCreated(m)+
    '<div class="grid2" style="margin-top:14px">'+funnelCard(m,'Meetings Created')+statusCard(rows)+'</div>'+
    '<div style="margin-top:14px">'+trendCard(rows,'meeting_created_date','Meetings created over time')+'</div>'+
    '<div style="margin-top:14px">'+breakdownCard('created',rows)+'</div>'+
    '<div style="margin-top:14px">'+tableCard('created',rows)+'</div>';
  wireCommon('created',root,rows);
}
function renderFrom(){
  var root=$('tab-from'), rows=filtered('from'), m=metrics(rows);
  root.innerHTML=
    filterBar('from')+
    '<h2 class="sec">Selected From Date range</h2>'+kpisToday(m).replace('Expected Today','Expected Meetings')+
    '<div class="grid2" style="margin-top:14px">'+funnelCard(m,'Expected Meetings')+statusCard(rows)+'</div>'+
    '<div style="margin-top:14px">'+trendCard(rows,'from_date','Expected meetings by From Date')+'</div>'+
    '<div style="margin-top:14px">'+breakdownCard('from',rows)+'</div>'+
    '<div style="margin-top:14px">'+tableCard('from',rows)+'</div>';
  wireCommon('from',root,rows);
}
function wireCommon(tab,root,rows){
  wireFilters(tab,root);
  $(tab+'_scope').innerHTML=scopeText(tab,rows);
  root.querySelectorAll('[data-bd]').forEach(function(b){ b.onclick=function(){ BD[tab]=b.getAttribute('data-bd'); renderTab(tab); }; });
  root.querySelector('[data-bdcsv]').onclick=function(){ exportBreakdown(tab); };
  root.querySelector('[data-csv]').onclick=function(){ exportTable(tab,rows); };
  root.querySelectorAll('th[data-sort]').forEach(function(th){ th.onclick=function(){ var k=th.getAttribute('data-sort'), t=TBL[tab]; if(t.sort===k) t.dir*=-1; else { t.sort=k; t.dir=1; } renderTab(tab); }; });
  root.querySelectorAll('[data-pg]').forEach(function(b){ b.onclick=function(){ TBL[tab].page+=+b.getAttribute('data-pg'); renderTab(tab); }; });
  var q=$(tab+'_q'); q.oninput=function(){ TBL[tab].q=q.value; TBL[tab].page=1; var pos=q.selectionStart; renderTab(tab); var q2=$(tab+'_q'); q2.focus(); try{q2.setSelectionRange(pos,pos);}catch(e){} };
  root.querySelectorAll('tr[data-mid]').forEach(function(tr){ tr.onclick=function(){ openJourney(tr.getAttribute('data-mid')); }; });
  bindTips(root);
}
function renderTab(tab){ if(tab==='created') renderCreated(); else if(tab==='from') renderFrom(); }

/* ---------------- help tab (static + live figures) ---------------- */
function renderHelp(){
  var h=(DATA&&DATA.health)||[];
  function hrow(s){ return '<tr><td><b>'+esc(s.source)+'</b></td><td><code>'+esc(s.table||'')+'</code></td><td>'+esc(s.cadence||'')+'</td><td>'+(s.last_sync_ist?fmtDT(s.last_sync_ist)+' IST':'—')+'</td><td>'+esc(s.status)+'</td></tr>'; }
  $('tab-help').innerHTML='<div class="help">'+
  '<h2>1. Dashboard purpose</h2><p>This dashboard tracks the journey of every <b>Zoho CRM meeting</b> from the moment it is created: <b>Meeting Created → Call after creation? → Walk-in after creation? → Sale after creation?</b> Nothing else. Tab 1 groups meetings by <b>Meeting Created Date</b>; Tab 2 groups the same meetings by <b>From Date</b> (the date the customer is expected). In both tabs, calls / walk-ins / sales are always counted from the meeting’s <b>Created Time</b>.</p>'+
  '<h2>2. Data sources</h2><table><tr><th>Source</th><th>BigQuery table</th><th>Refresh cadence</th><th>Last write (live)</th><th>Status</th></tr>'+
    (h.length?h.map(hrow).join(''):'<tr><td colspan="5">Loading…</td></tr>')+
    '<tr><td><b>Zoho Contacts</b></td><td><code>zoho_crm.cdc_contacts</code></td><td>CDC sync every 30 min</td><td colspan="2">customer name + mobile fallback only</td></tr>'+
    '<tr><td><b>Zoho Leads</b></td><td><code>zoho_crm.zoho_leads</code></td><td>periodic load</td><td colspan="2">mobile fallback for Lead-linked meetings only</td></tr>'+
    '<tr><td><b>Store master</b></td><td><code>ornaverse_erp_master.company</code></td><td>ERP reference</td><td colspan="2">store code → store name</td></tr></table>'+
    '<p>All five are combined in one BigQuery view, <code>'+esc((DATA&&DATA.view)||'ds_imputed_reporting.zoho_meeting_journey_v')+'</code> (source SQL: <code>store-visit-intelligence-app/sql/meeting_journey_view.sql</code>). The Zoho tables are the same 30-minute CDC tables already used by the Hourly Deals vs Orders API; walk-ins are the same <code>Walkin_marge</code> table used by Walk-in Source Intelligence; sales follow the Hourly Deals vs Orders rule for <code>marketing_sale</code>.</p>'+
  '<div class="callout"><b>Deliberately NOT used.</b> This dashboard is intentionally simple: it reads Zoho CRM + store walk-ins + POS sales only. <b>GA4 — not used. PDP / product-view events — not used. Product views — not used. Website &amp; Shopify browsing data — not used. Website analytics — not used.</b> No web/behavioural source feeds any number on this page; if a metric is not derivable from the five sources above, it is not shown.</div>'+
  '<h2>3. KPI definitions</h2><table><tr><th>Metric</th><th>Definition</th></tr>'+
    '<tr><td>Meeting Created</td><td>Zoho Meeting <code>Created_Time</code> (stored with +05:30 offset) shown in IST. Meeting Created Date = its IST calendar date.</td></tr>'+
    '<tr><td>From Date</td><td>Zoho Meeting <code>Start_DateTime</code> in IST. All-day meetings (stored as 00:00 UTC) use their calendar date.</td></tr>'+
    '<tr><td>Call After Creation</td><td><code>Call_Start_Time &gt; Meeting Created_Time</code>. Counts Outbound + Inbound call logs. <b>Excluded:</b> planned CRM calls with status Scheduled / Overdue (never happened) and Missed calls (shown separately in the journey panel). Calls before creation are never counted.</td></tr>'+
    '<tr><td>Connected Call</td><td>A call after creation with <code>Call_Duration_in_seconds ≥ 30</code>.</td></tr>'+
    '<tr><td>Total Talk Time</td><td>Sum of call durations after creation.</td></tr>'+
    '<tr><td>Previous Walk-in</td><td>Walk-in timestamp <code>&lt;</code> Meeting Created_Time. History only — never counted as a walk-in after creation.</td></tr>'+
    '<tr><td>Walk-in After Creation</td><td>Walk-in timestamp <code>&gt;</code> Meeting Created_Time. First walk-in date / store shown; Total Walk-ins After Creation shown as ×N.</td></tr>'+
    '<tr><td>Sale After Creation</td><td><code>marketing_sale</code> invoice timestamp (<code>document_date</code>, IST) <code>&gt;</code> Meeting Created_Time. Invoice = distinct <code>document_no</code>; amount = <code>SUM(net_sale)</code> of its lines. Sale Amount in the table = all invoices after creation for that meeting.</td></tr>'+
    '<tr><td>Unique Customers</td><td>Distinct normalised mobile; if none, Deal ID; else Contact ID.</td></tr>'+
    '<tr><td>Total Sales / Amount (KPI)</td><td>Distinct invoices across the filtered meetings — an invoice is counted once even when the same customer has several meetings.</td></tr>'+
    '<tr><td>Journey Status</td><td>Priority order: <b>Walk-in - Sale</b> (walk-in and sale after creation) → <b>Walk-in - No Sale</b> → <b>Sale (No Walk-in)</b> → <b>Connected</b> (connected call, no walk-in/sale) → <b>Called</b> → <b>No Activity</b>. Meetings with no mobile, Deal ID or Contact ID are <b>Not Trackable (no customer ID)</b> rather than forced into “No Activity”.</td></tr>'+
    '<tr><td>Funnel %</td><td>Each stage ÷ Meetings in scope (denominator stated on the chart). “% of previous stage” in the hover. Stages are independent flags, not a strict subset.</td></tr>'+
    '<tr><td>JC</td><td>Deal Owner of the linked Deal. Meetings without a Deal use Meeting Created By (marked “Meeting Created By” in the journey panel).</td></tr>'+
    '<tr><td>City</td><td>Deal <code>Address_City</code> exactly as in Zoho; blank = “Not Captured” (never guessed).</td></tr>'+
    '<tr><td>Store</td><td>Meeting <code>Venue</code> (free text) mapped to an ERP store code by keyword (e.g. “chembur”, “Chmebur”, “Chembur Store” → CS1 Chembur). Venues that match no store show as “Unmapped: &lt;venue&gt;”. The raw Venue is kept in the journey panel.</td></tr>'+
    '<tr><td>Deal Stage / Trigger / Probability</td><td>Zoho Deal <code>Stage</code>, <code>Deal_Trigger_Event</code>, <code>Probability</code> as-is. Blank = “Not Set”; meetings not linked to a Deal = “No Deal linked”.</td></tr>'+
    '<tr><td>Meeting Status</td><td>Zoho Meeting <code>Check_In_Status</code> (currently every meeting is PLANNED in Zoho).</td></tr>'+
  '</table>'+
  '<h2>4. Join logic (no fan-out)</h2><ol><li>Build the <b>meeting base</b> (1 row per <code>cdc_meetings.id</code>) with its Deal, Contact and customer mobile.</li><li><b>Aggregate calls</b> per meeting (DISTINCT call id, so a call matched on two keys counts once).</li><li><b>Aggregate walk-ins</b> per meeting.</li><li><b>Aggregate sales</b> to invoice level, then per meeting.</li><li>LEFT JOIN the three aggregates back to the meeting base on <code>meeting_id</code>.</li></ol><p>Meeting × Calls × Walk-ins × Sales is never joined directly. Verified: the view returns exactly one row per meeting.</p>'+
  '<h2>5. Customer matching</h2><table><tr><th>Event</th><th>Match rule (strongest first)</th></tr>'+
    '<tr><td>Meeting → Deal</td><td><code>What_Id.id</code> when <code>$se_module = Deals</code>.</td></tr>'+
    '<tr><td>Customer mobile</td><td>First valid of: Deal.Mobile → Contact.Mobile → Contact.Phone → Lead.Mobile → Lead.Phone → meeting Who_Id name (when it is a phone number). Normalised to the last 10 digits and must be a valid Indian mobile (<code>^[6-9]\\d{9}$</code>).</td></tr>'+
    '<tr><td>Calls</td><td>Call <code>What_Id</code> = Deal ID, <b>or</b> call <code>Who_Id</code> = meeting/deal Contact ID, <b>or</b> normalised To / From / Dialled number = customer mobile. Most Zoho calls are logged against the Contact, not the Deal, so Deal ID alone would miss them. The key used is shown per call in the journey panel.</td></tr>'+
    '<tr><td>Walk-ins</td><td>Normalised <code>Walkin_marge.phone</code> = customer mobile (the table has no CRM ID).</td></tr>'+
    '<tr><td>Sales</td><td>Normalised <code>marketing_sale.Cus_mobile</code> (else <code>mobile1</code>) = customer mobile (the table has no Deal ID).</td></tr></table><p>Customer name is never used for matching.</p>'+
  '<h2>6. Date / time</h2><p>All comparisons use absolute timestamps; all display is IST (<code>Asia/Kolkata</code>), e.g. <b>'+fmtDT('2026-09-26T10:30:00')+'</b>. Zoho timestamps carry an explicit offset; <code>marketing_sale.document_date</code> is IST wall-clock. <b>Data correction:</b> <code>Walkin_marge.walkin_date</code> is 5 h 30 min ahead of the matching POS invoice time (verified on 1,002 exact walk-in ↔ invoice matches, all +330 min), so walk-in IST = <code>walkin_date − 5:30</code>. Date presets (Today, This Week = Monday start, etc.) use today’s IST date.</p>'+
  '<h2>7. Live data &amp; refresh</h2><p>The page reads <code>/api/journey</code> on this same service (login-protected). The server queries BigQuery and caches the result for '+Math.round(((DATA&&DATA.cache_ttl_sec)||600)/60)+' minutes; the page re-fetches automatically on that interval and the ↻ Refresh button forces a re-query (at most once a minute). “Last Refresh” in the header is when BigQuery was last queried. The Source Health pills show when each source was last written; a source older than its expected cadence turns amber and a warning banner appears. If the query fails, an error is shown instead of numbers.</p>'+
  '<h2>8. Performance</h2><p>One aggregated query per cache window (~240 MB scanned; the source tables are not partitioned, so no partition filter is possible). The browser never queries BigQuery; filtering of the ~'+fmtInt(ROWS.length)+' meeting rows happens in the page. No <code>SELECT *</code> and no cross joins.</p>'+
  '<h2>9. Known limitations</h2><ul>'+
    '<li><b>Walk-in source:</b> <code>Walkin_marge</code> (store footfall, used by Walk-in Source Intelligence) is loaded once a day (~06:30 IST), so walk-ins from today appear tomorrow. The previous dashboard’s <code>meetings_sheet_sync</code> sheet is not used: it has only 2 confirmed “Show” visits, none after April 2026, and only a date (no time), so it cannot answer “walk-in after meeting created”.</li>'+
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
  fetch('api/journey'+(force?'?refresh=1':''),{credentials:'same-origin',cache:'no-store'})
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
    .then(function(x){
      if(!x.ok || !x.j.ok){ showFatal(x.j); return; }
      DATA=x.j; STORE_LABEL={}; ROWS=DATA.rows.map(prep);
      $('boot').hidden=true;
      renderHeader(); renderHelp(); renderTab('created'); renderTab('from'); showTab(TAB);
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
  renderHelp(); showTab(TAB);
  load(false);
  setInterval(function(){ load(false); }, 10*60*1000);
});
})();
