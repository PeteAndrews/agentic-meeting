from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Literal

from app.domain.models import AgentProfile
from app.services.scenario_loader import ScenarioDefinition, load_scenario, questions_for_calibration
from app.storage.jsonl import data_dir

LlmAction = Literal["draft_public", "ask_proxy", "wait"]
LlmSource = Literal[
    "known_calibration",
    "missing_calibration",
    "novel_topic",
    "moderator_disagreement",
    "meeting_meta",
]

DEFAULT_AGENT_NAME = "Echo"
PROXY_USER_LABEL = "my user"
MEETING_UNKNOWN_ACK = (
    "Hi — sorry, I don't have that from my user. I'll check with them and get back to you."
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
    return _env_int("AGENT_LLM_MAX_TOKENS", 200)


def apply_completion_token_limit(payload: dict[str, Any], model: str) -> None:
    """gpt-5* and o-series use max_completion_tokens; older models use max_tokens."""
    limit = agent_llm_max_tokens()
    if model.startswith("gpt-5") or model.startswith("o"):
        payload["max_completion_tokens"] = limit
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
    lines = [
        f'Someone in the meeting asked: "{trigger_text}"',
        "",
        "I don't have this from your calibration and need your input before I can answer in the meeting.",
    ]
    if reason and reason.strip():
        lines.append(f"Why I need input: {reason.strip()}")
    detail = llm_text.strip()
    if detail:
        lines.append(f"Please share: {detail}")
    return "\n".join(lines)


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
    except AgentLlmError:
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

Rewrite the draft reply as conversational spoken English (1–3 short sentences).
Rules:
- Keep every fact from my user's answer; do not add, remove, or change details
- Use the recent transcript for context (refer to others' suggestions when relevant)
- Do not read the answer as a bare label or fragment — use complete sentences
- Plain speakable text only
Return JSON: {{"spoken": "..."}}

Examples:
- Facts: "the meridian near leicester square" -> "We're staying at the Meridian near Leicester Square."
- Facts: "0900" (departure time) -> "We're flying out at 9 a.m."
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
    except AgentLlmError:
        pass
    return template


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
