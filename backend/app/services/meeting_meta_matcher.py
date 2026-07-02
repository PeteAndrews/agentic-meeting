from __future__ import annotations

import re

# Substantive cues — if present, do not treat as meeting-meta (calibration / LLM handles).
_SUBSTANTIVE_CUES = frozenset(
    {
        "hotel",
        "flight",
        "fly",
        "flying",
        "airport",
        "story",
        "stories",
        "think",
        "opinion",
        "prefer",
        "preference",
        "when",
        "where",
        "what",
        "which",
        "who",
        "how",
        "why",
        "time",
        "date",
        "lobby",
        "transport",
        "activity",
        "activities",
        "plan",
        "plans",
        "suggest",
        "destination",
        "stay",
        "staying",
        "hotel",
        "meet",
        "meeting",
    }
)

_GREETING_PREFIXES = ("hi", "hello", "hey", "ok", "okay", "so", "well")

_WAKE_NAMES = frozenset(
    {
        "echo",
        "eko",
        "eco",
        "ekko",
        "ecco",
        "mivo",
        "mevo",
        "nevo",
    }
)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.casefold().strip())


def _strip_opener(text: str) -> str:
    words = re.findall(r"[a-zA-Z']+", text.casefold())
    while words and words[0] in _GREETING_PREFIXES:
        words = words[1:]
    while words and words[0] in _WAKE_NAMES:
        words = words[1:]
    return " ".join(words)


def _has_substantive_cue(text: str) -> bool:
    normalized = _normalize(text)
    tokens = set(re.findall(r"[a-zA-Z']+", normalized))
    return bool(tokens & _SUBSTANTIVE_CUES)


def find_meeting_meta_reply(trigger_text: str) -> str | None:
    """Return a safe spoken reply for presence/hearing/greeting checks, or None."""
    if not trigger_text.strip():
        return None
    if _has_substantive_cue(trigger_text):
        return None

    remainder = _strip_opener(trigger_text)
    context = _normalize(trigger_text)
    rem = _normalize(remainder)

    if any(
        phrase in context
        for phrase in (
            "can you hear",
            "could you hear",
            "do you hear",
            "hear me",
            "hearing me",
            "audio",
            "sound ok",
            "coming through",
        )
    ):
        return "Yes, I can hear you."

    if any(
        phrase in context
        for phrase in (
            "are you there",
            "you there",
            "still there",
            "anyone there",
            "are you online",
            "are you with us",
        )
    ):
        return "I'm here."

    if rem in ("", "hi", "hello", "hey") or rem in ("how are you", "how are you doing"):
        return "Hi — I'm here on the line for my user."

    if any(phrase in context for phrase in ("ready", "can we start", "shall we start")) and not rem:
        return "Yes — I'm ready when you are."

    return None
