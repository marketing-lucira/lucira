@echo off
REM ============================================================================
REM  Lucira AI CBO — headless daily run (used by Windows Task Scheduler, 10:00 IST).
REM  Runs the full pipeline (KPIs, health, alerts, insights, Deal Follow-up,
REM  Decision Book) and publishes snapshots. No browser popup. Logs to run.log.
REM ============================================================================
setlocal
cd /d "%~dp0.."
set "PATH=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin;%PATH%"
set "BI_CONFIG_DIR=%CD%\config"
set "PYTHONPATH=%CD%\src"
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
echo [%date% %time%] run start >> "%~dp0run.log"
python -m bi_agent run >> "%~dp0run.log" 2>&1
echo [%date% %time%] run end (exit %errorlevel%) >> "%~dp0run.log"
endlocal
