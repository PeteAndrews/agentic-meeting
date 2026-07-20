from __future__ import annotations

import logging
import threading
import time
from typing import Any, Literal

from app.domain.models import AgentProfile, AgentPrompt, AgentPromptStatus, Condition, LogEventRequest, Role
from app.services.agent_llm import (
    AgentLlmError,
    evaluate_meeting_turn,
    format_calibration_speech,
    format_meeting_acknowledgment,
    format_proxy_console_message,
    format_proxy_reply_speech,
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
from app.services.agent_speak import AgentSpeakError, speak_for_profile, start_thinking, stop_thinking
from app.services.agent_trigger import match_trigger, resolve_trigger_phrases
from app.services.scenario_loader import load_scenario
from app.storage.jsonl import now_iso, read_jsonl, safe_room_slug
from app.storage.jsonl import data_dir

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_last_processed: dict[str, str] = {}
_room_locks: dict[str, threading.Lock] = {}
_room_locks_guard = threading.Lock()

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
        tsMs=int(time.time() * 1000),
        eventType=event_type,
        payload={"loggedAt": now_iso(), **payload},
    )
    append_jsonl(_events_path(room_name), {"loggedAt": now_iso(), **event.model_dump()})


def _load_final_segments(room_name: str) -> list[dict[str, Any]]:
    rows = read_jsonl(_segments_path(room_name))
    final = [r for r in rows if r.get("isFinal") is True]
    final.sort(key=lambda s: (int(s.get("startMs", 0)), int(s.get("endMs", 0))))
    return final


def _segment_signature(segments: list[dict[str, Any]]) -> str:
    if not segments:
        return "0"
    last = segments[-1]
    return "|".join(
        [
            str(len(segments)),
            str(last.get("participantId") or ""),
            str(last.get("text") or ""),
            str(last.get("endMs") or ""),
        ]
    )


def _room_lock(room_name: str) -> threading.Lock:
    with _room_locks_guard:
        lock = _room_locks.get(room_name)
        if lock is None:
            lock = threading.Lock()
            _room_locks[room_name] = lock
        return lock


def _start_thinking_async(room_name: str) -> None:
    """Fire ambient thinking without blocking the agent-loop LLM/TTS path."""
    threading.Thread(
        target=start_thinking,
        args=(room_name,),
        name=f"thinking-start-{safe_room_slug(room_name)}",
        daemon=True,
    ).start()


def _already_processed(room_name: str, segments: list[dict[str, Any]]) -> bool:
    if len(segments) < 1:
        return True
    signature = _segment_signature(segments)
    with _lock:
        return _last_processed.get(room_name) == signature


def _mark_processed(room_name: str, segments: list[dict[str, Any]]) -> None:
    if len(segments) < 1:
        return
    signature = _segment_signature(segments)
    with _lock:
        _last_processed[room_name] = signature


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
) -> AgentPrompt | None:
    if profile.interventionsUsed >= profile.maxInterventions:
        _persist_agent_event(
            room_name,
            "agent.intervention_cap_reached",
            {
                "interventionsUsed": profile.interventionsUsed,
                "maxInterventions": profile.maxInterventions,
                "participantId": profile.participantId,
            },
        )
        return None

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
    saved = save_prompt(room_name, prompt)
    return saved


def process_transcript_update(room_name: str) -> AgentPrompt | None:
    with _room_lock(room_name):
        return _process_transcript_update(room_name)


def _process_transcript_update(room_name: str) -> AgentPrompt | None:
    profile = find_proxy_profile_for_room(room_name)
    if not profile:
        logger.info(
            "Echo skipped transcript for %s: no completed proxy profile is available",
            room_name,
        )
        _persist_agent_event(room_name, "agent.loop_skipped", {"reason": "no_completed_proxy_profile"})
        return None
    if not profile.scenario:
        logger.info(
            "Echo skipped transcript for %s: profile %s has no scenario",
            room_name,
            profile.participantId,
        )
        _persist_agent_event(
            room_name,
            "agent.loop_skipped",
            {"reason": "profile_missing_scenario", "participantId": profile.participantId},
        )
        return None
    if not profile.calibrationCompletedAt:
        logger.info(
            "Echo skipped transcript for %s: profile %s has not completed onboarding",
            room_name,
            profile.participantId,
        )
        _persist_agent_event(
            room_name,
            "agent.loop_skipped",
            {"reason": "onboarding_incomplete", "participantId": profile.participantId},
        )
        return None
    if has_open_prompt(room_name):
        logger.info("Echo skipped transcript for %s: a proxy prompt is already open", room_name)
        _persist_agent_event(room_name, "agent.loop_skipped", {"reason": "prompt_already_open"})
        return None

    segments = _load_final_segments(room_name)
    if _already_processed(room_name, segments):
        logger.debug("Echo skipped transcript for %s: segment already processed", room_name)
        return None

    last_seg = segments[-1]
    trigger_text = str(last_seg.get("text") or "").strip()
    if not trigger_text:
        logger.info("Echo skipped transcript for %s: final segment is empty", room_name)
        return None

    phrases = resolve_trigger_phrases(profile)
    matched_phrase = match_trigger(trigger_text, phrases)
    if not matched_phrase:
        logger.info(
            "Echo trigger missed in %s: %r (expected one of %s)",
            room_name,
            trigger_text,
            phrases,
        )
        _persist_agent_event(
            room_name,
            "agent.trigger_missed",
            {
                "text": trigger_text,
                "phrases": phrases,
                "participantId": last_seg.get("participantId"),
            },
        )
        _mark_processed(room_name, segments)
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
    logger.info(
        "Echo trigger detected in %s: %r matched %r",
        room_name,
        trigger_text,
        matched_phrase,
    )
    _start_thinking_async(room_name)

    result: AgentPrompt | None = None
    try:
        result = _handle_triggered_turn(
            room_name,
            profile,
            segments=segments,
            trigger_text=trigger_text,
            matched_phrase=matched_phrase,
        )
        return result
    finally:
        waiting_for_proxy = (
            result is not None
            and result.kind == "proxy_question"
            and result.status == AgentPromptStatus.PENDING_PROXY
        )
        if not waiting_for_proxy:
            stop_thinking(room_name)


def _handle_triggered_turn(
    room_name: str,
    profile: AgentProfile,
    *,
    segments: list[dict[str, Any]],
    trigger_text: str,
    matched_phrase: str,
) -> AgentPrompt | None:
    now = now_iso()
    recap_intent = classify_recap_intent(trigger_text)
    if recap_intent == "repeat_last":
        last_spoken = find_last_spoken_text(room_name)
        spoken = (
            f"Sure — I said: {last_spoken}"
            if last_spoken
            else "I haven't said anything in this meeting yet."
        )
        result = _auto_speak_prompt(
            room_name,
            profile,
            spoken=spoken,
            trigger_text=trigger_text,
            source="meeting_recap",
            now=now,
            event_payload={"recapKind": "repeat_last", "matchedPhrase": matched_phrase},
        )
        if result is not None:
            _mark_processed(room_name, segments)
        return result

    if recap_intent == "summarize":
        spoken = summarize_meeting_so_far(
            profile,
            segments,
            trigger_index=len(segments) - 1,
        )
        result = _auto_speak_prompt(
            room_name,
            profile,
            spoken=spoken,
            trigger_text=trigger_text,
            source="meeting_recap",
            now=now,
            event_payload={"recapKind": "summarize", "matchedPhrase": matched_phrase},
        )
        if result is not None:
            _mark_processed(room_name, segments)
        return result

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
            "matchedPhrase": matched_phrase,
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
        result = _auto_speak_prompt(
            room_name,
            profile,
            spoken=spoken,
            trigger_text=trigger_text,
            source="known_calibration",
            now=now,
            event_payload=event_payload,
        )
        if result is not None:
            _mark_processed(room_name, segments)
        return result

    meta_reply = find_meeting_meta_reply(trigger_text)
    if meta_reply:
        result = _auto_speak_prompt(
            room_name,
            profile,
            spoken=meta_reply,
            trigger_text=trigger_text,
            source="meeting_meta",
            now=now,
            event_payload={"metaKind": "deterministic", "matchedPhrase": matched_phrase},
        )
        if result is not None:
            _mark_processed(room_name, segments)
        return result

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
        result = _submit_proxy_question(
            room_name,
            profile,
            trigger_text=trigger_text,
            console_detail="How would you like me to answer this in the meeting?",
            source="novel_topic",
            reason="Routing could not run; please reply so Echo can respond.",
            now=now,
        )
        _mark_processed(room_name, segments)
        return result

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
        _mark_processed(room_name, segments)
        return None

    if action == "draft_public" and source in ("known_calibration", "meeting_meta"):
        result = _auto_speak_prompt(
            room_name,
            profile,
            spoken=text,
            trigger_text=trigger_text,
            source=source,  # type: ignore[arg-type]
            now=now,
            event_payload={"metaKind": "llm", "matchedPhrase": matched_phrase},
        )
        if result is not None:
            _mark_processed(room_name, segments)
        return result

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
        _mark_processed(room_name, segments)
        return None

    result = _submit_proxy_question(
        room_name,
        profile,
        trigger_text=trigger_text,
        console_detail=text,
        source=source,
        reason=reason,
        now=now,
    )
    _mark_processed(room_name, segments)
    return result


def _trigger_segment_index(
    segments: list[dict[str, Any]],
    trigger_segment_text: str | None,
) -> int | None:
    if not segments:
        return None
    if trigger_segment_text:
        target = trigger_segment_text.strip()
        for i, seg in enumerate(segments):
            if str(seg.get("text") or "").strip() == target:
                return i
    return len(segments) - 1


def create_draft_from_proxy_reply(
    room_name: str,
    profile: AgentProfile,
    *,
    proxy_reply: str,
    source: str,
    trigger_segment_text: str | None = None,
    status: AgentPromptStatus = AgentPromptStatus.PENDING_APPROVAL,
) -> AgentPrompt:
    segments = _load_final_segments(room_name)
    spoken = format_proxy_reply_speech(
        profile,
        trigger_text=trigger_segment_text or "",
        proxy_reply=proxy_reply,
        segments=segments,
        trigger_index=_trigger_segment_index(segments, trigger_segment_text),
    )
    now = now_iso()
    prompt = AgentPrompt(
        id=new_prompt_id(),
        roomName=room_name,
        participantId=profile.participantId,
        kind="public_draft",
        text=spoken.strip(),
        status=status,
        interventionNumber=0,
        source=source,  # type: ignore[arg-type]
        createdAt=now,
        updatedAt=now,
        triggerSegmentText=trigger_segment_text,
    )
    return save_prompt(room_name, prompt)
