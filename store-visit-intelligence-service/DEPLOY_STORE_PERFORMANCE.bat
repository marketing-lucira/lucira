@echo off
REM Deploys the Meeting Journey dashboard:
REM  - Store Performance v2 (7 km columns on raised meetings, non-store rows hidden)
REM  - ALL store walk-ins: new /api/all-walkins (main.py) + All Store Walk-ins KPI, "Without Zoho meeting"
REM    rows in the Store visits list, Walk-ins Without Meeting column in Store Performance (journey.js)
REM  - 2026-11-11: Agreed to Reschedule / Cancelled by Customer KPIs + columns (main.py add_meeting_followups + journey.js)
REM  - 2026-11-12: STORE LINKS. Choosing stores in the Store filter turns the address into
REM    /MAL-PN1-N18 (one Store filter for all tabs) - ONLY on the plain home page "/".
REM    A dashboard OPENED on a store address (/MAL-LPN-BO1) is LOCKED: only those stores, no Store
REM    filter, the address never changes. To choose stores again, open the plain home address.
REM    "Copy store link" (home page) copies a signed link (?k=...) that opens WITHOUT login, locked the same way.
REM Login is UNCHANGED: the same user name / password as before (Cloud Run keeps the env vars).
REM (The email access list / Google sign-in code in main.py is switched OFF - user decision 2026-11-12.)
REM  - 2026-11-13: SALES. Cancelled orders not counted; an order on the same day as the meeting counts even if
REM    minutes before it was raised; one invoice shows on ONE meeting only (no duplicate). Trend LINES chart.
REM No BigQuery view change needed.
cd /d "%~dp0"
set "PATH=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin;%PATH%"
call gcloud run deploy store-visit-intelligence --source . --project=lucirajewelry-prod --region=asia-south1 --quiet
echo.
echo Done. Open https://store-visit-intelligence-3mvv5mdr2q-el.a.run.app/ and press Ctrl+F5.
pause
