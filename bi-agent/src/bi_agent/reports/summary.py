"""Executive summary builder. LLM-first (exec_summary prompt), rule-based fallback."""
from __future__ import annotations

import json

from ..core.models import RunResult, Status
from ..insights.llm import LLMClient

_ARROW = {"up_good": "▲", "down_bad": "▼"}


def _ctx(result: RunResult) -> dict:
    return {
        "period_label": result.period_label,
        "kpis": [{"label": k.metric.label, "value": round(k.value, 2),
                  "delta_pct": round(k.delta_pct, 1) if k.delta_pct is not None else None,
                  "unit": k.metric.unit, "higher_is_better": k.metric.higher_is_better,
                  "status": k.status.value}
                 for k in result.kpis if k.dimension is None],
        "insights": [i.__dict__ for i in result.insights[:5]],
        "recommendations": [r.__dict__ for r in result.recommendations[:3]],
        "alerts": {"critical": sum(a.severity.value == "critical" for a in result.alerts),
                   "warn": sum(a.severity.value == "warn" for a in result.alerts)},
        "generated_at": result.generated_at.isoformat() if result.generated_at else "",
    }


class SummaryBuilder:
    fmt = "summary"

    def __init__(self, llm: LLMClient) -> None:
        self.llm = llm

    def render(self, result: RunResult) -> str:
        template = self.llm.prompt("exec_summary")
        text = self.llm.complete(template.replace("{{context_json}}", json.dumps(_ctx(result))))
        return text or self._rule_based(result)

    def _rule_based(self, result: RunResult) -> str:
        lines = [f"📊 Lucira MIS — {result.period_label}", "", result.headline or "Daily briefing.", "",
                 "KEY NUMBERS"]
        for k in [k for k in result.kpis if k.dimension is None][:5]:
            fav = (k.delta_pct or 0) >= 0 if k.metric.higher_is_better else (k.delta_pct or 0) <= 0
            arrow = "▲" if fav else "▼"
            d = f" ({arrow}{abs(k.delta_pct):.0f}%)" if k.delta_pct is not None else ""
            unit = "₹" if k.metric.unit == "INR" else ""
            lines.append(f"• {k.metric.label}: {unit}{k.value:,.0f}{d}")
        def favorable(k):
            if k.delta_pct is None:
                return False
            return k.delta_pct >= 0 if k.metric.higher_is_better else k.delta_pct <= 0
        wins = [k.metric.label for k in result.kpis
                if k.dimension is None and k.status == Status.GOOD and favorable(k)][:3]
        risks = [a.message for a in result.alerts if a.severity.value in ("critical", "warn")][:3]
        lines += ["", "🟢 WINS"] + ([f"• {w}" for w in wins] or ["• None"])
        lines += ["", "🔴 WATCH"] + ([f"• {r}" for r in risks] or ["• None"])
        lines += ["", "✅ ACTIONS"] + (
            [f"• {r.priority} {r.owner}: {r.action}" for r in result.recommendations[:2]] or ["• None"])
        return "\n".join(lines)
