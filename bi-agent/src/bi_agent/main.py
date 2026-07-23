"""Cloud Run entrypoint (Flask) + CLI.

Local:   python -m bi_agent run [--date YYYY-MM-DD] [--dry]
Cloud:   gunicorn -b :$PORT bi_agent.main:app   (POST /run triggered by Cloud Scheduler)
"""
from __future__ import annotations

import logging
import sys
from datetime import date, datetime, timezone

from flask import Flask, jsonify, request

from .config import settings
from .logging_setup import configure
from .orchestrator import Orchestrator

log = logging.getLogger(__name__)
app = Flask(__name__)
_last_run: dict = {"status": "never", "run_id": None, "at": None}


def _orchestrator() -> Orchestrator:
    return Orchestrator(settings())


@app.get("/health")
def health():
    return jsonify({"ok": True, "last_run": _last_run,
                    "now": datetime.now(timezone.utc).isoformat()})


@app.post("/run")
def run():
    dry = request.args.get("dry") in ("1", "true")
    run_date = request.args.get("date")
    rd = date.fromisoformat(run_date) if run_date else None
    result = _orchestrator().run(run_date=rd, dry=dry)
    _last_run.update(status="ok", run_id=result.run_id,
                     at=datetime.now(timezone.utc).isoformat())
    return jsonify({"run_id": result.run_id, "kpis": len(result.kpis),
                    "alerts": len(result.alerts), "dry": dry,
                    "headline": result.headline})


@app.get("/snapshot")
def snapshot():
    """Convenience: serves the public GCS snapshot URL (dashboard usually reads GCS directly)."""
    s = settings()
    return jsonify({"url": f"https://storage.googleapis.com/{s.snapshot_bucket}/{s.snapshot_path}"})


@app.post("/ask")
def ask():
    """Copilot Q&A stub — classify intent, query bi.fact_kpi_daily (allow-listed), answer.
    Full implementation mirrors inventory-intelligence-api's guarded NL->SQL 'chat' action."""
    q = (request.get_json(silent=True) or {}).get("question", "")
    return jsonify({"question": q, "answer": "Copilot Q&A not yet wired — see ARCHITECTURE §5."})


def _cli(argv: list[str]) -> int:
    s = settings()
    configure(s.logging.get("level", "INFO"), s.logging.get("json", True))
    if not argv or argv[0] != "run":
        print("usage: python -m bi_agent run [--date YYYY-MM-DD] [--dry]")
        return 1
    dry = "--dry" in argv
    rd = None
    if "--date" in argv:
        rd = date.fromisoformat(argv[argv.index("--date") + 1])
    result = _orchestrator().run(run_date=rd, dry=dry)
    print(result.exec_summary)
    return 0


# configure logging at import for the Flask/gunicorn path too
configure(settings().logging.get("level", "INFO"), settings().logging.get("json", True))

if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
