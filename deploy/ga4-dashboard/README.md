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
2. (Optional) **Settings → Secrets and variables → Actions → Variables** — set to point the
   dashboard at the live BigQuery backend without editing the HTML:

   | Variable | Purpose | Example |
   |---|---|---|
   | `GA4_API_BASE` | The ga4-bq-api Cloud Run URL **including `/data`**. Empty = built-in GA4 sample. | `https://ga4-bq-api-xxxx-el.a.run.app/data` |
   | `GA4_CURRENCY` | Reporting currency | `INR` |
   | `GA4_AUTO_REFRESH_MIN` | Auto-refresh cadence (minutes) | `30` |

3. Push (or **Actions → Run workflow**).

## How the data path works

| Path | Status | Notes |
|---|---|---|
| **Built-in GA4 sample** | ✅ works now | Deterministic seeded session dataset. What you see with no `GA4_API_BASE`. |
| **Live BigQuery export** | ⛔ deploy-gated | Needs the `ga4-bq-api` Cloud Run backend deployed against the BigQuery GA4 export (`analytics_478308692`) with the 6 aggregated summary tables + 09:00 IST Cloud Scheduler refresh. This account is **view-only** with **no deploy rights**, so someone with access deploys it. See [`../../ga4-bq-api/README.md`](../../ga4-bq-api/README.md). |

Once the backend is live, set `GA4_API_BASE` to `<service-url>/data` and push — the dashboard
flips to live mode and auto-refreshes. The backend serves the **exact JSON shape** the dashboard
already consumes, so no dashboard code changes are needed.

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
