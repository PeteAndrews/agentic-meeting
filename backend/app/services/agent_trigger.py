from __future__ import annotations

import os
import re

from app.domain.models import AgentProfile

DEFAULT_TRIGGER_PHRASES = ["echo"]

# Common browser-STT mishearings of "Echo" (substring / fuzzy on opener word only).
# Mishearings starting with a different letter (Ako, Ayako) must be literal
# aliases: fuzzy matching requires the first letters to match.
DEFAULT_TRIGGER_ALIASES = [
    "eko",
    "eco",
    "ekko",
    "ecco",
    "hecho",
    "ako",
    "ayako",
    "aiko",
]


def _extra_aliases() -> list[str]:
    raw = os.environ.get("AGENT_TRIGGER_ALIASES_EXTRA", "").strip()
    if not raw:
        return []
    return [alias.strip() for alias in raw.split(",") if alias.strip()]

_GREETING_PREFIXES = ("hi", "hello", "hey", "ok", "okay", "so", "well")


def _word_tokens(text: str) -> list[str]:
    return [re.sub(r"[^a-zA-Z']", "", w).casefold() for w in re.findall(r"[a-zA-Z']+", text) if w]


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)

    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        curr = [i]
        for j, cb in enumerate(b, start=1):
            insert_cost = curr[j - 1] + 1
            delete_cost = prev[j] + 1
            replace_cost = prev[j - 1] + (0 if ca == cb else 1)
            curr.append(min(insert_cost, delete_cost, replace_cost))
        prev = curr
    return prev[-1]


def _max_edit_distance() -> int:
    raw = os.environ.get("AGENT_TRIGGER_MAX_EDIT_DISTANCE", "2").strip()
    try:
        return max(0, int(raw))
    except ValueError:
        return 2


def _opener_words(text: str, *, max_words: int = 4) -> list[str]:
    words = _word_tokens(text)
    while words and words[0] in _GREETING_PREFIXES:
        words = words[1:]
    return words[:max_words]


def _expand_phrases(phrases: list[str]) -> list[str]:
    expanded: list[str] = []
    seen: set[str] = set()
    for phrase in phrases:
        candidate = phrase.strip()
        if not candidate:
            continue
        key = candidate.casefold()
        if key not in seen:
            expanded.append(candidate)
            seen.add(key)
        if key == "echo":
            for alias in DEFAULT_TRIGGER_ALIASES + _extra_aliases():
                alias_key = alias.casefold()
                if alias_key not in seen:
                    expanded.append(alias)
                    seen.add(alias_key)
    return expanded


def resolve_trigger_phrases(profile: AgentProfile | None) -> list[str]:
    phrases: list[str] = []

    if profile and profile.agentTriggerPhrases:
        phrases.extend(p.strip() for p in profile.agentTriggerPhrases if p.strip())

    if profile and profile.agentDisplayName:
        name = profile.agentDisplayName.strip()
        if name and name.casefold() not in {p.casefold() for p in phrases}:
            phrases.append(name)

    if not phrases:
        env = os.environ.get("AGENT_TRIGGER_PHRASES", "").strip()
        if env:
            phrases.extend(p.strip() for p in env.split(",") if p.strip())

    if not phrases:
        phrases = list(DEFAULT_TRIGGER_PHRASES)

    return _expand_phrases(phrases)


def _word_matches_phrase(word: str, phrase: str, *, max_distance: int) -> bool:
    candidate = phrase.strip().casefold()
    if not candidate or not word:
        return False
    if " " in candidate:
        return candidate in word
    if word == candidate:
        return True
    if max_distance <= 0:
        return False
    # Fuzzy match only on opener tokens long enough (avoids "my" -> "myvo").
    if len(word) < 4 or len(candidate) < 4:
        return False
    allowed = max_distance
    if min(len(word), len(candidate)) <= 4:
        allowed = 1
    if not (word[0] == candidate[0]):
        return False
    return _levenshtein(word, candidate) <= allowed


def contains_trigger(text: str, phrases: list[str]) -> bool:
    return match_trigger(text, phrases) is not None


def match_trigger(text: str, phrases: list[str]) -> str | None:
    opener = _opener_words(text)
    if not opener:
        return None

    max_distance = _max_edit_distance()
    # Wake name must appear in the first few words (avoids "near" / echo mid-sentence).
    for word in opener:
        for phrase in phrases:
            if _word_matches_phrase(word, phrase, max_distance=max_distance):
                return phrase

    return None
