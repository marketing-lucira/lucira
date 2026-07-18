# GA4 Dashboard — GitHub Pages deployment

The GA4 Analytics Command Center ([`dashboard/ga4-dashboard.html`](../../dashboard/ga4-dashboard.html))
is published to GitHub Pages by the **unified** workflow
[`.github/workflows/deploy-dashboards.yml`](../../.github/workflows/deploy-dashboards.yml),
alongside the GCP cost dashboard.

- **URL:** `https://marketing-lucira.github.io/lucira/ga4/`
  (a repo hosts one Pages site → both dashboards share it under subpaths; `/` is a hub).
- **Publishes only** the dashboard file (as `/ga4/index.html`) with config injected inline —
  never the repo root, so nothing else in the monorepo is exposed. ⚠️ See the security note
  in [`../gcp-cost-dashboard/README.md`](../gcp-cost-dashboard/README.md#-read-this-before-making-the-repo--pages-public)
  before making the repo/Pages public (the monorepo still has a hardcoded Zoho secret to rotate).

## One-time setup

1. GitHub → **Settings → Pages → Source: GitHub Actions**.
2. (Optional) **Settings → Secrets and variables → Actions → Variables** — point the dashboard at
   the daily snapshot without editing the HTML:

   | Variable | Purpose | Example |
   |---|---|---|
   | `GA4_SNAPSHOT_URL` | The **daily static snapshot** the dashboard reads (public GCS object written by the backend's `/snapshot` at 09:00 IST). Empty = built-in GA4 sample. | `https://storage.googleapis.com/lucira-dashboards/ga4/latest.json` |
   | `GA4_API_BASE` | *(optional)* ga4-bq-api Cloud Run base URL — enables the **Gemini AI** assistant (`/ai`) and acts as a once-daily `/data` fallback if no snapshot URL is set. | `https://ga4-bq-api-xxxx-el.a.run.app` |
   | `GA4_CURRENCY` | Reporting currency | `INR` |

3. Push (or **Actions → Run workflow**).

## How the data path works — daily snapshot, not live querying

The dashboard uses a **once-daily snapshot**, by design (no continuous BigQuery querying):

- At **09:00 IST** Cloud Scheduler runs the backend: refresh aggregates → build a wide-window
  payload → write it as a **static JSON object** (`gs://…/ga4/latest.json`).
- The dashboard **loads that object once**, caches it in `localStorage`, and **reuses it all day**.
  Changing the date filter re-slices the loaded snapshot client-side — it never triggers a query.
- It re-fetches only when the **next 09:00 IST** boundary passes (a single scheduled timer). The
  header shows `Snapshot · <date> · 09:00 IST`.

| Path | Status | Notes |
|---|---|---|
| **Built-in GA4 sample** | ✅ works now | Deterministic seeded session dataset. What you see with no `GA4_SNAPSHOT_URL`. |
| **Daily snapshot (production)** | ⛔ deploy-gated | Needs `ga4-bq-api` deployed against the GA4 export (`analytics_478308692`): 6 aggregated tables + 09:00 IST Scheduler (refresh→snapshot). View-only account has **no deploy rights**, so someone with access deploys it. See [`../../ga4-bq-api/README.md`](../../ga4-bq-api/README.md). |

Once deployed, set `GA4_SNAPSHOT_URL` to the printed object URL and push. No dashboard code changes
are needed — the payload is the exact shape the dashboard already consumes.

## AI assistant

The dashboard has a floating **✨ Ask AI** button (bottom-right). It works two ways:

- **Local (now):** a rule-based assistant answers from the currently-filtered data — revenue,
  channels, campaigns, cities, products, conversion, and "top actions today". No backend needed.
- **Generative (when the backend is live + `GEMINI_API_KEY` is set on it):** questions are sent to
  the backend `/ai` endpoint (Gemini), with automatic fallback to the local assistant on any error.

The header chip shows `· local` or `· Gemini` depending on whether `GA4_API_BASE` is configured.

## Config injection detail

The dashboard carries a marker line `<!-- GA4_CONFIG_INJECT … -->` just before its main
`<script>`. CI replaces it with an inline `<script>window.__GA4_CONFIG__ = {…}</script>` built
from the Variables above; the dashboard merges it over its defaults at load. Inline (not an
external file) so the source keeps working on plain `file://`. No Variables set → the marker
collapses to a blank line and the built-in defaults apply.
