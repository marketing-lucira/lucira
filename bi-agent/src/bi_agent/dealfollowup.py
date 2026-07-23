"""Deal Follow-up tracker — daily, per-agent sales discipline:
  • deals created vs ATTENDED (got a call) vs NOT ATTENDED (no call)
  • first-response time (deal created → first matching call), per agent, per day
  • average call duration, call volume

Deal↔call join = call.What_Id.id == deal.id  (primary),  OR  matched mobile number (fallback,
since Zoho To/From number fields are null — phone is parsed from the call Subject). SLA for first
response = 30 minutes. Everything is best-effort with SAFE_* casts so a schema surprise gates a
field to null rather than breaking the run. VALIDATE Call_Duration format on first live run.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone

log = logging.getLogger(__name__)

DEALS = "`lucirajewelry-prod.zoho_crm.cdc_deals`"
CALLS = "`lucirajewelry-prod.zoho_crm.cdc_calls`"
SLA_MIN = 30            # first-response SLA in minutes
WINDOW_DAYS = 7


def _run(client, sql, params, mbb):
    from google.cloud import bigquery
    jc = bigquery.QueryJobConfig(
        maximum_bytes_billed=mbb,
        query_parameters=[bigquery.ScalarQueryParameter(k, "DATE" if isinstance(v, date) else "STRING", v)
                          for k, v in params.items()])
    return list(client.query(sql, job_config=jc).result())


def _daily_sql() -> str:
    return f"""
    WITH d AS (
      SELECT id, owner_name AS agent, created_time AS deal_time,
             DATE(created_time,'Asia/Kolkata') AS day,
             RIGHT(REGEXP_REPLACE(COALESCE(JSON_VALUE(data,'$.Mobile'),''),'[^0-9]',''),10) AS mobile
      FROM {DEALS}
      QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY synced_at DESC)=1
    ),
    c AS (
      SELECT owner_name AS agent, created_time AS call_time,
             JSON_VALUE(data,'$.What_Id.id') AS what_deal,
             RIGHT(REGEXP_REPLACE(COALESCE(JSON_VALUE(data,'$.Subject'),''),'[^0-9]',''),10) AS phone
      FROM {CALLS}
      QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY synced_at DESC)=1
    ),
    first_call AS (
      SELECT d.id, d.agent, d.day, d.deal_time,
             MIN(c.call_time) AS first_call_time
      FROM d
      LEFT JOIN c
        ON (c.what_deal = d.id OR (d.mobile != '' AND c.phone = d.mobile))
       AND c.call_time >= d.deal_time
      GROUP BY d.id, d.agent, d.day, d.deal_time
    )
    SELECT day AS date, IFNULL(agent,'(unassigned)') AS agent,
      COUNT(*) AS deals,
      COUNTIF(first_call_time IS NOT NULL) AS attended,
      COUNTIF(first_call_time IS NULL) AS not_attended,
      ROUND(AVG(IF(first_call_time IS NOT NULL,
                   TIMESTAMP_DIFF(first_call_time, deal_time, SECOND)/60.0, NULL)),1) AS first_response_min,
      COUNTIF(first_call_time IS NOT NULL
              AND TIMESTAMP_DIFF(first_call_time, deal_time, MINUTE) > {SLA_MIN}) AS sla_breaches
    FROM first_call
    WHERE day BETWEEN @start AND @run_date
    GROUP BY date, agent
    ORDER BY date DESC, deals DESC
    """


def _calls_sql() -> str:
    # avg call duration + volume per agent/day. Handles both seconds and "mm:ss".
    return f"""
    WITH dedup AS (
      SELECT owner_name, created_time, data
      FROM {CALLS}
      QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY synced_at DESC)=1
    )
    SELECT DATE(created_time,'Asia/Kolkata') AS date,
      IFNULL(owner_name,'(unassigned)') AS agent,
      COUNT(*) AS calls,
      ROUND(AVG(COALESCE(
        SAFE_CAST(JSON_VALUE(data,'$.Call_Duration_in_seconds') AS INT64),
        SAFE_CAST(SPLIT(JSON_VALUE(data,'$.Call_Duration'),':')[SAFE_OFFSET(0)] AS INT64)*60
          + SAFE_CAST(SPLIT(JSON_VALUE(data,'$.Call_Duration'),':')[SAFE_OFFSET(1)] AS INT64)
      )),0) AS avg_call_sec,
      COUNTIF(LOWER(JSON_VALUE(data,'$.Call_Type'))='outbound') AS outbound,
      COUNTIF(LOWER(JSON_VALUE(data,'$.Call_Type'))='inbound')  AS inbound
    FROM dedup
    WHERE DATE(created_time,'Asia/Kolkata') BETWEEN @start AND @run_date
    GROUP BY date, agent
    """


def _status(attend_rate, avg_first):
    if attend_rate is None:
        return "off"
    if attend_rate < 0.6 or (avg_first is not None and avg_first > SLA_MIN * 2):
        return "red"
    if attend_rate < 0.8 or (avg_first is not None and avg_first > SLA_MIN):
        return "amber"
    return "green"


def build(client, run_date: date, mbb: int = 5_000_000_000, days: int = WINDOW_DAYS) -> dict:
    start = run_date - timedelta(days=days - 1)
    p = {"start": start, "run_date": run_date}
    out = {"meta": {"run_date": str(run_date), "generated_at": datetime.now(timezone.utc).isoformat(),
                    "sla_min": SLA_MIN, "window_days": days, "source": "live"},
           "daily": [], "agents": [], "today": {}, "actions": [], "available": True}

    try:
        daily = _run(client, _daily_sql(), p, mbb)
    except Exception:
        log.warning("deal-followup daily query failed (gated)", exc_info=False)
        out["available"] = False
        return out
    try:
        calls = {(str(r["date"]), r["agent"]): r for r in _run(client, _calls_sql(), p, mbb)}
    except Exception:
        log.warning("deal-followup calls query failed (gated)", exc_info=False)
        calls = {}

    daily_rows = []
    for r in daily:
        key = (str(r["date"]), r["agent"])
        cr = calls.get(key)
        daily_rows.append({
            "date": str(r["date"]), "agent": r["agent"], "deals": int(r["deals"]),
            "attended": int(r["attended"]), "not_attended": int(r["not_attended"]),
            "first_response_min": (float(r["first_response_min"]) if r["first_response_min"] is not None else None),
            "sla_breaches": int(r["sla_breaches"]),
            "calls": (int(cr["calls"]) if cr else 0),
            "avg_call_sec": (int(cr["avg_call_sec"]) if cr and cr["avg_call_sec"] is not None else None),
        })
    out["daily"] = daily_rows

    # per-agent rollup over the window
    agg = {}
    for row in daily_rows:
        a = agg.setdefault(row["agent"], {"deals": 0, "attended": 0, "not_attended": 0,
                                          "sla_breaches": 0, "calls": 0, "_fr": [], "_dur": []})
        a["deals"] += row["deals"]; a["attended"] += row["attended"]
        a["not_attended"] += row["not_attended"]; a["sla_breaches"] += row["sla_breaches"]
        a["calls"] += row["calls"]
        if row["first_response_min"] is not None:
            a["_fr"].append((row["first_response_min"], row["attended"]))
        if row["avg_call_sec"] is not None:
            a["_dur"].append((row["avg_call_sec"], row["calls"]))

    def wavg(pairs):
        num = sum(v * w for v, w in pairs); den = sum(w for _, w in pairs)
        return round(num / den, 1) if den else None

    agents = []
    for name, a in agg.items():
        rate = (a["attended"] / a["deals"]) if a["deals"] else None
        avg_fr = wavg(a["_fr"]); avg_dur = wavg(a["_dur"])
        agents.append({"agent": name, "deals": a["deals"], "attended": a["attended"],
                       "not_attended": a["not_attended"], "attend_rate": round(rate * 100, 1) if rate is not None else None,
                       "avg_first_response_min": avg_fr, "sla_breaches": a["sla_breaches"],
                       "calls": a["calls"], "avg_call_sec": int(avg_dur) if avg_dur is not None else None,
                       "status": _status(rate, avg_fr)})
    agents.sort(key=lambda x: (x["not_attended"], -(x["attend_rate"] or 0)), reverse=True)
    out["agents"] = agents

    # today snapshot
    today = [r for r in daily_rows if r["date"] == str(run_date)]
    out["today"] = {
        "deals": sum(r["deals"] for r in today),
        "attended": sum(r["attended"] for r in today),
        "not_attended": sum(r["not_attended"] for r in today),
        "sla_breaches": sum(r["sla_breaches"] for r in today),
        "avg_first_response_min": wavg([(r["first_response_min"], r["attended"])
                                        for r in today if r["first_response_min"] is not None]),
    }

    # rule-based coaching actions (grounded, prioritized)
    actions = []
    for a in agents:
        if a["not_attended"] >= 5:
            actions.append({"priority": "P1", "agent": a["agent"],
                            "action": f"{a['agent']}: {a['not_attended']} deals un-attended in {days}d — call them today.",
                            "owner": "Sales Manager"})
        if a["avg_first_response_min"] is not None and a["avg_first_response_min"] > SLA_MIN:
            actions.append({"priority": "P2", "agent": a["agent"],
                            "action": f"Coach {a['agent']} on first response — avg {a['avg_first_response_min']:.0f} min vs {SLA_MIN} min SLA.",
                            "owner": "Sales Manager"})
    out["actions"] = actions[:8]
    return out
