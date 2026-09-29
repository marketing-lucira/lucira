# Lucira Store Location Intelligence & Campaign Demand — Reference Doc

**Purpose:** answer "where should Lucira open its next physical store, and why?" using real digital
demand (WebEngage + GA4), real store addresses, and a transparent, non-fabricated opportunity score.
Pincode is the primary dimension where the data genuinely supports it; everything else is honestly
labeled as a city-level proxy.

Files:
- `dashboard/store-location-intelligence.html` — the dashboard (single file, all JS inline)
- `dashboard/sql/store_location_store_master.sql` — real store address + geocode build
- `dashboard/sql/store_location_ga4_agg.sql` — 8 GA4-side reporting tables
- `dashboard/sql/store_location_webengage_pull.sql` — 5 WebEngage pull queries (run via `bq`, not SQL views — see below)
- `etl/build_store_location_intel.js` — Node merge/scoring script → `etl/out/store_location_intel.json`
- `etl/raw/store_location/*.json` — raw pulls the merge script reads

## Why this can't be one BigQuery pipeline

WebEngage's real BigQuery share (`test-webengage.11b56595a_shared.user_profile_view_v3`) lives in a
**separate GCP project, region US**. `lucirajewelry-prod`'s datasets are `asia-south1`. BigQuery
cannot `JOIN` or `EXPORT DATA` across the two in one job (confirmed live — cross-region join throws
"Access Denied", not a location-mismatch error). Every WebEngage query must be billed to
`lucirajewelry-prod` as the `projectId` (billing with `projectId=test-webengage` itself fails with a
`bigquery.jobs.create` permission error, even though reading the table works fine once billed
elsewhere). So: WebEngage is pulled to local JSON via `bq query`, GA4/store-master are built as real
BigQuery tables, and everything is merged **client-side in Node**, never in one SQL job.

## Refresh procedure (manual — not yet scheduled)

1. `bq query --use_legacy_sql=false --project_id=lucirajewelry-prod < dashboard/sql/store_location_store_master.sql`
   (only needed if a store opens/closes — static reference data otherwise)
2. `bq query --use_legacy_sql=false --project_id=lucirajewelry-prod < dashboard/sql/store_location_ga4_agg.sql`
3. Run each of the 5 queries in `store_location_webengage_pull.sql` individually via `bq query
   --format=json --project_id=lucirajewelry-prod --max_rows=<enough>`, saving each to
   `etl/raw/store_location/we_*.json` (exact filenames expected by the merge script — see its header comment)
4. Also re-pull the 8 BigQuery tables from step 1-2 to `etl/raw/store_location/*.json` (same pattern)
5. `cd etl && node build_store_location_intel.js` → writes `etl/out/store_location_intel.json`
6. `cp etl/out/store_location_intel.json dashboard/store_location_intel.json` — the dashboard fetches
   this same-folder relative path locally. (For a real deploy, this step is replaced by publishing to
   a public GCS bucket and pointing `CONFIG.SNAPSHOT_URL` at it — not done yet, see Open Items below.)

## The 15 tabs

| Tab | What it shows | Grain |
|---|---|---|
| Executive | KPIs + main ranked table | Pincode (real) + city-proxy GA4 |
| **Business Q&A** | The spec's 12 "final business questions," each answered by a live computation (not canned text) — see mapping below | mixed |
| Map | Store markers + pincode demand bubbles, colored by priority | Pincode (real) |
| Pincode | Every real pincode, one row | Pincode (real) + city-proxy GA4 |
| City | City rollup | City (real WebEngage + real GA4, both city-native) |
| State | State rollup | State (aggregated from real pincodes) |
| Campaign | WebEngage campaign users/geo + GA4 funnel (joined by UTM-string text match) | Campaign |
| Campaign × Pincode | PRIMARY: real GA4 campaign×city. SECONDARY: real WebEngage exact pincode×campaign (N=11 users) | City (primary) / Pincode (secondary, tiny) |
| Product Demand | Category/style demand by city + top-10-SKU-per-city | City (Top 80 by session volume) |
| Price Band | Price-band performance by city | City (Top 80) |
| Store Gap | HIGH/MEDIUM/LOW flag per real pincode | Pincode (real) |
| Store Recommendation | Top 10 pincodes with a plain-language "why" | Pincode (real) |
| Customer-Level | Bounded, masked sample — debugging only | User (real, matched-pincode only) |
| Data Quality | Every honest coverage number this build found | — |
| Methodology | The scoring formulas, written out | — |

## The 12 business questions → exact source (Business Q&A tab)

Each answer on the Q&A tab is a **live computation**, not static text. This is the exact logic behind each:

1. **Which state has the highest potential?** → State Intelligence, top row by `opportunityScore` (55% user percentile-rank blend).
2. **Which city has the highest potential?** → City Intelligence, top row by `opportunityScore`.
3. **Within that city, which pincode has strongest concentration?** → Pincode rows filtered to the top city's district text, sorted by real `users` descending.
4. **Which pincodes have high campaign response?** → Top 5 real pincodes by `campaignUsers` (WebEngage `campaign_source`/`campaign_medium` populated), descending.
5. **Which pincodes have strong sessions/digital engagement?** → Ranked by real `users`, NOT `sessions` — WebEngage's `session_count` is populated for only 8 of 3,096 real pincodes (see Data Quality), too sparse to rank on directly.
6. **What products/categories are in demand there?** → Product Demand tab filtered to the top city, top 3 by PDP Views (real GA4, city-exact; category = `product_type`, see the mislabeling note below).
7. **Which price bands are performing?** → Price Band tab filtered to the top city, top 3 by Purchase count.
8. **How much online demand/revenue exists?** → Sum of each real pincode's city-level GA4 proxy, **deduped by district first** (see `cityDedupTotals()` — a naive per-pincode sum would multiply a city's total by however many real pincodes fall in it).
9. **How far is the nearest existing store?** → Haversine distance from the #1 recommended pincode's real lat/lon to the nearest of the 6 real store addresses.
10. **Which 10 pincodes should management investigate first?** → Store Recommendation tab, verbatim.
11. **What product mix should the new store carry?** → Category PDP-views and price-band purchases summed across the 3 cities behind the Top 3 recommended pincodes.
12. **Which campaigns are generating the strongest demand in those locations?** → Campaign × City, filtered to those same 3 cities, top 5 by Sessions.

## Real data-quality findings (all disclosed in-app, not smoothed over)

- WebEngage `location.lat`/`lon`: **100% NULL**. `acquisition_source`: **100% NULL** (dead field —
  use `campaign_source`/`campaign_medium`, ~62% populated). `locality`: 100% NULL.
- Of users with a 6-digit-shaped `postal_code`, only **13.6% (19,275 of 141,638) sit on a REAL India
  Post pincode** — 3,096 distinct real pincodes total, cross-checked against `ds_india_geo.india_pincode`
  (19,561 real pincodes). The rest are plausible-looking free-text noise.
- `session_count`/`time_spent` are 77%-populated **system-wide** but present for only **8 of 3,096**
  real pincodes — pincode-providing and session-tracked users are largely disjoint segments.
- Exact (pincode + real campaign) co-occurrence: **11 users total**. Tab 6 therefore uses real GA4
  campaign×city as the primary view, per the spec's own prescribed fallback.
- GA4's `city`/`state` fields contain real international/bot/VPN traffic (a live "Lulea, Sweden" row
  had real session volume) — `country='India'` filtered everywhere. Detail tables (product/price-band/
  campaign-city) are bounded to the **Top 80 India cities by session volume** (87.4% of sessions).
- **`ga4_data.ga4_data`'s own `category` column is device type** (mobile/desktop/tablet — "mobile"
  alone is 8.5M rows / 3.3M PDP views), not a product category. The real jewelry taxonomy is
  `product_type` (Rings/Earrings/Bracelets/Necklaces/Mangalsutra/Chain/Nosepins/Pendants/Gold Coin) —
  used everywhere in this dashboard as "Category" instead. Caught by the Business Q&A tab surfacing
  "mobile" as a top "category," which prompted the check.
- Real store master: 6 distinct addresses from `ornaverse_erp_master.company` (BO1/CS1-FCS/LPN/N18/
  PN1/PV1; HO excluded as back-office). LPN (Lajpat Nagar) has no CRM owner-map entry in `dcs.js` but
  is a real ERP address — included, discrepancy disclosed.

## Scoring methodology (also on the Methodology tab)

**Pincode Opportunity Score** (0-100): 25% User Demand + 20% Digital Demand + 15% Campaign Demand +
15% Revenue Score (city-proxy) + 10% Conversion Score (city-proxy) + 15% Store Gap — each a
percentile rank, never revenue-only. **Priority tiers are percentile-of-the-final-blended-score**
(top 10% = High, next 20% = Medium, next 30% = Low, else Watch) — a 6-way percentile blend regresses
hard toward the middle (live-verified p90=19.3, max=74.9 on the raw 0-100 scale before this fix), so a
fixed absolute cutoff (e.g. "High ≥ 75") produced **zero** High-priority pincodes. Same method for City
Priority.

**Store Gap flag**: HIGH = top-tercile demand AND >15km from nearest store. MEDIUM = mid/high demand
AND 5-15km. LOW = otherwise.

## Bugs found via actual testing (headless Edge, all 15 tabs, hash-nav + console capture)

1. `bq --format=json` returns every value as a JSON string, including floats — unwrapped
   `geo.latitude`/`geo.longitude` crashed `.toFixed()` on the Pincode tab (arithmetic silently
   "worked" via JS's implicit string coercion, masking it in the distance calc).
2. Fixed-threshold priority tiers → 0 High pincodes (see Methodology above).
3. Executive KPIs summed city-proxy GA4 values once per pincode row instead of once per district —
   471 of 586 real-pincode districts have more than one real pincode (max 40), so totals were
   multiplied. PDP Views showing 33.5M against 1.09M sessions is what exposed it.
4. The device/product category mislabeling above.

## Date Range filter (added 2026-08-31) and Gender demand

A real, non-cosmetic Date Range filter (All time / 7d / 30d / 90d / 180d / Custom) is on the
**Executive** and **Campaign** tabs, backed by two new daily-grain BigQuery tables
(`ga4_geo_daily_city_agg`, `ga4_geo_daily_campaign_agg` — 34,051 and 33,318 rows, 483 real days,
2025-05-03 to 2026-08-29). It only affects real GA4 numbers (PDP/ATC/Checkout/Purchase/Revenue) —
WebEngage-native fields (Users, Sessions, Campaign Users, Opportunity Score, Priority) always stay
all-time, because `user_profile_view_v3` is a profile snapshot with no per-day breakdown. City,
State, Pincode, Product, Price Band, Store Gap, and Store Recommendation tabs are **not**
date-filterable yet — doing that honestly would require re-deriving the same fuzzy WebEngage-city
↔ GA4-city text match the all-time numbers already use server-side (`normCity()` in the merge
script), per arbitrary date range, which is real added complexity not built in this pass. Ask if
that's wanted.

A **Gender Demand** table was added to the Product Demand tab (Tab 7), sourced from a new
`ga4_geo_gender_agg` table — real GA4 `gender` field (Women/Men/Unisex/Kids; Women dominant at
2.6M of ~3.46M total PDP views, live-verified), Top 80 cities, all-time (not date-filtered).

## Open items (not done — ask before doing any of these)

- Cloud Run + Cloud Scheduler daily refresh automation (the WebEngage pull needs a job runner since it
  can't be a scheduled BigQuery query — same pattern as `walkin-source-api`/`sales-reporting-api`)
- Public GCS snapshot publishing + `CONFIG.SNAPSHOT_URL` wiring for a live (non-local) deploy
- git commit / push
