from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from app.domain.models import TranscriptSegmentRequest
from app.storage.jsonl import append_jsonl, data_dir, now_iso, safe_room_slug

router = APIRouter()


def _segments_path(room_name: str) -> Path:
    return data_dir() / "transcripts" / f"{safe_room_slug(room_name)}.segments.jsonl"


@router.post("/transcripts")
def log_transcript_segment(body: TranscriptSegmentRequest) -> dict[str, str]:
    append_jsonl(
        _segments_path(body.roomName),
        {
            "loggedAt": now_iso(),
            **body.model_dump(),
        },
    )
    return {"status": "ok"}

