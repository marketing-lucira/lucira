# Lucira BI Copilot — AI Business Intelligence (MIS Automation) Agent

An AI business analyst for Lucira Jewelry. Every morning at **09:00 IST** it reads the data you
already have in BigQuery, computes KPIs, detects issues with configurable rules, explains them in
plain language, recommends actions, builds an executive PDF/Excel, and delivers it over
WhatsApp + Email — then serves a live executive dashboard.

> **It is a copilot, not another dashboard.** It sits *on top* of your existing reporting stack
> (sales / inventory / GA4 / CRM APIs) and never rebuilds it. See [ARCHITECTURE.md](ARCHITECTURE.md)
> for the full blueprint (folder structure, DB/BigQuery schema, APIs, prompt design, deployment,
> automation flow, and roadmap).

## How it fits what you already run

| Existing asset | The copilot's use |
|---|---|
| `sales_dashboard.sales_reporting` (10:00 IST) | sales fact |
| `reporting.inventory_intelligence_*` (09:00 IST) | inventory fact |
| `ga4_dashboard.ga4_*` (09:00 IST) | marketing/traffic fact |
| `zoho_crm.cdc_*` (15-min) | CRM fact |
| Cloud Scheduler → Cloud Run → GCS snapshot → HTML dashboard | same pattern, reused |

## The 8 modules → folders

1. **Data Collection** → `src/bi_agent/collectors/` (adapters over reporting tables)
2. **KPI Engine** → `src/bi_agent/kpi/` (driven by `config/kpis.yaml`)
3. **Rule Engine** → `src/bi_agent/rules/` (driven by `config/rules.yaml`)
4. **AI Insight Engine** → `src/bi_agent/insights/insight_engine.py`
5. **Recommendation Engine** → `src/bi_agent/insights/recommender.py`
6. **Dashboard** → `dashboard/bi-copilot.html`
7. **Report Generator** → `src/bi_agent/reports/` (PDF / Excel / summary)
8. **Notification Engine** → `src/bi_agent/notify/` (WhatsApp / Email)

Everything is orchestrated by `src/bi_agent/orchestrator.py`, triggered daily by Cloud Scheduler.

## Configure, don't code

The whole system is driven from `config/`:
- `settings.yaml` — project, datasets, buckets, schedule, LLM provider, notification channels
- `sources.yaml` — which reporting table backs each domain
- `kpis.yaml` — every KPI (add one = a new entry, no schema change)
- `rules.yaml` — every business rule (thresholds, drops, staleness, anomalies)
- `prompts/` — versioned AI prompt templates (insight / recommendation / exec summary)

## Run it

```bash
pip install -r requirements.txt
export BI_CONFIG_DIR=config

# local dry run (no writes, no notifications) — prints the exec summary
python -m bi_agent run --dry
python -m bi_agent run --date 2026-07-20 --dry

# unit tests (KPI math + rule engine, no cloud creds needed)
pytest -q
```

## Go live

```bash
./deploy.sh          # builds bi.* dataset, deploys Cloud Run, schedules 09:00 IST, smoke-tests
```
Then point `dashboard/bi-copilot.html`'s `CONFIG.SNAPSHOT_URL` at
`https://storage.googleapis.com/lucira-dashboards/bi/latest.json`.

IAM for the Cloud Run SA: `bigquery.jobUser`, `bigquery.dataViewer` (source datasets),
`bigquery.dataEditor` (`bi`), `storage.objectAdmin` (bucket), `aiplatform.user` (if Gemini via Vertex).

## Graceful degradation (house style)

- **No LLM key** → insights/recommendations/summary fall back to a **grounded rule-based** narrative.
- **A domain query fails** → that section is skipped, the rest of the report still ships.
- **WhatsApp not onboarded** → email still sends; flip `notifications.whatsapp.enabled` later.

## Status

Scaffold + full blueprint in place. Sales collector is implemented as the reference; CRM, marketing,
inventory, product, and ops collectors follow the same `BigQueryCollector` pattern. Next: validate
each collector's SQL against live reporting-table columns, wire the LLM + WhatsApp vendor, and build
`bi-copilot.html`. See [ARCHITECTURE.md §11](ARCHITECTURE.md).
