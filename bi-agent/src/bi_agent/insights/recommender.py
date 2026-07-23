"""Recommendation Engine — actionable, prioritized, owned. LLM-first, rule-based fallback."""
from __future__ import annotations

import json
import logging

from ..core.models import Alert, Insight, Recommendation
from .llm import LLMClient

log = logging.getLogger(__name__)

_SEV_TO_PRIORITY = {"critical": "P1", "warn": "P2", "info": "P3"}


class RecommendationEngine:
    def __init__(self, llm: LLMClient) -> None:
        self.llm = llm

    def recommend(self, insights: list[Insight], alerts: list[Alert]) -> list[Recommendation]:
        ctx = {
            "insights": [i.__dict__ for i in insights],
            "alerts": [{"rule_id": a.rule_id, "severity": a.severity.value,
                        "message": a.message, "owner": a.owner} for a in alerts],
        }
        template = self.llm.prompt("recommendation")
        raw = self.llm.complete(template.replace("{{context_json}}", json.dumps(ctx)))
        if raw:
            try:
                data = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
                return [Recommendation(**r) for r in data.get("recommendations", [])]
            except Exception:
                log.exception("could not parse LLM recommendations; using rule-based")
        return self._rule_based(alerts)

    def _rule_based(self, alerts: list[Alert]) -> list[Recommendation]:
        out = []
        for a in alerts:
            out.append(Recommendation(
                action=f"Address: {a.message}", rationale=f"Rule {a.rule_id} fired.",
                priority=_SEV_TO_PRIORITY.get(a.severity.value, "P3"),
                owner=a.owner or "Ops", eta_days=1 if a.severity.value == "critical" else 3))
        return out[:6]
