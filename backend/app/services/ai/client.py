"""DeepSeek client (§5, §44, §45, §59).

The API key never leaves this module. The client:

* asks for structured JSON and validates the shape before returning it,
* retries exactly once on malformed JSON, with a compact correction request,
* returns the provider's own usage numbers untouched — §57 makes the API
  response the source of truth, so nothing here estimates.
* is structured for prompt caching: the stable prefix (system instructions,
  requirement map, project map) is sent as its own content block, ahead of the
  volatile task instructions.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.core.config import Settings

logger = logging.getLogger("hacksim.ai")

# The prefix DeepSeek can cache. Kept byte-identical between runs.
CACHE_CONTROL = {"type": "ephemeral"}


class AIError(RuntimeError):
    """A provider call failed in a way the caller must record, not retry."""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class AIResponse:
    """One provider response, plus the usage the provider reported."""

    content: str
    parsed: dict[str, Any] | None
    request_id: str | None
    model: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cached_tokens: int
    cache_miss_tokens: int
    duration_ms: int
    prompt_version: str
    raw_usage: dict[str, Any] = field(default_factory=dict)

    @property
    def valid_json(self) -> bool:
        return self.parsed is not None


class DeepSeekClient:
    """Minimal chat-completions client. No framework, no magic."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @property
    def configured(self) -> bool:
        return self.settings.has_deepseek

    def complete_json(
        self,
        *,
        system_stable: str,
        context_stable: str,
        task: str,
        prompt_version: str,
        max_output_tokens: int = 2000,
        temperature: float = 0.1,
    ) -> AIResponse:
        """One structured call, with a single repair retry (§45)."""
        if not self.configured:
            raise AIError("AI is not configured on the server.", code="not_configured")

        started = time.monotonic()
        response = self._post(
            messages=self._messages(system_stable, context_stable, task),
            max_tokens=max_output_tokens,
            temperature=temperature,
            prompt_version=prompt_version,
        )
        duration_ms = int((time.monotonic() - started) * 1000)

        parsed = _parse_json(response.content)

        if parsed is None:
            # §45 — exactly one compact correction attempt. A second failure is
            # recorded as a module failure, not retried again.
            logger.info("[hacksim.ai] malformed JSON, attempting one repair (%s)", prompt_version)
            repair = self._post(
                messages=self._messages(
                    system_stable,
                    context_stable,
                    task
                    + "\n\nYour previous reply was not valid JSON. Reply with only a JSON "
                    "object matching the requested shape. No prose, no code fence.",
                ),
                max_tokens=max_output_tokens,
                temperature=0.0,
                prompt_version=prompt_version,
            )
            duration_ms += int((time.monotonic() - started) * 1000)
            parsed = _parse_json(repair.content)

            # The repair call's usage is added so the ledger stays truthful.
            response = _merge_usage(response, repair, duration_ms)

        response.prompt_version = prompt_version
        response.duration_ms = duration_ms
        response.parsed = parsed
        return response

    # ── Internals ─────────────────────────────────────────────

    def _messages(
        self, system_stable: str, context_stable: str, task: str
    ) -> list[dict[str, Any]]:
        return [
            {
                "role": "system",
                "content": [
                    # §59 — stable first, so repeated calls can hit the cache.
                    {"type": "text", "text": system_stable, "cache_control": CACHE_CONTROL},
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": context_stable,
                        "cache_control": CACHE_CONTROL,
                    },
                    {"type": "text", "text": task},
                ],
            },
        ]

    def _post(
        self,
        *,
        messages: list[dict[str, Any]],
        max_tokens: int,
        temperature: float,
        prompt_version: str,
    ) -> AIResponse:
        url = f"{self.settings.deepseek_base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": self.settings.deepseek_model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            # Ask for JSON explicitly; the provider still needs a schema check.
            "response_format": {"type": "json_object"},
            "stream": False,
        }

        try:
            http_response = httpx.post(
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {self.settings.deepseek_api_key}",
                    "Content-Type": "application/json",
                },
                timeout=self.settings.deepseek_timeout_seconds,
            )
        except httpx.TimeoutException as exc:
            raise AIError(f"The AI provider timed out: {exc}", code="timeout") from exc
        except httpx.HTTPError as exc:
            raise AIError(f"Could not reach the AI provider: {exc}", code="network") from exc

        if http_response.status_code == 429:
            raise AIError("The AI provider rate limit was reached.", code="rate_limited")
        if http_response.status_code in (401, 403):
            raise AIError("The AI provider rejected the configured credentials.", code="unauthorized")
        if http_response.status_code >= 400:
            raise AIError(
                f"The AI provider returned an error (HTTP {http_response.status_code}).",
                code="provider_error",
            )

        try:
            body = http_response.json()
        except json.JSONDecodeError as exc:
            raise AIError("The AI provider returned a malformed response.", code="bad_response") from exc

        choices = body.get("choices") or []
        content = ""
        if choices:
            content = (choices[0].get("message") or {}).get("content") or ""

        return AIResponse(
            content=content,
            parsed=None,
            request_id=body.get("id"),
            model=body.get("model") or self.settings.deepseek_model,
            **_usage_fields(body.get("usage") or {}),
            prompt_version=prompt_version,
            raw_usage=body.get("usage") or {},
        )


def _usage_fields(usage: dict[str, Any]) -> dict[str, int]:
    """Read the provider's own counters. Never estimate these (§57)."""
    input_tokens = int(usage.get("prompt_tokens") or 0)
    output_tokens = int(usage.get("completion_tokens") or 0)
    total_tokens = int(usage.get("total_tokens") or (input_tokens + output_tokens))

    # DeepSeek reports cache behaviour on the prompt side.
    prompt_details = usage.get("prompt_cache_hit_tokens") or usage.get("cache_read_input_tokens") or 0
    prompt_miss = usage.get("prompt_cache_miss_tokens") or usage.get("cache_creation_input_tokens") or 0

    cached = int(prompt_details)
    if prompt_miss:
        cache_miss = int(prompt_miss)
    else:
        # Only the hit count is reported: the remainder is the miss.
        cache_miss = max(0, input_tokens - cached)

    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "cached_tokens": cached,
        "cache_miss_tokens": cache_miss,
    }


def _merge_usage(original: AIResponse, repair: AIResponse, duration_ms: int) -> AIResponse:
    """Add a repair call's cost to the original response."""
    return AIResponse(
        content=original.content,
        parsed=None,
        request_id=original.request_id,
        model=original.model,
        input_tokens=original.input_tokens + repair.input_tokens,
        output_tokens=original.output_tokens + repair.output_tokens,
        total_tokens=original.total_tokens + repair.total_tokens,
        cached_tokens=original.cached_tokens + repair.cached_tokens,
        cache_miss_tokens=original.cache_miss_tokens + repair.cache_miss_tokens,
        duration_ms=duration_ms,
        prompt_version=original.prompt_version,
        raw_usage={"original": original.raw_usage, "repair": repair.raw_usage},
    )


def _parse_json(content: str) -> dict[str, Any] | None:
    """Tolerate a code fence or surrounding prose, but return a dict or nothing."""
    if not content:
        return None
    text = content.strip()

    if text.startswith("```"):
        text = text.split("```", 2)[1] if text.count("```") >= 2 else text
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()

    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass

    # Last resort: the outermost braces of the reply.
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None
