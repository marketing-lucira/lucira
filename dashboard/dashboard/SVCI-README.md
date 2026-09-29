# Store Visit & Sales Conversion Intelligence

Executive dashboard tracking the full customer journey: **Deal Created → Agent Call Attempts →
Meeting Raised → Store Assigned → Store Visit → Store Follow-up Call → Sale**. Primary hierarchy:
**City → Agent → Day → Deal → Store Visit → Sale**.

This is a **sibling** of `deals-calls-meetings-sales.html` (built the same session) and reuses its
validated join model (Deal↔Call via `what_id`, Deal↔Meeting via `cdc_meetings` JSON, Deal↔Sale via
mobile match). It adds one thing the sibling dashboard didn't have: a genuine, non-fabricated
**Store Visit** signal from `meetings_sheet_sync.show_no_show`, kept strictly distinct from
Meeting Raised and from Store Called. New files only — nothing in the sibling dashboard was
touched.

Follows this repo's locally-embedded-snapshot pattern (same as `deals-calls-meetings-sales.html`,
`product-pricing-intelligence.html`): a Python build script queries BigQuery directly, aggregates
everything the dashboard needs, and writes one embedded JS data file. **No Cloud Run, no live
API, no deploy.** Refresh = rerun the build script.

## Files

| File | Purpose |
|---|---|
| `store-visit-sales-conversion-intelligence.html` | Dashboard shell (4 tabs: Executive Overview, City & Agent Performance, Store Visit Intelligence, Deal Journey) |
| `svci.js` | All dashboard logic — filtering, KPI/chart/table rendering, City→Agent→Day tree table, drill-down drawer, CSV export |
| `svci_data.js` | **Generated.** `window.SVCI_DATA = {...}` — locally-embedded BigQuery snapshot |
| `build_svci_data.py` | Build script — queries `lucirajewelry-prod` via `bq` CLI, joins/aggregates, writes `svci_data.js` |
| `sql/svci_build.sql` | Canonical Deal-grain query (Deals + Calls via `What_Id` + first Meeting via `cdc_meetings` JSON) |
| `sql/svci_meetings_sheet.sql` | Raw pull of `meetings_sheet_sync` (Store Visit + Store Follow-up source, 928 rows) |
| `sql/svci_sales.sql` | Raw pull of `marketing_sale` (2,532 rows) |

## How to refresh the data

```
python build_svci_data.py
```

Requires `bq` on PATH and an authenticated `gcloud`/`bq` session with access to
`lucirajewelry-prod` (same auth already working for every other `build_*_data.py` script in this
repo). Prints a full Data Quality Summary to stdout, then rewrites `svci_data.js` in this
directory.

### Live Zoho CRM refresh mode (`--source live`)

```
python build_svci_data.py --source live
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
- **Store Visit / Store Follow-up (`meetings_sheet_sync`) and Sales (`marketing_sale`) are
  always BigQuery**, in both modes — there is no Zoho CRM module equivalent for either, so
  `--source live` only changes where Deals/Calls/Meetings come from.
- The BigQuery-only diagnostic totals in the Data Quality tab (`cdc_meetings_*`,
  `calls_to_deal_match_pct`) are reported as `null`/unavailable in live mode, since that path
  never touches the `cdc_meetings` or `lucira_zoho_Calls` BigQuery tables. The
  `meetings_sheet_sync`-derived sheet totals are unaffected (always BigQuery, both modes).
- The generated `svci_data.js` records which mode produced it: `meta.source` is
  `"live_zoho_crm+bigquery"` for `--source live` and `"bigquery"` for the default, and
  `meta.generated_at_ist` always reflects when the file was written. The dashboard's freshness
  pill (top of every tab) shows both.
- Implementation lives in `zoho_live_fetch.py` (shared by `build_dcm_data.py` and
  `build_svci_data.py`) — it only replaces the data-loading step; all join/aggregation/KPI code
  downstream (including this dashboard's Store Visit vs Meeting Raised vs Store Called
  distinction) is the same code path used by the BigQuery source, unchanged.

## How to open

Open `store-visit-sales-conversion-intelligence.html` directly in a browser (works from `file://`,
no server needed). No `git add`/commit/deploy — everything here is left as uncommitted
working-tree changes per this repo's convention.

## Data sources (ground truth used, re-verified live 2026-09-16)

1. **Deals** — `Lucira_Prod.lucira_zoho_Deals` (22,819 rows). `id` is 100% unique (verified).
2. **Calls** — `Lucira_Prod.lucira_zoho_Calls` (69,510 rows). Joined to Deals **only** via
   `What_Id = Deal id` — no mobile-fallback join for calls. Call attempt number =
   `ROW_NUMBER() OVER (PARTITION BY what_id ORDER BY Call_Start_Time)`.
3. **Meetings** — `zoho_crm.cdc_meetings` (369 rows, JSON blob in `data`). First meeting per deal
   by `created_time_ist` (Asia/Kolkata) = the Meeting Raised event. Match rate re-verified live
   with the actual join test (`JSON_VALUE(data,'$.What_Id.id') IN (SELECT id FROM Deals)`), **not**
   just "has a non-null What_Id" — those two numbers differ (343 vs 315 of 369).
4. **Store Visit + Store Follow-up** — `Lucira_Prod.meetings_sheet_sync` (928 rows, synced Google
   Sheet). Three **distinct** fields come from here, on **distinct** columns:
   - **Meeting Store** — the `store` column.
   - **Store Visit** — `action='Store Visit' AND show_no_show='Show'` (genuine confirmed
     attendance). `action='Video Call'` / `action='TAH'` rows and `show_no_show` of `WIP`/NULL are
     explicitly **not** a confirmed visit.
   - **Store Called** — `call_status IS NOT NULL`.
   All three are joined to Deals by normalized last-10-digit mobile — **mobile-match only**, and
   only computed for deals with Meeting Raised = Yes (not applicable otherwise).
5. **Sales** — `ds_imputed_reporting.marketing_sale` (2,532 rows). **No Deal ID column exists.**
   Joined to Deals only via normalized mobile (`Cus_mobile`/`mobile1`) — mobile-match only, and a
   sale dated before the deal's/meeting's/visit's anchor date is never counted as caused by it.

## Honesty gates (do not violate when modifying this dashboard)

- **`Deals.Store_Assigned` is 0% populated and is never read anywhere** in `svci_build.sql`,
  `build_svci_data.py`, `svci.js`, or the HTML.
- **Address_City is only ~11.2% populated** (2,561 of 22,819 deals). The rest are shown as an
  explicit **"City Not Captured"** bucket in every filter, chart, and table — never dropped, never
  guessed. The exact coverage % is shown in the Data Coverage banner and the Data Quality card.
- **Meeting Raised ≠ Store Visit ≠ Store Called — three distinct fields, three distinct
  sources/columns, never conflated in KPI math or table columns:**
  - Meeting Raised ← `cdc_meetings` (a meeting record exists for the deal).
  - Store Visit Confirmed ← `meetings_sheet_sync.action='Store Visit' AND show_no_show='Show'`.
  - Store Called ← `meetings_sheet_sync.call_status IS NOT NULL`.
  A deal can be Store Called without a confirmed Visit, or have a confirmed Visit with no
  follow-up call logged — the dashboard never assumes one implies the other.
- **Store Visit Status = "Not Available" when no `meetings_sheet_sync` row matches a
  meeting-raised deal's mobile** — never inferred as visited just because a meeting exists, and
  never inferred as not-visited either. `No Show` (a real sheet value) and `Scheduled / Pending`
  (WIP or null `show_no_show`) are rendered as their own distinct statuses, never merged into
  "visited" or "not available."
- **Sale matching is mobile-only, everywhere it's shown** — `marketing_sale` has no Deal ID
  column, so this dashboard never invents one.
- **All day-diffs use `DATE(later) − DATE(earlier)`, never shown negative.** A negative diff is
  excluded from the value (rendered as "—") and counted in `data_quality.negative_date_diff_flags`.
- **Meeting→Sale% is always "sales among meeting-raised deals" / "meetings raised" — never "all
  sales in scope" / "meetings raised."** Dividing the wrong numerator in would trivially produce
  >100% readings (most of the 637 mobile-matched sales come from deals that never had a meeting at
  all) — this exact bug was caught and fixed during testing (see below).

## Real Data Quality Summary (from the live 2026-09-16 build)

```
Deal ID uniqueness:                       100.00% (0 duplicate rows)
Total deals:                              22,819
Address_City coverage:                    2,561 of 22,819 (11.22%)
Calls table rows with a What_Id:          45,057 of 69,510 (64.82%)
Deals matched to >=1 call:                11,102 of 22,819 (48.65%)
cdc_meetings rows resolving a real Deal id (live IN-join re-verify): 315 of 369 (85.37%)
  (cdc_meetings rows with a non-null What_Id at all: 343 of 369 -- a looser, less honest number)
Deals with Meeting Raised:                307 of 22,819 (1.35%)
Meeting Store from meetings_sheet_sync:   247
Meeting Store from cdc_meetings.venue (fallback): 54
Meeting Store Not Available:              6

meetings_sheet_sync action breakdown:     Store Visit 694 / Video Call 219 / TAH 15
meetings_sheet_sync show_no_show breakdown: Show 52 (sheet-level) / No Show 125 / WIP 207
Store Visit Confirmed (sheet-level, action=Store Visit AND show_no_show=Show): 52
Store Visit Confirmed, resolved to a Deal (mobile-match, meeting-raised only): 38 of 307
  -- NOTE: 52 vs 38 is not a bug. 52 is the true sheet-level count; only 38 of those rows
     mobile-match to a Deal that also has a Meeting Raised. Both numbers are reported honestly
     in the Data Quality card -- never silently collapsed to one.
Store Visit No Show (resolved to a Deal):          62
Store Visit Scheduled / Pending (WIP/null, resolved to a Deal): 118
Store Visit Not Available (no sheet match at all): 60
Store Called Yes / No / Not Available:    235 / 12 / 60 (of 307 meeting-raised deals)

meetings_sheet_sync rows / distinct mobiles: 928 / 878
marketing_sale rows / distinct mobiles:   2,532 / 1,368
Deals matched to a sale (mobile-match):   637 of 22,819 (2.79%)
Sales among Store-Visit-Confirmed deals:  24 of 38 (63.16%)
Negative date-diff rows excluded:         {"negative_meeting_to_storecall": 9, "negative_meeting_to_visit": 7}
```

**Read this honestly**: only 1.35% of deals ever get a meeting raised (n=307), and only 38 of
those have a *confirmed* store visit. Every Store Visit / Store Called / Meeting→Sale metric is a
small-sample statistic on top of an already-small sample — the dashboard's KPI tooltips, the Data
Coverage banner, and the Data Quality card all say this explicitly. Don't let the headline
"22,819 deals" number imply the funnel metrics share that sample size.

## Real bugs found and fixed during testing

1. **City Summary Meeting→Sale% overflow** (same class of bug the sibling DCM dashboard hit): the
   first build of `renderOverviewCharts`'s City Summary table divided *all* sales in a city by
   meetings raised in that city — but most of the 637 mobile-matched sales come from deals that
   never had a meeting (only 307 meetings raised total), so several cities showed impossible
   Meeting→Sale% values (**"City Not Captured" read 205.8%, Bengaluru read 500.0%, Mumbai read
   200.0%**). Caught by reading the real rendered table DOM in a headless-Edge run, not by
   inspection. Fixed by adding a separate `salesFromMeeting` counter (sales specifically among
   meeting-raised deals in that city) and using that as the numerator, splitting the column into
   "Total Sales (all deals)" and "Sales from Meeting-raised Deals" so both honest numbers are
   visible side by side. Re-verified: "City Not Captured" now reads a sane 12.0%, all other cities
   ≤100%.

Both the tree table's and the Store Visit Intelligence table's Meeting→Sale%/Store-Visit%/Sale%
columns were built with the fix already applied (they only ever iterate meeting-raised rows), so
they did not need a separate fix — only the City Summary table on Tab 1 had the bug.

## Testing performed

- Headless Edge (`msedge --headless=new --dump-dom`) load of the real file — confirmed the boot
  overlay clears (render completes), all 12 KPIs show real non-NaN numbers matching the Data
  Quality Summary exactly, and all 4 tabs populate with real rows (Funnel, City Summary, Data
  Quality, City→Agent→Day Tree, Store Visit Intelligence, Deal Journey).
- A CDP-driven interaction test (`node` + `chrome-remote-interface`, `Runtime.evaluate` over the
  Chrome DevTools Protocol) against a running headless Edge instance (`--remote-debugging-port`):
  - Checked a real city checkbox (Mumbai) on the filter bar and confirmed Total Deals dropped from
    22,819 → 461 and the scope note updated to match.
  - Clicked a City row in the Tab 2 tree table and confirmed it expanded (row count went from 1 to
    17, i.e. real Agent sub-rows appeared).
  - Clicked "Reset all filters" and confirmed the KPI returned to 22,819.
  - Opened the Deal Journey drawer on a random deal (no meeting) and confirmed the timeline
    rendered real dates and an honest "Not Available" for every downstream field.
  - Filtered Store Visit = "Confirmed" on Tab 4, confirmed exactly **38** rows (matching the Data
    Quality number precisely), opened the drawer on the first one, and confirmed a full real
    journey: Deal Created → 1st/2nd Call (real durations) → Meeting Raised (Noida Store) → Store
    Assigned (Noida) → **Store Visit 2026-06-15, "Visited (Confirmed)"** → Store Follow-up Call
    ("Connected") → Sale "Not Available" (honestly, no matching sale for that customer).
  - Read the Deal Journey table's live DOM as CSV-shaped rows and confirmed real, non-garbled
    values across all 28 columns.
  - Captured zero console errors/exceptions across the full run (both the initial load and every
    interaction).

## Known limitations (by design, not bugs)

- Meeting-raised sample size is very small (307 of 22,819 deals), and confirmed-visit sample size
  is smaller still (38 of those 307) — every Store Visit / Store Called / Sale metric downstream
  inherits that small sample.
- Store Visit / Meeting Store free-text store names have real-world variants ("Borivali",
  "Paschim Vihar - Delhi", "Lajpat Nagar Store" etc. appear as distinct values) — intentionally
  **not** normalized/merged in this build, since guessing at which variants are the same store
  would be exactly the kind of fabrication the honesty gates prohibit. If the client wants them
  merged, that's a real decision for them to make, not an inference for this build to bake in
  silently.
- The dashboard is a static ~28MB `svci_data.js` snapshot (22,819 deals × ~40 fields, uncompressed
  JSON) — fine for local `file://` use per this repo's convention, but if this ever needs to be
  hosted, consider gzip/compression at the server layer.
- The City→Agent→Day tree table and Store Visit Intelligence table are aggregated **client-side**
  in JS from the flat `deals` array on every filter change (not precomputed per-combination in
  Python) — this keeps the honesty/aggregation logic in one place and is fast enough at this data
  volume (22,819 rows), but a much larger dataset would need to move this aggregation server-side.

## Deployment-ready-code note

This dashboard is **deployment-ready code** in the sense that the HTML/JS/data-file bundle is
self-contained and works from `file://` with zero build step or server — but per this session's
instructions it has **not** been deployed (no Cloud Run, no Scheduler, no GCS, no git
add/commit/push). Everything here is left as uncommitted working-tree changes, consistent with
every sibling dashboard in this repo.
