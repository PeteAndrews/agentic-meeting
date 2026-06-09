from __future__ import annotations



import base64

import binascii

import json

import re

from pathlib import Path

from typing import Any



from fastapi import APIRouter, HTTPException, Query



from app.domain.models import (

    AgentProfile,

    AgentProfileCompleteResponse,

    AgentProfileKey,

    AgentProfileUpdate,

    AgentProfileVoiceSampleRequest,

    Condition,

    LogEventRequest,

    Role,

    VoiceMode,

)

from app.services.agent_join import join_agent_room

from app.storage.jsonl import append_jsonl, data_dir, now_iso, safe_room_slug



router = APIRouter()





def _participant_slug(participant_id: str) -> str:

    slug = re.sub(r"[^a-zA-Z0-9_-]+", "_", participant_id).strip("_-")

    return slug or "participant"





def _profile_path(room_name: str, participant_id: str) -> Path:

    return (

        data_dir()

        / "agent_profiles"

        / f"{safe_room_slug(room_name)}__{_participant_slug(participant_id)}.json"

    )





def _voice_sample_path(room_name: str, participant_id: str, ext: str) -> Path:

    return (

        data_dir()

        / "voice_samples"

        / f"{safe_room_slug(room_name)}__{_participant_slug(participant_id)}.{ext}"

    )





def _load_profile(room_name: str, participant_id: str) -> AgentProfile | None:

    path = _profile_path(room_name, participant_id)

    if not path.exists():

        return None

    try:

        data = json.loads(path.read_text(encoding="utf-8"))

        return AgentProfile.model_validate(data)

    except Exception as e:  # noqa: BLE001

        raise HTTPException(status_code=500, detail=f"Invalid agent profile JSON: {e}") from e





def _save_profile(profile: AgentProfile) -> AgentProfile:

    path = _profile_path(profile.roomName, profile.participantId)

    path.parent.mkdir(parents=True, exist_ok=True)

    path.write_text(profile.model_dump_json(indent=2), encoding="utf-8")

    return profile





def _normalize_voice_mode(value: str | None) -> VoiceMode:

    if value in ("generic_tts", "cloned_voice_tts"):

        return value  # type: ignore[return-value]

    return "generic_tts"





def _default_profile(

    room_name: str,

    participant_id: str,

    voice_output_mode: VoiceMode = "generic_tts",

) -> AgentProfile:

    return AgentProfile(

        roomName=room_name,

        participantId=participant_id,

        voiceOutputMode=voice_output_mode,

        updatedAt=now_iso(),

    )





def _events_path(room_name: str) -> Path:

    return data_dir() / "events" / f"{safe_room_slug(room_name)}.events.jsonl"





def _persist_proxy_event(room_name: str, participant_id: str, event_type: str, payload: dict[str, Any]) -> None:

    event = LogEventRequest(

        roomName=room_name,

        participantId=participant_id,

        role=Role.PROXY,

        condition=Condition.HA,

        tsMs=int(__import__("time").time() * 1000),

        eventType=event_type,

        payload={"loggedAt": now_iso(), **payload},

    )

    append_jsonl(

        _events_path(room_name),

        {

            "loggedAt": now_iso(),

            **event.model_dump(),

        },

    )





@router.get("/agent-profile", response_model=AgentProfile)

def get_agent_profile(

    roomName: str = Query(min_length=1, max_length=256),

    participantId: str = Query(min_length=1, max_length=128),

    voiceOutputMode: str | None = Query(default=None),

) -> AgentProfile:

    profile = _load_profile(roomName, participantId)

    if profile:

        return profile

    return _default_profile(roomName, participantId, _normalize_voice_mode(voiceOutputMode))





@router.put("/agent-profile", response_model=AgentProfile)

def update_agent_profile(body: AgentProfileUpdate) -> AgentProfile:

    existing = _load_profile(body.roomName, body.participantId) or _default_profile(

        body.roomName, body.participantId

    )

    patch = body.model_dump(exclude_unset=True)

    patch.pop("roomName", None)

    patch.pop("participantId", None)

    merged = existing.model_copy(update={**patch, "updatedAt": now_iso()})

    saved = _save_profile(merged)

    _persist_proxy_event(

        body.roomName,

        body.participantId,

        "proxy.profile_updated",

        {"fields": sorted(k for k in patch if k != "updatedAt")},

    )

    return saved





@router.post("/agent-profile/voice-sample", response_model=AgentProfile)

def upload_voice_sample(body: AgentProfileVoiceSampleRequest) -> AgentProfile:

    try:

        audio = base64.b64decode(body.audioBase64, validate=True)

    except (binascii.Error, ValueError) as e:

        raise HTTPException(status_code=400, detail="Invalid audioBase64 payload") from e



    if len(audio) < 256:

        raise HTTPException(status_code=400, detail="Voice sample too short")

    if len(audio) > 5_000_000:

        raise HTTPException(status_code=400, detail="Voice sample too large (max 5MB)")



    ext = "webm"

    if "ogg" in body.mimeType:

        ext = "ogg"

    elif "wav" in body.mimeType:

        ext = "wav"



    path = _voice_sample_path(body.roomName, body.participantId, ext)

    path.parent.mkdir(parents=True, exist_ok=True)

    path.write_bytes(audio)



    mode = _normalize_voice_mode(body.voiceOutputMode)

    profile = _load_profile(body.roomName, body.participantId) or _default_profile(

        body.roomName, body.participantId, mode

    )

    profile = profile.model_copy(

        update={

            "voiceOutputMode": mode if body.voiceOutputMode else profile.voiceOutputMode,

            "voiceSampleStored": True,

            "updatedAt": now_iso(),

        }

    )

    saved = _save_profile(profile)

    _persist_proxy_event(

        body.roomName,

        body.participantId,

        "proxy.voice_sample_uploaded",

        {"bytes": len(audio), "mimeType": body.mimeType, "path": str(path.name)},

    )

    return saved





@router.post("/agent-profile/complete", response_model=AgentProfileCompleteResponse)

def complete_calibration(body: AgentProfileKey) -> AgentProfileCompleteResponse:

    profile = _load_profile(body.roomName, body.participantId) or _default_profile(

        body.roomName, body.participantId

    )



    if profile.voiceOutputMode == "cloned_voice_tts" and not profile.voiceSampleStored:

        raise HTTPException(

            status_code=400,

            detail="Voice sample required before completing onboarding (cloned_voice_tts)",

        )



    completed = profile.model_copy(

        update={

            "calibrationCompletedAt": now_iso(),

            "updatedAt": now_iso(),

        }

    )

    saved = _save_profile(completed)

    _persist_proxy_event(

        body.roomName,

        body.participantId,

        "proxy.calibration_completed",

        {

            "voiceOutputMode": saved.voiceOutputMode,

            "voiceSampleStored": saved.voiceSampleStored,

        },

    )



    agent_join_ok = False

    agent_join_error: str | None = None

    agent_join: dict[str, Any] | None = None

    try:

        agent_join = join_agent_room(body.roomName)

        agent_join_ok = True

        _persist_proxy_event(

            body.roomName,

            body.participantId,

            "proxy.agent_auto_joined",

            {"status": "ok"},

        )

    except HTTPException as exc:

        agent_join_error = str(exc.detail)

        _persist_proxy_event(

            body.roomName,

            body.participantId,

            "proxy.agent_auto_join_failed",

            {"error": agent_join_error},

        )

    except Exception as exc:  # noqa: BLE001

        agent_join_error = str(exc)

        _persist_proxy_event(

            body.roomName,

            body.participantId,

            "proxy.agent_auto_join_failed",

            {"error": agent_join_error},

        )



    return AgentProfileCompleteResponse(

        profile=saved,

        agentJoinOk=agent_join_ok,

        agentJoinError=agent_join_error,

        agentJoin=agent_join,

    )

