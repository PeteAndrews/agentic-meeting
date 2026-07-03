from __future__ import annotations

import threading
from typing import Any, Literal

from app.domain.models import AgentProfile, AgentPrompt, AgentPromptStatus, Condition, LogEventRequest, Role
from app.services.agent_llm import (
    AgentLlmError,
    evaluate_meeting_turn,
    format_calibration_speech,
    format_meeting_acknowledgment,
    format_proxy_console_message,
    summarize_meeting_so_far,
)
from app.services.agent_store import (
    find_last_spoken_text,
    find_proxy_profile_for_room,
    has_open_prompt,
    new_prompt_id,
    save_prompt,
)
from app.services.calibration_matcher import resolve_calibration_answer
from app.services.meeting_meta_matcher import find_meeting_meta_reply
from app.services.meeting_recap_matcher import classify_recap_intent
from app.services.agent_speak import AgentSpeakError, speak_for_profile
from app.services.agent_trigger import match_trigger, resolve_trigger_phrases
from app.services.scenario_loader import load_scenario
from app.storage.jsonl import now_iso, read_jsonl, safe_room_slug
from app.storage.jsonl import data_dir

_lock = threading.Lock()
_last_processed: dict[str, int] = {}

AutoSpeakSource = Literal["known_calibration", "meeting_meta", "meeting_recap"]


def _segments_path(room_name: str):
    return data_dir() / "transcripts" / f"{safe_room_slug(room_name)}.segments.jsonl"


def _events_path(room_name: str):
    return data_dir() / "events" / f"{safe_room_slug(room_name)}.events.jsonl"


def _persist_agent_event(room_name: str, event_type: str, payload: dict[str, Any]) -> None:
    from app.storage.jsonl import append_jsonl

    event = LogEventRequest(
        roomName=room_name,
        participantId="echo",
        role=Role.AGENT,
        condition=Condition.HA,
        tsMs=int(__import__("time").time() * 1000),
        eventType=event_type,
        payload={"loggedAt": now_iso(), **payload},
    )
    append_jsonl(_events_path(room_name), {"loggedAt": now_iso(), **event.model_dump()})


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
    if llm_source in (
        "missing_calibration",
        "novel_topic",
        "moderator_disagreement",
        "known_calibration",
        "meeting_meta",
        "meeting_recap",
    ):
        return llm_source
    return "novel_topic"


def _auto_speak_prompt(
    room_name: str,
    profile: AgentProfile,
    *,
    spoken: str,
    trigger_text: str,
    source: AutoSpeakSource,
    now: str,
    event_payload: dict[str, Any] | None = None,
) -> AgentPrompt | None:
    try:
        duration_ms = speak_for_profile(room_name, profile, spoken)
    except AgentSpeakError as exc:
        _persist_agent_event(
            room_name,
            "agent.speak_failed",
            {"error": str(exc), "text": spoken, "participantId": profile.participantId},
        )
        return None

    prompt = AgentPrompt(
        id=new_prompt_id(),
        roomName=room_name,
        participantId=profile.participantId,
        kind="public_draft",
        text=spoken,
        status=AgentPromptStatus.SPOKEN,
        interventionNumber=0,
        source=source,  # type: ignore[arg-type]
        createdAt=now,
        updatedAt=now,
        triggerSegmentText=trigger_text,
    )
    saved = save_prompt(room_name, prompt)
    _persist_agent_event(
        room_name,
        "agent.auto_spoken",
        {
            "text": spoken,
            "durationMs": duration_ms,
            "promptId": saved.id,
            "source": source,
            "participantId": profile.participantId,
            **(event_payload or {}),
        },
    )
    return saved


def _submit_proxy_question(
    room_name: str,
    profile: AgentProfile,
    *,
    trigger_text: str,
    console_detail: str,
    source: str,
    reason: str | None,
    now: str,
) -> AgentPrompt:
    ack = format_meeting_acknowledgment(profile)
    try:
        ack_duration_ms = speak_for_profile(room_name, profile, ack)
        _persist_agent_event(
            room_name,
            "agent.ack_spoken",
            {
                "text": ack,
                "durationMs": ack_duration_ms,
                "participantId": profile.participantId,
            },
        )
    except AgentSpeakError as exc:
        _persist_agent_event(
            room_name,
            "agent.ack_speak_failed",
            {"error": str(exc), "text": ack, "participantId": profile.participantId},
        )

    proxy_text = format_proxy_console_message(trigger_text, console_detail, reason=reason)
    prompt = AgentPrompt(
        id=new_prompt_id(),
        roomName=room_name,
        participantId=profile.participantId,
        kind="proxy_question",
        text=proxy_text,
        status=AgentPromptStatus.PENDING_PROXY,
        interventionNumber=profile.interventionsUsed + 1,
        source=source,  # type: ignore[arg-type]
        createdAt=now,
        updatedAt=now,
        triggerSegmentText=trigger_text,
    )
    return save_prompt(room_name, prompt)


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

    phrases = resolve_trigger_phrases(profile)
    matched_phrase = match_trigger(trigger_text, phrases)
    if not matched_phrase:
        _persist_agent_event(
            room_name,
            "agent.trigger_missed",
            {
                "text": trigger_text,
                "phrases": phrases,
                "participantId": last_seg.get("participantId"),
            },
        )
        return None

    _persist_agent_event(
        room_name,
        "agent.trigger_detected",
        {
            "text": trigger_text,
            "phrases": phrases,
            "matchedPhrase": matched_phrase,
            "participantId": last_seg.get("participantId"),
        },
    )

    now = now_iso()
    calibration_hit = resolve_calibration_answer(profile, trigger_text)
    if calibration_hit:
        question, answer, match_method = calibration_hit
        try:
            spoken = format_calibration_speech(
                profile,
                trigger_text=trigger_text,
                question_text=question.text,
                raw_answer=answer,
                question_id=question.id,
                segments=segments,
                trigger_index=len(segments) - 1,
            )
        except AgentLlmError:
            spoken = answer
        event_payload: dict[str, Any] = {
            "rawAnswer": answer,
            "calibrationQuestionId": question.id,
            "matchMethod": match_method,
        }
        if match_method == "semantic":
            _persist_agent_event(
                room_name,
                "agent.calibration_semantic_match",
                {
                    "text": trigger_text,
                    "questionId": question.id,
                    "participantId": profile.participantId,
                },
            )
        return _auto_speak_prompt(
            room_name,
            profile,
            spoken=spoken,
            trigger_text=trigger_text,
            source="known_calibration",
            now=now,
            event_payload=event_payload,
        )

    recap_intent = classify_recap_intent(trigger_text)
    if recap_intent == "repeat_last":
        last_spoken = find_last_spoken_text(room_name)
        spoken = (
            f"Sure — I said: {last_spoken}"
            if last_spoken
            else "I haven't said anything in this meeting yet."
        )
        return _auto_speak_prompt(
            room_name,
            profile,
            spoken=spoken,
            trigger_text=trigger_text,
            source="meeting_recap",
            now=now,
            event_payload={"recapKind": "repeat_last"},
        )

    if recap_intent == "summarize":
        spoken = summarize_meeting_so_far(
            profile,
            segments,
            trigger_index=len(segments) - 1,
        )
        return _auto_speak_prompt(
            room_name,
            profile,
            spoken=spoken,
            trigger_text=trigger_text,
            source="meeting_recap",
            now=now,
            event_payload={"recapKind": "summarize"},
        )

    meta_reply = find_meeting_meta_reply(trigger_text)
    if meta_reply:
        return _auto_speak_prompt(
            room_name,
            profile,
            spoken=meta_reply,
            trigger_text=trigger_text,
            source="meeting_meta",
            now=now,
            event_payload={"metaKind": "deterministic"},
        )

    try:
        llm_result = evaluate_meeting_turn(
            profile,
            segments,
            trigger_index=len(segments) - 1,
            wake_phrase_detected=True,
        )
    except AgentLlmError as exc:
        _persist_agent_event(
            room_name,
            "agent.llm_error",
            {"error": str(exc), "participantId": profile.participantId},
        )
        return _submit_proxy_question(
            room_name,
            profile,
            trigger_text=trigger_text,
            console_detail="How would you like me to answer this in the meeting?",
            source="novel_topic",
            reason="Routing could not run; please reply so Echo can respond.",
            now=now,
        )

    action = str(llm_result.get("action", "wait"))
    text = str(llm_result.get("text") or "").strip()
    source = _infer_source(profile, llm_result.get("source"))
    reason = str(llm_result.get("reason") or "").strip() or None

    if action == "wait" or not text:
        _persist_agent_event(
            room_name,
            "agent.llm_wait",
            {
                "action": action,
                "reason": llm_result.get("reason"),
                "participantId": profile.participantId,
            },
        )
        return None

    if action == "draft_public" and source in ("known_calibration", "meeting_meta"):
        return _auto_speak_prompt(
            room_name,
            profile,
            spoken=text,
            trigger_text=trigger_text,
            source=source,  # type: ignore[arg-type]
            now=now,
            event_payload={"metaKind": "llm"},
        )

    if action == "draft_public":
        source = "novel_topic"

    if action != "ask_proxy":
        _persist_agent_event(
            room_name,
            "agent.llm_wait",
            {
                "action": action,
                "reason": llm_result.get("reason"),
                "participantId": profile.participantId,
            },
        )
        return None

    return _submit_proxy_question(
        room_name,
        profile,
        trigger_text=trigger_text,
        console_detail=text,
        source=source,
        reason=reason,
        now=now,
    )


def create_draft_from_proxy_reply(
    room_name: str,
    participant_id: str,
    *,
    proxy_reply: str,
    source: str,
    trigger_segment_text: str | None = None,
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
        triggerSegmentText=trigger_segment_text,
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
