from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from app.domain.models import Condition, SessionConfig
from app.services.stt_config import default_stt_mode
from app.storage.jsonl import data_dir, safe_room_slug

router = APIRouter()


def _config_path(room_name: str) -> Path:
    return data_dir() / "session_configs" / f"{safe_room_slug(room_name)}.json"


def _with_env_stt_mode(config: SessionConfig, *, explicit_stt_mode: bool) -> SessionConfig:
    if explicit_stt_mode:
        return config
    env_mode = default_stt_mode()
    if env_mode != "browser":
        return config.model_copy(update={"sttMode": env_mode})
    return config


@router.get("/session-config", response_model=SessionConfig)
def get_session_config(roomName: str = Query(min_length=1, max_length=256)) -> SessionConfig:
    path = _config_path(roomName)
    if path.exists():
        try:
            raw = path.read_text(encoding="utf-8")
            import json

            parsed = json.loads(raw)
            config = SessionConfig.model_validate(parsed)
            return _with_env_stt_mode(config, explicit_stt_mode="sttMode" in parsed)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Invalid session config JSON: {e}") from e

    # Default: minimal config; condition can be overridden later once tokens drive it.
    if roomName.startswith(("am-demo-ha", "am-pilot-ha")):
        return _with_env_stt_mode(
            SessionConfig(
                roomName=roomName,
                condition=Condition.HA,
                sttRequireUserClick=False,
            ),
            explicit_stt_mode=False,
        )
    return _with_env_stt_mode(SessionConfig(roomName=roomName, condition=Condition.HH), explicit_stt_mode=False)

