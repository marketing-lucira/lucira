"""AI Insight Engine — what / why / business impact. LLM-first, rule-based fallback."""
from __future__ import annotations

import json
import logging

from ..core.models import Alert, Insight, KpiValue, Status
from .llm import LLMClient

log = logging.getLogger(__name__)


def _material(kpis: list[KpiValue]) -> list[KpiValue]:
    return [k for k in kpis if k.dimension is None and k.status in (Status.WATCH, Status.RISK)]


def _context(kpis: list[KpiValue], alerts: list[Alert]) -> dict:
    return {
        "kpis": [{
            "key": k.metric.key, "label": k.metric.label, "domain": k.metric.domain,
            "value": round(k.value, 2), "prev": round(k.prev_value or 0, 2),
            "delta_pct": round(k.delta_pct, 1) if k.delta_pct is not None else None,
            "unit": k.metric.unit, "target": k.target, "status": k.status.value,
        } for k in kpis if k.dimension is None],
        "alerts": [{"rule_id": a.rule_id, "severity": a.severity.value,
                    "domain": a.domain, "message": a.message} for a in alerts],
    }


class InsightEngine:
    def __init__(self, llm: LLMClient) -> None:
        self.llm = llm

    def generate(self, kpis: list[KpiValue], alerts: list[Alert]) -> list[Insight]:
        ctx = _context(kpis, alerts)
        template = self.llm.prompt("insight")
        raw = self.llm.complete(template.replace("{{context_json}}", json.dumps(ctx)))
        if raw:
            try:
                data = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
                return [Insight(kpi=i.get("kpi", ""), what=i["what"], why=i["why"],
                                impact=i["impact"], confidence=i.get("confidence", "medium"))
                        for i in data.get("insights", [])]
            except Exception:
                log.exception("could not parse LLM insight JSON; using rule-based")
        return self._rule_based(kpis, alerts)

    def _rule_based(self, kpis: list[KpiValue], alerts: list[Alert]) -> list[Insight]:
        """Deterministic, grounded narrative when no LLM is configured."""
        out: list[Insight] = []
        for k in _material(kpis):
            dirn = "down" if (k.delta_pct or 0) < 0 else "up"
            out.append(Insight(
                kpi=k.metric.key, domain=k.metric.domain,
                what=f"{k.metric.label} is {k.value:,.0f} {k.metric.unit}, "
                     f"{dirn} {abs(k.delta_pct or 0):.1f}% vs prior period.",
                why="Driver not identifiable from available data (enable LLM for root-cause).",
                impact=f"Status {k.status.value}."
                       + (f" {k.attainment_pct:.0f}% of target." if k.attainment_pct else ""),
                confidence="low"))
        for a in alerts[:5]:
            out.append(Insight(kpi=a.rule_id, domain=a.domain, what=a.message,
                               why="Business rule breached.", impact=f"Owner: {a.owner}.",
                               confidence="high"))
        return out
