from datetime import date, timedelta

import pandas as pd

from bi_agent.core.models import Metric, Status
from bi_agent.kpi.engine import KpiEngine


def _frame(run_date):
    rows = []
    # current 7-day window: revenue 100/day ; previous 7-day: 200/day (a 50% drop)
    for i in range(7):
        rows.append({"date": run_date - timedelta(days=i), "store": "A",
                     "revenue": 100.0, "orders": 5})
    for i in range(7, 14):
        rows.append({"date": run_date - timedelta(days=i), "store": "A",
                     "revenue": 200.0, "orders": 5})
    return pd.DataFrame(rows)


def test_revenue_delta_and_status():
    run_date = date(2026, 7, 20)
    df = _frame(run_date)
    m = Metric(key="revenue", label="Revenue", domain="sales", unit="INR",
               agg="sum", higher_is_better=True, watch_pct=-10, risk_pct=-15)
    eng = KpiEngine(run_date, window_days=7)
    total = [k for k in eng.compute(m, df, "revenue") if k.dimension is None][0]
    assert total.value == 700.0            # 7 * 100
    assert total.prev_value == 1400.0      # 7 * 200
    assert round(total.delta_pct, 1) == -50.0
    assert total.status == Status.RISK     # -50% is worse than the -15% risk band


def test_ratio_metric_aov():
    run_date = date(2026, 7, 20)
    df = _frame(run_date)
    m = Metric(key="aov", label="AOV", domain="sales", unit="INR", agg="ratio")
    eng = KpiEngine(run_date, window_days=7)
    total = [k for k in eng.compute(m, df, "revenue", ratio_of=("revenue", "orders"))
             if k.dimension is None][0]
    assert total.value == 700.0 / 35.0     # revenue/orders over the current window


def test_slicing_by_store():
    run_date = date(2026, 7, 20)
    df = _frame(run_date)
    m = Metric(key="revenue", label="Revenue", domain="sales", unit="INR",
               agg="sum", slice_by=["store"])
    eng = KpiEngine(run_date, window_days=7)
    slices = [k for k in eng.compute(m, df, "revenue") if k.dimension == "store"]
    assert any(s.dim_value == "A" for s in slices)
