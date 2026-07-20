from __future__ import annotations

import os
from typing import Literal

SttMode = Literal["browser", "server_per_client"]


def default_stt_mode() -> SttMode:
    raw = os.environ.get("STT_MODE", "browser").strip().lower()
    if raw == "server_per_client":
        return "server_per_client"
    return "browser"


def deepgram_api_key() -> str:
    return os.environ.get("DEEPGRAM_API_KEY", "").strip()


def deepgram_model() -> str:
    return os.environ.get("DEEPGRAM_MODEL", "nova-2").strip() or "nova-2"


def stt_language() -> str:
    return os.environ.get("STT_LANGUAGE", "en-US").strip() or "en-US"


def stt_endpointing_ms() -> int:
    raw = os.environ.get("STT_ENDPOINTING_MS", "400").strip()
    try:
        return max(100, min(2000, int(raw)))
    except ValueError:
        return 400


def stt_keyterms() -> list[str]:
    raw = os.environ.get("STT_KEYTERMS", "Echo").strip()
    if not raw:
        return []
    terms: list[str] = []
    seen: set[str] = set()
    for part in raw.split(","):
        term = part.strip()
        if not term:
            continue
        key = term.casefold()
        if key in seen:
            continue
        seen.add(key)
        terms.append(term)
    return terms
