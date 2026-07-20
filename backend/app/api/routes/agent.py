from __future__ import annotations

import base64
import json
import time
from typing import Any

from fastapi import APIRouter, HTTPException

from app.domain.models import (
    AgentJoinRequest,
    AgentLeaveRequest,
    AgentSpeakRequest,
    AgentSpeakTestRequest,
    AgentStatusResponse,
    Condition,
    LogEventRequest,
    Role,
)
from app.services.agent_join import join_agent_room
from app.services.agent_store import find_proxy_profile_for_room
from app.services.http_client import HttpClientError, get_json_from_bot, post_json_to_bot
from app.services.tts import TtsError, pcm_duration_ms, synthesize_speech
from app.storage.jsonl import append_jsonl, data_dir, now_iso, safe_room_slug

router = APIRouter()


def _post_json(path: str, payload: dict[str, Any], timeout: float = 10) -> dict[str, Any]:
    try:
        return post_json_to_bot(path, payload, timeout=timeout)
    except HttpClientError as exc:
        if exc.status_code is not None:
            detail = exc.body or str(exc)
            try:
                parsed = json.loads(detail) if detail else {}
            except json.JSONDecodeError:
                parsed = {"raw": detail}
            if exc.status_code == 409:
                note = parsed.get("note") if isinstance(parsed, dict) else None
                raise HTTPException(status_code=409, detail=note or parsed) from exc
            raise HTTPException(status_code=502, detail=f"Agent-bot HTTP error: {detail}") from exc
        reason = exc.reason or str(exc)
        raise HTTPException(status_code=503, detail=f"Agent-bot unavailable: {reason}") from exc


def _get_json(path: str) -> dict[str, Any]:
    try:
        return get_json_from_bot(path, timeout=10.0)
    except HttpClientError as exc:
        if exc.status_code is not None:
            detail = exc.body or str(exc)
            raise HTTPException(status_code=502, detail=f"Agent-bot HTTP error: {detail}") from exc
        reason = exc.reason or str(exc)
        raise HTTPException(status_code=503, detail=f"Agent-bot unavailable: {reason}") from exc


def _backend_event(room_name: str, event_type: str, payload: dict[str, Any]) -> LogEventRequest:
    return LogEventRequest(
        roomName=room_name,
        participantId="agent-c",
        role=Role.AGENT,
        condition=Condition.HA,
        tsMs=int(time.time() * 1000),
        eventType=event_type,
        payload={"loggedAt": now_iso(), **payload},
    )


def _events_path(room_name: str):
    return data_dir() / "events" / f"{safe_room_slug(room_name)}.events.jsonl"


def _persist_event(event: LogEventRequest) -> None:
    append_jsonl(
        _events_path(event.roomName),
        {
            "loggedAt": now_iso(),
            **event.model_dump(),
        },
    )


@router.post("/agent/join")
def agent_join(body: AgentJoinRequest) -> dict[str, Any]:
    return join_agent_room(body.roomName, body.displayName)


@router.post("/agent/leave")
def agent_leave(body: AgentLeaveRequest) -> dict[str, Any]:
    result = _post_json("/bot/leave", body.model_dump(), timeout=60)
    room_name = body.roomName or str(result.get("roomName") or "unknown-room")
    event = _backend_event(room_name, "agent.leave_requested", {})
    _persist_event(event)
    return {"status": "ok", "event": event.model_dump(), "bot": result}


@router.get("/agent/status", response_model=AgentStatusResponse)
def agent_status() -> AgentStatusResponse:
    status = _get_json("/bot/status")
    return AgentStatusResponse(
        connected=bool(status.get("connected", False)),
        roomName=status.get("roomName"),
        displayName=status.get("displayName"),
        phase=str(status.get("phase", "phase_5b")),
        mode=str(status.get("mode", "unknown")),
    )


@router.post("/agent/speak-test")
def agent_speak_test(body: AgentSpeakTestRequest) -> dict[str, Any]:
    event = _backend_event(body.roomName, "agent.speak_test_requested", {})
    _persist_event(event)
    result = _post_json("/bot/speak-test", body.model_dump(), timeout=120)
    completed = _backend_event(body.roomName, "agent.speak_test_completed", {"bot": result})
    _persist_event(completed)
    return {"status": "ok", "event": event.model_dump(), "completed": completed.model_dump(), "bot": result}


@router.post("/agent/speak")
def agent_speak(body: AgentSpeakRequest) -> dict[str, Any]:
    requested = _backend_event(
        body.roomName,
        "agent.speak_requested",
        {"text": body.text, "voiceMode": body.voiceMode},
    )
    _persist_event(requested)

    try:
        profile = find_proxy_profile_for_room(body.roomName)
        voice_gender = profile.ttsVoiceGender if profile else None
        pcm, sample_rate = synthesize_speech(
            body.text,
            voice_mode=body.voiceMode,
            voice_gender=voice_gender,
            profile=profile,
        )
    except TtsError as exc:
        failed = _backend_event(body.roomName, "agent.speak_failed", {"error": str(exc)})
        _persist_event(failed)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    duration_ms = pcm_duration_ms(pcm, sample_rate)
    started = _backend_event(
        body.roomName,
        "agent.speak_started",
        {"durationMs": duration_ms, "sampleRate": sample_rate, "voiceMode": body.voiceMode},
    )
    _persist_event(started)

    bot_payload = {
        "roomName": body.roomName,
        "audioBase64": base64.b64encode(pcm).decode("ascii"),
        "sampleRate": sample_rate,
        "durationMs": duration_ms,
        "text": body.text,
    }
    # Bridge setup + full playback; allow generous headroom over audio length.
    timeout = max(120.0, duration_ms / 1000.0 + 90.0)
    result = _post_json("/bot/speak", bot_payload, timeout=timeout)

    completed = _backend_event(
        body.roomName,
        "agent.speak_finished",
        {"text": body.text, "durationMs": duration_ms, "bot": result},
    )
    _persist_event(completed)
    return {
        "status": "ok",
        "requested": requested.model_dump(),
        "started": started.model_dump(),
        "completed": completed.model_dump(),
        "durationMs": duration_ms,
        "bot": result,
    }
