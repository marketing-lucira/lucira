"""Orchestrator — the 09:00 IST pipeline. Wires every module end-to-end with per-stage
error tolerance: a broken domain degrades its section, never the whole run."""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone

from . import dealfollowup
from . import decisionbook
from . import health as health_mod
from .config import CONFIG_DIR, Settings, load_metrics, load_rules, load_sources
from .core.models import KpiValue, RunResult
from .insights.insight_engine import InsightEngine
from .runlog import RunLog
from .storage.status import build as build_status
from .storage.status import write_local
from .insights.llm import LLMClient
from .insights.recommender import RecommendationEngine
from .kpi.engine import KpiEngine
from .kpi.registry import KpiRegistry
from .reports.summary import SummaryBuilder
from .rules.engine import RuleEngine
from .storage.bq import BiWriter
from .storage.gcs import SnapshotStore

log = logging.getLogger(__name__)


def _period_label(run_date: date, win: int) -> str:
    start = run_date - timedelta(days=win - 1)
    return f"{start:%d %b} – {run_date:%d %b %Y}" if win > 1 else f"{run_date:%d %b %Y}"


def _snapshot_payload(result: RunResult) -> dict:
    """The exact JSON contract the dashboard reads from GCS."""
    return {
        "meta": {"run_id": result.run_id, "run_date": str(result.run_date),
                 "period": result.period_label, "generated_at": str(result.generated_at),
                 "headline": result.headline},
        "kpis": [{"key": k.metric.key, "label": k.metric.label, "domain": k.metric.domain,
                  "unit": k.metric.unit, "dimension": k.dimension, "dim_value": k.dim_value,
                  "value": k.value, "prev": k.prev_value, "delta_pct": k.delta_pct,
                  "target": k.target, "attainment_pct": k.attainment_pct,
                  "status": k.status.value, "sparkline": k.sparkline} for k in result.kpis],
        "alerts": [{"rule_id": a.rule_id, "severity": a.severity.value, "domain": a.domain,
                    "message": a.message, "owner": a.owner} for a in result.alerts],
        "insights": [i.__dict__ for i in result.insights],
        "recommendations": [r.__dict__ for r in result.recommendations],
        "exec_summary": result.exec_summary,
        "deal_followup": result.deal_followup,
    }


class Orchestrator:
    def __init__(self, settings: Settings) -> None:
        self.s = settings
        self.registry = KpiRegistry(load_metrics())
        self.rules = RuleEngine(load_rules())
        self.sources = load_sources()
        self.llm = LLMClient(settings.llm)
        self.insight_engine = InsightEngine(self.llm)
        self.recommender = RecommendationEngine(self.llm)
        self.summary = SummaryBuilder(self.llm)

    def _collectors(self) -> list:
        """Instantiate the domain collectors. Each exposes .domain and .MEASURES.
        (ops/store-target are gated pending an ERP dispatch/target table — see ARCHITECTURE.)"""
        from .collectors.crm import CrmCollector
        from .collectors.customers import CustomerCollector
        from .collectors.inventory import InventoryCollector
        from .collectors.marketing import MarketingCollector
        from .collectors.product import ProductCollector
        from .collectors.sales import SalesCollector
        c = (self.s.project, self.s.location, self.s.max_bytes_billed)
        return [SalesCollector(*c), CustomerCollector(*c), CrmCollector(*c),
                MarketingCollector(*c), InventoryCollector(*c), ProductCollector(*c)]

    def run(self, run_date: date | None = None, dry: bool = False) -> RunResult:
        run_date = run_date or (datetime.now(timezone.utc).date() - timedelta(days=1))
        run_id = uuid.uuid4().hex[:12]
        win = self.s.window_delta
        result = RunResult(run_id=run_id, run_date=run_date,
                           period_label=_period_label(run_date, win),
                           generated_at=datetime.now(timezone.utc))
        rl = RunLog()
        log.info("run start", extra={"extra_fields": {"run_id": run_id, "date": str(run_date), "dry": dry}})

        # ① collect + ② compute KPIs (per-domain isolation, each a logged/retried step)
        engine = KpiEngine(run_date, win)
        kpis: list[KpiValue] = []
        dash_status: list[dict] = []
        for collector in self._collectors():
            df = rl.run(f"Collect · {collector.domain}",
                        lambda c=collector: c.collect(run_date, self.s.window_trend))
            dash_status.append({"domain": collector.domain, "ok": df is not None})
            if df is not None:
                kpis += self._compute(engine, collector, df)
        result.kpis = kpis

        # ③ rules
        result.alerts = rl.run("KPI + rules", lambda: self.rules.evaluate(kpis, context={})) or []

        # ④ insights + ⑤ recommendations
        result.insights = rl.run("AI insights",
                                 lambda: self.insight_engine.generate(kpis, result.alerts)) or []
        result.recommendations = rl.run("AI recommendations",
                                        lambda: self.recommender.recommend(result.insights, result.alerts)) or []
        result.headline = result.insights[0].what if result.insights else "Daily briefing."
        result.exec_summary = self.summary.render(result)

        # Deal Follow-up tracker (daily per-agent attendance + first-response + call duration)
        result.deal_followup = rl.run("Deal Follow-up analysis",
            lambda: dealfollowup.build(self._bq_client(), run_date, self.s.max_bytes_billed)) or {}

        # Business Health Score (7 departments)
        healthscore = health_mod.compute(kpis, result.alerts)

        automation = {"email_sent": 0, "whatsapp_sent": 0,
                      "insights_generated": len(result.insights),
                      "dashboards_ok": sum(d["ok"] for d in dash_status),
                      "dashboards_failed": sum(not d["ok"] for d in dash_status),
                      "failed_jobs": rl.failed, "retries": rl.retries}

        if not dry:
            rl.run("Publish snapshot", lambda: self._persist(result))
            sent = rl.run("Notify (email + WhatsApp)", lambda: self._notify(result)) or {}
            automation["email_sent"] = sent.get("email", 0)
            automation["whatsapp_sent"] = sent.get("whatsapp", 0)

        # Always refresh the desktop AI Business Monitor's status feed
        self._write_status(result, healthscore, rl, dash_status, automation)

        # Assemble + publish the single daily Executive Decision Book
        rl.run("Executive Decision Book", lambda: self._write_decision_book(result, healthscore))

        log.info("run complete", extra={"extra_fields": {
            "run_id": run_id, "kpis": len(result.kpis), "alerts": len(result.alerts),
            "health": healthscore.get("overall"), "failed_steps": rl.failed}})
        return result

    def _compute(self, engine: KpiEngine, collector, df) -> list[KpiValue]:
        """Compute every KPI the collector declares in its MEASURES map."""
        out: list[KpiValue] = []
        for kpi_key, spec in getattr(collector, "MEASURES", {}).items():
            try:
                metric = self.registry.get(kpi_key)
            except KeyError:
                continue
            ratio = spec.get("ratio")
            measure = spec.get("measure") or (ratio[0] if ratio else None)
            try:
                out += engine.compute(metric, df, measure, ratio_of=tuple(ratio) if ratio else None)
            except Exception:
                log.exception("kpi %s compute failed", kpi_key)
        return out

    def _persist(self, result: RunResult) -> None:
        try:
            store = SnapshotStore(self.s.snapshot_bucket, self.s.project)
            store.publish_json(self.s.snapshot_path, _snapshot_payload(result))
        except Exception:
            log.exception("snapshot publish failed")
        try:
            writer = BiWriter(self.s.project, self.s.bi_dataset, self.s.location)
            writer.write_alerts(result.run_id, result.alerts)
            writer.write_insights(result.run_id, result.generated_at, result.insights,
                                  result.recommendations, self.llm.model, "v1")
        except Exception:
            log.exception("bq log write failed")

    def _notify(self, result: RunResult) -> dict:
        from .notify.email import EmailNotifier
        from .notify.whatsapp import WhatsAppNotifier
        attachments: dict[str, bytes] = {}
        try:  # reports are best-effort; failure must not block notification of the summary
            from .reports.excel import ExcelReporter
            attachments[f"lucira-mis-{result.run_date}.xlsx"] = ExcelReporter().render(result)
        except Exception:
            log.exception("excel report failed")
        sent = {"email": 0, "whatsapp": 0}
        for notifier in (EmailNotifier(self.s.notifications.get("email", {})),
                         WhatsAppNotifier(self.s.notifications.get("whatsapp", {}))):
            try:
                if notifier.send(result, attachments):
                    sent[notifier.channel] = 1
            except Exception:
                log.exception("%s notify failed", notifier.channel)
        return sent

    def _write_status(self, result: RunResult, healthscore: dict, rl: RunLog,
                      dash_status: list[dict], automation: dict) -> None:
        """Write the desktop AI Business Monitor's status.json (local + GCS mirror)."""
        cfg = self.s.raw.get("agent", {})
        dashboards = [{"name": d.get("name"), "status": self._dash_health(d, dash_status),
                       "url": d.get("url", "")} for d in self.s.raw.get("dashboards", [])]
        status = build_status(result, healthscore, rl, dashboards, automation)
        try:
            out = CONFIG_DIR.parent / "desktop" / cfg.get("status_file", "status.json")
            write_local(status, str(out))
        except Exception:
            log.exception("local status write failed")
        try:  # mirror to GCS so a hosted monitor can read it too
            SnapshotStore(self.s.snapshot_bucket, self.s.project).publish_json("bi/status.json", status)
        except Exception:
            log.exception("status GCS mirror failed")

    def _bq_client(self):
        if getattr(self, "_client", None) is None:
            from google.cloud import bigquery
            self._client = bigquery.Client(project=self.s.project, location=self.s.location)
        return self._client

    def _write_decision_book(self, result: RunResult, healthscore: dict) -> None:
        """Build the sectioned Executive Decision Book and publish it (local + GCS)."""
        book = decisionbook.build(result, healthscore, client=self._bq_client(), mbb=self.s.max_bytes_billed)
        try:
            out = CONFIG_DIR.parent / "dashboard" / "decision-book.json"
            write_local(book, str(out))
        except Exception:
            log.exception("local decision-book write failed")
        try:
            SnapshotStore(self.s.snapshot_bucket, self.s.project).publish_json("bi/decision-book.json", book)
        except Exception:
            log.exception("decision-book GCS publish failed")

    @staticmethod
    def _dash_health(dash: dict, dash_status: list[dict]) -> str:
        if not dash.get("url"):
            return "red"                      # not connected
        m = next((d for d in dash_status if d["domain"] == dash.get("key")), None)
        if m is None:
            return "green"                    # external dashboard, not collector-backed
        return "green" if m["ok"] else "red"
