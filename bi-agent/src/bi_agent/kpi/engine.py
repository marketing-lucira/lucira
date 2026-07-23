"""KPI Engine — turns collected frames into KpiValue objects (current, prev, delta, status).

Collectors return DATE-GRAIN frames: one row per date with the measure columns. The engine
aggregates over the current and previous windows using each metric's `agg` (sum/avg/last/ratio).
Percentage ratios (unit == 'pct') are scaled ×100. Pure functions over pandas — unit-testable.
"""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd

from ..core.models import KpiValue, Metric


def _agg(series: pd.Series, how: str) -> float:
    if series.empty:
        return 0.0
    if how == "avg":
        return float(series.mean())
    if how == "last":
        return float(series.iloc[-1])
    return float(series.sum())  # sum is the default (also used as the ratio components' agg)


class KpiEngine:
    def __init__(self, run_date: date, window_days: int) -> None:
        self.run_date = run_date
        self.window = window_days
        self.cur_start = run_date - timedelta(days=window_days - 1)
        self.prev_start = run_date - timedelta(days=2 * window_days - 1)
        self.prev_end = run_date - timedelta(days=window_days)

    def _slice(self, df: pd.DataFrame, start: date, end: date) -> pd.DataFrame:
        d = pd.to_datetime(df["date"]).dt.date
        return df[(d >= start) & (d <= end)]

    def compute(self, metric: Metric, df: pd.DataFrame, measure: str | None,
                ratio_of: tuple[str, str] | None = None) -> list[KpiValue]:
        """Compute total (+ optional per-slice) KpiValues for one metric.

        `measure`   column to aggregate for sum/avg/last (and the sparkline series).
        `ratio_of`  (numerator_col, denominator_col) for agg='ratio' (e.g. revenue/orders).
        """
        if df is None or df.empty or "date" not in df:
            return []
        df = df.sort_values("date")
        cur = self._slice(df, self.cur_start, self.run_date)
        prev = self._slice(df, self.prev_start, self.prev_end)

        def measure_of(frame: pd.DataFrame) -> float:
            if metric.agg == "ratio" and ratio_of:
                num = _agg(frame[ratio_of[0]], "sum")
                den = _agg(frame[ratio_of[1]], "sum")
                val = (num / den) if den else 0.0
                return val * 100.0 if metric.unit == "pct" else val
            if measure is None or measure not in frame:
                return 0.0
            return _agg(frame[measure], metric.agg)

        # 30-point daily sparkline of the measure (or numerator for ratios)
        spark_col = measure or (ratio_of[0] if ratio_of else None)
        if spark_col and spark_col in df:
            daily = (self._slice(df, self.run_date - timedelta(days=29), self.run_date)
                     .groupby("date")[spark_col].sum().sort_index())
            sparkline = [float(x) for x in daily.tolist()][-30:]
        else:
            sparkline = []

        out = [KpiValue(metric=metric, value=measure_of(cur), prev_value=measure_of(prev),
                        target=metric.target, sparkline=sparkline)]

        for dim in metric.slice_by:
            if dim not in df.columns:
                continue
            for dim_value, g_cur in cur.groupby(dim):
                g_prev = prev[prev[dim] == dim_value]
                out.append(KpiValue(metric=metric, value=measure_of(g_cur), prev_value=measure_of(g_prev),
                                    target=metric.target, dimension=dim, dim_value=str(dim_value)))
        return out
