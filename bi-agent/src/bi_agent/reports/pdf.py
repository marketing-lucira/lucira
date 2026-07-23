"""Branded A4 PDF via HTML->PDF (WeasyPrint). Renders the exec summary + KPI grid + actions."""
from __future__ import annotations

from ..config import settings
from ..core.models import RunResult


def _html(result: RunResult) -> str:
    brand = settings().reports.get("brand", {})
    gold = brand.get("primary", "#C9A24B")
    rows = "".join(
        f"<tr><td>{k.metric.label}</td><td>{k.value:,.0f}</td>"
        f"<td>{'' if k.delta_pct is None else f'{k.delta_pct:+.1f}%'}</td>"
        f"<td>{k.status.value}</td></tr>"
        for k in result.kpis if k.dimension is None)
    recs = "".join(f"<li><b>{r.priority} · {r.owner}:</b> {r.action}</li>"
                   for r in result.recommendations)
    return f"""<html><head><style>
      @page {{ size: A4; margin: 18mm; }}
      body {{ font-family: Georgia, serif; color:#1a1a1a; }}
      h1 {{ color:{gold}; }} table {{ width:100%; border-collapse:collapse; }}
      td,th {{ border-bottom:1px solid #eee; padding:6px 8px; text-align:left; }}
    </style></head><body>
      <h1>Lucira Jewelry — MIS Report</h1>
      <p><b>{result.period_label}</b> · generated {result.generated_at}</p>
      <p>{result.headline}</p>
      <h2>Key KPIs</h2>
      <table><tr><th>KPI</th><th>Value</th><th>Δ%</th><th>Status</th></tr>{rows}</table>
      <h2>Recommended Actions</h2><ul>{recs}</ul>
    </body></html>"""


class PdfReporter:
    fmt = "pdf"

    def render(self, result: RunResult) -> bytes:
        from weasyprint import HTML  # lazy import
        return HTML(string=_html(result)).write_pdf()
