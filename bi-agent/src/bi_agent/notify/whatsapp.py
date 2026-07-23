"""WhatsApp notifier — Cloud API / Gupshup / Interakt template message with the exec summary."""
from __future__ import annotations

import logging
import os

import requests

from ..core.models import RunResult

log = logging.getLogger(__name__)


class WhatsAppNotifier:
    channel = "whatsapp"

    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.enabled = cfg.get("enabled", False)
        self.provider = cfg.get("provider", "cloud_api")
        self.token = os.environ.get("WHATSAPP_TOKEN")
        self.phone_id = os.environ.get("WHATSAPP_PHONE_ID")

    def send(self, result: RunResult, attachments: dict[str, bytes]) -> bool:
        if not (self.enabled and self.token):
            return False
        body = (result.exec_summary or result.headline)[:1024]
        ok = True
        for to in self.cfg.get("recipients", []):
            ok = self._send_cloud_api(to, body) and ok
        return ok

    def _send_cloud_api(self, to: str, body: str) -> bool:
        url = f"https://graph.facebook.com/v20.0/{self.phone_id}/messages"
        try:
            r = requests.post(url, headers={"Authorization": f"Bearer {self.token}"},
                              json={"messaging_product": "whatsapp", "to": to,
                                    "type": "text", "text": {"body": body}}, timeout=20)
            r.raise_for_status()
            return True
        except Exception:
            log.exception("whatsapp send to %s failed", to)
            return False
