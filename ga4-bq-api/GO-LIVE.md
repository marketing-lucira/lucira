# GO LIVE — connect the GA4 dashboard to real data

This turns the GA4 dashboard from **sample data** into your **real GA4 numbers**,
auto-refreshing **daily at 09:00 IST**. Everything is already coded — this is the
run sequence for **someone with GCP access** (the marketing account is view-only,
so hand this to an admin/developer with the roles below).

Two ways to get real data:
- **Path A — full live (recommended, ~20–30 min).** Deploy the backend once; the
  dashboard then updates itself every morning. Do this for daily business use.
- **Path B — real numbers to preview sooner (no deploy).** Authorize the BigQuery
  connector so real data can be pulled into a snapshot for review. See the end.

---

## What you're connecting

| Thing | Value |
|---|---|
| GCP project | `lucirajewelry-prod` |
| GA4 export dataset | `analytics_478308692` (tables `events_YYYYMMDD`) |
| New dataset this creates | `ga4_dashboard` (6 aggregate tables + AI reports) |
| Daily snapshot object | `gs://lucira-dashboards/ga4/latest.json` (the dashboard reads this) |
| Refresh time | 09:00 IST (Cloud Scheduler) |

---

## Path A — full live deploy

### 0. Roles the deploying person needs (on `lucirajewelry-prod`)
Simplest: **Owner** or **Editor**. Granular: BigQuery Admin, Cloud Run Admin,
Cloud Scheduler Admin, Service Account Admin, Storage Admin, Secret Manager Admin.

### 1. Confirm the GA4 export + its region  ⚠ important
In BigQuery console open dataset **`analytics_478308692`**:
- Confirm there are `events_YYYYMMDD` tables (the GA4 → BigQuery export is on).
  If not: GA4 Admin → **BigQuery links** → link the property and enable **daily**
  export. (It does **not** backfill — enable ASAP; data starts from link date.)
- Note the dataset's **Data location** (e.g. `asia-south1`, or `US`). You'll set
  `REGION` to match in step 3.

### 2. Set your Key Events  ⚠ important
The GA4 export has no per-event "conversion" flag, so edit the list in
[`sql/10_refresh_daily_summary.sql`](sql/10_refresh_daily_summary.sql):
```sql
DECLARE key_events_set ARRAY<STRING> DEFAULT ['purchase'];  -- add yours, e.g. ['purchase','generate_lead','sign_up']
```
Use the event names you've marked as **Key events** in GA4 Admin.

### 3. Get a Gemini key + store it (you said you can get one)
- Create a key at **aistudio.google.com/apikey**.
- Store it in Secret Manager (never in code/git):
  ```bash
  printf 'YOUR_GEMINI_KEY' | gcloud secrets create gemini-api-key \
    --project lucirajewelry-prod --data-file=- --replication-policy=automatic
  ```
- In [`deploy.sh`](deploy.sh) set:
  ```bash
  REGION="asia-south1"          # ← match the dataset location from step 1
  GEMINI_SECRET="gemini-api-key"
  ```

### 4. Authenticate + deploy
```bash
gcloud auth login
gcloud config set project lucirajewelry-prod
cd ga4-bq-api
bash deploy.sh
```
This creates the dataset + 6 tables, backfills 90 days, creates the snapshot
bucket, deploys Cloud Run, and wires Scheduler (09:00 refresh → 09:05 snapshot →
09:15 AI report). It prints a **`GA4_SNAPSHOT_URL`** — copy it.

### 5. Build the first snapshot now (don't wait for 09:00)
```bash
gcloud scheduler jobs run ga4-daily-refresh  --location asia-south1
gcloud scheduler jobs run ga4-daily-snapshot --location asia-south1
```
Open the printed `GA4_SNAPSHOT_URL` in a browser — you should see **JSON with your
real numbers**. That confirms the data pipeline works.

### 6. Point the dashboard at it (GitHub)
- GitHub → repo **Settings → Pages → Source: GitHub Actions** (one time).
- **Settings → Secrets and variables → Actions → Variables** → add:
  - `GA4_SNAPSHOT_URL` = the snapshot URL from step 4/5
  - `GA4_API_BASE` = the Cloud Run service URL (enables the Gemini AI assistant)
- Merge the reviewed branch to `main` (after your approval) → Pages auto-deploys.
  Dashboard goes live at `https://marketing-lucira.github.io/lucira/ga4/`.

### 7. Confirm it's LIVE
Open the dashboard. The header chip must read **"Snapshot · <date> · 09:00 IST"**
with a **green** dot (not amber "Sample data"). Numbers should match GA4.

### To enable the AI assistant in the browser
The daily data works with the service kept private. For the **✨ Ask AI** button to
call Gemini live, the `/ai` endpoint must be reachable from the browser: redeploy
Cloud Run with `--allow-unauthenticated`, keep write endpoints guarded by
`REFRESH_TOKEN`, and set `CORS_ORIGIN=https://marketing-lucira.github.io`. Without
this, the assistant still works in local rule-based mode.

---

## Path B — real numbers to preview sooner (no deploy)

If a full deploy will take time but you want to **see real data now**:
1. In **claude.ai → your connector settings**, authorize **Google Cloud BigQuery**
   for `lucirajewelry-prod`.
2. Tell me it's connected. In an interactive session I'll then query your real
   `analytics_478308692` export directly, **validate the aggregation SQL** against
   real data, and **generate a real-data snapshot** to load into the dashboard
   preview — so you review real numbers before the production deploy.

(This gives real data for review; it does **not** set up the automated daily
refresh — that still needs Path A.)

---

## Validation checklist (once live)

- [ ] Header shows green "Snapshot · … · 09:00 IST" (not "Sample data").
- [ ] Totals (users, sessions, revenue) match GA4 for the same date range (small
      variance is normal — GA4 UI samples/thresholds; the export is unsampled).
- [ ] Key Events count looks right (step 2 list correct).
- [ ] Channels/sources roughly match GA4 Traffic acquisition (channel-grouping is
      an approximation — tune `default_channel_group` in `sql/00_setup.sql` if off).
- [ ] Currency is INR (or change `GA4_CURRENCY`).

## Cost
Tiny. Raw events are scanned **once/day** by the refresh (one date partition);
the dashboard reads a static JSON object, so dashboard loads cost nothing. Typical
BigQuery + Cloud Run + Scheduler for one property ≈ a few dollars/month.
