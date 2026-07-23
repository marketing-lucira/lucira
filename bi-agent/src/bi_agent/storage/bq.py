"""BigQuery writer — persist fired alerts + generated insights to the bi.* logs."""
from __future__ import annotations

import logging
from datetime import date

from ..core.models import Alert, Insight, Recommendation

log = logging.getLogger(__name__)


class BiWriter:
    def __init__(self, project: str, dataset: str, location: str) -> None:
        self.project, self.dataset, self.location = project, dataset, location
        self._client = None

    @property
    def client(self):
        if self._client is None:
            from google.cloud import bigquery
            self._client = bigquery.Client(project=self.project, location=self.location)
        return self._client

    def _insert(self, table: str, rows: list[dict]) -> None:
        if not rows:
            return
        errors = self.client.insert_rows_json(f"{self.project}.{self.dataset}.{table}", rows)
        if errors:
            log.error("insert errors into %s: %s", table, errors)

    def write_alerts(self, run_id: str, alerts: list[Alert]) -> None:
        self._insert("alerts_log", [{
            "run_id": run_id, "fired_at": (a.fired_at.isoformat() if a.fired_at else None),
            "rule_id": a.rule_id, "severity": a.severity.value, "domain": a.domain,
            "entity": a.entity, "entity_value": a.entity_value, "metric": a.metric,
            "threshold": a.threshold, "message": a.message, "owner": a.owner, "status": "open",
        } for a in alerts])

    def write_insights(self, run_id: str, generated_at, insights: list[Insight],
                       recs: list[Recommendation], model: str, prompt_version: str) -> None:
        rows = [{
            "run_id": run_id, "generated_at": generated_at.isoformat(), "domain": i.domain,
            "kpi_key": i.kpi, "headline": "", "what": i.what, "why": i.why, "impact": i.impact,
            "confidence": i.confidence, "recommendation": None, "priority": None, "owner": None,
            "eta_days": None, "est_value_inr": None, "model": model, "prompt_version": prompt_version,
        } for i in insights]
        rows += [{
            "run_id": run_id, "generated_at": generated_at.isoformat(), "domain": "",
            "kpi_key": None, "headline": "", "what": None, "why": None, "impact": None,
            "confidence": None, "recommendation": r.action, "priority": r.priority, "owner": r.owner,
            "eta_days": r.eta_days, "est_value_inr": r.est_value_inr, "model": model,
            "prompt_version": prompt_version,
        } for r in recs]
        self._insert("insights_log", rows)
