from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from app.domain.models import LogEventRequest
from app.storage.jsonl import append_jsonl, data_dir, now_iso, safe_room_slug

router = APIRouter()


def _events_path(room_name: str) -> Path:
    return data_dir() / "events" / f"{safe_room_slug(room_name)}.events.jsonl"


@router.post("/events")
def log_event(body: LogEventRequest) -> dict[str, str]:
    append_jsonl(
        _events_path(body.roomName),
        {
            "loggedAt": now_iso(),
            **body.model_dump(),
        },
    )
    return {"status": "ok"}

