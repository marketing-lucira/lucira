"""BigQueryCollector base — safe, cached reads from the EXISTING reporting tables only."""
from __future__ import annotations

import logging
from datetime import date

import pandas as pd

log = logging.getLogger(__name__)


class BigQueryCollector:
    """Base adapter. Subclasses set `domain` and implement `collect()` using `self.query()`.

    Never queries a raw source table at request time — only the reporting/summary tables
    declared in config/sources.yaml. Enforces a bytes-billed cap.
    """
    domain: str = "base"
    # kpi_key -> {"measure": col} for sum/avg/last, or {"ratio": (num_col, den_col)} for ratios.
    MEASURES: dict = {}

    def __init__(self, project: str, location: str, max_bytes_billed: int) -> None:
        self.project = project
        self.location = location
        self.max_bytes_billed = max_bytes_billed
        self._client = None

    @property
    def client(self):
        if self._client is None:
            from google.cloud import bigquery  # lazy import (keeps unit tests dependency-free)
            self._client = bigquery.Client(project=self.project, location=self.location)
        return self._client

    def query(self, sql: str, params: dict | None = None) -> pd.DataFrame:
        from google.cloud import bigquery
        job_config = bigquery.QueryJobConfig(
            maximum_bytes_billed=self.max_bytes_billed,
            query_parameters=[
                bigquery.ScalarQueryParameter(k, "DATE" if isinstance(v, date) else "STRING", v)
                for k, v in (params or {}).items()
            ],
        )
        log.info("bq query", extra={"extra_fields": {"domain": self.domain}})
        return self.client.query(sql, job_config=job_config).result().to_dataframe()

    def collect(self, run_date: date, window_days: int) -> pd.DataFrame:  # pragma: no cover
        raise NotImplementedError
