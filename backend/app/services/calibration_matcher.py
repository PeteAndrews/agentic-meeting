from __future__ import annotations

import re
from typing import Literal

from app.domain.models import AgentProfile
from app.services.scenario_loader import CalibrationQuestion, load_scenario, questions_for_calibration

_STOP_WORDS = frozenset(
    {
        "a",
        "an",
        "the",
        "is",
        "are",
        "was",
        "were",
        "what",
        "when",
        "where",
        "who",
        "how",
        "why",
        "do",
        "does",
        "did",
        "can",
        "could",
        "would",
        "should",
        "we",
        "you",
        "your",
        "our",
        "they",
        "their",
        "me",
        "my",
        "i",
        "to",
        "of",
        "in",
        "on",
        "at",
        "for",
        "and",
        "or",
        "about",
        "tell",
        "know",
        "think",
        "views",
        "view",
        "echo",
        "mevo",
        "meevo",
        "nevo",
        "miro",
        "hello",
        "hi",
        "hey",
    }
)

# Boilerplate words in calibration question text that must not match alone.
_WEAK_KEYWORDS = frozenset(
    {
        "name",
        "time",
        "team",
        "point",
        "day",
        "london",
        "getting",
    }
)

_PROXY_IDENTITY_PATTERNS = (
    r"\buser\s*name\b",
    r"\busername\b",
    r"\byour\s+user\b",
    r"\bmy\s+user\b",
    r"\bwho\s+is\s+your\s+user\b",
    r"\bproxy\b",
    r"\brepresentative\b",
    r"\bperson\s+c\b",
    r"\bwho\s+are\s+you\s+representing\b",
)


def _token_variants(word: str) -> set[str]:
    w = word.casefold()
    variants = {w}
    if len(w) > 4 and w.endswith("ing"):
        variants.add(w[:-3])
    if len(w) > 3 and w.endswith("ed"):
        variants.add(w[:-2])
    if len(w) > 2 and w.endswith("s"):
        variants.add(w[:-1])
    return variants


def _significant_tokens(text: str) -> set[str]:
    tokens: set[str] = set()
    for word in re.findall(r"[a-zA-Z']+", text.casefold()):
        if len(word) < 3 or word in _STOP_WORDS:
            continue
        tokens.update(_token_variants(word))
    return tokens


def is_proxy_identity_question(trigger_text: str) -> bool:
    normalized = re.sub(r"\s+", " ", trigger_text.casefold().strip())
    return any(re.search(pattern, normalized) for pattern in _PROXY_IDENTITY_PATTERNS)


def _primary_keywords(question: CalibrationQuestion) -> set[str]:
    keywords: set[str] = set()
    if question.matchKeywords:
        for kw in question.matchKeywords:
            keywords.update(_significant_tokens(kw))
    return keywords


def _question_keywords(question: CalibrationQuestion) -> set[str]:
    keywords = _primary_keywords(question)
    keywords.update(_significant_tokens(question.text))
    return keywords


def _count_token_hits(trigger_tokens: set[str], keywords: set[str]) -> int:
    hits = 0
    for token in trigger_tokens:
        if token in keywords:
            hits += 1
            continue
        if any(token in kw or kw in token for kw in keywords if len(kw) >= 4):
            hits += 1
    return hits


def _score_match(trigger_text: str, question: CalibrationQuestion) -> float:
    trigger_tokens = _significant_tokens(trigger_text)
    if not trigger_tokens:
        return 0.0

    primary_keywords = _primary_keywords(question)
    all_keywords = _question_keywords(question)
    if not all_keywords:
        return 0.0

    primary_hits = _count_token_hits(trigger_tokens, primary_keywords)
    if primary_hits < 1:
        return 0.0

    weak_only = trigger_tokens <= _WEAK_KEYWORDS
    if weak_only:
        return 0.0

    hits = _count_token_hits(trigger_tokens, all_keywords)
    return hits / len(trigger_tokens)


def find_calibration_answer(profile: AgentProfile, trigger_text: str) -> tuple[CalibrationQuestion, str] | None:
    if not profile.scenario:
        return None
    if is_proxy_identity_question(trigger_text):
        return None

    scenario = load_scenario(profile.scenario)
    candidates = questions_for_calibration(scenario, drop_index=profile.droppedQuestionIndex)

    best_question: CalibrationQuestion | None = None
    best_score = 0.0

    for question in candidates:
        answer = profile.calibrationAnswers.get(question.id, "").strip()
        if not answer:
            continue
        score = _score_match(trigger_text, question)
        if score > best_score:
            best_score = score
            best_question = question

    if best_question is None or best_score < 0.34:
        return None

    return best_question, profile.calibrationAnswers[best_question.id].strip()


CalibrationMatchMethod = Literal["keyword", "semantic"]


def resolve_calibration_answer(
    profile: AgentProfile,
    trigger_text: str,
) -> tuple[CalibrationQuestion, str, CalibrationMatchMethod] | None:
    keyword_hit = find_calibration_answer(profile, trigger_text)
    if keyword_hit:
        question, answer = keyword_hit
        return question, answer, "keyword"

    from app.services.agent_llm import infer_calibration_question_id

    question_id = infer_calibration_question_id(profile, trigger_text)
    if not question_id or not profile.scenario:
        return None

    scenario = load_scenario(profile.scenario)
    for question in questions_for_calibration(scenario, drop_index=profile.droppedQuestionIndex):
        if question.id != question_id:
            continue
        answer = profile.calibrationAnswers.get(question.id, "").strip()
        if answer:
            return question, answer, "semantic"
    return None
