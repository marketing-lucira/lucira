"""Business Health Score — an overall 0-100 plus seven department scores, each with a reason.
Derived from computed KPIs (status bands) and fired alerts. Green >=80, yellow >=60, red <60.
Departments with no connected source report status 'off' (score None) — honest, not faked.
"""
from __future__ import annotations

from .core.models import Alert, KpiValue, Status

# Department -> the KPI keys and alert domains that feed its score.
DOMAIN_KPIS = {
    "Sales":      ["revenue", "orders", "aov", "return_rate", "returns_value", "store_target_attainment"],
    "Marketing":  ["sessions", "marketing_conversion", "ad_spend", "marketing_roi"],
    "CRM":        ["deals", "calls", "contact_rate", "conversion"],
    "Inventory":  ["inventory_value", "inventory_health", "low_stock_skus", "dead_stock_pct", "products_missing_attrs"],
    "Customer":   ["new_customers", "repeat_customers"],
    "Operations": ["pending_mto", "dispatch", "avg_dispatch_days"],
    "Finance":    [],   # wire GCP-cost / margin source to activate
}
DOMAIN_ALERTS = {
    "Sales": {"sales"}, "Marketing": {"marketing"}, "CRM": {"crm"},
    "Inventory": {"inventory", "product"}, "Customer": set(),   # scored from new/repeat KPIs only
    "Operations": {"ops"}, "Finance": {"finance"},
}
_RISK_PENALTY, _WATCH_PENALTY = 18, 8
_ALERT_PENALTY = {"critical": 15, "warn": 7, "info": 1}


def _status(score: float) -> str:
    return "green" if score >= 80 else "yellow" if score >= 60 else "red"


def compute(kpis: list[KpiValue], alerts: list[Alert]) -> dict:
    totals = [k for k in kpis if k.dimension is None]
    by_key = {}
    for k in totals:
        by_key.setdefault(k.metric.key, k)

    domains, weighted, wsum = [], 0.0, 0.0
    for dept, keys in DOMAIN_KPIS.items():
        present = [by_key[k] for k in keys if k in by_key]
        dept_alerts = [a for a in alerts if a.domain in DOMAIN_ALERTS.get(dept, set())]
        if not present and not dept_alerts:
            domains.append({"name": dept, "score": None, "status": "off",
                            "reason": "No data source connected yet."})
            continue
        score = 100.0
        worst_reason, worst_pen = "Healthy — all metrics within range.", 0
        for k in present:
            pen = _RISK_PENALTY if k.status == Status.RISK else _WATCH_PENALTY if k.status == Status.WATCH else 0
            if pen and pen > worst_pen:
                d = f"{k.delta_pct:+.1f}%" if k.delta_pct is not None else "off-target"
                worst_reason, worst_pen = f"{k.metric.label} {d} ({k.status.value}).", pen
            score -= pen
        for a in dept_alerts:
            pen = _ALERT_PENALTY.get(a.severity.value, 1)
            score -= pen
            if pen > worst_pen:
                worst_reason, worst_pen = a.message, pen
        score = max(0.0, min(100.0, score))
        st = _status(score)
        domains.append({"name": dept, "score": round(score), "status": st, "reason": worst_reason})
        weighted += score
        wsum += 1

    overall = round(weighted / wsum) if wsum else None
    return {"overall": overall, "domains": domains}
