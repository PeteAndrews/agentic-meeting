from __future__ import annotations

import base64
import binascii
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
    CalibrationAnswerRequest,
    CalibrationPlanResponse,
    CalibrationQuestionView,
    Condition,
    LogEventRequest,
    Role,
    VoiceMode,
)
from app.services.agent_join import join_agent_room
from app.services.agent_llm import calibration_complete
from app.services.agent_store import load_profile, save_profile
from app.services.scenario_loader import load_scenario, questions_for_calibration
from app.services.tts import TtsError
from app.services.tts_f5 import ensure_ref_wav, resolve_ref_text
from app.storage.jsonl import append_jsonl, data_dir, now_iso, safe_room_slug

router = APIRouter()


def _participant_slug(participant_id: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "_", participant_id).strip("_-")
    return slug or "participant"


def _voice_sample_path(room_name: str, participant_id: str, ext: str) -> Path:
    return (
        data_dir()
        / "voice_samples"
        / f"{safe_room_slug(room_name)}__{_participant_slug(participant_id)}.{ext}"
    )


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
    append_jsonl(_events_path(room_name), {"loggedAt": now_iso(), **event.model_dump()})


def _init_scenario_from_query(
    profile: AgentProfile,
    *,
    scenario: str | None,
    drop_index: int | None,
    max_interventions: int | None,
    agent_trigger_phrases: list[str] | None = None,
    agent_display_name: str | None = None,
    tts_voice_gender: str | None = None,
) -> AgentProfile:
    patch: dict[str, Any] = {"updatedAt": now_iso()}
    if scenario and not profile.scenario:
        patch["scenario"] = scenario
        load_scenario(scenario)
    if drop_index is not None and profile.droppedQuestionIndex is None:
        patch["droppedQuestionIndex"] = drop_index
    if max_interventions is not None:
        patch["maxInterventions"] = max_interventions
    if agent_trigger_phrases:
        patch["agentTriggerPhrases"] = agent_trigger_phrases
    if agent_display_name:
        patch["agentDisplayName"] = agent_display_name
    if tts_voice_gender in ("male", "female"):
        patch["ttsVoiceGender"] = tts_voice_gender
    if len(patch) == 1:
        return profile
    return profile.model_copy(update=patch)


def _build_calibration_plan(profile: AgentProfile) -> CalibrationPlanResponse:
    if not profile.scenario:
        raise HTTPException(status_code=400, detail="No scenario assigned to profile")
    scenario = load_scenario(profile.scenario)
    active_questions = questions_for_calibration(scenario, drop_index=profile.droppedQuestionIndex)
    views = [
        CalibrationQuestionView(
            id=q.id,
            text=q.text,
            index=next(i for i, sq in enumerate(scenario.calibrationQuestions) if sq.id == q.id),
        )
        for q in active_questions
    ]
    answered = [qid for qid in profile.calibrationAnswers if profile.calibrationAnswers[qid].strip()]
    return CalibrationPlanResponse(
        scenario=scenario.id,
        displayName=scenario.displayName,
        droppedQuestionIndex=profile.droppedQuestionIndex,
        questions=views,
        answeredQuestionIds=answered,
        complete=calibration_complete(profile, scenario.id),
    )


@router.get("/agent-profile", response_model=AgentProfile)
def get_agent_profile(
    roomName: str = Query(min_length=1, max_length=256),
    participantId: str = Query(min_length=1, max_length=128),
    voiceOutputMode: str | None = Query(default=None),
    scenario: str | None = Query(default=None),
    calibrationDropQuestionIndex: int | None = Query(default=None, ge=0, le=20),
    maxInterventions: int | None = Query(default=None, ge=1, le=9999),
    agentTriggerPhrases: str | None = Query(default=None),
    agentDisplayName: str | None = Query(default=None),
    ttsVoiceGender: str | None = Query(default=None),
) -> AgentProfile:
    trigger_phrases: list[str] | None = None
    if agentTriggerPhrases:
        trigger_phrases = [p.strip() for p in agentTriggerPhrases.split(",") if p.strip()]

    profile = load_profile(roomName, participantId)
    if profile:
        updated = _init_scenario_from_query(
            profile,
            scenario=scenario,
            drop_index=calibrationDropQuestionIndex,
            max_interventions=maxInterventions,
            agent_trigger_phrases=trigger_phrases,
            agent_display_name=agentDisplayName,
            tts_voice_gender=ttsVoiceGender,
        )
        if updated != profile:
            profile = save_profile(updated)
        return profile

    created = _default_profile(roomName, participantId, _normalize_voice_mode(voiceOutputMode))
    created = _init_scenario_from_query(
        created,
        scenario=scenario,
        drop_index=calibrationDropQuestionIndex,
        max_interventions=maxInterventions,
        agent_trigger_phrases=trigger_phrases,
        agent_display_name=agentDisplayName,
        tts_voice_gender=ttsVoiceGender,
    )
    return save_profile(created)


@router.put("/agent-profile", response_model=AgentProfile)
def update_agent_profile(body: AgentProfileUpdate) -> AgentProfile:
    existing = load_profile(body.roomName, body.participantId) or _default_profile(
        body.roomName, body.participantId
    )
    patch = body.model_dump(exclude_unset=True)
    patch.pop("roomName", None)
    patch.pop("participantId", None)
    if patch.get("scenario"):
        load_scenario(str(patch["scenario"]))
    merged = existing.model_copy(update={**patch, "updatedAt": now_iso()})
    saved = save_profile(merged)
    _persist_proxy_event(
        body.roomName,
        body.participantId,
        "proxy.profile_updated",
        {"fields": sorted(k for k in patch if k != "updatedAt")},
    )
    return saved


@router.get("/agent-profile/calibration-plan", response_model=CalibrationPlanResponse)
def get_calibration_plan(
    roomName: str = Query(min_length=1, max_length=256),
    participantId: str = Query(min_length=1, max_length=128),
    scenario: str | None = Query(default=None),
    calibrationDropQuestionIndex: int | None = Query(default=None, ge=0, le=20),
    maxInterventions: int | None = Query(default=None, ge=1, le=9999),
    agentTriggerPhrases: str | None = Query(default=None),
    agentDisplayName: str | None = Query(default=None),
    ttsVoiceGender: str | None = Query(default=None),
) -> CalibrationPlanResponse:
    trigger_phrases: list[str] | None = None
    if agentTriggerPhrases:
        trigger_phrases = [p.strip() for p in agentTriggerPhrases.split(",") if p.strip()]

    profile = load_profile(roomName, participantId) or _default_profile(roomName, participantId)
    profile = _init_scenario_from_query(
        profile,
        scenario=scenario,
        drop_index=calibrationDropQuestionIndex,
        max_interventions=maxInterventions,
        agent_trigger_phrases=trigger_phrases,
        agent_display_name=agentDisplayName,
        tts_voice_gender=ttsVoiceGender,
    )
    profile = save_profile(profile)
    if profile.droppedQuestionIndex is not None:
        _persist_proxy_event(
            roomName,
            participantId,
            "proxy.calibration_question_dropped",
            {"index": profile.droppedQuestionIndex},
        )
    return _build_calibration_plan(profile)


@router.post("/agent-profile/calibration-answer", response_model=AgentProfile)
def save_calibration_answer(body: CalibrationAnswerRequest) -> AgentProfile:
    profile = load_profile(body.roomName, body.participantId)
    if not profile or not profile.scenario:
        raise HTTPException(status_code=400, detail="Profile or scenario not initialized")

    scenario = load_scenario(profile.scenario)
    allowed_ids = {q.id for q in questions_for_calibration(scenario, drop_index=profile.droppedQuestionIndex)}
    if body.questionId not in allowed_ids:
        raise HTTPException(status_code=400, detail="Question is not part of this calibration plan")

    answers = dict(profile.calibrationAnswers)
    answers[body.questionId] = body.answer.strip()
    saved = save_profile(
        profile.model_copy(update={"calibrationAnswers": answers, "updatedAt": now_iso()})
    )
    _persist_proxy_event(
        body.roomName,
        body.participantId,
        "proxy.calibration_answer_saved",
        {"questionId": body.questionId},
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

    # Always rebuild the WAV cache for an uploaded sample. Browser recordings
    # can overwrite the WebM within the same timestamp resolution as its cache;
    # relying on mtime would then leave F5 using stale, shorter audio.
    try:
        ensure_ref_wav(path, force_rebuild=True)
    except TtsError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not process voice sample: {exc}",
        ) from exc

    mode = _normalize_voice_mode(body.voiceOutputMode)
    profile = load_profile(body.roomName, body.participantId) or _default_profile(
        body.roomName, body.participantId, mode
    )
    # Use the scripted passage the participant was asked to read (matches typical recording).
    ref_text = resolve_ref_text(profile.model_copy(update={"voiceSampleRefText": None}))
    profile = profile.model_copy(
        update={
            "voiceOutputMode": mode if body.voiceOutputMode else profile.voiceOutputMode,
            "voiceSampleStored": True,
            "voiceSamplePath": path.name,
            "voiceSampleRefText": ref_text,
            "updatedAt": now_iso(),
        }
    )
    saved = save_profile(profile)
    _persist_proxy_event(
        body.roomName,
        body.participantId,
        "proxy.voice_sample_uploaded",
        {
            "bytes": len(audio),
            "mimeType": body.mimeType,
            "path": path.name,
            "refTextChars": len(ref_text),
            "refTextSource": "passage",
        },
    )
    return saved


@router.post("/agent-profile/complete", response_model=AgentProfileCompleteResponse)
def complete_calibration(body: AgentProfileKey) -> AgentProfileCompleteResponse:
    profile = load_profile(body.roomName, body.participantId) or _default_profile(
        body.roomName, body.participantId
    )

    if profile.voiceOutputMode == "cloned_voice_tts" and not profile.voiceSampleStored:
        raise HTTPException(
            status_code=400,
            detail="Voice sample required before completing onboarding (cloned_voice_tts)",
        )

    if profile.scenario and not calibration_complete(profile, profile.scenario):
        scenario = load_scenario(profile.scenario)
        required = questions_for_calibration(scenario, drop_index=profile.droppedQuestionIndex)
        missing = [q.text for q in required if q.id not in profile.calibrationAnswers]
        raise HTTPException(
            status_code=400,
            detail=(
                "Calibration questions not complete. "
                f"Please answer {len(missing)} remaining question(s) in the Agent Console."
            ),
        )

    completed = profile.model_copy(
        update={"calibrationCompletedAt": now_iso(), "updatedAt": now_iso()}
    )
    saved = save_profile(completed)
    _persist_proxy_event(
        body.roomName,
        body.participantId,
        "proxy.calibration_completed",
        {
            "voiceOutputMode": saved.voiceOutputMode,
            "voiceSampleStored": saved.voiceSampleStored,
            "scenario": saved.scenario,
            "droppedQuestionIndex": saved.droppedQuestionIndex,
        },
    )

    agent_join_ok = False
    agent_join_error: str | None = None
    agent_join: dict[str, Any] | None = None
    try:
        agent_join = join_agent_room(body.roomName, saved.agentDisplayName)
        agent_join_ok = True
        _persist_proxy_event(body.roomName, body.participantId, "proxy.agent_auto_joined", {"status": "ok"})
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
