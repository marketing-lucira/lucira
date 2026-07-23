"""Sales collector — sales_dashboard.sales_reporting (validated columns 2026-07-21).
Real cols: date, document_no, customer_id, customer_type, store, channel, category,
sale_type, qty, gross, net, discount, tax_amount. Net already = Gross/1.03; returns negative.
"""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd

from .base import BigQueryCollector

TABLE = "`lucirajewelry-prod.sales_dashboard.sales_reporting`"


class SalesCollector(BigQueryCollector):
    domain = "sales"
    MEASURES = {
        "revenue": {"measure": "revenue"},
        "orders": {"measure": "orders"},
        "aov": {"ratio": ("revenue", "orders")},
        "returns_value": {"measure": "returns_value"},
        "return_rate": {"ratio": ("returns_value", "gross")},
    }

    def collect(self, run_date: date, window_days: int) -> pd.DataFrame:
        start = run_date - timedelta(days=2 * window_days)
        sql = f"""
        SELECT
          date,
          SUM(gross)                                                    AS gross,
          SUM(net)                                                      AS revenue,
          COUNT(DISTINCT IF(sale_type NOT IN ('Return','Exchange'), document_no, NULL)) AS orders,
          SUM(IF(sale_type IN ('Return','Exchange'), ABS(net), 0))      AS returns_value
        FROM {TABLE}
        WHERE date BETWEEN @start AND @run_date
        GROUP BY date
        """
        return self.query(sql, {"start": start, "run_date": run_date})
