from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from app.domain.models import Condition, SessionConfig
from app.storage.jsonl import data_dir, safe_room_slug

router = APIRouter()


def _config_path(room_name: str) -> Path:
    return data_dir() / "session_configs" / f"{safe_room_slug(room_name)}.json"


@router.get("/session-config", response_model=SessionConfig)
def get_session_config(roomName: str = Query(min_length=1, max_length=256)) -> SessionConfig:
    path = _config_path(roomName)
    if path.exists():
        try:
            return SessionConfig.model_validate_json(path.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Invalid session config JSON: {e}") from e

    # Default: minimal config; condition can be overridden later once tokens drive it.
    return SessionConfig(roomName=roomName, condition=Condition.HH)

