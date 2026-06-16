from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Literal

from app.domain.models import AgentProfile
from app.services.scenario_loader import ScenarioDefinition, load_scenario, questions_for_calibration
from app.storage.jsonl import data_dir

LlmAction = Literal["draft_public", "ask_proxy", "wait"]
LlmSource = Literal["known_calibration", "missing_calibration", "novel_topic", "moderator_disagreement"]


class AgentLlmError(Exception):
    pass


def _default_prompt_path() -> Path:
    override = os.environ.get("AGENT_SYSTEM_PROMPT_PATH", "").strip()
    if override:
        return Path(override)
    return data_dir() / "prompts" / "agent_system.md"


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
    max_interventions: int = 3,
) -> str:
    template_path = _default_prompt_path()
    if not template_path.exists():
        raise AgentLlmError(f"System prompt template not found: {template_path}")
    template = template_path.read_text(encoding="utf-8")
    replacements = {
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


def build_transcript_user_prompt(segments: list[dict[str, Any]], *, max_segments: int = 40) -> str:
    recent = segments[-max_segments:]
    if not recent:
        return "No transcript yet. Wait for meeting participants to speak."
    lines: list[str] = []
    for seg in recent:
        role = seg.get("role", "unknown")
        participant = seg.get("participantId", "?")
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        lines.append(f"[{role}/{participant}]: {text}")
    if not lines:
        return "No transcript yet. Wait for meeting participants to speak."
    return "Recent meeting transcript:\n" + "\n".join(lines)


def parse_llm_response(raw: str) -> dict[str, Any]:
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
    action = parsed.get("action")
    if action not in ("draft_public", "ask_proxy", "wait"):
        raise AgentLlmError(f"Invalid action in LLM response: {action!r}")
    return parsed


def call_agent_llm(
    *,
    system_prompt: str,
    user_prompt: str,
    model: str | None = None,
) -> dict[str, Any]:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise AgentLlmError("OPENAI_API_KEY is required for agent LLM")

    chosen_model = model or os.environ.get("AGENT_LLM_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini"
    payload = {
        "model": chosen_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }
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
    return parse_llm_response(str(content))


def evaluate_meeting_turn(
    profile: AgentProfile,
    segments: list[dict[str, Any]],
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
    user_prompt = build_transcript_user_prompt(segments)
    return call_agent_llm(system_prompt=system_prompt, user_prompt=user_prompt)


def calibration_complete(profile: AgentProfile, scenario_id: str) -> bool:
    scenario = load_scenario(scenario_id)
    required = questions_for_calibration(scenario, drop_index=profile.droppedQuestionIndex)
    return all(q.id in profile.calibrationAnswers for q in required)
