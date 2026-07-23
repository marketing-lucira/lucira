"""Rule Engine — evaluates every rule in config/rules.yaml (with optional bi.rule_config
runtime overrides) against the computed KPIs and context, producing Alerts."""
from __future__ import annotations

import logging

from ..core.models import Alert, KpiValue
from . import evaluators

log = logging.getLogger(__name__)


class RuleEngine:
    def __init__(self, rules: list[dict], overrides: dict[str, dict] | None = None) -> None:
        self.rules = rules
        self.overrides = overrides or {}

    def _apply_override(self, rule: dict) -> dict | None:
        """Merge a bi.rule_config row over the YAML rule; None if disabled at runtime."""
        ov = self.overrides.get(rule["id"])
        if ov is None:
            return rule
        if ov.get("enabled") is False:
            return None
        merged = dict(rule)
        for k in ("threshold", "severity"):
            if ov.get(k) is not None:
                merged[k] = ov[k]
        return merged

    def evaluate(self, kpis: list[KpiValue], context: dict | None = None) -> list[Alert]:
        context = context or {}
        alerts: list[Alert] = []
        for raw in self.rules:
            rule = self._apply_override(raw)
            if rule is None:
                continue
            fn = evaluators.REGISTRY.get(rule["evaluator"])
            if fn is None:
                log.warning("unknown evaluator %s for rule %s", rule["evaluator"], rule["id"])
                continue
            try:
                fired = fn(rule, kpis, context)
                alerts.extend(fired)
            except Exception:  # a broken rule never breaks the run
                log.exception("rule %s failed", rule["id"])
        # sort critical first
        order = {"critical": 0, "warn": 1, "info": 2}
        alerts.sort(key=lambda a: order.get(a.severity.value, 9))
        log.info("rule engine fired %d alerts", len(alerts))
        return alerts
