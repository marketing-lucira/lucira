"""Customer collector — new vs repeat, keyed on customer_id (mobile-derived identity in the
reporting table). 'new' = first-ever purchase falls on that day; 'repeat' = bought before.
Note: new_customers summed over a window = distinct new (each new once). repeat is a per-day
distinct that can double-count a customer across days in a multi-day window (acceptable at
the 2-day daily-delta window; use bi.fact_kpi_daily history for exact period repeat).
"""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd

from .base import BigQueryCollector

TABLE = "`lucirajewelry-prod.sales_dashboard.sales_reporting`"


class CustomerCollector(BigQueryCollector):
    domain = "sales"
    MEASURES = {
        "new_customers": {"measure": "new_customers"},
        "repeat_customers": {"measure": "repeat_customers"},
    }

    def collect(self, run_date: date, window_days: int) -> pd.DataFrame:
        start = run_date - timedelta(days=2 * window_days)
        sql = f"""
        WITH firsts AS (
          SELECT customer_id, MIN(date) AS first_date
          FROM {TABLE}
          WHERE customer_id IS NOT NULL AND sale_type NOT IN ('Return','Exchange')
          GROUP BY customer_id
        ),
        day AS (
          SELECT DISTINCT date, customer_id
          FROM {TABLE}
          WHERE customer_id IS NOT NULL AND sale_type NOT IN ('Return','Exchange')
            AND date BETWEEN @start AND @run_date
        )
        SELECT d.date,
          COUNTIF(f.first_date = d.date) AS new_customers,
          COUNTIF(f.first_date <  d.date) AS repeat_customers
        FROM day d JOIN firsts f USING (customer_id)
        GROUP BY date
        """
        return self.query(sql, {"start": start, "run_date": run_date})
