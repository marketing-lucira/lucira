@echo off
REM 2026-11-14 USER RULE: a call on the SAME DAY the meeting was created counts as Called, even when it
REM happened a few minutes BEFORE the meeting was saved (the call on which the visit was booked).
REM This replaces the BigQuery view ds_imputed_reporting.zoho_meeting_journey_v with
REM sql\meeting_journey_view.sql (only the call rule changed). No Cloud Run deploy is needed for the
REM numbers: the dashboard shows the new counts after its next refresh (press the Refresh button).
cd /d "%~dp0"
set "PATH=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin;%PATH%"
cmd /c "bq query --use_legacy_sql=false < sql\meeting_journey_view.sql"
echo.
echo Done. Open the dashboard and press the Refresh button.
pause
