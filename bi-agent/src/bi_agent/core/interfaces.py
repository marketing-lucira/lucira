"""Protocols (ports). Outer modules implement these; the orchestrator depends only on them."""
from __future__ import annotations

from datetime import date
from typing import Protocol, runtime_checkable

import pandas as pd

from .models import Alert, Insight, KpiValue, Recommendation, RunResult


@runtime_checkable
class Collector(Protocol):
    """Reads a domain's reporting table into a tidy frame for a date window."""
    domain: str
    def collect(self, run_date: date, window_days: int) -> pd.DataFrame: ...


@runtime_checkable
class RuleEvaluator(Protocol):
    """Evaluates one rule kind against KPI values + context, yielding Alerts."""
    name: str
    def evaluate(self, rule: dict, kpis: list[KpiValue], context: dict) -> list[Alert]: ...


@runtime_checkable
class InsightGenerator(Protocol):
    def generate(self, kpis: list[KpiValue], alerts: list[Alert]) -> list[Insight]: ...


@runtime_checkable
class Recommender(Protocol):
    def recommend(self, insights: list[Insight], alerts: list[Alert]) -> list[Recommendation]: ...


@runtime_checkable
class Reporter(Protocol):
    """Renders a RunResult to bytes (pdf/xlsx) or str (summary)."""
    fmt: str
    def render(self, result: RunResult) -> bytes | str: ...


@runtime_checkable
class Notifier(Protocol):
    channel: str
    def send(self, result: RunResult, attachments: dict[str, bytes]) -> bool: ...
