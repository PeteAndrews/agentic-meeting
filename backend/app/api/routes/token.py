from __future__ import annotations

import os
import secrets
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from app.domain.models import Condition, ResolveTokenRequest, ResolveTokenResponse, Role, VoiceMode
from app.storage.jsonl import append_jsonl, data_dir, now_iso

router = APIRouter()


def _tokens_path() -> Path:
    return data_dir() / "token_registry.jsonl"


def _load_token_registry() -> dict[str, dict[str, Any]]:
    path = _tokens_path()
    if not path.exists():
        return {}

    registry: dict[str, dict[str, Any]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = __import__("json").loads(line)
        token = rec.get("studyToken")
        if isinstance(token, str):
            registry[token] = rec
    return registry


def _auto_create_enabled() -> bool:
    return os.environ.get("ALLOW_TOKEN_AUTO_CREATE", "").lower() in ("1", "true", "yes", "y")


@router.post("/resolve-token", response_model=ResolveTokenResponse)
def resolve_token(body: ResolveTokenRequest) -> ResolveTokenResponse:
    registry = _load_token_registry()
    rec = registry.get(body.studyToken)

    if not rec:
        if not _auto_create_enabled():
            raise HTTPException(status_code=404, detail="Unknown studyToken")

        # Dev-only convenience: create a token mapping with safe defaults.
        room_name = f"am-{secrets.token_hex(4)}"
        rec = {
            "studyToken": body.studyToken,
            "createdAt": now_iso(),
            "participantId": f"p-{secrets.token_hex(4)}",
            "role": Role.MODERATOR.value,
            "condition": Condition.HH.value,
            "roomName": room_name,
            "displayName": "Moderator (A)",
        }
        append_jsonl(_tokens_path(), rec)

    try:
        role = Role(rec["role"])
        condition = Condition(rec["condition"])
        voice_mode: VoiceMode | None = None
        scenario: str | None = None
        calibration_drop_index: int | None = None
        max_interventions = 999
        agent_trigger_phrases: list[str] = ["echo"]
        agent_display_name = "Echo"
        tts_voice_gender: str | None = None
        if role == Role.PROXY:
            raw_mode = rec.get("voiceOutputMode", "generic_tts")
            if raw_mode in ("generic_tts", "cloned_voice_tts"):
                voice_mode = raw_mode  # type: ignore[assignment]
            else:
                voice_mode = "generic_tts"
            raw_scenario = rec.get("scenario")
            if isinstance(raw_scenario, str) and raw_scenario.strip():
                scenario = raw_scenario.strip()
            raw_drop = rec.get("calibrationDropQuestionIndex")
            if isinstance(raw_drop, int):
                calibration_drop_index = raw_drop
            raw_max = rec.get("maxInterventions")
            if isinstance(raw_max, int) and raw_max >= 1:
                max_interventions = raw_max
            raw_phrases = rec.get("agentTriggerPhrases")
            if isinstance(raw_phrases, list):
                cleaned = [str(p).strip() for p in raw_phrases if str(p).strip()]
                if cleaned:
                    agent_trigger_phrases = cleaned
            raw_agent_name = rec.get("agentDisplayName")
            if isinstance(raw_agent_name, str) and raw_agent_name.strip():
                agent_display_name = raw_agent_name.strip()
            raw_gender = rec.get("ttsVoiceGender")
            if raw_gender in ("male", "female"):
                tts_voice_gender = raw_gender
        else:
            raw_scenario = rec.get("scenario")
            if isinstance(raw_scenario, str) and raw_scenario.strip():
                scenario = raw_scenario.strip()
        return ResolveTokenResponse(
            participantId=str(rec["participantId"]),
            role=role,
            condition=condition,
            roomName=str(rec["roomName"]),
            displayName=str(rec.get("displayName") or rec.get("participantId") or "Participant"),
            voiceOutputMode=voice_mode,
            scenario=scenario,
            calibrationDropQuestionIndex=calibration_drop_index,
            maxInterventions=max_interventions,
            agentTriggerPhrases=agent_trigger_phrases,
            agentDisplayName=agent_display_name,
            ttsVoiceGender=tts_voice_gender,  # type: ignore[arg-type]
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Invalid token registry record: {e}") from e

