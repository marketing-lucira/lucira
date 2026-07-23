# Lucira BI Copilot — Enterprise AI Business Intelligence (MIS Automation) Agent

> An AI-powered business analyst for Lucira Jewelry that **collects** data, **computes** KPIs,
> **detects** issues via configurable rules, **explains** them in natural language, **recommends**
> actions, **generates** executive reports, and **delivers** them over WhatsApp + Email —
> automatically, every morning at **09:00 IST**.

This is not "another dashboard." It is a **copilot** that turns the data you already have in
BigQuery into decisions.

---

## 0. Design principle — build ON TOP, do not rebuild

Lucira already runs a mature reporting stack. This agent **reuses** it rather than duplicating it:

| Layer that already exists | Owned by | The BI Copilot's relationship |
|---|---|---|
| `sales_dashboard.sales_reporting*` (daily 10:00 IST) | `sales-reporting-api` | **Read** as the sales fact |
| `reporting.inventory_intelligence_*` (daily 09:00 IST) | `inventory-intelligence-api` | **Read** as the inventory fact |
| `ga4_dashboard.ga4_fact_sessions` + summaries (daily 09:00 IST) | `ga4-bq-api` | **Read** as the marketing/traffic fact |
| `zoho_crm.cdc_*` (every 15 min) | `zoho-login-dashboard` | **Read** as the CRM fact |
| `shopify_raw.*`, `ornaverse_erp_*`, `gold_rates`, `meta_ads`, `google_ads` | ETL pipelines | **Read** for orders/returns/payments/store perf |
| Cloud Scheduler → Cloud Run → public GCS snapshot → HTML dashboard | all APIs | **Same pattern**, reused verbatim |

> **Golden rule:** the BI Copilot never touches a raw source table on request-time. It only reads
> **reporting/summary tables** (already deduped, typed, business-ruled) and its own `bi.*` layer.
> This keeps cost bounded, latency < 3s, and business logic in exactly one place per domain.

---

## 1. System architecture (logical)

```
                          ┌─────────────────────────────────────────────────────────┐
                          │                  DATA SOURCES (existing)                 │
                          │  Zoho CRM · Shopify · GA4 · ERP(Ornaverse) · WebEngage   │
                          │  Meta/Google Ads · Gold Rates · Payments · Returns       │
                          └───────────────┬─────────────────────────────────────────┘
                                          │  (already synced to BigQuery by existing ETL)
                                          ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │                          BIGQUERY  (lucirajewelry-prod)                            │
   │                                                                                     │
   │   RAW / STAGING            REPORTING (per-domain, exists)        BI SEMANTIC (NEW)  │
   │   shopify_raw.*            sales_dashboard.sales_reporting        bi.dim_date        │
   │   zoho_crm.cdc_*     ─┐    reporting.inventory_intelligence_*     bi.fact_kpi_daily  │
   │   ornaverse_erp_*     ├──► ga4_dashboard.ga4_*                ──► bi.kpi_snapshot    │
   │   ga4_data.*          │    zoho_crm reporting views              bi.alerts_log       │
   │   meta_ads/google_ads┘    (single source of truth per domain)    bi.insights_log    │
   │                                                                    bi.rule_config     │
   └───────────────────────────────────────────┬───────────────────────────────────────┘
                                                │  read reporting + write bi.*
                                                ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │            BI COPILOT SERVICE  (Cloud Run, python, modular clean-arch)             │
   │                                                                                     │
   │   ① Collection ──► ② KPI Engine ──► ③ Rule Engine ──► ④ Insight Engine (LLM)       │
   │       (adapters)      (metric          (YAML rules,      "what / why / impact")     │
   │                        registry)        anomalies)              │                   │
   │                                                                 ▼                   │
   │                                              ⑤ Recommendation Engine (LLM)          │
   │                                                                 │                   │
   │                          ┌──────────────────────────────────────┤                   │
   │                          ▼                        ▼             ▼                   │
   │                  ⑦ Report Generator      GCS snapshot     ⑧ Notification            │
   │                    (PDF / Excel /         (bi/latest.json)   (WhatsApp / Email)      │
   │                     Exec Summary)                                                    │
   └───────────────────────────────────────────┬───────────────────────────────────────┘
                                                │  serves latest.json
                                                ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │        ⑥ EXECUTIVE COPILOT DASHBOARD  (bi-copilot.html, self-contained)            │
   │   Executive Summary · Sales · Marketing · CRM · Inventory · Product · Operations   │
   │   AI Insights · Alerts · Recommendations · ✨ Ask-AI copilot                        │
   └───────────────────────────────────────────────────────────────────────────────────┘

           ⑨ AUTOMATION:  Cloud Scheduler  0 9 * * *  Asia/Kolkata  ──►  POST /run
```

Each numbered block maps 1:1 to the modules the brief requested.

---

## 2. Folder structure

```
bi-agent/
├── README.md                       # quickstart + how it fits the existing stack
├── ARCHITECTURE.md                 # ← this document
├── requirements.txt
├── pyproject.toml
├── Dockerfile
├── deploy.sh                       # dataset + Cloud Run + Scheduler, one command
├── .env.example
├── .gcloudignore
│
├── config/                         # ← the whole system is driven from here
│   ├── settings.yaml               # project, datasets, buckets, schedule, channels
│   ├── sources.yaml                # data-source registry (which BQ table backs each domain)
│   ├── kpis.yaml                   # KPI definitions (metric registry, single source of truth)
│   ├── rules.yaml                  # configurable business rules
│   └── prompts/                    # AI prompt design (versioned templates)
│       ├── insight.md
│       ├── recommendation.md
│       └── exec_summary.md
│
├── sql/                            # BI semantic layer DDL (idempotent)
│   ├── 00_setup_bi_dataset.sql     # CREATE SCHEMA bi + config/log tables
│   ├── 10_dim_date.sql             # calendar dim (IST, festivals, fiscal)
│   ├── 20_fact_kpi_daily.sql       # per-day × domain KPI fact (the copilot's heart)
│   ├── 30_kpi_snapshot.sql         # latest period-over-period rollup for the dashboard
│   └── 40_logs.sql                 # alerts_log + insights_log tables
│
├── src/bi_agent/
│   ├── __init__.py
│   ├── main.py                     # Cloud Run entrypoint (Flask) + CLI (`python -m bi_agent`)
│   ├── orchestrator.py             # runs the full pipeline end-to-end
│   ├── config.py                   # typed config loader (pydantic)
│   ├── logging_setup.py            # structured JSON logging + Cloud Logging
│   │
│   ├── core/
│   │   ├── models.py               # domain dataclasses: Metric, KpiValue, Alert, Insight…
│   │   └── interfaces.py           # Protocols: Collector, RuleEvaluator, Notifier, Reporter
│   │
│   ├── collectors/                 # ① DATA COLLECTION LAYER (adapters, one per domain)
│   │   ├── base.py                 # BigQueryCollector base (query + cache + dry-run guard)
│   │   ├── sales.py
│   │   ├── crm.py
│   │   ├── ga4.py
│   │   ├── inventory.py
│   │   ├── shopify.py
│   │   ├── returns.py
│   │   └── stores.py
│   │
│   ├── kpi/                        # ② KPI ENGINE
│   │   ├── registry.py             # loads kpis.yaml → Metric objects
│   │   └── engine.py               # computes value · prev · delta · target · status
│   │
│   ├── rules/                      # ③ RULE ENGINE
│   │   ├── engine.py               # evaluates rules.yaml against KPI + row context
│   │   └── evaluators.py           # threshold / drop / staleness / missing-attr / anomaly
│   │
│   ├── insights/                   # ④ INSIGHT + ⑤ RECOMMENDATION ENGINES
│   │   ├── llm.py                  # provider-agnostic LLM client (Gemini/Claude)
│   │   ├── insight_engine.py       # what / why / business impact
│   │   └── recommender.py          # prioritized, owner-assigned actions
│   │
│   ├── reports/                    # ⑦ REPORT GENERATOR
│   │   ├── summary.py              # executive-summary builder (structured → text)
│   │   ├── pdf.py                  # branded PDF (WeasyPrint/HTML→PDF)
│   │   └── excel.py                # multi-sheet .xlsx (openpyxl)
│   │
│   ├── notify/                     # ⑧ NOTIFICATION ENGINE
│   │   ├── email.py                # SMTP / SendGrid
│   │   └── whatsapp.py             # WhatsApp Cloud API / Gupshup / Interakt
│   │
│   └── storage/
│       ├── bq.py                   # write kpi/alerts/insights back to bi.*
│       └── gcs.py                  # publish latest.json + archive PDFs/Excel
│
├── dashboard/
│   └── bi-copilot.html             # ⑥ executive dashboard (self-contained, reads latest.json)
│
└── tests/
    ├── conftest.py
    ├── test_config.py
    ├── test_kpi_engine.py
    ├── test_rule_engine.py
    └── test_report_summary.py
```

**Clean-architecture layering** (dependencies point inward):

```
main / orchestrator  →  collectors / kpi / rules / insights / reports / notify  →  core (models + interfaces)  ←  config
```

`core` depends on nothing. Every outer module depends only on `core` interfaces, so any piece
(LLM provider, WhatsApp vendor, a KPI's SQL) is swappable without touching the rest.

---

## 3. Database / BigQuery design (the `bi` semantic layer)

A new dataset `lucirajewelry-prod.bi` (location `asia-south1`, matching the sources). Five objects:

### 3.1 `bi.dim_date` — calendar dimension
```sql
date            DATE      -- PK
day_name        STRING
iso_week        INT64
month, quarter, year INT64
fiscal_year     STRING    -- Apr–Mar
is_weekend      BOOL
festival        STRING    -- 'Diwali','Akshaya Tritiya','Valentine', NULL  (jewelry seasonality)
season_weight   FLOAT64   -- demand multiplier used for target normalisation
```

### 3.2 `bi.fact_kpi_daily` — the heart (long/tall, one row per metric per day)
```sql
date            DATE      NOT NULL     -- PARTITION BY date
domain          STRING    NOT NULL     -- 'sales'|'marketing'|'crm'|'inventory'|'product'|'ops'
kpi_key         STRING    NOT NULL     -- 'revenue','orders','aov','conversion',...  CLUSTER BY
dimension       STRING                 -- optional slice: store / channel / category (NULL = total)
dim_value       STRING
value           FLOAT64                -- the measured value
unit            STRING                 -- 'INR' | 'count' | 'pct' | 'days' | 'ratio'
target          FLOAT64                -- from kpis.yaml or store target table (nullable)
source_table    STRING                 -- provenance
computed_at      TIMESTAMP
-- PARTITION BY date  CLUSTER BY domain, kpi_key
```
> Tall design = adding a KPI is a config change, never a schema migration. Every KPI, every slice,
> every domain lives in one queryable table the dashboard and reports read.

### 3.3 `bi.kpi_snapshot` — dashboard-ready rollup (rebuilt daily)
Wide, small, one row per `(domain,kpi_key,dimension,dim_value)` with `value`, `prev_value`,
`delta_abs`, `delta_pct`, `target`, `attainment_pct`, `status` (`good|watch|risk`), `sparkline`
(ARRAY<FLOAT64> last 30 pts). This is what the copilot serialises to `bi/latest.json`.

### 3.4 `bi.alerts_log` — every rule firing (audit + trend)
```sql
run_id STRING, fired_at TIMESTAMP, rule_id STRING, severity STRING,   -- 'info|warn|critical'
domain STRING, entity STRING, entity_value STRING,
metric FLOAT64, threshold FLOAT64, message STRING, status STRING       -- 'open|ack|resolved'
-- PARTITION BY DATE(fired_at)
```

### 3.5 `bi.insights_log` — generated narratives + recommendations (LLM output, cached)
```sql
run_id STRING, generated_at TIMESTAMP, domain STRING, kpi_key STRING,
headline STRING, what STRING, why STRING, impact STRING,
recommendation STRING, priority STRING, owner STRING, eta_days INT64,
est_value_inr FLOAT64, model STRING, prompt_version STRING
-- PARTITION BY DATE(generated_at)
```

### 3.6 `bi.rule_config` (optional) — rules editable without redeploy
Mirror of `config/rules.yaml` so non-engineers can toggle/tune thresholds from a sheet or admin UI.
`rules.yaml` is the seed; `bi.rule_config` (if present) overrides at runtime.

---

## 4. Module specifications

### ① Data Collection Layer (`collectors/`)
- One **adapter per domain**, all extending `BigQueryCollector` (connection pooling, `maximum_bytes_billed` guard, LRU cache per run, `@run_date` param).
- Adapters return **tidy `pandas.DataFrame`s** with a documented contract, never raw SQL results leaked upward.
- **Incremental**: every collector reads a windowed slice (`WINDOW_DAYS`, default 400 for trends, 2 for the daily delta). Because the upstream reporting tables are already incrementally refreshed, the agent inherits incremental-refresh for free.
- `sources.yaml` maps `domain → {table, date_column, grain}` so switching a domain's backing table is a config edit.

### ② KPI Engine (`kpi/`)
- `registry.py` loads `kpis.yaml` into `Metric` objects (`key, label, domain, unit, sql|derive, target, higher_is_better, format`).
- `engine.py` computes for each metric: **current, previous (same-length prior window), Δ absolute, Δ %, direction arrow, target, attainment %, status** and a **30-point sparkline** — then writes rows into `bi.fact_kpi_daily` + `bi.kpi_snapshot`.
- KPIs covered out of the box (the brief's list): **Revenue, Orders, Deals, Calls, Conversion, Store Target, AOV, Repeat Customers, New Customers, Inventory Health, Returns, Pending MTO, Dispatch, Marketing ROI** — plus derived: contact-rate, RFM segments, dead-stock %, refill-need, ROAS/CPA, coverage days.

### ③ Rule Engine (`rules/`)
- Declarative rules in `rules.yaml`; each rule = `{id, domain, kpi/expr, evaluator, threshold, severity, window, group_by, message_template, owner}`.
- Evaluators: `threshold_below`, `threshold_above`, `pct_drop`, `pct_spike`, `staleness` (time-since-event, e.g. *deal with no call in 30 min*), `missing_attribute`, `ratio`, `zscore_anomaly`.
- Output = `Alert` objects → `bi.alerts_log` + fed to the Insight Engine as grounding facts.

### ④ AI Insight Engine (`insights/insight_engine.py`)
- Consumes KPI deltas + fired alerts + top movers, builds a **grounded context pack** (numbers only, no free hallucination surface), and asks the LLM to produce **What happened / Why / Business impact** per material change.
- Provider-agnostic (`insights/llm.py`): Gemini (`gemini-2.x`) or Claude (`claude-*`), configured in `settings.yaml`. Degrades gracefully to a **rule-based narrative** if no API key (same pattern as your existing dashboards).

### ⑤ Recommendation Engine (`insights/recommender.py`)
- Turns each insight into **actionable, prioritized recommendations**: `action, priority (P1–P3), owner, ETA, estimated ₹ impact`. Never "here's a problem" without "here's the move."

### ⑥ Dashboard (`dashboard/bi-copilot.html`)
- Self-contained vanilla-JS + hand-rolled SVG (your house style), reads `bi/latest.json`.
- Tabs: **Executive Summary · Sales · Marketing · CRM · Inventory · Product · Operations · AI Insights · Alerts · Recommendations**, plus a floating **✨ Ask-AI** copilot (local grounded answers; `/ask` backend when configured).
- Links out to your existing deep dashboards (sales-intelligence, ga4, inventory-intelligence, deals-vs-call) so the copilot is the **hub**, not a replacement.

### ⑦ Report Generator (`reports/`)
- `summary.py` → structured **Executive Summary** (headline, 6 KPI tiles, top 3 wins, top 3 risks, top 3 actions).
- `pdf.py` → branded A4 PDF (Lucira gold theme, HTML→PDF via WeasyPrint).
- `excel.py` → multi-sheet `.xlsx` (Summary, KPIs, Alerts, Recommendations, per-domain detail) with SLA-breach cells styled.
- Archived to `gs://<bucket>/bi/reports/YYYY-MM-DD/`.

### ⑧ Notification Engine (`notify/`)
- `whatsapp.py` → WhatsApp **Cloud API** (or Gupshup/Interakt) template message with the exec summary + a link to the PDF/dashboard.
- `email.py` → SMTP/SendGrid HTML email with PDF + Excel attached.
- Recipient lists + channels per report in `settings.yaml`; idempotent (one send per `run_id`).

### ⑨ Automation (`orchestrator.py`)
- Single entrypoint `run()` executes: **collect → compute KPIs → evaluate rules → generate insights → recommend → persist (bq+gcs) → build reports → notify**.
- Triggered by **Cloud Scheduler `0 9 * * *` Asia/Kolkata → `POST /run`** (OIDC-authenticated). Manual `POST /run?dry=1` for testing; CLI `python -m bi_agent run` for local.
- Every stage is wrapped in structured logging + try/except with partial-failure tolerance (a broken domain degrades that section, never the whole report).

---

## 5. API surface (Cloud Run, `main.py`)

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /run` | OIDC (Scheduler) | Full pipeline for `run_date` (default yesterday IST) |
| `POST /run?dry=1` | OIDC | Pipeline without notifications/writes (test) |
| `GET  /snapshot` | public | Serve latest `bi/latest.json` (dashboard data) |
| `POST /ask` | public/proxy | Copilot Q&A: NL → grounded answer over `bi.*` |
| `GET  /report/latest.pdf` | signed URL | Latest executive PDF |
| `GET  /health` | public | Liveness + last-run status + freshness |
| `POST /rules/reload` | OIDC | Hot-reload `bi.rule_config` without redeploy |

`/ask` is the copilot brain: it classifies intent, pulls the relevant `bi.fact_kpi_daily` slice
(read-only, byte-capped, allow-listed tables only — same guardrail as your inventory-intelligence
`chat` action), and answers with numbers + a short narrative.

---

## 6. AI prompt design

Prompts are **versioned files** in `config/prompts/` (never inline in code) so they can be tuned and
A/B'd. Core principles: **ground every claim in supplied numbers**, forbid inventing figures, force
structured output, keep it executive-terse. See the three templates; the shape is:

```
SYSTEM: You are Lucira's Chief Data Analyst. You ONLY use the JSON facts provided.
        If a number isn't in the facts, say "not available" — never estimate.
CONTEXT: { period, kpis:[{key,value,prev,delta_pct,target,status}], alerts:[...], top_movers:[...] }
TASK:    For each material change, output {headline, what, why, impact_inr, confidence}.
         Then 3 prioritized recommendations {action, owner, priority, eta_days, est_value_inr}.
OUTPUT:  strict JSON matching the schema. No prose outside JSON.
```

This makes LLM output **parseable, cacheable, and auditable** (stored in `bi.insights_log` with
`model` + `prompt_version`).

---

## 7. Deployment plan

**Prereqs** (already true on this machine): gcloud SDK authed as `tech@lucirajewelry.com`,
project `lucirajewelry-prod`, region `asia-south1`.

```bash
# 1. Semantic layer — run the DDL (idempotent)
for f in sql/00_setup_bi_dataset.sql sql/10_dim_date.sql sql/20_fact_kpi_daily.sql \
         sql/30_kpi_snapshot.sql sql/40_logs.sql; do
  bq query --use_legacy_sql=false --location=asia-south1 < "$f"
done

# 2. Deploy the service (Cloud Run gen2)
gcloud run deploy bi-copilot --source . --region=asia-south1 \
  --allow-unauthenticated \
  --set-env-vars "BI_DATASET=bi,SNAPSHOT_BUCKET=lucira-dashboards,LLM_PROVIDER=gemini" \
  --set-secrets "LLM_API_KEY=bi-llm-key:latest,WHATSAPP_TOKEN=wa-token:latest"

# 3. Schedule the 09:00 IST daily run
gcloud scheduler jobs create http bi-copilot-daily \
  --schedule="0 9 * * *" --time-zone="Asia/Kolkata" \
  --uri="https://<run-url>/run" --http-method=POST --oidc-service-account-email=<sa>

# 4. Wire the dashboard
#    dashboard/bi-copilot.html CONFIG.SNAPSHOT_URL = https://storage.googleapis.com/lucira-dashboards/bi/latest.json
```

**IAM** the Cloud Run SA needs: `roles/bigquery.jobUser`, `roles/bigquery.dataViewer` on source
datasets, `roles/bigquery.dataEditor` on `bi`, `roles/storage.objectAdmin` on the bucket,
`roles/aiplatform.user` (if Gemini via Vertex).

**Publishing the dashboard**: same unified `deploy-dashboards.yml` Pages workflow you already use —
add a `/bi/` route + a hub card. (Note: Pages still needs the branch merged to `main` + Source=Actions,
per the standing repo state.)

---

## 8. Automation flow (daily, 09:00 IST)

```
09:00  Cloud Scheduler ─► POST /run
09:00  ① collectors read reporting tables for [yesterday, -400d window]
09:00  ② KPI engine computes 14+ KPIs × slices ─► write bi.fact_kpi_daily + bi.kpi_snapshot
09:01  ③ rule engine evaluates rules.yaml ─► bi.alerts_log
09:01  ④ insight engine (LLM) ─► what/why/impact
09:02  ⑤ recommender ─► prioritized actions ─► bi.insights_log
09:02  publish bi/latest.json to GCS  (dashboard now fresh)
09:02  ⑦ build Executive PDF + Excel ─► archive to GCS
09:03  ⑧ WhatsApp + Email to leadership distribution list
09:03  /health flips to green with run_id + counts
```

Upstream refreshes (sales 10:00, inventory 09:00, ga4 09:00, crm every 15 min) mean the 09:00 run
reads **yesterday fully closed** data; if you want same-morning freshness for sales, move the sales
Scheduled Query earlier or run the copilot at 10:15. This is a one-line schedule change.

---

## 9. Non-functional requirements (how the brief's "technical requirements" are met)

| Requirement | How |
|---|---|
| Clean architecture | inward-pointing layers; `core` has zero deps; adapters behind Protocols |
| Modular / reusable | one module per concern; KPIs/rules/prompts are **config**, not code |
| Scalable | stateless Cloud Run (autoscale); BigQuery does the heavy compute; tall fact table |
| Logging | `logging_setup.py` → structured JSON → Cloud Logging; every stage logs counts + timing |
| Error handling | per-stage try/except; partial-failure tolerance; `/health` surfaces last-run status |
| Monitoring | `/health` + Cloud Monitoring uptime check + alert on failed run / stale snapshot |
| Configuration | `config/*.yaml` single source; secrets via Secret Manager; env for wiring |
| Documentation | this file + `README.md` + per-KPI docstrings in `kpis.yaml` |
| Unit tests | `tests/` for config load, KPI math, rule evaluation, summary rendering |

---

## 10. Future enhancement roadmap

**Phase 1 — MVP (weeks 1–3)** ✦ *this blueprint*
Semantic layer + KPI engine + rule engine + rule-based narrative + daily PDF/Excel + Email + dashboard.

**Phase 2 — True generative copilot (weeks 4–6)**
LLM insights/recommendations live; `/ask` conversational copilot; WhatsApp delivery; insight caching + feedback thumbs.

**Phase 3 — Proactive & predictive (weeks 7–10)**
- **Forecasting**: revenue/demand (Prophet/BQML `ARIMA_PLUS`), inventory stock-out prediction.
- **Anomaly detection**: BQML `ML.DETECT_ANOMALIES` replacing static thresholds where data supports it.
- **Root-cause drill**: agent auto-decomposes a metric drop by dimension (which store/channel/SKU drove it).

**Phase 4 — Autonomous actions (weeks 11+)**
- Two-way: copilot doesn't just recommend "call this deal" — it **creates the Zoho task** (via Zoho MCP), **drafts the WhatsApp** to the customer, **flags the PO** in ERP — with human-in-the-loop approval.
- Natural-language KPI authoring ("track average days-to-dispatch by store") → auto-generates the `kpis.yaml` entry + backfills.
- Slack/Teams copilot surface; scheduled *ad-hoc* deep-dives on request.
- Multi-tenant / role-based views (CEO vs store-manager vs marketing).

**Phase 5 — Governance & trust**
Metric lineage catalog, data-quality gates (freshness/volume/schema tests before a report sends),
prompt-eval harness, and a "why did the number change" audit trail on every KPI.

---

## 11. What ships in this scaffold vs. what to build next

**In repo now (this scaffold):** full architecture (this doc), folder structure, `config/*.yaml`
(real KPI + rule definitions), AI prompt templates, BigQuery DDL, and runnable Python anchors
(config loader, KPI engine, rule engine, orchestrator, Cloud Run entry, domain models).

**Next build steps:** flesh out each collector's SQL against the confirmed reporting-table columns,
wire the chosen LLM + WhatsApp vendor, build `bi-copilot.html`, and add the CI Pages route. Each is
isolated — pick a module and it can be built end-to-end without disturbing the others.
