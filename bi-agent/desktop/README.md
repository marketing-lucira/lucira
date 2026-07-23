# AI Business Monitor — Desktop Command Center

Your one-click daily command center for the Lucira **AI Chief Business Officer**.

## The button

A shortcut **"AI Business Monitor"** is on your Desktop. Click it to open the command center.
It shows, at a glance (green / yellow / red):

- **Business Health Score** /100 + 7 department scores (Sales, Marketing, CRM, Inventory,
  Customer, Operations, Finance) — each with a reason
- **System status** — last run, next scheduled run (10:00 IST), run id, duration
- **Automation** — emails sent, WhatsApp sent, insights generated, dashboards OK, failed jobs, retries
- **Critical alerts**, **connected dashboards** (with links), **top AI recommendations**, **today's insights**
- **Execution log** — every step with status, duration, retries, and error

## How it works

The panel reads `status.json` (written by the daily run). Because browsers block `fetch` on
`file://`, the launcher serves this folder on `http://localhost:8899` and opens the panel there.

- **`AI-Business-Monitor.cmd`** — what the Desktop button runs: starts the local server, opens the panel.
- **`run-agent.cmd`** — runs the analysis **now** (`python -m bi_agent run`), refreshes `status.json`,
  then opens the panel. Use this for an on-demand refresh; otherwise the autonomous run fires daily.
- **`status.json`** — the live operational feed (currently populated from real BigQuery data).
- **`monitor.html`** — the command center UI (self-contained, theme-aware).

## Daily autonomy

The AI CBO runs itself every day at **10:00 IST** (Cloud Scheduler → the Cloud Run service), reads
your reporting tables, scores business health, fires alerts, writes insights + recommendations,
sends the email + WhatsApp report, and refreshes this panel. No manual trigger required.

## First-time live run

To run the pipeline locally (or deploy it), the Python client needs Google credentials once:

```
gcloud auth application-default login
```

Then `run-agent.cmd` (or `python -m bi_agent run`) will populate `status.json` from live data.
Until then the panel shows the last written status (already real BigQuery figures).

## Recreate the Desktop button

If the shortcut is ever lost, re-run the generator (or point a new shortcut at
`desktop/AI-Business-Monitor.cmd` with `desktop/icon.ico`).
