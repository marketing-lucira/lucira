"""Product collector — mandatory-attribute completeness from the inventory fact
(reporting.inventory_intelligence_fact, validated 2026-07-21). A SKU is flagged if it is missing
any of: image, metal, purity, weight, or MRP. Latest snapshot, date-grain.
"""
from __future__ import annotations

from datetime import date

import pandas as pd

from .base import BigQueryCollector

FACT = "`lucirajewelry-prod.reporting.inventory_intelligence_fact`"


class ProductCollector(BigQueryCollector):
    domain = "product"
    MEASURES = {"products_missing_attrs": {"measure": "products_missing_attrs"}}

    def collect(self, run_date: date, window_days: int) -> pd.DataFrame:
        sql = f"""
        SELECT refresh_date AS date,
          COUNT(DISTINCT IF(
            (image IS NULL AND image_url IS NULL)
            OR metal IS NULL OR TRIM(metal) = ''
            OR purity IS NULL OR TRIM(purity) = ''
            OR weight IS NULL OR weight = 0
            OR mrp IS NULL OR mrp <= 0,
            sku, NULL)) AS products_missing_attrs
        FROM {FACT}
        WHERE refresh_date = (SELECT MAX(refresh_date) FROM {FACT})
        GROUP BY date
        """
        return self.query(sql)
