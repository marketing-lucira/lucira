@echo off
REM ============================================================================
REM  AI Business Monitor — one-click command center (Lucira)
REM  Opens the panel in your default browser. It reads the local status.json
REM  when served, and falls back to the public status feed on GCS (so it shows
REM  live data even opened directly). No dependencies required.
REM ============================================================================
start "" "%~dp0monitor.html"
