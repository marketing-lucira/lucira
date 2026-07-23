"""Provider-agnostic LLM client. Gemini or Claude; returns text. No key -> None (caller falls back)."""
from __future__ import annotations

import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)


class LLMClient:
    def __init__(self, cfg: dict) -> None:
        self.provider = cfg.get("provider", "none")
        self.model = cfg.get("model", "")
        self.temperature = float(cfg.get("temperature", 0.2))
        self.max_tokens = int(cfg.get("max_output_tokens", 2048))
        self.prompt_dir = Path(cfg.get("prompt_dir", "config/prompts"))
        self.api_key = os.environ.get("LLM_API_KEY")
        self.enabled = bool(self.api_key) and self.provider in ("gemini", "claude")

    def prompt(self, name: str) -> str:
        return (self.prompt_dir / f"{name}.md").read_text(encoding="utf-8")

    def complete(self, system_and_user: str) -> str | None:
        """Single-shot completion. Returns None if disabled so callers use the rule-based path."""
        if not self.enabled:
            return None
        try:
            if self.provider == "gemini":
                return self._gemini(system_and_user)
            if self.provider == "claude":
                return self._claude(system_and_user)
        except Exception:
            log.exception("LLM call failed; falling back to rule-based narrative")
        return None

    def _gemini(self, text: str) -> str:
        import google.generativeai as genai  # lazy import
        genai.configure(api_key=self.api_key)
        model = genai.GenerativeModel(self.model)
        resp = model.generate_content(
            text, generation_config={"temperature": self.temperature,
                                     "max_output_tokens": self.max_tokens})
        return resp.text

    def _claude(self, text: str) -> str:
        import anthropic  # lazy import
        client = anthropic.Anthropic(api_key=self.api_key)
        msg = client.messages.create(
            model=self.model, max_tokens=self.max_tokens, temperature=self.temperature,
            messages=[{"role": "user", "content": text}])
        return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
