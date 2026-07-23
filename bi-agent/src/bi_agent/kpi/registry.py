"""KPI registry — Metric lookup loaded from config/kpis.yaml."""
from __future__ import annotations

from ..config import load_metrics
from ..core.models import Metric


class KpiRegistry:
    def __init__(self, metrics: list[Metric] | None = None) -> None:
        self._metrics = {m.key: m for m in (metrics or load_metrics())}

    def get(self, key: str) -> Metric:
        return self._metrics[key]

    def by_domain(self, domain: str) -> list[Metric]:
        return [m for m in self._metrics.values() if m.domain == domain]

    def all(self) -> list[Metric]:
        return list(self._metrics.values())
