"""CRM collector — zoho_crm.cdc_deals + cdc_calls (validated 2026-07-21).
cdc rows carry a JSON `data` payload; fields via JSON_VALUE(data,'$.Field'). CDC can duplicate
an id across syncs, so we keep the latest row per id (QUALIFY). 'won' = Stage contains 'won';
'contacted' proxied by a non-null Last_Activity_Time (a true deal-call join is a Phase-2 upgrade).
"""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd

from .base import BigQueryCollector

DEALS = "`lucirajewelry-prod.zoho_crm.cdc_deals`"
CALLS = "`lucirajewelry-prod.zoho_crm.cdc_calls`"


class CrmCollector(BigQueryCollector):
    domain = "crm"
    MEASURES = {
        "deals": {"measure": "deals"},
        "calls": {"measure": "calls"},
        "conversion": {"ratio": ("won_deals", "deals")},
        "contact_rate": {"ratio": ("contacted_deals", "deals")},
    }

    def collect(self, run_date: date, window_days: int) -> pd.DataFrame:
        start = run_date - timedelta(days=2 * window_days)
        sql = f"""
        WITH d AS (
          SELECT id, created_time, data
          FROM {DEALS}
          QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY synced_at DESC) = 1
        ),
        deal_daily AS (
          SELECT DATE(created_time, 'Asia/Kolkata') AS date,
            COUNT(*) AS deals,
            COUNTIF(LOWER(JSON_VALUE(data,'$.Stage')) LIKE '%won%') AS won_deals,
            COUNTIF(JSON_VALUE(data,'$.Last_Activity_Time') IS NOT NULL) AS contacted_deals
          FROM d
          WHERE DATE(created_time, 'Asia/Kolkata') BETWEEN @start AND @run_date
          GROUP BY date
        ),
        c AS (
          SELECT id, created_time
          FROM {CALLS}
          QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY synced_at DESC) = 1
        ),
        call_daily AS (
          SELECT DATE(created_time, 'Asia/Kolkata') AS date, COUNT(*) AS calls
          FROM c
          WHERE DATE(created_time, 'Asia/Kolkata') BETWEEN @start AND @run_date
          GROUP BY date
        )
        SELECT date,
          IFNULL(deals, 0) AS deals, IFNULL(won_deals, 0) AS won_deals,
          IFNULL(contacted_deals, 0) AS contacted_deals, IFNULL(calls, 0) AS calls
        FROM deal_daily FULL OUTER JOIN call_daily USING (date)
        """
        df = self.query(sql, {"start": start, "run_date": run_date})
        return df.fillna(0)
