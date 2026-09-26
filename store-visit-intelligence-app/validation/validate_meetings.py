"""Independent validation of zoho_meeting_journey_v against RAW source rows.

Picks real meetings covering each required case, then recomputes calls / walk-ins / sales
in Python from raw cdc_calls / Walkin_marge / marketing_sale rows (not from the view) and
compares with what the view (and therefore the dashboard) reports.
Run from store-visit-intelligence-app/:  python validation/validate_meetings.py
"""
import datetime as dt
import json
import re

from google.cloud import bigquery

bq = bigquery.Client(project="lucirajewelry-prod")
V = "lucirajewelry-prod.ds_imputed_reporting.zoho_meeting_journey_v"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


def q(sql, **params):
    qp = [bigquery.ArrayQueryParameter(k, "STRING", v) if isinstance(v, list) else bigquery.ScalarQueryParameter(k, "STRING", v)
          for k, v in params.items()]
    return list(bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=qp)).result())


CASES = {
    "1 no call": "calls_after = 0 AND mobile IS NOT NULL",
    "2 one call": "calls_after = 1",
    "3 multiple calls": "calls_after >= 3",
    "4 previous walk-in": "prev_walkin",
    "5 walk-in after, no sale": "walkins_after > 0 AND sales_after = 0",
    "6 sale after": "sales_after > 0",
    "7 walk-in + sale": "walkins_after > 0 AND sales_after > 0",
    "8 sale, no walk-in": "sales_after > 0 AND walkins_after = 0",
    "9 different JC": "jc = 'Sheetal Parve' AND calls_after > 0",
    "10 city/stage/trigger": "deal_city IS NOT NULL AND deal_stage = 'Closed Won' AND deal_trigger IS NOT NULL",
    "11 call before creation": (
        "meeting_id IN (SELECT m.id FROM `lucirajewelry-prod.zoho_crm.cdc_meetings` m "
        "JOIN `lucirajewelry-prod.zoho_crm.cdc_calls` c ON JSON_VALUE(c.data,'$.What_Id.id') = JSON_VALUE(m.data,'$.What_Id.id') "
        "WHERE TIMESTAMP(JSON_VALUE(c.data,'$.Call_Start_Time')) < m.created_time)"),
}
picked, used = [], set()
for name, cond in CASES.items():
    rows = q(f"SELECT meeting_id FROM `{V}` WHERE {cond} ORDER BY meeting_created_ist DESC LIMIT 6")
    mid = next((r.meeting_id for r in rows if r.meeting_id not in used), None)
    if mid:
        picked.append((name, mid))
        used.add(mid)
ids = [m for _, m in picked]

view = {r.meeting_id: r for r in q(f"""
  SELECT meeting_id, customer_name, mobile, deal_id, contact_id, jc, deal_city, deal_stage, deal_trigger,
    calls_after, connected_calls, talk_time_sec, first_call_ist, prev_walkin, prev_walkin_ist, walkins_after,
    first_walkin_ist, sales_after, sales_amount_after, first_sale_ist, journey_status
  FROM `{V}` WHERE meeting_id IN UNNEST(@ids)""", ids=ids)}
meet = {r.id: r for r in q("SELECT id, created_time FROM `lucirajewelry-prod.zoho_crm.cdc_meetings` WHERE id IN UNNEST(@ids)", ids=ids)}
mobiles = sorted({v.mobile for v in view.values() if v.mobile})
deals = sorted({v.deal_id for v in view.values() if v.deal_id})
contacts = sorted({v.contact_id for v in view.values() if v.contact_id})

N10 = r"RIGHT(REGEXP_REPLACE(IFNULL({},''),r'\D',''),10)"
raw_calls = q(f"""
  SELECT id, JSON_VALUE(data,'$.Call_Start_Time') st, JSON_VALUE(data,'$.Call_Duration_in_seconds') dur,
    JSON_VALUE(data,'$.Call_Type') typ, JSON_VALUE(data,'$.Outgoing_Call_Status') ost,
    JSON_VALUE(data,'$.What_Id.id') w, JSON_VALUE(data,'$.Who_Id.id') wh,
    JSON_VALUE(data,'$.To_Number__s') tn, JSON_VALUE(data,'$.From_Number__s') fn, JSON_VALUE(data,'$.Dialled_Number') dn
  FROM `lucirajewelry-prod.zoho_crm.cdc_calls`
  WHERE JSON_VALUE(data,'$.What_Id.id') IN UNNEST(@d) OR JSON_VALUE(data,'$.Who_Id.id') IN UNNEST(@c)
     OR {N10.format("JSON_VALUE(data,'$.To_Number__s')")} IN UNNEST(@m)
     OR {N10.format("JSON_VALUE(data,'$.From_Number__s')")} IN UNNEST(@m)
     OR {N10.format("JSON_VALUE(data,'$.Dialled_Number')")} IN UNNEST(@m)""", d=deals, c=contacts, m=mobiles)
raw_walk = q(f"""SELECT phone, walkin_date, store_code FROM `lucirajewelry-prod.ds_imputed_reporting.Walkin_marge`
  WHERE event_name='StoreVisit' AND {N10.format('phone')} IN UNNEST(@m)""", m=mobiles)
raw_sale = q(f"""SELECT document_no, document_date, net_sale, Cus_mobile, mobile1 FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale`
  WHERE {N10.format('COALESCE(Cus_mobile, mobile1)')} IN UNNEST(@m)""", m=mobiles)


def n10(s):
    return re.sub(r"\D", "", s or "")[-10:]


def fmt(t):
    return t.astimezone(IST).strftime("%d %b %Y %I:%M %p") if t else "-"


results = []
for name, mid in picked:
    v, created = view[mid], meet[mid].created_time
    cs = {c.id: c for c in raw_calls
          if (c.w and c.w == v.deal_id) or (c.wh and c.wh == v.contact_id) or (v.mobile and v.mobile in (n10(c.tn), n10(c.fn), n10(c.dn)))}.values()
    before = [c for c in cs if dt.datetime.fromisoformat(c.st) <= created]
    after = [c for c in cs if dt.datetime.fromisoformat(c.st) > created and c.typ != "Missed" and (c.ost or "") not in ("Scheduled", "Overdue")]
    conn = [c for c in after if int(c.dur or 0) >= 30]
    ws = {(w.walkin_date, w.store_code) for w in raw_walk if n10(w.phone) == v.mobile and (w.store_code or "") not in ("Amazon", "HO")}
    wts = [(dt.datetime.strptime(d, "%Y-%m-%d %H:%M:%S") - dt.timedelta(minutes=330)).replace(tzinfo=IST) for d, _ in ws]
    docs = {}
    for s in raw_sale:
        if n10(s.Cus_mobile or s.mobile1) == v.mobile:
            d = docs.setdefault(s.document_no, [dt.datetime.strptime(s.document_date, "%d-%m-%Y %H:%M:%S").replace(tzinfo=IST), 0.0])
            d[1] += float(s.net_sale or 0)
    s_after = {k: d for k, d in docs.items() if d[0] > created}
    raw = dict(calls=len(after), conn=len(conn), talk=sum(int(c.dur or 0) for c in after),
               prev_walkin=any(t < created for t in wts), walk_after=sum(t > created for t in wts),
               sales=len(s_after), amount=round(sum(d[1] for d in s_after.values()), 2))
    dash = dict(calls=v.calls_after, conn=v.connected_calls, talk=v.talk_time_sec, prev_walkin=v.prev_walkin,
                walk_after=v.walkins_after, sales=v.sales_after, amount=round(float(v.sales_amount_after or 0), 2))
    ok = all(raw[k] == dash[k] for k in dash)
    results.append(dict(case=name, meeting_id=mid, customer=v.customer_name, jc=v.jc, city=v.deal_city, stage=v.deal_stage,
                        trigger=v.deal_trigger, created_ist=fmt(created), calls_before_creation_excluded=len(before),
                        first_call_ist=v.first_call_ist, prev_walkin_ist=v.prev_walkin_ist, first_walkin_ist=v.first_walkin_ist,
                        first_sale_ist=v.first_sale_ist, status=v.journey_status, raw=raw, dashboard=dash, match=ok))
    print(f"{'PASS' if ok else 'FAIL'} | {name:26} | {mid} | {v.customer_name} | JC {v.jc} | {v.deal_city} / {v.deal_stage} / {v.deal_trigger} | created {fmt(created)}")
    print(f"     raw : calls {raw['calls']} (+{len(before)} before creation, excluded) conn {raw['conn']} talk {raw['talk']}s | "
          f"prev walk-in {raw['prev_walkin']} | walk-ins after {raw['walk_after']} | sales {raw['sales']} Rs {raw['amount']}")
    print(f"     dash: calls {dash['calls']} conn {dash['conn']} talk {dash['talk']}s | prev walk-in {dash['prev_walkin']} | "
          f"walk-ins after {dash['walk_after']} | sales {dash['sales']} Rs {dash['amount']} | {v.journey_status}")
print(f"\n{sum(r['match'] for r in results)}/{len(results)} meetings match raw source data")
with open(__file__.replace(".py", "_results.json"), "w", encoding="utf-8") as fh:
    json.dump(results, fh, indent=1, default=str, ensure_ascii=False)
