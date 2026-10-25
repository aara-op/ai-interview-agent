"""Thin OpenAI-compatible chat client with JSON mode and an offline fallback.

Any provider that speaks the OpenAI API works: set OPENAI_API_KEY,
OPENAI_BASE_URL and OPENAI_MODEL in backend/.env.
"""
from __future__ import annotations

import json
import re
from typing import Any, Optional

import httpx

from .config import LLM_API_KEY, LLM_BASE_URL, LLM_ENABLED, LLM_MODEL

TIMEOUT = 90.0


class LLMError(RuntimeError):
    pass


def chat(
    system: str,
    user: str,
    *,
    json_mode: bool = False,
    temperature: float = 0.4,
    max_tokens: int = 2000,
) -> str:
    """Return the assistant message text. Raises LLMError on failure."""
    if not LLM_ENABLED:
        raise LLMError("OPENAI_API_KEY not configured")

    payload: dict[str, Any] = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}

    headers = {"Authorization": f"Bearer {LLM_API_KEY}"}
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.post(f"{LLM_BASE_URL.rstrip('/')}/chat/completions",
                            json=payload, headers=headers)
            if r.status_code >= 400:
                # some providers reject response_format — retry without it
                if json_mode and r.status_code in (400, 422):
                    payload.pop("response_format", None)
                    r = client.post(f"{LLM_BASE_URL.rstrip('/')}/chat/completions",
                                    json=payload, headers=headers)
            r.raise_for_status()
    except httpx.HTTPError as exc:  # network / timeout
        raise LLMError(f"LLM request failed: {exc}") from exc

    data = r.json()
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError) as exc:
        raise LLMError(f"Unexpected LLM response shape: {data}") from exc


def chat_json(
    system: str,
    user: str,
    *,
    temperature: float = 0.4,
    max_tokens: int = 2000,
) -> Any:
    """Chat and parse the reply as JSON, tolerating markdown fences."""
    text = chat(system, user, json_mode=True, temperature=temperature,
                max_tokens=max_tokens)
    return loads_lenient(text)


def loads_lenient(text: str) -> Any:
    """Parse JSON even if the model wrapped it in ```json fences or prose."""
    text = text.strip()
    if not text:
        raise LLMError("Empty LLM response")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    fence = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.S)
    if fence:
        try:
            return json.loads(fence.group(1))
        except json.JSONDecodeError:
            pass
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=-1)
    if start >= 0:
        for end in range(len(text), start, -1):
            if text[end - 1] in "}]":
                try:
                    return json.loads(text[start:end])
                except json.JSONDecodeError:
                    continue
    raise LLMError(f"Could not parse JSON from LLM reply: {text[:300]}")


def status() -> dict:
    return {"enabled": LLM_ENABLED, "model": LLM_MODEL, "base_url": LLM_BASE_URL}
