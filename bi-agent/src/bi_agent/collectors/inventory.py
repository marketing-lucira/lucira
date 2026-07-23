"""Inventory collector — reporting.inventory_intelligence_fact (validated 2026-07-21).
The fact is a daily point-in-time snapshot (CREATE OR REPLACE), so we read the latest
refresh_date and aggregate to a single date-grain row. Health/low-stock/dead-stock flags are
precomputed upstream. Prev-period deltas accrue from bi.fact_kpi_daily history as the agent runs.
"""
from __future__ import annotations

from datetime import date

import pandas as pd

from .base import BigQueryCollector

FACT = "`lucirajewelry-prod.reporting.inventory_intelligence_fact`"


class InventoryCollector(BigQueryCollector):
    domain = "inventory"
    MEASURES = {
        "inventory_value": {"measure": "inventory_value"},
        "inventory_health": {"measure": "inventory_health"},
        "low_stock_skus": {"measure": "low_stock_skus"},
        "dead_stock_pct": {"ratio": ("dead_value", "total_value")},
    }

    def collect(self, run_date: date, window_days: int) -> pd.DataFrame:
        sql = f"""
        SELECT
          refresh_date                                  AS date,
          SUM(inventory_value)                          AS inventory_value,
          AVG(health_score)                             AS inventory_health,
          SUM(CAST(is_low_stock AS INT64))              AS low_stock_skus,
          SUM(IF(is_dead_stock, inventory_value, 0))    AS dead_value,
          SUM(inventory_value)                          AS total_value
        FROM {FACT}
        WHERE refresh_date = (SELECT MAX(refresh_date) FROM {FACT})
        GROUP BY date
        """
        return self.query(sql)
