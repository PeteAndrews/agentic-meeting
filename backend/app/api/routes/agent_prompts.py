from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.domain.models import (
    AgentPrompt,
    AgentPromptEditRequest,
    AgentPromptRespondRequest,
    AgentPromptStatus,
    Condition,
    LogEventRequest,
    Role,
)
from app.services.agent_store import (
    find_proxy_profile_for_room,
    load_profile,
    load_prompts,
    save_profile,
    update_prompt,
)
from app.services.agent_loop import create_draft_from_proxy_reply
from app.services.agent_speak import AgentSpeakError, speak_for_profile, speak_in_room
from app.storage.jsonl import append_jsonl, data_dir, now_iso, safe_room_slug

router = APIRouter()


def _agent_bot_base_url() -> str:
    return os.environ.get("AGENT_BOT_BASE_URL", "http://127.0.0.1:3001").rstrip("/")


def _post_json(path: str, payload: dict[str, Any], timeout: float = 10) -> dict[str, Any]:
    url = f"{_agent_bot_base_url()}{path}"
    req = urllib.request.Request(
        url=url,
        method="POST",
        headers={"Content-Type": "application/json"},
        data=json.dumps(payload).encode("utf-8"),
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            content = resp.read().decode("utf-8")
            return json.loads(content) if content else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8") or str(exc)
        raise HTTPException(status_code=502, detail=f"Agent-bot HTTP error: {detail}") from exc
    except urllib.error.URLError as exc:
        raise HTTPException(status_code=503, detail=f"Agent-bot unavailable: {exc.reason}") from exc


def _events_path(room_name: str):
    return data_dir() / "events" / f"{safe_room_slug(room_name)}.events.jsonl"


def _persist_event(room_name: str, event_type: str, payload: dict[str, Any]) -> None:
    event = LogEventRequest(
        roomName=room_name,
        participantId="agent-c",
        role=Role.AGENT,
        condition=Condition.HA,
        tsMs=int(__import__("time").time() * 1000),
        eventType=event_type,
        payload={"loggedAt": now_iso(), **payload},
    )
    append_jsonl(_events_path(room_name), {"loggedAt": now_iso(), **event.model_dump()})


def _get_prompt(room_name: str, prompt_id: str) -> AgentPrompt:
    for prompt in load_prompts(room_name):
        if prompt.id == prompt_id:
            return prompt
    raise HTTPException(status_code=404, detail="Prompt not found")


def _speak_approved_text(
    room_name: str,
    text: str,
    voice_mode: str,
    voice_gender: str | None = None,
) -> None:
    try:
        speak_in_room(
            room_name,
            text,
            voice_mode=voice_mode,  # type: ignore[arg-type]
            voice_gender=voice_gender,  # type: ignore[arg-type]
        )
    except AgentSpeakError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/agent/prompts")
def list_agent_prompts(
    roomName: str = Query(min_length=1, max_length=256),
    participantId: str | None = Query(default=None),
) -> dict[str, Any]:
    prompts = load_prompts(roomName)
    if participantId:
        prompts = [p for p in prompts if p.participantId == participantId]
    prompts.sort(key=lambda p: p.createdAt)
    return {"roomName": roomName, "prompts": [p.model_dump() for p in prompts]}


@router.post("/agent/prompts/{prompt_id}/respond")
def respond_to_prompt(prompt_id: str, body: AgentPromptRespondRequest, roomName: str = Query(min_length=1)) -> dict[str, Any]:
    prompt = _get_prompt(roomName, prompt_id)
    if prompt.status != AgentPromptStatus.PENDING_PROXY:
        raise HTTPException(status_code=400, detail="Prompt is not awaiting proxy response")

    profile = load_profile(roomName, prompt.participantId)
    if not profile:
        raise HTTPException(status_code=404, detail="Agent profile not found")

    updated = update_prompt(
        roomName,
        prompt_id,
        status=AgentPromptStatus.APPROVED,
        text=body.text,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Prompt not found")

    profile = profile.model_copy(
        update={
            "interventionsUsed": profile.interventionsUsed + 1,
            "updatedAt": now_iso(),
        }
    )
    save_profile(profile)

    draft = create_draft_from_proxy_reply(
        roomName,
        profile,
        proxy_reply=body.text,
        source=prompt.source,
        trigger_segment_text=prompt.triggerSegmentText,
    )
    _persist_event(
        roomName,
        "agent.prompt_proxy_answered",
        {
            "promptId": prompt_id,
            "draftId": draft.id,
            "rawReply": body.text,
            "polishedReply": draft.text,
        },
    )
    return {"status": "ok", "prompt": updated.model_dump(), "draft": draft.model_dump()}


@router.post("/agent/prompts/{prompt_id}/approve")
def approve_prompt(prompt_id: str, roomName: str = Query(min_length=1)) -> dict[str, Any]:
    prompt = _get_prompt(roomName, prompt_id)
    if prompt.status != AgentPromptStatus.PENDING_APPROVAL:
        raise HTTPException(status_code=400, detail="Prompt is not awaiting approval")

    profile = load_proxy_profile(roomName, prompt.participantId)
    voice_mode = profile.voiceOutputMode if profile else "generic_tts"
    voice_gender = profile.ttsVoiceGender if profile else None

    _speak_approved_text(roomName, prompt.text, voice_mode, voice_gender)
    updated = update_prompt(roomName, prompt_id, status=AgentPromptStatus.SPOKEN)
    _persist_event(roomName, "agent.prompt_approved", {"promptId": prompt_id, "text": prompt.text})
    return {"status": "ok", "prompt": updated.model_dump() if updated else None}


@router.post("/agent/prompts/{prompt_id}/edit")
def edit_and_approve_prompt(
    prompt_id: str,
    body: AgentPromptEditRequest,
    roomName: str = Query(min_length=1),
) -> dict[str, Any]:
    prompt = _get_prompt(roomName, prompt_id)
    if prompt.status != AgentPromptStatus.PENDING_APPROVAL:
        raise HTTPException(status_code=400, detail="Prompt is not awaiting approval")

    profile = load_proxy_profile(roomName, prompt.participantId)
    voice_mode = profile.voiceOutputMode if profile else "generic_tts"
    voice_gender = profile.ttsVoiceGender if profile else None

    _speak_approved_text(roomName, body.text, voice_mode, voice_gender)
    updated = update_prompt(roomName, prompt_id, status=AgentPromptStatus.SPOKEN, text=body.text)
    _persist_event(roomName, "agent.prompt_edited", {"promptId": prompt_id, "text": body.text})
    return {"status": "ok", "prompt": updated.model_dump() if updated else None}


@router.post("/agent/prompts/{prompt_id}/reject")
def reject_prompt(prompt_id: str, roomName: str = Query(min_length=1)) -> dict[str, Any]:
    prompt = _get_prompt(roomName, prompt_id)
    if prompt.status != AgentPromptStatus.PENDING_APPROVAL:
        raise HTTPException(status_code=400, detail="Prompt is not awaiting approval")
    updated = update_prompt(roomName, prompt_id, status=AgentPromptStatus.REJECTED)
    _persist_event(roomName, "agent.prompt_rejected", {"promptId": prompt_id})
    return {"status": "ok", "prompt": updated.model_dump() if updated else None}


def load_proxy_profile(room_name: str, participant_id: str):
    profile = load_profile(room_name, participant_id)
    if profile:
        return profile
    return find_proxy_profile_for_room(room_name)
