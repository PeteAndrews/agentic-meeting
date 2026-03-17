from __future__ import annotations

import os
import secrets
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from app.domain.models import Condition, ResolveTokenRequest, ResolveTokenResponse, Role
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
        return ResolveTokenResponse(
            participantId=str(rec["participantId"]),
            role=role,
            condition=condition,
            roomName=str(rec["roomName"]),
            displayName=str(rec.get("displayName") or rec.get("participantId") or "Participant"),
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Invalid token registry record: {e}") from e

