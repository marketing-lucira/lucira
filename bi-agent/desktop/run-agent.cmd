@echo off
REM ============================================================================
REM  Run the AI Business Monitor analysis NOW (manual trigger).
REM  Refreshes status.json + snapshot, then opens the command center.
REM  (The autonomous run fires daily at 10:00 IST via Cloud Scheduler.)
REM ============================================================================
setlocal
cd /d "%~dp0.."

set "PATH=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin;%PATH%"
set "BI_CONFIG_DIR=%CD%\config"
set "PYTHONPATH=%CD%\src"

echo.
echo   Running the AI Chief Business Officer analysis...
echo   (first run needs:  gcloud auth application-default login)
echo.
python -m bi_agent run
echo.
echo   Done. Opening the AI Business Monitor...
call "%~dp0AI-Business-Monitor.cmd"
endlocal
