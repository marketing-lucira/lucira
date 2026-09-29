/* Store Visit Campaign Intelligence — static data snapshot
   Source: lucirajewelry-prod.Lucira_Prod.Webengage_Final (WebEngage campaign-engagement mart,
   22.2M rows) filtered to the 8 campaigns whose campaign_name/journey_title identify them as
   "Store Visit" activity, joined by normalized mobile number (cuid, +91-prefixed) to
   lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals for deal attribution.
   Pulled live via bq CLI on 2026-08-07. Nothing in this file is fabricated — see meta.notes
   for every known gap. */
window.STORE_VISIT_DATA = {
  meta: {
    generated_at: "2026-08-07",
    source_campaigns: "lucirajewelry-prod.Lucira_Prod.Webengage_Final",
    source_deals: "lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals",
    source_sales: "lucirajewelry-prod.Lucira_Prod.sales_oneview_data",
    join_key: "WebEngage cuid = Zoho Deals Mobile = sales_oneview_data Cus_mobile, all normalized to last-10-digits",
    campaign_match: "campaign_name LIKE '%store_visit%'/'%storevisit%' OR journey_title LIKE '%store visit%'",
    total_targeted_valid_mobile: 1262,
    total_targeted_raw: 1263,
    has_deal: 20, has_sale: 23, has_both: 5, has_either: 38,
    notes: [
      "WebEngage has no literal \"store visit\" (footfall) event — there is no event_name/event-type column in Webengage_Final at all. Every send/delivery/engagement number in this dashboard is messaging-campaign activity for campaigns whose NAME references a store visit, not a confirmed physical visit.",
      "\"Deals Created\" and \"Made a Purchase\" are both mobile-number matches (WebEngage cuid → Zoho Deals Mobile / sales_oneview_data Cus_mobile) — correlation, not proven causation. A matched customer may have converted for reasons unrelated to this campaign.",
      "Real revenue IS available via sales_oneview_data (Shopify + POS order history, LTV/AOV/order dates) — 23 of 1,262 targeted users (1.8%) have a purchase on record, totaling ₹17,44,272 lifetime value across 42 orders, 21 of which fall on/after the customer's first store-visit campaign touch. Zoho Deals' own Amount field is separately near-empty (populated for only 27 of 13,927 deals company-wide, 0 of the 36 matched here) so deal-stage revenue is NOT shown — sales_oneview_data is the only revenue source used.",
      "sales_oneview_data covers only 1,057 customers company-wide — far fewer than the Shopify customer table (15,855) or Zoho Deals (13,927) — so it likely reflects a specific channel/time-window rather than the full historical customer base. Treat the 23/42/₹17.44L figures as a lower bound, not complete coverage.",
      "7 of the 23 matched sales rows are suspicious: identical first_order_date (2026-06-05), identical first_touch_date (2026-05-31), and ₹0 LTV/AOV for each — shown as-is (not excluded) but flagged as a likely data-quality artifact (bulk import or test orders), not 7 independent revenue-generating conversions.",
      "Store_Assigned is null for 100% of the 36 matched deal rows — no store-level attribution is possible for the deals cohort.",
      "One mobile (••••••1443) has 6 separate Deal records created within a 9-day span (2026-06-01 to 2026-06-09) — a known Zoho duplicate-creation pattern, not 6 independent conversions. Shown as-is in the register, not deduplicated or hidden.",
      "days_touch_to_deal / days_touch_to_first_order are negative for several matched rows (the deal or order predates the customer's first store-visit campaign touch) — shown as-is rather than filtered out; the causal direction does not hold for those rows.",
      "Only 5 of the 38 customers with any commercial outcome have BOTH a Zoho Deal and a sales_oneview_data purchase — the two systems mostly capture different customers, not the same funnel twice.",
      "No cross-check yet against actual footfall (Walkin_marge, used by the Walk-in Source Intelligence dashboard) — this dashboard cannot currently confirm whether any targeted customer physically visited a store."
    ]
  },
  // One row per (campaign_name, channel) — each Webengage_Final row is already single-channel,
  // so sent/delivered/opened/clicked below are that channel's own metrics, never summed across channels.
  campaigns: [
    { campaign_name:"store_visit_push_03_10_25", journey_title:"ONE_TIME", channel:"Push", first_run:"2025-10-03", last_run:"2025-10-06", users:20, sent:181, delivered:180, opened:54, opened_label:"Impressions", clicked:0 },
    { campaign_name:"store_visit_wp_camp_09_11_25", journey_title:"ONE_TIME", channel:"WhatsApp", first_run:"2025-11-09", last_run:"2025-11-15", users:726, sent:726, delivered:485, opened:373, opened_label:"Read", clicked:0 },
    { campaign_name:"storevisit_journey_sms", journey_title:"Store visit journey", channel:"SMS", first_run:"2026-04-05", last_run:"2026-07-02", users:504, sent:504, delivered:348, opened:null, opened_label:null, clicked:10 },
    { campaign_name:"storevisit_journey_emailer", journey_title:"Store visit journey", channel:"Email", first_run:"2026-04-13", last_run:"2026-06-28", users:28, sent:28, delivered:24, opened:7, opened_label:"Opened", clicked:3 },
    { campaign_name:"storevisit_journey_rcs_leg1", journey_title:"Store Visit journey - Features", channel:"RCS", first_run:"2026-07-08", last_run:"2026-07-10", users:12, sent:0, delivered:0, opened:0, opened_label:"Read", clicked:0 },
    { campaign_name:"storevisit_journey_whatsapp_leg1", journey_title:"Store Visit journey - Features", channel:"WhatsApp", first_run:"2026-07-08", last_run:"2026-07-10", users:12, sent:12, delivered:9, opened:5, opened_label:"Read", clicked:0 },
    { campaign_name:"storevisit_journey_sms", journey_title:"Store Visit journey - Features", channel:"SMS", first_run:"2026-07-08", last_run:"2026-07-10", users:12, sent:12, delivered:9, opened:null, opened_label:null, clicked:0 },
    { campaign_name:"storevisit_journey_emailer_leg1", journey_title:"Store Visit journey - Features", channel:"Email", first_run:"2026-07-09", last_run:"2026-07-10", users:2, sent:2, delivered:2, opened:0, opened_label:"Opened", clicked:0 }
  ],
  // Monthly total sent + distinct users across ALL store-visit campaigns combined
  monthly: [
    { ym:"2025-10", sent:181, users:20 },
    { ym:"2025-11", sent:726, users:726 },
    { ym:"2026-04", sent:122, users:108 },
    { ym:"2026-05", sent:171, users:164 },
    { ym:"2026-06", sent:239, users:234 },
    { ym:"2026-07", sent:26, users:13 }
  ],
  // Every Zoho Deal matched to a store-visit-campaign-targeted mobile number (36 rows, 20 distinct customers)
  dealsRegister: [
    { mobile_masked:"••••••0791", first_touch:"2026-05-20", campaigns:"storevisit_journey_sms", channels:"sms", stage:"Prospect", deal_created:"2026-08-06", days_touch_to_deal:78, city:null, lead_source:"Website" },
    { mobile_masked:"••••••0791", first_touch:"2026-05-20", campaigns:"storevisit_journey_sms", channels:"sms", stage:"Prospect", deal_created:"2026-08-06", days_touch_to_deal:78, city:null, lead_source:"Website" },
    { mobile_masked:"••••••9103", first_touch:"2025-11-09", campaigns:"store_visit_wp_camp_09_11_25", channels:"whatsapp", stage:"Prospect", deal_created:"2026-08-06", days_touch_to_deal:270, city:null, lead_source:"Website" },
    { mobile_masked:"••••••9103", first_touch:"2025-11-09", campaigns:"store_visit_wp_camp_09_11_25", channels:"whatsapp", stage:"Prospect", deal_created:"2026-08-06", days_touch_to_deal:270, city:null, lead_source:"Website" },
    { mobile_masked:"••••••2972", first_touch:"2025-11-09", campaigns:"store_visit_wp_camp_09_11_25", channels:"whatsapp", stage:"Prospect", deal_created:"2026-07-29", days_touch_to_deal:262, city:null, lead_source:null },
    { mobile_masked:"••••••8579", first_touch:"2026-06-06", campaigns:"storevisit_journey_sms", channels:"sms", stage:"Closed Won", deal_created:"2026-07-18", days_touch_to_deal:42, city:null, lead_source:"Website" },
    { mobile_masked:"••••••9101", first_touch:"2026-07-09", campaigns:"storevisit_journey_emailer_leg1, storevisit_journey_rcs_leg1, storevisit_journey_sms, storevisit_journey_whatsapp_leg1", channels:"RCS, email, sms, whatsapp", stage:"Prospect", deal_created:"2026-07-09", days_touch_to_deal:0, city:null, lead_source:"Website" },
    { mobile_masked:"••••••2482", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Payment", deal_created:"2026-07-01", days_touch_to_deal:271, city:null, lead_source:null },
    { mobile_masked:"••••••1343", first_touch:"2026-06-28", campaigns:"storevisit_journey_emailer, storevisit_journey_sms", channels:"email, sms", stage:"Prospect", deal_created:"2026-06-22", days_touch_to_deal:-6, city:"Indore", lead_source:"Website" },
    { mobile_masked:"••••••9468", first_touch:"2025-11-09", campaigns:"store_visit_wp_camp_09_11_25", channels:"whatsapp", stage:"Closed Lost", deal_created:"2026-06-17", days_touch_to_deal:220, city:null, lead_source:"Website" },
    { mobile_masked:"••••••4226", first_touch:"2025-11-09", campaigns:"store_visit_wp_camp_09_11_25", channels:"whatsapp", stage:"Closed Lost", deal_created:"2026-06-17", days_touch_to_deal:220, city:null, lead_source:"Website" },
    { mobile_masked:"••••••4506", first_touch:"2026-06-15", campaigns:"storevisit_journey_sms", channels:"sms", stage:"Closed Lost", deal_created:"2026-06-16", days_touch_to_deal:1, city:null, lead_source:"Website" },
    { mobile_masked:"••••••9993", first_touch:"2026-06-14", campaigns:"storevisit_journey_sms", channels:"sms", stage:"Prospect", deal_created:"2026-06-15", days_touch_to_deal:1, city:null, lead_source:"Website" },
    { mobile_masked:"••••••3723", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Closed Lost", deal_created:"2026-06-11", days_touch_to_deal:251, city:null, lead_source:null },
    { mobile_masked:"••••••9559", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Payment", deal_created:"2026-06-10", days_touch_to_deal:250, city:null, lead_source:"Website" },
    { mobile_masked:"••••••4141", first_touch:"2026-04-15", campaigns:"storevisit_journey_emailer, storevisit_journey_sms", channels:"email, sms", stage:"Closed Lost", deal_created:"2026-06-10", days_touch_to_deal:56, city:null, lead_source:null },
    { mobile_masked:"••••••4141", first_touch:"2026-04-15", campaigns:"storevisit_journey_emailer, storevisit_journey_sms", channels:"email, sms", stage:"Closed Lost", deal_created:"2026-06-10", days_touch_to_deal:56, city:null, lead_source:null },
    { mobile_masked:"••••••3770", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Closed Lost", deal_created:"2026-06-09", days_touch_to_deal:249, city:null, lead_source:null },
    { mobile_masked:"••••••1443", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Prospect", deal_created:"2026-06-09", days_touch_to_deal:249, city:"Mumbai", lead_source:"Website" },
    { mobile_masked:"••••••3723", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Closed Lost", deal_created:"2026-06-09", days_touch_to_deal:249, city:null, lead_source:null },
    { mobile_masked:"••••••1443", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Closed Lost", deal_created:"2026-06-08", days_touch_to_deal:248, city:null, lead_source:null },
    { mobile_masked:"••••••1443", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Closed Lost", deal_created:"2026-06-08", days_touch_to_deal:248, city:null, lead_source:null },
    { mobile_masked:"••••••3855", first_touch:"2026-06-08", campaigns:"storevisit_journey_sms", channels:"sms", stage:"Prospect", deal_created:"2026-06-08", days_touch_to_deal:0, city:null, lead_source:"Website" },
    { mobile_masked:"••••••1443", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Closed Lost", deal_created:"2026-06-07", days_touch_to_deal:247, city:null, lead_source:null },
    { mobile_masked:"••••••1352", first_touch:"2026-06-08", campaigns:"storevisit_journey_emailer, storevisit_journey_sms", channels:"email, sms", stage:"Closed Lost", deal_created:"2026-06-07", days_touch_to_deal:-1, city:null, lead_source:"Website" },
    { mobile_masked:"••••••1352", first_touch:"2026-06-08", campaigns:"storevisit_journey_emailer, storevisit_journey_sms", channels:"email, sms", stage:"Closed Lost", deal_created:"2026-06-07", days_touch_to_deal:-1, city:null, lead_source:"Website" },
    { mobile_masked:"••••••3855", first_touch:"2026-06-08", campaigns:"storevisit_journey_sms", channels:"sms", stage:"Closed Lost", deal_created:"2026-06-06", days_touch_to_deal:-2, city:null, lead_source:null },
    { mobile_masked:"••••••1443", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Closed Lost", deal_created:"2026-06-05", days_touch_to_deal:245, city:null, lead_source:null },
    { mobile_masked:"••••••7833", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Closed Lost", deal_created:"2026-06-04", days_touch_to_deal:244, city:null, lead_source:null },
    { mobile_masked:"••••••0005", first_touch:"2026-05-31", campaigns:"storevisit_journey_sms", channels:"sms", stage:"Closed Lost", deal_created:"2026-06-03", days_touch_to_deal:3, city:null, lead_source:"Website" },
    { mobile_masked:"••••••3770", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Closed Lost", deal_created:"2026-06-03", days_touch_to_deal:243, city:null, lead_source:null },
    { mobile_masked:"••••••9559", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Closed Lost", deal_created:"2026-06-02", days_touch_to_deal:242, city:null, lead_source:null },
    { mobile_masked:"••••••4141", first_touch:"2026-04-15", campaigns:"storevisit_journey_emailer, storevisit_journey_sms", channels:"email, sms", stage:"Closed Lost", deal_created:"2026-06-02", days_touch_to_deal:48, city:null, lead_source:"Website" },
    { mobile_masked:"••••••3855", first_touch:"2026-06-08", campaigns:"storevisit_journey_sms", channels:"sms", stage:"Closed Lost", deal_created:"2026-06-02", days_touch_to_deal:-6, city:null, lead_source:null },
    { mobile_masked:"••••••1443", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Closed Lost", deal_created:"2026-06-01", days_touch_to_deal:241, city:null, lead_source:null },
    { mobile_masked:"••••••1443", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", channels:"push_notification", stage:"Closed Lost", deal_created:"2026-06-01", days_touch_to_deal:241, city:null, lead_source:null }
  ],
  // Every sales_oneview_data (Shopify + POS order history) record matched to a store-visit-campaign
  // -targeted mobile number (23 rows/customers). ltv/aov are lifetime figures for that customer,
  // not incremental-since-campaign — see meta.notes for the 7-row same-day-₹0 data-quality flag.
  salesRegister: [
    { mobile_masked:"••••••9468", first_touch:"2025-11-09", campaigns:"store_visit_wp_camp_09_11_25", total_orders:14, ltv:541965.11, aov:38711.79, first_order_date:"2025-10-15", latest_order_date:"2026-06-17", days_touch_to_first_order:-25, city:"Mumbai", state:"Maharashtra" },
    { mobile_masked:"••••••0033", first_touch:"2025-11-09", campaigns:"store_visit_wp_camp_09_11_25", total_orders:1, ltv:225917.46, aov:225917.46, first_order_date:"2025-12-29", latest_order_date:"2025-12-29", days_touch_to_first_order:50, city:null, state:null },
    { mobile_masked:"••••••1657", first_touch:"2026-05-20", campaigns:"storevisit_journey_sms", total_orders:3, ltv:155979.48, aov:51993.16, first_order_date:"2026-05-18", latest_order_date:"2026-06-08", days_touch_to_first_order:-2, city:null, state:null },
    { mobile_masked:"••••••6929", first_touch:"2026-05-29", campaigns:"storevisit_journey_emailer, storevisit_journey_sms", total_orders:1, ltv:150517.26, aov:150517.26, first_order_date:"2026-06-30", latest_order_date:"2026-06-30", days_touch_to_first_order:32, city:null, state:null },
    { mobile_masked:"••••••8020", first_touch:"2026-05-15", campaigns:"storevisit_journey_sms", total_orders:2, ltv:121517.37, aov:60758.69, first_order_date:"2026-05-17", latest_order_date:"2026-05-29", days_touch_to_first_order:2, city:null, state:null },
    { mobile_masked:"••••••7357", first_touch:"2026-05-02", campaigns:"storevisit_journey_sms", total_orders:1, ltv:115416.57, aov:115416.57, first_order_date:"2026-05-04", latest_order_date:"2026-05-04", days_touch_to_first_order:2, city:null, state:null },
    { mobile_masked:"••••••7000", first_touch:"2025-11-09", campaigns:"store_visit_wp_camp_09_11_25", total_orders:2, ltv:110883.26, aov:55441.63, first_order_date:"2025-11-12", latest_order_date:"2025-11-14", days_touch_to_first_order:3, city:"Mumbai", state:"Maharashtra" },
    { mobile_masked:"••••••3855", first_touch:"2026-06-08", campaigns:"storevisit_journey_sms", total_orders:2, ltv:64331.32, aov:32165.66, first_order_date:"2026-07-20", latest_order_date:"2026-07-27", days_touch_to_first_order:42, city:"Mumbai", state:"Maharashtra" },
    { mobile_masked:"••••••8351", first_touch:"2025-11-09", campaigns:"store_visit_wp_camp_09_11_25", total_orders:1, ltv:62299.69, aov:62299.69, first_order_date:"2025-10-14", latest_order_date:"2025-10-14", days_touch_to_first_order:-26, city:"Mumbai", state:"Maharashtra" },
    { mobile_masked:"••••••8729", first_touch:"2025-11-09", campaigns:"store_visit_wp_camp_09_11_25", total_orders:1, ltv:47999.71, aov:47999.71, first_order_date:"2026-03-16", latest_order_date:"2026-03-16", days_touch_to_first_order:127, city:null, state:null },
    { mobile_masked:"••••••8579", first_touch:"2026-06-06", campaigns:"storevisit_journey_sms", total_orders:1, ltv:42081.45, aov:42081.45, first_order_date:"2026-07-18", latest_order_date:"2026-07-18", days_touch_to_first_order:42, city:null, state:null },
    { mobile_masked:"••••••2581", first_touch:"2025-11-09", campaigns:"store_visit_wp_camp_09_11_25", total_orders:1, ltv:30999.87, aov:30999.87, first_order_date:"2026-04-10", latest_order_date:"2026-04-10", days_touch_to_first_order:152, city:null, state:null },
    { mobile_masked:"••••••7094", first_touch:"2026-05-14", campaigns:"storevisit_journey_emailer, storevisit_journey_sms", total_orders:1, ltv:28748.50, aov:28748.50, first_order_date:"2026-05-13", latest_order_date:"2026-05-13", days_touch_to_first_order:-1, city:null, state:null },
    { mobile_masked:"••••••0005", first_touch:"2026-05-31", campaigns:"storevisit_journey_sms", total_orders:2, ltv:28614.87, aov:14307.44, first_order_date:"2026-06-03", latest_order_date:"2026-06-27", days_touch_to_first_order:3, city:null, state:null },
    { mobile_masked:"••••••3770", first_touch:"2025-10-03", campaigns:"store_visit_push_03_10_25", total_orders:1, ltv:17000.17, aov:17000.17, first_order_date:"2026-04-16", latest_order_date:"2026-04-16", days_touch_to_first_order:195, city:null, state:null },
    { mobile_masked:"••••••1001", first_touch:"2026-05-31", campaigns:"storevisit_journey_sms", total_orders:1, ltv:0, aov:0, first_order_date:"2026-06-05", latest_order_date:"2026-06-05", days_touch_to_first_order:5, city:null, state:null, flagged:true },
    { mobile_masked:"••••••7517", first_touch:"2026-05-31", campaigns:"storevisit_journey_sms", total_orders:1, ltv:0, aov:0, first_order_date:"2026-06-05", latest_order_date:"2026-06-05", days_touch_to_first_order:5, city:null, state:null, flagged:true },
    { mobile_masked:"••••••6634", first_touch:"2026-05-31", campaigns:"storevisit_journey_sms", total_orders:1, ltv:0, aov:0, first_order_date:"2026-06-05", latest_order_date:"2026-06-05", days_touch_to_first_order:5, city:null, state:null, flagged:true },
    { mobile_masked:"••••••7563", first_touch:"2026-05-31", campaigns:"storevisit_journey_sms", total_orders:1, ltv:0, aov:0, first_order_date:"2026-06-05", latest_order_date:"2026-06-05", days_touch_to_first_order:5, city:null, state:null, flagged:true },
    { mobile_masked:"••••••7152", first_touch:"2026-05-31", campaigns:"storevisit_journey_sms", total_orders:1, ltv:0, aov:0, first_order_date:"2026-06-05", latest_order_date:"2026-06-05", days_touch_to_first_order:5, city:null, state:null, flagged:true },
    { mobile_masked:"••••••6006", first_touch:"2026-05-31", campaigns:"storevisit_journey_sms", total_orders:1, ltv:0, aov:0, first_order_date:"2026-06-05", latest_order_date:"2026-06-05", days_touch_to_first_order:5, city:null, state:null, flagged:true },
    { mobile_masked:"••••••4305", first_touch:"2026-05-31", campaigns:"storevisit_journey_sms", total_orders:1, ltv:0, aov:0, first_order_date:"2026-06-05", latest_order_date:"2026-06-05", days_touch_to_first_order:5, city:null, state:null, flagged:true },
    { mobile_masked:"••••••4994", first_touch:"2026-05-31", campaigns:"storevisit_journey_sms", total_orders:1, ltv:0, aov:0, first_order_date:"2026-06-05", latest_order_date:"2026-06-05", days_touch_to_first_order:5, city:null, state:null, flagged:true }
  ]
};
