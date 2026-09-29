# Store City & Agent-wise Deals → Calls → Meetings → Store Follow-up → Sales Intelligence

Executive dashboard tracking Zoho Deals by Address-City and Agent through call attempts,
meeting-raised, store assignment, store follow-up calls, and eventual sale conversion.

Follows this repo's locally-embedded-snapshot pattern (same as `product-pricing-intelligence.html`
and `store-product-scan-sales.html`): a Python build script queries BigQuery directly, aggregates
everything the dashboard needs, and writes one embedded JS data file. **No Cloud Run, no live API,
no deploy.** Refresh = rerun the build script.

## Files

| File | Purpose |
|---|---|
| `deals-calls-meetings-sales.html` | Dashboard shell (5 tabs: Executive KPIs, Charts, Summary Table, Deal Drill-down, Data Quality) |
| `dcm.js` | All dashboard logic — filtering, KPI/chart/table rendering, drill-down drawer, CSV export |
| `dcm_data.js` | **Generated.** `window.DCM_DATA = {...}` — locally-embedded BigQuery snapshot |
| `build_dcm_data.py` | Build script — queries `lucirajewelry-prod` via `bq` CLI, joins/aggregates, writes `dcm_data.js` |
| `sql/dcm_build.sql` | Canonical Deal-grain query (Deals + Calls via `What_Id` + first Meeting via `cdc_meetings` JSON) |
| `sql/dcm_meetings_sheet.sql` | Raw pull of `meetings_sheet_sync` (Store Follow-up source, 928 rows) |
| `sql/dcm_sales.sql` | Raw pull of `marketing_sale` (2,531 rows) |

## How to refresh the data

```
python build_dcm_data.py
```

Requires `bq` on PATH and an authenticated `gcloud`/`bq` session with access to
`lucirajewelry-prod` (same auth already working for every other `build_*_data.py` script in this
repo). Prints a full Data Quality Summary to stdout, then rewrites `dcm_data.js` in this directory.

### Live Zoho CRM refresh mode (`--source live`)

```
python build_dcm_data.py --source live
```

An additive alternative to the default `bigquery` path above — default behavior is unchanged
unless `--source live` is passed explicitly. In this mode, Deals/Calls/Meetings are fetched
directly from the Zoho CRM v8 REST Modules API instead of BigQuery, so the dashboard can show
same-minute-current data instead of waiting for the next BigQuery sync (verified live
2026-09-17: BigQuery's snapshot had 0 deals for that day and only a partial count for the day
before, while `--source live` already showed the day's real, growing deal count).

- **Requires** `dashboard/../etl/.zoho.env` to exist with a valid `ZOHO_CLIENT_ID`,
  `ZOHO_CLIENT_SECRET`, and `ZOHO_REFRESH_TOKEN` (git-ignored; never printed or logged by this
  build script — referenced only as "read from etl/.zoho.env"). Uses the same OAuth
  refresh-token pattern as `etl/_lib.ps1`'s `Get-ZohoCreds`/`Get-ZohoToken`.
- **Scope limitation:** the current OAuth grant is `ZohoCRM.modules.ALL` only. The COQL query
  endpoint (`/crm/v8/coql`) returns `OAUTH_SCOPE_MISMATCH` under this grant and cannot be used.
  Live mode therefore paginates the plain REST Modules API (`GET /crm/v8/Deals`, `/Calls`,
  `/Events`) client-side instead of running a server-side query — slower per record than COQL
  would be, but it is the only endpoint this grant allows.
- **Store Follow-up (`meetings_sheet_sync`) and Sales (`marketing_sale`) are always BigQuery**,
  in both modes — there is no Zoho CRM module equivalent for either, so `--source live` only
  changes where Deals/Calls/Meetings come from.
- The two BigQuery-only diagnostic totals in the Data Quality tab (`cdc_meetings_*`,
  `calls_to_deal_match_pct`) are reported as `null`/unavailable in live mode, since that path
  never touches the `cdc_meetings` or `lucira_zoho_Calls` BigQuery tables.
- The generated `dcm_data.js` records which mode produced it: `meta.source` is
  `"live_zoho_crm+bigquery"` for `--source live` and `"bigquery"` for the default, and
  `meta.generated_at_ist` always reflects when the file was written. The dashboard's freshness
  pill (top of every tab) shows both.
- Implementation lives in `zoho_live_fetch.py` (shared by `build_dcm_data.py` and
  `build_svci_data.py`) — it only replaces the data-loading step; all join/aggregation/KPI code
  downstream is the same code path used by the BigQuery source, unchanged.

## How to open

Open `deals-calls-meetings-sales.html` directly in a browser (works from `file://`, no server
needed). No `git add`/commit/deploy — everything here is left as uncommitted working-tree changes
per this repo's convention.

## Data sources (ground truth used, do not re-derive)

1. **Deals** — `Lucira_Prod.lucira_zoho_Deals` (22,819 rows). `id` is 100% unique (verified).
2. **Calls** — `Lucira_Prod.lucira_zoho_Calls` (69,510 rows). Joined to Deals **only** via
   `What_Id = Deal id` — no mobile-fallback join for calls. Call attempt number =
   `ROW_NUMBER() OVER (PARTITION BY what_id ORDER BY Call_Start_Time)`.
3. **Meetings** — `zoho_crm.cdc_meetings` (369 rows, JSON blob in `data`). First meeting per deal
   by `created_time_ist` (Asia/Kolkata) = the Meeting Raised event.
4. **Store Follow-up** — `Lucira_Prod.meetings_sheet_sync` (928 rows, synced Google Sheet). The
   real source for **Meeting Store** (`store` column) and **Store Called**
   (`call_status IS NOT NULL`). **Not** `store_visit_deal_outcomes` (stale 38-row test table,
   unused). Joined to Deals by normalized last-10-digit mobile — **mobile-match only**.
5. **Sales** — `ds_imputed_reporting.marketing_sale` (2,531 rows). **No Deal ID column exists.**
   Joined to Deals only via normalized mobile (`Cus_mobile`/`mobile1`) — mobile-match only, and a
   sale dated before the deal's/meeting's anchor date is never counted as caused by it.

## Honesty gates (do not violate when modifying this dashboard)

- **`Deals.Store_Assigned` is 0% populated and is never read anywhere** in `dcm_build.sql`,
  `build_dcm_data.py`, `dcm.js`, or the HTML. If you're tempted to use it, don't — it's dead data.
- **Address_City is only ~11.2% populated** (2,561 of 22,819 deals). The rest are shown as an
  explicit **"City Not Captured"** bucket in every filter, chart, and table — never dropped,
  never guessed. The exact coverage % is shown in the "Data Coverage & Assumptions" banner and
  the Data Quality tab.
- **Meeting Store / Store Called are only computed for deals with Meeting Raised = Yes.** For
  those deals, if no `meetings_sheet_sync` row matches the deal's mobile, both fields render as
  **"Not Available"** — never a fabricated "No". `cdc_meetings.venue` is used as a fallback
  signal for Meeting Store only when no sheet match exists (and is labeled as such in the
  `meeting_store_source` field / deal drawer).
- **Sale matching is mobile-only, everywhere it's shown** — `marketing_sale` has no Deal ID
  column, so this dashboard never invents one. The Sale Status column, KPI tooltips, and the
  Data Quality tab all say "mobile-matched, not Deal-ID-matched."
- **All day-diffs use `DATE(later) − DATE(earlier)`, never shown negative.** A negative diff is
  excluded from the value (rendered as "—") and counted in `data_quality.negative_date_diff_flags`
  — as built, this snapshot has 9 such cases, all in Meeting→Store-Call, none in Deal→Meeting or
  Meeting→Sale.

## Real Data Quality Summary (from the live 2026-09-16 build)

```
Deal ID uniqueness:                    100.00% (0 duplicate rows)
Total deals:                           22,819
Address_City coverage:                 2,561 of 22,819 (11.22%)
Calls table rows with a What_Id:       45,057 of 69,510 (64.82%)
Deals matched to >=1 call:             11,102 of 22,819 (48.65%)
cdc_meetings rows resolving a Deal id: 343 of 369 (92.95%)
Deals with Meeting Raised:             307 of 22,819 (1.35%)
Meeting Store from meetings_sheet_sync: 247
Meeting Store from cdc_meetings.venue (fallback): 54
Meeting Store Not Available:           6
Store Called Yes / No / Not Available: 235 / 12 / 22,572
meetings_sheet_sync rows / distinct mobiles: 928 / 878
marketing_sale rows / distinct mobiles: 2,531 / 1,367
Deals matched to a sale (mobile-match): 639 of 22,819 (2.80%)
Negative date-diff rows excluded:      {"negative_meeting_to_storecall": 9}
```

**Read this honestly**: only 1.35% of deals ever get a meeting raised, so every meeting-dependent
metric (Meeting Store, Store Called, Meeting→Sale%) is a small-sample statistic (n≈307) even
though the deal universe is 22,819. The dashboard's KPI tooltips and the Data Coverage banner say
this explicitly — don't let the headline "22,819 deals" numbers imply the funnel metrics have
that same sample size.

## Real bugs found and fixed during testing

1. **Store Follow-up gating bug**: the first build attempt looked up `meetings_sheet_sync` by
   mobile for every deal, regardless of whether a meeting was ever raised — which both leaked
   "Meeting Store" values onto deals with no meeting, and produced an impossible negative count
   (`meeting_store_not_available: -209`) in the Data Quality summary. Fixed by gating the sheet
   lookup on `meeting_raised` only; re-ran and confirmed `meeting_store_not_available: 6` (a
   sane, non-negative number).
2. **Meeting→Sale% overflow in the Summary Table**: the per (date, city, agent) row divided
   *all* sales in that row by meetings raised in that row — but most sales (639 total) come from
   deals that never had a meeting (only 307 meetings raised total), so several rows showed
   "400.0%" / "600.0%" Meeting→Sale%, which is meaningless. Fixed by tracking a separate
   `salesFromMeeting` counter (sales specifically among meeting-raised deals in that row) and
   using that as the percentage numerator — verified the same row now reads a sane 100.0%.

Both fixes were caught by actually reading the rendered DOM output of a headless-Edge run against
the real `dcm_data.js`, not by inspection alone.

## Testing performed

- Headless Edge (`msedge --headless=new --dump-dom`) load of the real file — confirmed the boot
  overlay clears (render completes), all 14 KPIs show real non-NaN numbers, all 5 tabs populate
  with real rows, and no genuine console errors/exceptions (only unrelated Chromium telemetry
  noise in stderr).
- A CDP-driven interaction test (`node` + `Runtime.evaluate` over the Chrome DevTools Protocol)
  against a running headless Edge instance: checked a real city checkbox (Mumbai) and confirmed
  Total Deals dropped from 22,819 → 461 and the scope note updated; clicked a drill-down row and
  confirmed the timeline drawer opened with real deal data; read the Summary Table's live DOM as
  CSV-shaped rows and confirmed real, non-garbled values; clicked "Reset all filters" and
  confirmed the KPI returned to 22,819; captured zero console errors/exceptions throughout.

## Known limitations (by design, not bugs)

- Meeting-raised sample size is very small (307 of 22,819 deals) — every Meeting/Store/Sale
  metric downstream of it inherits that small sample.
- Store Follow-up (`meetings_sheet_sync`) has free-text store names with real-world variants
  ("Borivali", "Borivali store", "Paschim Vihar", "Pashchim Vihar", "Lajpat Nagar",
  "Lajpat Nagar Store" all appear as distinct rows in the Store Follow-up Performance table) —
  intentionally **not** normalized/merged, since guessing at "Pashchim Vihar" = "Paschim Vihar"
  would be exactly the kind of fabrication this brief prohibits. If the client wants them merged,
  that's a real decision for them to make, not an inference for this build to bake in silently.
- The dashboard is a static ~22MB `dcm_data.js` snapshot (22,819 deals × ~35 fields, uncompressed
  JSON) — fine for local `file://` use per this repo's convention, but if this ever needs to be
  hosted, consider gzip/compression at the server layer.
