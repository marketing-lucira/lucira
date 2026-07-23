"""Builds and writes the AI Business Monitor's status.json (local desktop-panel state,
optionally mirrored to GCS). This is the operational feed the desktop control panel reads."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..core.models import RunResult

log = logging.getLogger(__name__)


def _next_10am_ist(now_utc: datetime) -> str:
    ist = now_utc + timedelta(hours=5, minutes=30)
    nxt = ist.replace(hour=10, minute=0, second=0, microsecond=0)
    if nxt <= ist:
        nxt += timedelta(days=1)
    return (nxt - timedelta(hours=5, minutes=30)).replace(tzinfo=timezone.utc).isoformat()


def build(result: RunResult, health: dict, runlog, dashboards: list[dict],
          automation: dict) -> dict:
    now = datetime.now(timezone.utc)
    return {
        "meta": {"generated_at": now.isoformat(), "period": result.period_label, "source": "live"},
        "system": {
            "status": runlog.overall_status(health.get("overall")),
            "last_run": (result.generated_at or now).isoformat(),
            "next_run": _next_10am_ist(now),
            "run_id": result.run_id,
            "duration_sec": round(runlog.duration_sec, 1),
        },
        "health": health,
        "automation": automation,
        "dashboards": dashboards,
        "alerts": [{"severity": a.severity.value, "domain": a.domain,
                    "message": a.message, "owner": a.owner} for a in result.alerts],
        "insights": [{"what": i.what, "confidence": i.confidence} for i in result.insights],
        "recommendations": [{"action": r.action, "priority": r.priority, "owner": r.owner,
                             "eta_days": r.eta_days, "est_value_inr": r.est_value_inr,
                             "difficulty": getattr(r, "difficulty", None),
                             "confidence": getattr(r, "confidence", None)} for r in result.recommendations],
        "steps": runlog.steps,
    }


def write_local(status: dict, path: str) -> str:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(status, indent=2, default=str), encoding="utf-8")
    log.info("wrote status.json -> %s", p.resolve())
    return str(p.resolve())
