"""Marketing collector — GA4 sessions/conversion (ga4_dashboard.ga4_fact_sessions) merged with
Meta ad spend (meta_ads.AdInsights) by date (validated 2026-07-21).

CAVEATS: (1) GA4 purchases/revenue are tiny — checkout completes off-GA4 via GoKwik — so
marketing_roi computed from GA4 revenue UNDERSTATES true ROAS; wire Shopify/sales revenue for a
real ROAS in Phase 2. (2) AdInsights is multi-level; we sum Level='ad' to avoid double counting;
Google Ads spend is a follow-up union.
"""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd

from .base import BigQueryCollector

GA4 = "`lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`"
ADS = "`lucirajewelry-prod.meta_ads.AdInsights`"


class MarketingCollector(BigQueryCollector):
    domain = "marketing"
    MEASURES = {
        "sessions": {"measure": "sessions"},
        "marketing_conversion": {"ratio": ("purchases", "sessions")},
        "ad_spend": {"measure": "ad_spend"},
        "marketing_roi": {"ratio": ("ga4_revenue", "ad_spend")},
    }

    def collect(self, run_date: date, window_days: int) -> pd.DataFrame:
        start = run_date - timedelta(days=2 * window_days)
        ga4 = self.query(f"""
            SELECT session_date AS date,
              COUNT(*)              AS sessions,
              SUM(ev_purchase)      AS purchases,
              SUM(revenue)          AS ga4_revenue
            FROM {GA4}
            WHERE session_date BETWEEN @start AND @run_date
            GROUP BY date
        """, {"start": start, "run_date": run_date})

        spend = self.query(f"""
            SELECT DateStart AS date, CAST(SUM(Spend) AS FLOAT64) AS ad_spend
            FROM {ADS}
            WHERE DateStart BETWEEN @start AND @run_date AND LOWER(Level) = 'ad'
            GROUP BY date
        """, {"start": start, "run_date": run_date})

        if spend.empty:
            ga4["ad_spend"] = 0.0
            return ga4
        return ga4.merge(spend, on="date", how="left").fillna({"ad_spend": 0.0})
