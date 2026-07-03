from __future__ import annotations

import re
from typing import Literal

RecapIntent = Literal["repeat_last", "summarize"]

_REPEAT_PATTERNS = (
    r"\bwhat did you just say\b",
    r"\bwhat did \w+ just say\b",
    r"\bwhat was that you said\b",
    r"\bwhat was that again\b",
    r"\bcan you repeat\b",
    r"\bcould you repeat\b",
    r"\bplease repeat\b",
    r"\brepeat that\b",
    r"\bsay that again\b",
    r"\bsay it again\b",
    r"\bremind me (of )?what you (just )?said\b",
)

_SUMMARIZE_PATTERNS = (
    r"\bsummari[sz]e\b",
    r"\bsummary\b",
    r"\brecap\b",
    r"\bcatch (me|us) up\b",
    r"\bwhat have we covered\b",
    r"\bwhat have we discussed\b",
    r"\bwhat did we discuss\b",
    r"\bwhere are we so far\b",
    r"\bwhat('s| is| has) been (said|discussed|decided)( so far)?\b",
    r"\bmeeting so far\b",
    r"\bdiscussion so far\b",
)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.casefold().strip())


def classify_recap_intent(trigger_text: str) -> RecapIntent | None:
    """Classify a wake-word utterance as a repeat/summarize request, or None."""
    normalized = _normalize(trigger_text)
    if not normalized:
        return None

    for pattern in _REPEAT_PATTERNS:
        if re.search(pattern, normalized):
            return "repeat_last"

    for pattern in _SUMMARIZE_PATTERNS:
        if re.search(pattern, normalized):
            return "summarize"

    return None
