"""Email notifier — SMTP or SendGrid. Sends exec summary + PDF/Excel attachments."""
from __future__ import annotations

import logging
import os
import smtplib
from email.message import EmailMessage

from ..core.models import RunResult

log = logging.getLogger(__name__)


class EmailNotifier:
    channel = "email"

    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.enabled = cfg.get("enabled", False)

    def send(self, result: RunResult, attachments: dict[str, bytes]) -> bool:
        if not self.enabled:
            return False
        msg = EmailMessage()
        msg["Subject"] = f"Lucira MIS — {result.period_label}"
        msg["From"] = self.cfg["from"]
        msg["To"] = ", ".join(self.cfg["recipients"])
        msg.set_content(result.exec_summary or result.headline)
        for name, blob in attachments.items():
            if name.split(".")[-1] in self.cfg.get("attach", []):
                maintype, subtype = ("application",
                                     "pdf" if name.endswith("pdf") else "vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                msg.add_attachment(blob, maintype=maintype, subtype=subtype, filename=name)
        try:
            host = os.environ.get("SMTP_HOST", "localhost")
            with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", 587))) as s:
                if os.environ.get("SMTP_USER"):
                    s.starttls()
                    s.login(os.environ["SMTP_USER"], os.environ["SMTP_PASS"])
                s.send_message(msg)
            log.info("email sent to %s", msg["To"])
            return True
        except Exception:
            log.exception("email send failed")
            return False
