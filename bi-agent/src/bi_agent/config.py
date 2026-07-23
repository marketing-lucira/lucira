"""Typed config loader. All YAML under config/ becomes validated dataclasses here."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import yaml

from .core.models import Metric

CONFIG_DIR = Path(os.environ.get("BI_CONFIG_DIR", "config"))


def _load_yaml(name: str) -> dict:
    with open(CONFIG_DIR / name, "r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


@dataclass
class Settings:
    project: str
    location: str
    timezone: str
    bi_dataset: str
    max_bytes_billed: int
    snapshot_bucket: str
    snapshot_path: str
    reports_prefix: str
    window_trend: int
    window_delta: int
    llm: dict
    reports: dict
    notifications: dict
    logging: dict
    raw: dict = field(repr=False, default_factory=dict)

    @classmethod
    def load(cls) -> "Settings":
        s = _load_yaml("settings.yaml")
        return cls(
            project=s["project"],
            location=s["location"],
            timezone=s["timezone"],
            bi_dataset=s["bigquery"]["bi_dataset"],
            max_bytes_billed=int(s["bigquery"]["max_bytes_billed"]),
            snapshot_bucket=s["storage"]["snapshot_bucket"],
            snapshot_path=s["storage"]["snapshot_path"],
            reports_prefix=s["storage"]["reports_prefix"],
            window_trend=int(s["schedule"]["window_days_trend"]),
            window_delta=int(s["schedule"]["window_days_delta"]),
            llm=s.get("llm", {}),
            reports=s.get("reports", {}),
            notifications=s.get("notifications", {}),
            logging=s.get("logging", {}),
            raw=s,
        )


def load_metrics() -> list[Metric]:
    """Parse config/kpis.yaml into Metric objects (the KPI registry seed)."""
    data = _load_yaml("kpis.yaml")
    out: list[Metric] = []
    for k in data.get("kpis", []):
        out.append(Metric(
            key=k["key"], label=k["label"], domain=k["domain"], unit=k["unit"],
            agg=k.get("agg", "sum"), higher_is_better=k.get("higher_is_better", True),
            target=k.get("target"), watch_pct=k.get("watch_pct"), risk_pct=k.get("risk_pct"),
            slice_by=k.get("slice_by", []), describe=k.get("describe", ""),
        ))
    return out


def load_rules() -> list[dict]:
    return _load_yaml("rules.yaml").get("rules", [])


def load_sources() -> dict:
    return _load_yaml("sources.yaml").get("sources", {})


@lru_cache(maxsize=1)
def settings() -> Settings:
    return Settings.load()
