"""Execution log + retry — tracks every pipeline step (start/end/duration/status/retries/error)
for the AI Business Monitor. Failed steps auto-retry up to N times before being marked failed.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

log = logging.getLogger(__name__)


class RunLog:
    def __init__(self, max_retries: int = 3) -> None:
        self.max_retries = max_retries
        self.started_at = datetime.now(timezone.utc)
        self._t0 = time.monotonic()
        self.steps: list[dict] = []

    def record(self, name: str, status: str, duration: float, retry_count: int = 0, error: str = "") -> None:
        self.steps.append({"name": name, "status": status, "duration_sec": round(duration, 2),
                           "retry_count": retry_count, "error": error})

    def run(self, name: str, fn, retries: int | None = None):
        """Execute fn() with retry. Records one step (ok / retry-recovered / fail). Returns fn()'s
        result, or None on terminal failure (the pipeline degrades that section, never crashes)."""
        retries = self.max_retries if retries is None else retries
        t0 = time.monotonic()
        last_err = ""
        for attempt in range(retries + 1):
            try:
                result = fn()
                dur = time.monotonic() - t0
                self.record(name, "retry" if attempt else "ok", dur, attempt,
                            f"recovered after {attempt} retr{'y' if attempt == 1 else 'ies'}: {last_err}" if attempt else "")
                return result
            except Exception as e:  # noqa: BLE001
                last_err = f"{type(e).__name__}: {e}"
                log.warning("step '%s' attempt %d/%d failed: %s", name, attempt + 1, retries + 1, last_err)
        self.record(name, "fail", time.monotonic() - t0, retries, last_err)
        return None

    @property
    def duration_sec(self) -> float:
        return time.monotonic() - self._t0

    @property
    def failed(self) -> int:
        return sum(1 for s in self.steps if s["status"] == "fail")

    @property
    def retries(self) -> int:
        return sum(s["retry_count"] for s in self.steps)

    def overall_status(self, health_overall: int | None) -> str:
        if self.failed:
            return "red"
        if health_overall is not None and health_overall < 60:
            return "red"
        if self.retries or (health_overall is not None and health_overall < 80):
            return "yellow"
        return "green"
