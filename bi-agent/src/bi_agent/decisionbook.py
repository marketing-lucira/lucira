"""Executive Decision Book — assembles the single daily sectioned report from the already-computed
RunResult (KPIs with sparklines → yesterday vs 7-day-avg), the health score, section narratives
(insights/alerts/recommendations), and a set of ISOLATED breakdown queries. Every query is wrapped
so a missing/failed source gates that piece to n/a rather than breaking the book.
"""
from __future__ import annotations

import logging
import statistics
from datetime import date, datetime, timezone

from .core.models import Alert, Insight, KpiValue, Recommendation, RunResult

log = logging.getLogger(__name__)

SALES = "`lucirajewelry-prod.sales_dashboard.sales_reporting`"
GA4 = "`lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`"
DEALS = "`lucirajewelry-prod.zoho_crm.cdc_deals`"
CALLS = "`lucirajewelry-prod.zoho_crm.cdc_calls`"
INV = "`lucirajewelry-prod.reporting.inventory_intelligence_fact`"


# ── KPI shaping ──────────────────────────────────────────────────────────────
def _ya(k: KpiValue) -> tuple:
    """(yesterday, avg7, change_pct) for a KPI. Sum/count KPIs use the daily sparkline;
    ratio KPIs fall back to the period value vs prior."""
    sp = k.sparkline or []
    if k.metric.agg in ("sum", "count") and len(sp) >= 1:
        yest = sp[-1]
        avg7 = statistics.mean(sp[-7:]) if len(sp) >= 1 else None
        chg = ((yest - avg7) / avg7 * 100) if avg7 else None
        return yest, avg7, chg
    return k.value, k.prev_value, k.delta_pct


def _row(name, k=None, target=None, unit=None, insight="", action="", raw=None):
    if raw is not None:  # a literal value (string/number) with no yesterday/avg framing
        return {"name": name, "yesterday": raw, "avg7": None, "target": target,
                "change_pct": None, "status": "green", "insight": insight, "action": action, "unit": unit}
    if k is None:
        return {"name": name, "yesterday": None, "avg7": None, "target": target,
                "change_pct": None, "status": "off", "insight": insight, "action": action, "unit": unit}
    y, a, c = _ya(k)
    return {"name": name, "yesterday": y, "avg7": a, "target": target if target is not None else k.metric.target,
            "change_pct": c, "status": k.status.value, "insight": insight, "action": action,
            "unit": unit or k.metric.unit}


def _by_key(kpis: list[KpiValue]) -> dict:
    return {k.metric.key: k for k in kpis if k.dimension is None}


# ── isolated breakdown queries ───────────────────────────────────────────────
def _q(client, sql: str, params: dict, mbb: int) -> list:
    from google.cloud import bigquery
    jc = bigquery.QueryJobConfig(
        maximum_bytes_billed=mbb,
        query_parameters=[bigquery.ScalarQueryParameter(k, "DATE" if isinstance(v, date) else "STRING", v)
                          for k, v in params.items()])
    return list(client.query(sql, job_config=jc).result())


def _bd(client, title, sql, params, mbb, unit=None):
    """Run a breakdown query -> {title, rows}. Gates to empty on any failure."""
    try:
        rows = _q(client, sql, params, mbb)
        return {"title": title, "rows": [{"label": str(r[0]), "value": (float(r[1]) if r[1] is not None else None),
                                          "unit": unit} for r in rows if r[0] is not None]}
    except Exception:
        log.warning("breakdown '%s' failed (gated)", title, exc_info=False)
        return {"title": title, "rows": []}


def _breakdowns(client, run_date: date, mbb: int) -> dict:
    p = {"start": date.fromordinal(run_date.toordinal() - 7), "run_date": run_date}
    out = {}
    # Sales
    out["sales_store"] = _bd(client, "By Store",
        f"SELECT store, SUM(net) v FROM {SALES} WHERE date BETWEEN @start AND @run_date "
        f"AND sale_type NOT IN ('Return','Exchange') GROUP BY store ORDER BY v DESC LIMIT 8", p, mbb, "INR")
    out["sales_category"] = _bd(client, "By Category",
        f"SELECT category, SUM(net) v FROM {SALES} WHERE date BETWEEN @start AND @run_date "
        f"AND sale_type NOT IN ('Return','Exchange') GROUP BY category ORDER BY v DESC LIMIT 8", p, mbb, "INR")
    out["sales_city"] = _bd(client, "By City",
        f"SELECT city, SUM(net) v FROM {SALES} WHERE date BETWEEN @start AND @run_date "
        f"AND sale_type NOT IN ('Return','Exchange') GROUP BY city ORDER BY v DESC LIMIT 8", p, mbb, "INR")
    out["sales_product"] = _bd(client, "Top Products",
        f"SELECT product_name, SUM(net) v FROM {SALES} WHERE date BETWEEN @start AND @run_date "
        f"AND sale_type NOT IN ('Return','Exchange') GROUP BY product_name ORDER BY v DESC LIMIT 10", p, mbb, "INR")
    out["sales_product_low"] = _bd(client, "Products Needing Attention",
        f"SELECT product_name, SUM(net) v FROM {SALES} WHERE date BETWEEN @start AND @run_date "
        f"AND sale_type NOT IN ('Return','Exchange') GROUP BY product_name HAVING v>0 ORDER BY v ASC LIMIT 8", p, mbb, "INR")
    # GA4
    out["ga4_channel"] = _bd(client, "Top Channels",
        f"SELECT channel, COUNT(*) v FROM {GA4} WHERE session_date BETWEEN @start AND @run_date "
        f"GROUP BY channel ORDER BY v DESC LIMIT 8", p, mbb, "count")
    out["ga4_city"] = _bd(client, "Top Cities",
        f"SELECT city, COUNT(*) v FROM {GA4} WHERE session_date BETWEEN @start AND @run_date "
        f"GROUP BY city ORDER BY v DESC LIMIT 8", p, mbb, "count")
    out["ga4_device"] = _bd(client, "Top Devices",
        f"SELECT device_category, COUNT(*) v FROM {GA4} WHERE session_date BETWEEN @start AND @run_date "
        f"GROUP BY device_category ORDER BY v DESC LIMIT 5", p, mbb, "count")
    out["ga4_campaign"] = _bd(client, "Top Campaigns",
        f"SELECT campaign, COUNT(*) v FROM {GA4} WHERE session_date BETWEEN @start AND @run_date "
        f"AND campaign IS NOT NULL AND campaign NOT IN ('(not set)','(organic)','(direct)') "
        f"GROUP BY campaign ORDER BY v DESC LIMIT 8", p, mbb, "count")
    out["ga4_landing"] = _bd(client, "Top Landing Pages",
        f"SELECT landing_page, COUNT(*) v FROM {GA4} WHERE session_date BETWEEN @start AND @run_date "
        f"GROUP BY landing_page ORDER BY v DESC LIMIT 8", p, mbb, "count")
    # CRM
    out["crm_owner"] = _bd(client, "Top Deal Owners",
        f"SELECT owner_name, COUNT(*) v FROM {DEALS} WHERE DATE(created_time,'Asia/Kolkata') BETWEEN @start AND @run_date "
        f"GROUP BY owner_name ORDER BY v DESC LIMIT 10", p, mbb, "count")
    out["crm_stage"] = _bd(client, "Deal Stages",
        f"SELECT JSON_VALUE(data,'$.Stage') s, COUNT(*) v FROM {DEALS} "
        f"WHERE DATE(created_time,'Asia/Kolkata') BETWEEN @start AND @run_date GROUP BY s ORDER BY v DESC LIMIT 8", p, mbb, "count")
    out["crm_source"] = _bd(client, "Lead Sources",
        f"SELECT JSON_VALUE(data,'$.Lead_Source') s, COUNT(*) v FROM {DEALS} "
        f"WHERE DATE(created_time,'Asia/Kolkata') BETWEEN @start AND @run_date GROUP BY s ORDER BY v DESC LIMIT 8", p, mbb, "count")
    # Calls (agent + type)
    out["calls_agent"] = _bd(client, "Calls per Agent",
        f"SELECT owner_name, COUNT(*) v FROM {CALLS} WHERE DATE(created_time,'Asia/Kolkata') BETWEEN @start AND @run_date "
        f"GROUP BY owner_name ORDER BY v DESC LIMIT 10", p, mbb, "count")
    # Inventory
    out["inv_category"] = _bd(client, "By Category (value)",
        f"SELECT category, SUM(inventory_value) v FROM {INV} "
        f"WHERE refresh_date=(SELECT MAX(refresh_date) FROM {INV}) GROUP BY category ORDER BY v DESC LIMIT 8", p, mbb, "INR")
    return out


# ── section assembly ─────────────────────────────────────────────────────────
def _narr(insights: list[Insight], alerts: list[Alert], recs: list[Recommendation], domains: set[str]):
    ins = [i.what for i in insights if i.domain in domains][:4]
    rca = [i.why for i in insights if i.domain in domains and i.why][:3]
    risk = [a.message for a in alerts if a.domain in domains][:4]
    act = [r.action for r in recs if True][:5] if not domains else \
          [r.action for r in recs][:5]
    return ins, rca, risk


def build(result: RunResult, health: dict, client=None, mbb: int = 5_000_000_000) -> dict:
    K = _by_key(result.kpis)
    run_date = result.run_date
    bd = _breakdowns(client, run_date, mbb) if client is not None else {}

    def rows_of(*specs):
        return [s for s in specs if s]

    def sec_narr(domains, extra_actions=None):
        ins = [i.what for i in result.insights if i.domain in domains][:4]
        rca = [i.why for i in result.insights if i.domain in domains and i.why][:3]
        risk = [a.message for a in result.alerts if a.domain in domains][:4]
        act = (extra_actions or []) + [r.action for r in result.recommendations][:4]
        return ins, rca, risk, act[:6]

    sections = []

    # SECTION 1 — GA4
    ins, rca, risk, act = sec_narr({"marketing"})
    sections.append({"id": "ga4", "icon": "🌐", "title": "GA4 — Website & App Analytics",
        "kpis": rows_of(
            _row("Sessions", K.get("sessions"), unit="count"),
            _row("Site Conversion", K.get("marketing_conversion"), unit="pct"),
            _row("Ad Spend", K.get("ad_spend"), unit="INR", insight="Meta feed stale since 06-Jan." if not K.get("ad_spend") or K["ad_spend"].value == 0 else ""),
            _row("ROAS (proxy)", K.get("marketing_roi"), unit="ratio"),
            _row("Users / New Users / Engagement / Funnel", None, insight="From GA4 detail — enable ga4 funnel query for full table.")),
        "breakdowns": [b for b in [bd.get("ga4_channel"), bd.get("ga4_city"), bd.get("ga4_device"),
                                   bd.get("ga4_campaign"), bd.get("ga4_landing")] if b and b["rows"]],
        "executive_summary": (result.headline if any(i.domain == "marketing" for i in result.insights) else
                              "Website traffic and on-site conversion for the period, with channel, city and device mix."),
        "insights": ins, "root_cause": rca, "opportunities": [], "leakage": [],
        "risks": risk, "actions": act})

    # SECTION 2 — Sales
    ins, rca, risk, act = sec_narr({"sales"}, ["Run a store-recovery push at the lagging stores."])
    sections.append({"id": "sales", "icon": "💰", "title": "Sales",
        "kpis": rows_of(
            _row("Revenue", K.get("revenue"), unit="INR"),
            _row("Orders", K.get("orders"), unit="count"),
            _row("AOV", K.get("aov"), unit="INR"),
            _row("Returns Value", K.get("returns_value"), unit="INR"),
            _row("Return Rate", K.get("return_rate"), unit="pct"),
            _row("Margin", None, unit="INR", insight="No cost/COGS in reporting table.", action="Add COGS to enable margin."),
            _row("Target Achievement", None, unit="pct", insight="No store-target table connected.", action="Connect targets.")),
        "breakdowns": [b for b in [bd.get("sales_store"), bd.get("sales_category"), bd.get("sales_city"),
                                   bd.get("sales_product")] if b and b["rows"]],
        "executive_summary": "Revenue, orders and AOV for the period, broken down by store, category, city and product.",
        "insights": ins, "root_cause": rca,
        "opportunities": ["Push the top-selling category where demand is strong.",
                          "Recover order volume to the 7-day norm."],
        "leakage": [a.message for a in result.alerts if a.domain == "sales"][:2],
        "risks": risk, "actions": act})

    # SECTION 3 — CRM / Deals
    ins, rca, risk, act = sec_narr({"crm"}, ["Call the un-contacted deals today, worst owners first."])
    sections.append({"id": "crm", "icon": "🤝", "title": "CRM / Deals",
        "kpis": rows_of(
            _row("Total Deals", K.get("deals"), unit="count"),
            _row("Conversion %", K.get("conversion"), unit="pct"),
            _row("Contact Rate", K.get("contact_rate"), unit="pct"),
            _row("Total Leads", None, insight="Lead module (leads_1) not wired.", action="Connect leads."),
            _row("Pipeline Value", None, unit="INR", insight="Deal Amount mostly ₹0 in CRM.", action="Populate deal value.")),
        "breakdowns": [b for b in [bd.get("crm_owner"), bd.get("crm_stage"), bd.get("crm_source")] if b and b["rows"]],
        "executive_summary": "Deal inflow, win-rate and follow-up (contact rate), with owner, stage and lead-source mix.",
        "insights": ins, "root_cause": rca,
        "opportunities": ["Lift contact rate to the 80% SLA to realise aging pipeline.",
                          "Coach low-win owners using the top owner's playbook."],
        "leakage": [a.message for a in result.alerts if a.domain == "crm"][:2],
        "risks": risk, "actions": act})

    # SECTION 4 — Calls
    sections.append({"id": "calls", "icon": "📞", "title": "Calls",
        "kpis": rows_of(
            _row("Total Calls", K.get("calls"), unit="count"),
            _row("Connected Calls", None, insight="Call_Result not consistently set.", action="Standardise dispositions."),
            _row("Avg Call Duration", None, unit="sec", insight="Duration format varies.", action="Normalise duration."),
            _row("First Response Time", None, target=30, insight="Not derivable per-deal yet.", action="Wire deal↔call join.")),
        "breakdowns": [b for b in [bd.get("calls_agent")] if b and b["rows"]],
        "executive_summary": "Call activity by agent. Disposition and first-response quality need field standardisation to score.",
        "insights": ["Agent call volume is uneven — rebalance workload."],
        "root_cause": ["Call dispositions inconsistent → connected/missed not measurable."],
        "opportunities": ["Standardising dispositions unlocks outcome-based agent coaching."],
        "leakage": ["Un-measured missed calls = hidden follow-up leakage."],
        "risks": ["High-value customers may go uncontacted undetected."],
        "actions": ["Standardise call dispositions.", "Wire deal↔call join for first-response time.",
                    "Rebalance workload across agents."]})

    # SECTION 5 — Inventory
    ins, rca, risk, act = sec_narr({"inventory", "product"})
    sections.append({"id": "inventory", "icon": "📦", "title": "Inventory",
        "kpis": rows_of(
            _row("Total Inventory Value", K.get("inventory_value"), unit="INR"),
            _row("Health Score", K.get("inventory_health"), unit="pct"),
            _row("Low Stock SKUs", K.get("low_stock_skus"), unit="count"),
            _row("Dead Stock %", K.get("dead_stock_pct"), unit="pct"),
            _row("Products Missing Attrs", K.get("products_missing_attrs"), unit="count")),
        "breakdowns": [b for b in [bd.get("inv_category")] if b and b["rows"]],
        "executive_summary": "On-hand value with health, low-stock, dead-stock and attribute completeness by category.",
        "insights": ins or ["Dead-stock is inflated by a SKU key mismatch (only ~34% of items join to sales)."],
        "root_cause": rca or ["SKU convention differs between inventory and sales/GRN → velocity un-joined."],
        "opportunities": ["Build a SKU crosswalk to reclassify most 'dead' stock and unlock accurate refill."],
        "leakage": [a.message for a in result.alerts if a.domain in ("inventory", "product")][:2],
        "risks": risk or ["Stock-out on true fast-movers ahead of demand."],
        "actions": ["Build the SKU crosswalk table (biggest lever).",
                    "Trigger POs for the low-stock SKUs.", "Complete missing product attributes."]})

    # SECTION 6 — Marketing
    sections.append({"id": "marketing", "icon": "📣", "title": "Marketing",
        "kpis": rows_of(
            _row("Ad Spend", K.get("ad_spend"), unit="INR", insight="meta_ads stale since 06-Jan.", action="Reconnect feed."),
            _row("Revenue (attributed)", K.get("revenue"), unit="INR", insight="Using order revenue."),
            _row("ROAS", K.get("marketing_roi"), unit="ratio"),
            _row("CPC / CTR / CPM / CAC", None, insight="No spend data (stale meta_ads).", action="Reconnect meta_ads.")),
        "breakdowns": [b for b in [bd.get("ga4_channel"), bd.get("ga4_city"), bd.get("ga4_campaign")] if b and b["rows"]],
        "executive_summary": "Paid performance is un-scorable until the Meta spend feed reconnects (stale since 6 Jan); channel mix from GA4 shown.",
        "insights": ["Organic/Direct efficient; paid can't be judged without spend."],
        "root_cause": ["Meta ad-insights ingestion stopped 06-Jan-2026."],
        "opportunities": ["Reconnecting spend enables budget-shift decisions (pause low-ROAS sets)."],
        "leakage": ["Flying blind on paid spend = unquantified waste risk."],
        "risks": ["Budget may be spent on low-ROAS campaigns undetected."],
        "actions": ["Reconnect the meta_ads pipeline (priority).", "Until then, lean budget into Direct/Organic promos."]})

    # SECTION 7 — Customer
    ins, rca, risk, act = sec_narr({"sales"})
    sections.append({"id": "customer", "icon": "👥", "title": "Customer",
        "kpis": rows_of(
            _row("New Customers", K.get("new_customers"), unit="count"),
            _row("Repeat Customers", K.get("repeat_customers"), unit="count"),
            _row("Return Rate", K.get("return_rate"), unit="pct"),
            _row("Refund %", None, unit="pct", insight="Refund source not wired."),
            _row("Customer Lifetime Value", None, unit="INR", insight="CLV needs a full-history model.", action="Enable CLV model.")),
        "breakdowns": [],
        "executive_summary": "New vs repeat acquisition and returns. Loyalty (repeat cohort) is the lever to lean on while acquisition recovers.",
        "insights": ["Repeat cohort resilience is a bright spot."],
        "root_cause": ["Acquisition tracks overall traffic/checkout softness."],
        "opportunities": ["Targeted repeat-customer offers (esp. top cities).", "Stand up a win-back flow for lapsed VIPs."],
        "leakage": ["Lost-customer / win-back not yet instrumented."],
        "risks": ["Acquisition softness if the traffic issue persists."],
        "actions": ["Push repeat-customer offers in the top cities.", "Build a win-back flow for lapsed high-value customers."]})

    # FINAL CEO summary — decision table from recs+alerts, lists from narratives, rankings from breakdowns.
    decision_table = []
    prio_map = {"critical": "P1", "warn": "P2", "info": "P3"}
    for r in result.recommendations[:8]:
        decision_table.append({"priority": r.priority, "department": r.owner or "—",
                               "issue": r.action[:60], "why": r.rationale, "impact_inr": r.est_value_inr,
                               "action": r.action, "owner": r.owner, "deadline": f"{r.eta_days}d" if r.eta_days else "—"})

    def rank(key):
        b = bd.get(key) or {"rows": []}
        return b["rows"][:5]

    def rank_rev(key):
        b = bd.get(key) or {"rows": []}
        return list(reversed(b["rows"]))[:5]

    growth = [r.action for r in result.recommendations][:10]
    leakage = [a.message for a in result.alerts][:10]
    risks = [a.message for a in result.alerts if a.severity.value in ("critical", "warn")][:10]
    quick = [r.action for r in result.recommendations if r.priority in ("P1", "P2")][:10]
    est_gain = sum((r.est_value_inr or 0) for r in result.recommendations)

    final = {
        "health": {"overall": health.get("overall"),
                   "domains": [{"name": d["name"], "score": d["score"], "status": d["status"]}
                               for d in health.get("domains", [])]},
        "estimated_gain_inr": est_gain or None,
        "decision_table": decision_table,
        "lists": {"growth": growth, "leakage": leakage, "risks": risks, "quick_wins": quick},
        "rankings": {
            "best_cities": rank("sales_city"), "worst_cities": rank_rev("sales_city"),
            "best_stores": rank("sales_store"), "worst_stores": rank_rev("sales_store"),
            "best_agents": rank("calls_agent"), "worst_agents": rank_rev("calls_agent"),
            "best_campaigns": rank("ga4_campaign"), "worst_campaigns": rank_rev("ga4_campaign"),
            "best_products": rank("sales_product"), "attention_products": rank("sales_product_low"),
        },
    }

    return {
        "meta": {"run_date": str(run_date), "generated_at": datetime.now(timezone.utc).isoformat(),
                 "period": "Yesterday vs 7-day average", "source": "live"},
        "sections": sections, "final": final,
    }
