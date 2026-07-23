"""Rule evaluators — one pure function per evaluator kind. Registered by name."""
from __future__ import annotations

import statistics
from datetime import datetime, timezone

from ..core.models import Alert, KpiValue, Severity


def _kpi_totals(kpis: list[KpiValue], key: str) -> KpiValue | None:
    for k in kpis:
        if k.metric.key == key and k.dimension is None:
            return k
    return None


def _kpi_slices(kpis: list[KpiValue], key: str) -> list[KpiValue]:
    return [k for k in kpis if k.metric.key == key and k.dimension is not None]


def _fmt(msg: str, **kw) -> str:
    try:
        return msg.format(**kw)
    except (KeyError, ValueError):
        return msg


def _alert(rule: dict, message: str, metric: float | None = None,
           entity: str | None = None, entity_value: str | None = None) -> Alert:
    return Alert(
        rule_id=rule["id"], domain=rule["domain"],
        severity=Severity(rule.get("severity", "warn")), message=message,
        owner=rule.get("owner", ""), entity=entity, entity_value=entity_value,
        metric=metric, threshold=rule.get("threshold"), fired_at=datetime.now(timezone.utc),
    )


def threshold_below(rule, kpis, ctx):
    out = []
    targets = _kpi_slices(kpis, rule["kpi"]) if rule.get("group_by") else [_kpi_totals(kpis, rule["kpi"])]
    for k in filter(None, targets):
        if k.value < rule["threshold"]:
            out.append(_alert(rule, _fmt(rule["message"], value=k.value, count=int(k.value),
                                         **{rule.get("group_by", ""): k.dim_value or ""}),
                              metric=k.value, entity=k.dimension, entity_value=k.dim_value))
    return out


def threshold_above(rule, kpis, ctx):
    out = []
    targets = _kpi_slices(kpis, rule["kpi"]) if rule.get("group_by") else [_kpi_totals(kpis, rule["kpi"])]
    for k in filter(None, targets):
        if k.value > rule["threshold"]:
            out.append(_alert(rule, _fmt(rule["message"], value=k.value, count=int(k.value),
                                         **{rule.get("group_by", ""): k.dim_value or ""}),
                              metric=k.value, entity=k.dimension, entity_value=k.dim_value))
    return out


def pct_drop(rule, kpis, ctx):
    k = _kpi_totals(kpis, rule["kpi"])
    if k and k.delta_pct is not None and k.delta_pct <= -abs(rule["threshold"]):
        return [_alert(rule, _fmt(rule["message"], value=k.value, delta_pct=k.delta_pct), metric=k.value)]
    return []


def pct_spike(rule, kpis, ctx):
    k = _kpi_totals(kpis, rule["kpi"])
    if k and k.delta_pct is not None and k.delta_pct >= abs(rule["threshold"]):
        return [_alert(rule, _fmt(rule["message"], value=k.value, delta_pct=k.delta_pct), metric=k.value)]
    return []


def staleness(rule, kpis, ctx):
    """Event-followup gap, e.g. deal created but no call within N minutes.
    `ctx['stale_counts'][rule_id]` = {group_value: count} supplied by the collector."""
    counts = ctx.get("stale_counts", {}).get(rule["id"], {})
    out = []
    for group_value, count in counts.items():
        if count > 0:
            out.append(_alert(rule, _fmt(rule["message"], count=count,
                                         **{rule.get("group_by", "owner"): group_value}),
                              metric=count, entity=rule.get("group_by"), entity_value=group_value))
    return out


def missing_attribute(rule, kpis, ctx):
    k = _kpi_totals(kpis, rule["kpi"])
    if k and k.value > rule["threshold"]:
        return [_alert(rule, _fmt(rule["message"], value=k.value), metric=k.value)]
    return []


def zscore_anomaly(rule, kpis, ctx):
    k = _kpi_totals(kpis, rule["kpi"])
    if not k or len(k.sparkline) < 8:
        return []
    hist = k.sparkline[:-1]
    mu, sd = statistics.mean(hist), (statistics.pstdev(hist) or 1.0)
    z = (k.value - mu) / sd
    if abs(z) >= rule["threshold"]:
        return [_alert(rule, _fmt(rule["message"], zscore=z, value=k.value), metric=k.value)]
    return []


REGISTRY = {
    "threshold_below": threshold_below,
    "threshold_above": threshold_above,
    "pct_drop": pct_drop,
    "pct_spike": pct_spike,
    "staleness": staleness,
    "missing_attribute": missing_attribute,
    "zscore_anomaly": zscore_anomaly,
}
