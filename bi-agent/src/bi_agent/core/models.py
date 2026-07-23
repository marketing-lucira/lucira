"""Domain models — the vocabulary every module speaks. Depends on nothing (clean-arch core)."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum


class Status(str, Enum):
    GOOD = "good"
    WATCH = "watch"
    RISK = "risk"


class Severity(str, Enum):
    INFO = "info"
    WARN = "warn"
    CRITICAL = "critical"


@dataclass(frozen=True)
class Metric:
    """A KPI definition, loaded from config/kpis.yaml."""
    key: str
    label: str
    domain: str
    unit: str                      # INR|count|pct|days|ratio
    agg: str = "sum"               # sum|avg|last|ratio
    higher_is_better: bool = True
    target: float | None = None
    watch_pct: float | None = None
    risk_pct: float | None = None
    slice_by: list[str] = field(default_factory=list)
    describe: str = ""


@dataclass
class KpiValue:
    """A computed KPI for one period (optionally sliced by a dimension)."""
    metric: Metric
    value: float
    prev_value: float | None = None
    target: float | None = None
    dimension: str | None = None
    dim_value: str | None = None
    sparkline: list[float] = field(default_factory=list)

    @property
    def delta_abs(self) -> float | None:
        return None if self.prev_value is None else self.value - self.prev_value

    @property
    def delta_pct(self) -> float | None:
        if not self.prev_value:
            return None
        return (self.value - self.prev_value) / self.prev_value * 100.0

    @property
    def attainment_pct(self) -> float | None:
        if not self.target:
            return None
        return self.value / self.target * 100.0

    @property
    def status(self) -> Status:
        """Favourable-direction-aware health band using the metric's watch/risk bands."""
        d = self.delta_pct
        m = self.metric
        if d is None or (m.watch_pct is None and m.risk_pct is None):
            return Status.GOOD
        # normalise so that "adverse" is always negative
        adverse = d if m.higher_is_better else -d
        risk = m.risk_pct if m.risk_pct is not None else m.watch_pct
        watch = m.watch_pct if m.watch_pct is not None else m.risk_pct
        # bands are expressed as adverse thresholds (e.g. -15 for a drop, +12 for return-rate)
        risk_t = -abs(risk) if m.higher_is_better else -abs(risk)
        watch_t = -abs(watch) if m.higher_is_better else -abs(watch)
        if adverse <= risk_t:
            return Status.RISK
        if adverse <= watch_t:
            return Status.WATCH
        return Status.GOOD


@dataclass
class Alert:
    """A fired business rule."""
    rule_id: str
    domain: str
    severity: Severity
    message: str
    owner: str = ""
    entity: str | None = None
    entity_value: str | None = None
    metric: float | None = None
    threshold: float | None = None
    fired_at: datetime | None = None


@dataclass
class Insight:
    """AI (or rule-based) narrative for a material change."""
    kpi: str
    what: str
    why: str
    impact: str
    confidence: str = "medium"
    domain: str = ""


@dataclass
class Recommendation:
    action: str
    rationale: str
    priority: str            # P1|P2|P3
    owner: str
    eta_days: int | None = None
    est_value_inr: float | None = None


@dataclass
class RunResult:
    """Everything one 09:00 pipeline run produces — the report/dashboard payload."""
    run_id: str
    run_date: date
    period_label: str
    kpis: list[KpiValue] = field(default_factory=list)
    alerts: list[Alert] = field(default_factory=list)
    insights: list[Insight] = field(default_factory=list)
    recommendations: list[Recommendation] = field(default_factory=list)
    headline: str = ""
    exec_summary: str = ""
    generated_at: datetime | None = None
    deal_followup: dict = field(default_factory=dict)
