-- WebEngage-by-pin-code — REAL, but reachable only via an indirect join.
--
-- WebEngage's own export (`Lucira_Prod.Webengage_Final`) has NO location/pincode field at
-- all (checked against its full schema: journey/campaign/channel + email/push/sms/whatsapp/
-- rcs sent/delivered/opened/clicked counters, keyed by `cuid` — nothing geographic).
-- `cuid` IS the customer's +91-prefixed mobile number (same fact already used by
-- walkin-source-api's channel-priority match), so the only way to attach a pin code to a
-- WebEngage contact is: match that mobile number against Zoho Deals' Mobile field, and use
-- THAT deal's real Address_Zip. This is the exact same mobile-number-match technique already
-- used for Walk-in Source channel attribution — not a new methodology.
--
-- Coverage is real but small: of ~180K distinct WebEngage mobiles, only ~340 also appear on a
-- Zoho deal with a populated Address_Zip, reaching ~133 distinct pin codes. Every number below
-- is a real count from matched rows — no estimation, no allocation-by-share modelling (unlike
-- the GA4 Sessions/PDP/ATC/Checkout columns on this same page).
WITH web AS (
  SELECT
    RIGHT(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 10) AS mobile_number,
    email_Sent, email_delivered, Unique_email_open, Unique_email_click,
    push_sent, push_Dlivered, Unique_push_click,
    sms_Sent, sms_Dlivered, Unique_sms_click,
    whatsapp_sent, whatsapp_Delivered, whatsapp_read, Unique_whatsapp_click,
    rcs_sent, rcs_Delivered, rcs_read, Unique_RCS_Click
  FROM `lucirajewelry-prod.Lucira_Prod.Webengage_Final`
  WHERE cuid IS NOT NULL
    AND REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 10), r'^[6-9][0-9]{9}$')
),
deals_zip AS (
  SELECT DISTINCT
    RIGHT(REGEXP_REPLACE(Mobile, r'[^0-9]', ''), 10) AS mobile_number,
    Address_Zip AS pincode
  FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals`
  WHERE Mobile IS NOT NULL AND Address_Zip IS NOT NULL AND TRIM(Address_Zip) != ''
    AND REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(Mobile, r'[^0-9]', ''), 10), r'^[6-9][0-9]{9}$')
)
SELECT
  d.pincode,
  COUNT(DISTINCT w.mobile_number) AS webengage_contacts,
  SUM(IFNULL(w.email_Sent,0) + IFNULL(w.push_sent,0) + IFNULL(w.sms_Sent,0) + IFNULL(w.whatsapp_sent,0) + IFNULL(w.rcs_sent,0)) AS total_sent,
  SUM(IFNULL(w.email_delivered,0) + IFNULL(w.push_Dlivered,0) + IFNULL(w.sms_Dlivered,0) + IFNULL(w.whatsapp_Delivered,0) + IFNULL(w.rcs_Delivered,0)) AS total_delivered,
  SUM(IFNULL(w.Unique_email_open,0) + IFNULL(w.Unique_email_click,0) + IFNULL(w.Unique_push_click,0) + IFNULL(w.Unique_sms_click,0) + IFNULL(w.whatsapp_read,0) + IFNULL(w.Unique_whatsapp_click,0) + IFNULL(w.rcs_read,0) + IFNULL(w.Unique_RCS_Click,0)) AS total_engaged
FROM web w
JOIN deals_zip d USING (mobile_number)
GROUP BY d.pincode
ORDER BY total_sent DESC;
