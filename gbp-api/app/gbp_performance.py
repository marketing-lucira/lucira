"""Daily performance metrics via the Business Profile Performance API.

GET https://businessprofileperformance.googleapis.com/v1/{location=locations/*}:fetchMultiDailyMetricsTimeSeries
    ?dailyMetrics=CALL_CLICKS&dailyMetrics=BUSINESS_DIRECTION_REQUESTS
    &dailyRange.start_date.year=...&dailyRange.start_date.month=...&dailyRange.start_date.day=...
    &dailyRange.end_date.year=...  (etc)

Only CALL_CLICKS and BUSINESS_DIRECTION_REQUESTS are requested/stored per the
"don't add extra metrics unless required" instruction -- other available
DailyMetric enums (WEBSITE_CLICKS, BUSINESS_IMPRESSIONS_DESKTOP_SEARCH, etc.)
exist in the API and can be added to config.DAILY_METRICS later if wanted,
but are intentionally left out of the reporting table for now.
"""
import datetime as dt

from app import config
from app.logging_utils import request_with_retry


def _date_params(prefix: str, d: dt.date) -> dict:
    return {
        f"{prefix}.year": d.year,
        f"{prefix}.month": d.month,
        f"{prefix}.day": d.day,
    }


def get_daily_metrics(access_token: str, location_id: str, start: dt.date, end: dt.date) -> dict:
    """Returns {date_iso: {"call_clicks": int|None, "direction_requests": int|None}}
    for every day in [start, end], inclusive. Missing days/metrics are left
    absent (caller stores NULL) rather than invented.
    """
    headers = {"Authorization": f"Bearer {access_token}"}
    params = {"dailyMetrics": config.DAILY_METRICS}
    params.update(_date_params("dailyRange.startDate", start))
    params.update(_date_params("dailyRange.endDate", end))

    resp = request_with_retry(
        "GET",
        f"{config.PERFORMANCE_BASE}/locations/{location_id}:fetchMultiDailyMetricsTimeSeries",
        headers=headers, params=params,
    )
    if resp.status_code == 404:
        return {}
    if resp.status_code >= 400:
        raise RuntimeError(f"fetchMultiDailyMetricsTimeSeries failed ({resp.status_code}): {resp.text}")

    data = resp.json()
    by_date: dict[str, dict] = {}
    metric_key = {"CALL_CLICKS": "call_clicks", "BUSINESS_DIRECTION_REQUESTS": "direction_requests"}

    for series in data.get("multiDailyMetricTimeSeries", []):
        for dm in series.get("dailyMetricTimeSeries", []):
            metric = dm.get("dailyMetric")
            key = metric_key.get(metric)
            if not key:
                continue
            for dv in dm.get("timeSeries", {}).get("datedValues", []):
                date = dv.get("date", {})
                if not date:
                    continue
                iso = dt.date(date["year"], date["month"], date["day"]).isoformat()
                by_date.setdefault(iso, {"call_clicks": None, "direction_requests": None})
                value = dv.get("value")
                by_date[iso][key] = int(value) if value is not None else None

    return by_date
