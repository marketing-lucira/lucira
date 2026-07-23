from bi_agent.core.models import KpiValue, Metric
from bi_agent.rules.engine import RuleEngine


def _kpi(key, value, prev, higher=True, dim=None, dimval=None, spark=None, target=None):
    m = Metric(key=key, label=key, domain="sales", unit="INR",
               higher_is_better=higher, target=target)
    return KpiValue(metric=m, value=value, prev_value=prev, target=target,
                    dimension=dim, dim_value=dimval, sparkline=spark or [])


def test_pct_drop_fires():
    rules = [{"id": "rev_drop", "domain": "sales", "evaluator": "pct_drop",
              "kpi": "revenue", "threshold": 15, "severity": "critical",
              "message": "down {delta_pct:.1f}%", "owner": "CEO"}]
    kpis = [_kpi("revenue", 700, 1400)]           # -50%
    alerts = RuleEngine(rules).evaluate(kpis)
    assert len(alerts) == 1 and alerts[0].rule_id == "rev_drop"


def test_threshold_below_grouped():
    rules = [{"id": "store_low", "domain": "sales", "evaluator": "threshold_below",
              "kpi": "store_target_attainment", "threshold": 70, "severity": "critical",
              "group_by": "store", "message": "{store} at {value:.0f}%", "owner": "Store Head"}]
    kpis = [_kpi("store_target_attainment", 65, 90, dim="store", dimval="A"),
            _kpi("store_target_attainment", 85, 90, dim="store", dimval="B")]
    alerts = RuleEngine(rules).evaluate(kpis)
    assert len(alerts) == 1 and alerts[0].entity_value == "A"


def test_override_disables_rule():
    rules = [{"id": "r", "domain": "sales", "evaluator": "pct_drop", "kpi": "revenue",
              "threshold": 15, "severity": "warn", "message": "x"}]
    kpis = [_kpi("revenue", 700, 1400)]
    alerts = RuleEngine(rules, overrides={"r": {"enabled": False}}).evaluate(kpis)
    assert alerts == []


def test_zscore_anomaly():
    rules = [{"id": "anom", "domain": "sales", "evaluator": "zscore_anomaly",
              "kpi": "revenue", "window_days": 30, "threshold": 2.5, "severity": "info",
              "message": "outlier z={zscore:.1f}"}]
    spark = [100.0] * 10 + [1000.0]     # last point is a big outlier
    kpis = [_kpi("revenue", 1000.0, 100.0, spark=spark)]
    alerts = RuleEngine(rules).evaluate(kpis)
    assert len(alerts) == 1
