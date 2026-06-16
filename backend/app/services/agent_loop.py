from __future__ import annotations

import threading
from typing import Any

from app.domain.models import AgentProfile, AgentPrompt, AgentPromptStatus
from app.services.agent_llm import AgentLlmError, evaluate_meeting_turn
from app.services.agent_store import (
    find_proxy_profile_for_room,
    has_open_prompt,
    load_prompts,
    new_prompt_id,
    save_prompt,
)
from app.services.scenario_loader import load_scenario
from app.storage.jsonl import now_iso, read_jsonl, safe_room_slug
from app.storage.jsonl import data_dir

_lock = threading.Lock()
_last_processed: dict[str, int] = {}


def _segments_path(room_name: str):
    return data_dir() / "transcripts" / f"{safe_room_slug(room_name)}.segments.jsonl"


def _load_final_segments(room_name: str) -> list[dict[str, Any]]:
    try:
        rows = read_jsonl(_segments_path(room_name))
    except FileNotFoundError:
        return []
    final = [r for r in rows if r.get("isFinal") is True]
    final.sort(key=lambda s: (int(s.get("startMs", 0)), int(s.get("endMs", 0))))
    return final


def _segment_signature(segments: list[dict[str, Any]]) -> int:
    if not segments:
        return 0
    last = segments[-1]
    return hash(
        (
            len(segments),
            last.get("participantId"),
            last.get("text"),
            last.get("endMs"),
        )
    )


def _should_process(room_name: str, segments: list[dict[str, Any]]) -> bool:
    if len(segments) < 1:
        return False
    signature = _segment_signature(segments)
    with _lock:
        if _last_processed.get(room_name) == signature:
            return False
        _last_processed[room_name] = signature
    return True


def _infer_source(profile: AgentProfile, llm_source: str | None) -> str:
    if llm_source in ("missing_calibration", "novel_topic", "moderator_disagreement", "known_calibration"):
        return llm_source
    return "novel_topic"


def _is_intervention_action(action: str, source: str) -> bool:
    return action == "ask_proxy" or source in ("missing_calibration", "novel_topic", "moderator_disagreement")


def process_transcript_update(room_name: str) -> AgentPrompt | None:
    profile = find_proxy_profile_for_room(room_name)
    if not profile or not profile.calibrationCompletedAt or not profile.scenario:
        return None
    if has_open_prompt(room_name):
        return None

    segments = _load_final_segments(room_name)
    if not _should_process(room_name, segments):
        return None

    last_seg = segments[-1]
    trigger_text = str(last_seg.get("text") or "").strip()
    if not trigger_text:
        return None

    try:
        llm_result = evaluate_meeting_turn(profile, segments)
    except AgentLlmError:
        return None

    action = str(llm_result.get("action", "wait"))
    text = str(llm_result.get("text") or "").strip()
    source = _infer_source(profile, llm_result.get("source"))
    if action == "wait" or not text:
        return None

    now = now_iso()
    if action == "ask_proxy":
        if profile.interventionsUsed >= profile.maxInterventions:
            return None
        prompt = AgentPrompt(
            id=new_prompt_id(),
            roomName=room_name,
            participantId=profile.participantId,
            kind="proxy_question",
            text=text,
            status=AgentPromptStatus.PENDING_PROXY,
            interventionNumber=profile.interventionsUsed + 1,
            source=source,  # type: ignore[arg-type]
            createdAt=now,
            updatedAt=now,
            triggerSegmentText=trigger_text,
        )
        return save_prompt(room_name, prompt)

    if action == "draft_public":
        prompt = AgentPrompt(
            id=new_prompt_id(),
            roomName=room_name,
            participantId=profile.participantId,
            kind="public_draft",
            text=text,
            status=AgentPromptStatus.PENDING_APPROVAL,
            interventionNumber=0,
            source=source,  # type: ignore[arg-type]
            createdAt=now,
            updatedAt=now,
            triggerSegmentText=trigger_text,
        )
        return save_prompt(room_name, prompt)

    return None


def create_draft_from_proxy_reply(
    room_name: str,
    participant_id: str,
    *,
    proxy_reply: str,
    source: str,
) -> AgentPrompt:
    now = now_iso()
    prompt = AgentPrompt(
        id=new_prompt_id(),
        roomName=room_name,
        participantId=participant_id,
        kind="public_draft",
        text=proxy_reply.strip(),
        status=AgentPromptStatus.PENDING_APPROVAL,
        interventionNumber=0,
        source=source,  # type: ignore[arg-type]
        createdAt=now,
        updatedAt=now,
    )
    return save_prompt(room_name, prompt)


def dropped_question_ids(profile: AgentProfile) -> set[str]:
    if not profile.scenario or profile.droppedQuestionIndex is None:
        return set()
    scenario = load_scenario(profile.scenario)
    for i, question in enumerate(scenario.calibrationQuestions):
        if i == profile.droppedQuestionIndex:
            return {question.id}
    return set()
