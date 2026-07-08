from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from app.domain.models import AgentProfile, AgentPrompt, AgentPromptStatus
from app.services.agent_store import load_prompts
from app.services.scenario_loader import ScenarioDefinition, load_scenario, questions_for_calibration
from app.storage.jsonl import data_dir

logger = logging.getLogger(__name__)

LlmAction = Literal["draft_public", "ask_proxy", "wait"]
LlmSource = Literal[
    "known_calibration",
    "missing_calibration",
    "novel_topic",
    "moderator_disagreement",
    "meeting_meta",
    "meeting_recap",
]

DEFAULT_AGENT_NAME = "Echo"
PROXY_USER_LABEL = "my user"
MEETING_UNKNOWN_ACK = (
    "Good question — I don't have that from my user yet. I'll check with them and get back to you."
)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


def calibration_llm_polish_enabled() -> bool:
    return _env_bool("AGENT_CALIBRATION_LLM_POLISH", False)


def calibration_semantic_inference_enabled() -> bool:
    return _env_bool("AGENT_CALIBRATION_SEMANTIC_INFERENCE", True)


def agent_llm_max_tokens() -> int:
    # Reasoning models (gpt-5*) spend part of this budget on hidden reasoning
    # tokens, so it must be well above the expected visible reply length.
    return _env_int("AGENT_LLM_MAX_TOKENS", 600)


def agent_llm_reasoning_effort() -> str:
    return os.environ.get("AGENT_LLM_REASONING_EFFORT", "low").strip().lower()


def _is_reasoning_model(model: str) -> bool:
    return model.startswith("gpt-5") or model.startswith("o")


def apply_completion_token_limit(payload: dict[str, Any], model: str) -> None:
    """gpt-5* and o-series use max_completion_tokens; older models use max_tokens."""
    limit = agent_llm_max_tokens()
    if _is_reasoning_model(model):
        payload["max_completion_tokens"] = limit
        effort = agent_llm_reasoning_effort()
        if effort and effort != "default":
            payload["reasoning_effort"] = effort
    else:
        payload["max_tokens"] = limit


def routing_transcript_max_chars() -> int:
    return _env_int("AGENT_ROUTING_TRANSCRIPT_MAX_CHARS", 2500)


def calibration_transcript_max_chars() -> int:
    return _env_int("AGENT_CALIBRATION_TRANSCRIPT_MAX_CHARS", 2000)


class AgentLlmError(Exception):
    pass


def _default_prompt_path() -> Path:
    override = os.environ.get("AGENT_SYSTEM_PROMPT_PATH", "").strip()
    if override:
        return Path(override)
    return data_dir() / "prompts" / "agent_system.md"


def _default_policy_path() -> Path:
    override = os.environ.get("AGENT_POLICY_PATH", "").strip()
    if override:
        return Path(override)
    return data_dir() / "prompts" / "agent_policy.md"


def load_agent_policy(profile: AgentProfile) -> str:
    template_path = _default_policy_path()
    if not template_path.exists():
        raise AgentLlmError(f"Agent policy template not found: {template_path}")
    template = template_path.read_text(encoding="utf-8")
    agent_name = profile.agentDisplayName or DEFAULT_AGENT_NAME
    replacements = {
        "{{agent_display_name}}": agent_name,
        "{{proxy_user_label}}": PROXY_USER_LABEL,
    }
    for key, value in replacements.items():
        template = template.replace(key, value)
    return template


def format_meeting_acknowledgment(_profile: AgentProfile) -> str:
    return MEETING_UNKNOWN_ACK


def format_proxy_console_message(
    trigger_text: str,
    llm_text: str,
    *,
    reason: str | None = None,
) -> str:
    question = trigger_text.strip()
    if question:
        return (
            f"Hi in the meeting I was asked, '{question}', "
            "give me an answer and I will communicate it in the meeting."
        )
    return "Hi, I need your answer so I can respond in the meeting."


def format_discussion_key_points(scenario: ScenarioDefinition) -> str:
    return "\n".join(f"- {point}" for point in scenario.discussionKeyPoints)


def format_calibration_facts(profile: AgentProfile, scenario: ScenarioDefinition) -> str:
    drop_index = profile.droppedQuestionIndex
    lines: list[str] = []
    for i, question in enumerate(scenario.calibrationQuestions):
        if drop_index is not None and i == drop_index:
            continue
        answer = profile.calibrationAnswers.get(question.id)
        if not answer:
            continue
        lines.append(f"- Q: {question.text}\n  A: {answer}")
    if not lines:
        return "(No calibration facts recorded yet.)"
    return "\n".join(lines)


def build_system_prompt(
    profile: AgentProfile,
    scenario: ScenarioDefinition,
    *,
    interventions_used: int = 0,
    max_interventions: int = 999,
) -> str:
    template_path = _default_prompt_path()
    if not template_path.exists():
        raise AgentLlmError(f"System prompt template not found: {template_path}")
    template = template_path.read_text(encoding="utf-8")
    agent_name = profile.agentDisplayName or DEFAULT_AGENT_NAME
    replacements = {
        "{{agent_display_name}}": agent_name,
        "{{proxy_user_label}}": PROXY_USER_LABEL,
        "{{agent_policy}}": load_agent_policy(profile),
        "{{scenario_display_name}}": scenario.displayName,
        "{{scenario_description}}": scenario.description,
        "{{discussion_key_points}}": format_discussion_key_points(scenario),
        "{{calibration_facts}}": format_calibration_facts(profile, scenario),
        "{{interventions_used}}": str(interventions_used),
        "{{max_interventions}}": str(max_interventions),
    }
    prompt = template
    for key, value in replacements.items():
        prompt = prompt.replace(key, value)
    return prompt


def _format_segment_line(seg: dict[str, Any], *, is_trigger: bool = False) -> str | None:
    text = (seg.get("text") or "").strip()
    if not text:
        return None
    role = seg.get("role", "unknown")
    participant = seg.get("participantId", "?")
    prefix = "[TRIGGER] " if is_trigger else ""
    return f"{prefix}[{role}/{participant}]: {text}"


def build_transcript_user_prompt(
    segments: list[dict[str, Any]],
    *,
    trigger_index: int | None = None,
    max_chars: int | None = None,
) -> str:
    if max_chars is None:
        max_chars = int(os.environ.get("AGENT_TRANSCRIPT_MAX_CHARS", "12000"))

    if not segments:
        return "No transcript yet. Wait for meeting participants to speak."

    trigger_idx = trigger_index if trigger_index is not None else len(segments) - 1
    indexed_lines: list[tuple[int, str]] = []
    for i, seg in enumerate(segments):
        line = _format_segment_line(seg, is_trigger=(i == trigger_idx))
        if line:
            indexed_lines.append((i, line))

    if not indexed_lines:
        return "No transcript yet. Wait for meeting participants to speak."

    trigger_line: str | None = None
    other_lines: list[str] = []
    for i, line in indexed_lines:
        if i == trigger_idx:
            trigger_line = line
        else:
            other_lines.append(line)

    header = "Recent meeting transcript:\n"
    selected = other_lines[:]

    def body_length(lines: list[str]) -> int:
        parts = lines + ([trigger_line] if trigger_line else [])
        return len(header) + len("\n".join(parts))

    while selected and body_length(selected) > max_chars:
        selected.pop(0)

    all_lines = selected + ([trigger_line] if trigger_line else [])
    return header + "\n".join(all_lines)


def _iso_to_ms(iso: str) -> int:
    normalized = iso.strip().replace("Z", "+00:00")
    try:
        return int(datetime.fromisoformat(normalized).timestamp() * 1000)
    except ValueError:
        return 0


def _segment_sort_key(seg: dict[str, Any]) -> tuple[int, int, str, str]:
    return (
        int(seg.get("startMs", 0)),
        0 if seg.get("role") != "agent" else 1,
        str(seg.get("participantId") or ""),
        str(seg.get("text") or ""),
    )


def _spoken_prompts_to_segments(
    prompts: list[AgentPrompt],
    *,
    agent_label: str,
) -> list[dict[str, Any]]:
    utterances: list[dict[str, Any]] = []
    for prompt in prompts:
        if prompt.kind != "public_draft":
            continue
        if prompt.status != AgentPromptStatus.SPOKEN:
            continue
        text = prompt.text.strip()
        if not text:
            continue
        when_ms = _iso_to_ms(prompt.updatedAt or prompt.createdAt)
        utterances.append(
            {
                "role": "agent",
                "participantId": agent_label,
                "text": text,
                "startMs": when_ms,
                "endMs": when_ms,
                "isFinal": True,
            }
        )
    return utterances


def merge_meeting_transcript(
    segments: list[dict[str, Any]],
    prompts: list[AgentPrompt],
    *,
    agent_label: str = "echo",
    trigger_index: int | None = None,
) -> tuple[list[dict[str, Any]], int | None]:
    """Interleave participant STT segments with Echo's spoken lines for summarization."""
    if trigger_index is None:
        trigger_index = len(segments) - 1 if segments else None

    trigger_seg = segments[trigger_index] if trigger_index is not None and segments else None
    trigger_ms = int(trigger_seg.get("startMs", 0)) if trigger_seg is not None else None
    agent_segments = _spoken_prompts_to_segments(prompts, agent_label=agent_label)
    if trigger_ms is not None:
        agent_segments = [s for s in agent_segments if int(s.get("startMs", 0)) < trigger_ms]

    merged = list(segments) + agent_segments
    merged.sort(key=_segment_sort_key)

    merged_trigger_index: int | None = None
    if trigger_seg is not None:
        target_key = _segment_sort_key(trigger_seg)
        for i, seg in enumerate(merged):
            if _segment_sort_key(seg) == target_key:
                merged_trigger_index = i
                break
        if merged_trigger_index is None:
            merged_trigger_index = len(merged) - 1

    return merged, merged_trigger_index


def parse_llm_json_object(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise AgentLlmError(f"LLM returned invalid JSON: {raw[:200]}") from exc
    if not isinstance(parsed, dict):
        raise AgentLlmError("LLM response must be a JSON object")
    return parsed


def parse_llm_response(raw: str) -> dict[str, Any]:
    parsed = parse_llm_json_object(raw)
    action = parsed.get("action")
    if action not in ("draft_public", "ask_proxy", "wait"):
        raise AgentLlmError(f"Invalid action in LLM response: {action!r}")
    return parsed


def _chat_completion_json(
    *,
    system_prompt: str,
    user_prompt: str,
    model: str | None = None,
    temperature: float | None = None,
) -> dict[str, Any]:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise AgentLlmError("OPENAI_API_KEY is required for agent LLM")

    chosen_model = model or os.environ.get("AGENT_LLM_MODEL", "gpt-5-nano").strip() or "gpt-5-nano"
    payload: dict[str, Any] = {
        "model": chosen_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "response_format": {"type": "json_object"},
    }
    if temperature is not None and not chosen_model.startswith("gpt-5"):
        payload["temperature"] = temperature
    apply_completion_token_limit(payload, chosen_model)
    req = urllib.request.Request(
        url="https://api.openai.com/v1/chat/completions",
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        data=json.dumps(payload).encode("utf-8"),
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") or str(exc)
        raise AgentLlmError(f"OpenAI chat HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise AgentLlmError(f"OpenAI chat request failed: {exc.reason}") from exc

    try:
        content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise AgentLlmError(f"Unexpected OpenAI response shape: {body}") from exc
    return parse_llm_json_object(str(content))


def call_agent_llm_json(
    *,
    system_prompt: str,
    user_prompt: str,
    model: str | None = None,
    temperature: float | None = None,
) -> dict[str, Any]:
    return _chat_completion_json(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        model=model,
        temperature=temperature,
    )


def call_agent_llm(
    *,
    system_prompt: str,
    user_prompt: str,
    model: str | None = None,
) -> dict[str, Any]:
    parsed = _chat_completion_json(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        model=model,
        temperature=0.2,
    )
    action = parsed.get("action")
    if action not in ("draft_public", "ask_proxy", "wait"):
        raise AgentLlmError(f"Invalid action in LLM response: {action!r}")
    return parsed


def parse_spoken_reply(raw: str) -> str:
    text = raw.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            spoken = parsed.get("spoken") or parsed.get("text")
            if isinstance(spoken, str) and spoken.strip():
                return spoken.strip()
    except json.JSONDecodeError:
        pass
    if text:
        return text.strip()
    raise AgentLlmError("LLM returned empty spoken reply")


def call_agent_llm_text(
    *,
    system_prompt: str,
    user_prompt: str,
    model: str | None = None,
) -> str:
    parsed = _chat_completion_json(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        model=model,
        temperature=0.4,
    )
    return parse_spoken_reply(json.dumps(parsed))


def infer_calibration_question_id(profile: AgentProfile, trigger_text: str) -> str | None:
    if not profile.scenario or not calibration_semantic_inference_enabled():
        return None

    scenario = load_scenario(profile.scenario)
    candidates = questions_for_calibration(scenario, drop_index=profile.droppedQuestionIndex)
    topics: list[str] = []
    valid_ids: set[str] = set()
    for question in candidates:
        answer = profile.calibrationAnswers.get(question.id, "").strip()
        if not answer:
            continue
        valid_ids.add(question.id)
        topics.append(f'{question.id}: "{question.text}" → {answer}')

    if not topics:
        return None

    system_prompt = """You map live meeting questions to calibration topic ids when the participant is clearly asking about the same subject, including paraphrases and indirect wording.

Examples of the same topic:
- "what is the activity plan for tomorrow" and "what is the event tomorrow" → Day 2 activities
- "when are we meeting" and "what time is the lobby meet-up" → lobby meeting time
- "where are we staying" and "what hotel" → hotel

Return JSON only:
{"questionId": "<id>" | null, "reason": "..."}

Rules:
- Use questionId only when the utterance clearly maps to one calibration topic.
- Return null when uncertain or when the topic is outside calibration.
- Never invent ids."""
    user_prompt = (
        f'Meeting utterance: "{trigger_text}"\n\n'
        "Calibration topics (id: question → answer):\n"
        + "\n".join(f"- {line}" for line in topics)
    )

    try:
        result = call_agent_llm_json(system_prompt=system_prompt, user_prompt=user_prompt)
    except AgentLlmError as exc:
        logger.warning("Calibration semantic inference LLM call failed: %s", exc)
        return None

    question_id = result.get("questionId")
    if question_id is None:
        return None
    question_id = str(question_id).strip()
    if question_id in valid_ids:
        return question_id
    return None


def _present_answer(answer: str) -> str:
    text = answer.strip()
    if text and text[0].islower():
        return text[0].upper() + text[1:]
    return text


def _humanize_time_fragment(answer: str) -> str:
    digits = re.sub(r"\D", "", answer)
    if len(digits) == 4:
        hour = int(digits[:2])
        minute = int(digits[2:])
        period = "a.m." if hour < 12 else "p.m."
        display_hour = hour % 12 or 12
        if minute == 0:
            return f"{display_hour} {period}"
        return f"{display_hour}:{minute:02d} {period}"
    if len(digits) == 3:
        hour = int(digits[0])
        minute = int(digits[1:])
        period = "a.m." if hour < 12 else "p.m."
        return f"{hour}:{minute:02d} {period}"
    return answer.strip()


def template_calibration_speech(
    trigger_text: str,
    question_text: str,
    raw_answer: str,
    *,
    question_id: str | None = None,
) -> str:
    answer = _present_answer(raw_answer)
    when = _humanize_time_fragment(raw_answer) if any(c.isdigit() for c in raw_answer) else answer

    by_id = _template_for_question_id(question_id, answer=answer, when=when)
    if by_id:
        return by_id

    trigger = trigger_text.casefold()
    if any(k in trigger for k in ("lobby", "meet", "meeting", "gather")):
        return f"We're meeting in the hotel lobby at {when.rstrip('.')}."
    if any(k in trigger for k in ("hotel", "staying", "accommodation", "lodging")):
        return f"We're staying at {answer}."
    if any(k in trigger for k in ("fly", "flight", "airport", "arrive", "depart", "uk", "heathrow")):
        return f"We're flying out at {when.rstrip('.')}."
    if any(k in trigger for k in ("activit", "day 2", "plans", "schedule", "tomorrow")):
        return f"For Day 2, we're planning {answer}."
    if any(k in trigger for k in ("transport", "shuttle", "taxi", "bus", "train")):
        return f"We're getting from the airport to the hotel by {answer}."
    return f"From what my user shared, {answer}."


def _template_for_question_id(
    question_id: str | None,
    *,
    answer: str,
    when: str,
) -> str | None:
    if not question_id:
        return None
    templates = {
        "q0": f"We're flying out at {when.rstrip('.')}.",
        "q1": f"We're staying at {answer}.",
        "q2": f"We're getting from the airport to the hotel by {answer}.",
        "q3": f"{answer.rstrip('.')}.",
        "q4": f"For Day 2, we're planning {answer}.",
    }
    return templates.get(question_id)


def _calibration_speech_acceptable(spoken: str, template: str, raw_answer: str) -> bool:
    spoken_cf = spoken.casefold().strip()
    raw_cf = raw_answer.casefold().strip()
    if not spoken_cf or spoken_cf == raw_cf:
        return False
    digits = re.sub(r"\D", "", raw_answer)
    if digits and len(digits) >= 3 and digits in re.sub(r"\D", "", spoken):
        if not any(marker in spoken_cf for marker in ("a.m.", "p.m.", " am", " pm", "o'clock")):
            return False
    if spoken_cf.startswith("it's ") and digits:
        return False
    return len(spoken.split()) >= max(4, len(template.split()) - 2)


def format_calibration_speech(
    profile: AgentProfile,
    *,
    trigger_text: str,
    question_text: str,
    raw_answer: str,
    question_id: str | None = None,
    segments: list[dict[str, Any]] | None = None,
    trigger_index: int | None = None,
) -> str:
    template = template_calibration_speech(
        trigger_text,
        question_text,
        raw_answer,
        question_id=question_id,
    )
    if not calibration_llm_polish_enabled():
        return template

    agent_name = profile.agentDisplayName or DEFAULT_AGENT_NAME
    policy_excerpt = load_agent_policy(profile)
    system_prompt = f"""You are {agent_name}, speaking naturally in a live meeting on my user's behalf.

{policy_excerpt}

Rewrite the draft reply as conversational spoken English (1–3 short sentences; up to 4 when tying to prior discussion).
Rules:
- Keep every fact from my user's answer; do not add, remove, or change substantive details
- You may add brief conversational framing: acknowledgments, soft agreement, or a bridge from the recent transcript
- Read the recent transcript and refer to what others said when relevant (who suggested what, what was just discussed)
- Do not invent new preferences, reasons, times, places, or decisions not in the answer, calibration, scenario, or transcript
- Do not read the answer as a bare label or fragment — use complete sentences
- Plain speakable text only
Return JSON: {{"spoken": "..."}}

Examples:
- Facts: "the meridian near leicester square" -> "We're staying at the Meridian near Leicester Square."
- Facts: "0900" (departure time) -> "We're flying out at 9 a.m."
- Facts: "taxi" after transport was discussed -> "On the airport transfer — my user had taxi in mind."
- Facts: "7 sounds good" -> "Sure, that works for my user too — they're happy with 7."
- Disagreement context: someone suggested Leicester -> "Sorry — meeting at Leicester isn't suitable for my user; they suggest the Meridian near Leicester Square instead."
"""

    transcript_block = ""
    if segments:
        transcript_block = (
            "\n\n"
            + build_transcript_user_prompt(
                segments,
                trigger_index=trigger_index,
                max_chars=calibration_transcript_max_chars(),
            )
        )

    user_prompt = (
        f'Meeting utterance: "{trigger_text}"\n'
        f"Calibration topic: {question_text}\n"
        f"My user's answer (facts to preserve): {raw_answer}\n"
        f"Draft reply to polish: {template}"
        f"{transcript_block}"
    )

    try:
        spoken = call_agent_llm_text(system_prompt=system_prompt, user_prompt=user_prompt)
        if _calibration_speech_acceptable(spoken, template, raw_answer):
            return spoken
        logger.warning(
            "Calibration polish reply rejected by acceptability check; using template. spoken=%r",
            spoken,
        )
    except AgentLlmError as exc:
        logger.warning("Calibration polish LLM call failed; using template: %s", exc)
    return template


def _proxy_reply_acceptable(spoken: str, raw_answer: str) -> bool:
    spoken_cf = spoken.casefold().strip()
    raw_cf = raw_answer.casefold().strip()
    if not spoken_cf:
        return False
    if spoken_cf == raw_cf and len(spoken.split()) < 4:
        return False
    return len(spoken.split()) >= 3


def format_proxy_reply_speech(
    profile: AgentProfile,
    *,
    trigger_text: str,
    proxy_reply: str,
    segments: list[dict[str, Any]] | None = None,
    trigger_index: int | None = None,
) -> str:
    """Turn a console answer from my user into conversational meeting speech."""
    raw = proxy_reply.strip()
    if not raw:
        return raw

    agent_name = profile.agentDisplayName or DEFAULT_AGENT_NAME
    policy_excerpt = load_agent_policy(profile)
    system_prompt = f"""You are {agent_name}, speaking naturally in a live meeting on my user's behalf.

{policy_excerpt}

Rewrite my user's console answer as conversational spoken English (1–3 short sentences; up to 4 when tying to prior discussion) for the meeting.
Rules:
- Keep every fact and preference from their answer; do not add, remove, or change substantive details
- Refer to them as "my user" when speaking about them in the third person
- You may add brief conversational framing: acknowledgments, soft agreement, or a bridge from the recent transcript
- Read the recent transcript and refer to what others said when relevant (address the question or tie to the discussion)
- Do not invent new preferences, reasons, times, places, or decisions not in their answer, calibration, scenario, or transcript
- Do not read the answer as a bare label or fragment — use complete sentences
- Plain speakable text only, no lists or labels
Return JSON: {{"spoken": "..."}}

Examples:
- Console: "7 sounds good" -> "Sure, that works for my user too — they're happy with 7."
- Console: "taxi" after transport was discussed -> "On the airport transfer — my user had taxi in mind."
- Console: "no, too early" -> "Sorry — that's a bit too early for my user."
"""

    transcript_block = ""
    if segments:
        transcript_block = (
            "\n\n"
            + build_transcript_user_prompt(
                segments,
                trigger_index=trigger_index,
                max_chars=routing_transcript_max_chars(),
            )
        )

    trigger_line = f'Meeting question: "{trigger_text}"\n' if trigger_text.strip() else ""
    user_prompt = (
        f"{trigger_line}"
        f"My user's console answer (facts to preserve): {raw}"
        f"{transcript_block}"
    )

    try:
        spoken = call_agent_llm_text(system_prompt=system_prompt, user_prompt=user_prompt)
        if _proxy_reply_acceptable(spoken, raw):
            return spoken
        logger.warning(
            "Proxy reply polish rejected by acceptability check; using raw answer. spoken=%r",
            spoken,
        )
    except AgentLlmError as exc:
        logger.warning("Proxy reply polish LLM call failed; using raw answer: %s", exc)
    return raw


SUMMARY_UNAVAILABLE_FALLBACK = (
    "Sorry, I don't have enough of the discussion recorded yet to summarize."
)


def summarize_meeting_so_far(
    profile: AgentProfile,
    segments: list[dict[str, Any]],
    *,
    trigger_index: int | None = None,
) -> str:
    if not segments:
        return SUMMARY_UNAVAILABLE_FALLBACK

    agent_label = (profile.agentDisplayName or DEFAULT_AGENT_NAME).casefold()
    prompts = load_prompts(profile.roomName)
    merged_segments, merged_trigger_index = merge_meeting_transcript(
        segments,
        prompts,
        agent_label=agent_label,
        trigger_index=trigger_index,
    )

    agent_name = profile.agentDisplayName or DEFAULT_AGENT_NAME
    policy_excerpt = load_agent_policy(profile)
    system_prompt = f"""You are {agent_name}, speaking naturally in a live meeting on my user's behalf.

{policy_excerpt}

Summarize the discussion so far in 2-4 short spoken sentences.
Rules:
- Cover the main topics raised by participants and what you ({agent_name}) answered
- Focus on decisions made and open items still being discussed
- Never invent facts, times, places, or preferences not in the transcript
- Plain speakable text only, no lists or labels
Return JSON: {{"spoken": "..."}}"""

    user_prompt = (
        "Someone asked for a summary of the meeting so far. "
        "The transcript below includes participant speech and your spoken replies.\n\n"
        + build_transcript_user_prompt(merged_segments, trigger_index=merged_trigger_index)
    )

    try:
        return call_agent_llm_text(system_prompt=system_prompt, user_prompt=user_prompt)
    except AgentLlmError as exc:
        logger.warning("Meeting summary LLM call failed; using fallback: %s", exc)
        return SUMMARY_UNAVAILABLE_FALLBACK


def evaluate_meeting_turn(
    profile: AgentProfile,
    segments: list[dict[str, Any]],
    *,
    trigger_index: int | None = None,
    wake_phrase_detected: bool = False,
) -> dict[str, Any]:
    if not profile.scenario:
        raise AgentLlmError("Agent profile has no scenario assigned")
    scenario = load_scenario(profile.scenario)
    system_prompt = build_system_prompt(
        profile,
        scenario,
        interventions_used=profile.interventionsUsed,
        max_interventions=profile.maxInterventions,
    )
    user_prompt = build_transcript_user_prompt(
        segments,
        trigger_index=trigger_index,
        max_chars=routing_transcript_max_chars(),
    )
    if wake_phrase_detected:
        agent_name = profile.agentDisplayName or DEFAULT_AGENT_NAME
        user_prompt = (
            f"The wake phrase for {agent_name} was already detected in the triggering utterance. "
            "Do not refuse with 'not addressed by name' or action wait for that reason. "
            "Use ask_proxy for unknown topics.\n\n"
            + user_prompt
        )
    return call_agent_llm(system_prompt=system_prompt, user_prompt=user_prompt)


def calibration_complete(profile: AgentProfile, scenario_id: str) -> bool:
    scenario = load_scenario(scenario_id)
    required = questions_for_calibration(scenario, drop_index=profile.droppedQuestionIndex)
    return all(q.id in profile.calibrationAnswers for q in required)
