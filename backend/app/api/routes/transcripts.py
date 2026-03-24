from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse

from app.domain.models import TranscriptSegmentRequest
from app.storage.jsonl import append_jsonl, data_dir, now_iso, read_jsonl, safe_room_slug

router = APIRouter()


def _segments_path(room_name: str) -> Path:
    return data_dir() / "transcripts" / f"{safe_room_slug(room_name)}.segments.jsonl"


def _as_int(value: Any, field: str) -> int:
    try:
        return int(value)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Invalid segment field {field!r}: {value!r}") from e


def _as_bool(value: Any, field: str, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("true", "1", "yes", "y", "t"):
            return True
        if v in ("false", "0", "no", "n", "f"):
            return False
    raise HTTPException(status_code=500, detail=f"Invalid segment field {field!r}: {value!r}")


def _load_segments(room_name: str) -> list[dict[str, Any]]:
    try:
        return read_jsonl(_segments_path(room_name))
    except FileNotFoundError:
        return []
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to read segments: {e}") from e


def _normalize_segment(seg: dict[str, Any]) -> dict[str, Any]:
    # Normalize required fields so sorting/export is robust even if older records exist.
    start_ms = _as_int(seg.get("startMs", 0), "startMs")
    end_ms = _as_int(seg.get("endMs", start_ms), "endMs")
    if end_ms < start_ms:
        end_ms = start_ms

    is_final = _as_bool(seg.get("isFinal"), "isFinal", default=True)

    return {
        "loggedAt": seg.get("loggedAt"),
        "roomName": seg.get("roomName"),
        "participantId": seg.get("participantId"),
        "role": seg.get("role"),
        "condition": seg.get("condition"),
        "startMs": start_ms,
        "endMs": end_ms,
        "isFinal": is_final,
        "text": seg.get("text"),
        "confidence": seg.get("confidence"),
    }


def _reconstruct_timeline(
    segments: list[dict[str, Any]],
    *,
    final_only: bool,
) -> list[dict[str, Any]]:
    normalized = [_normalize_segment(s) for s in segments]
    if final_only:
        normalized = [s for s in normalized if s.get("isFinal") is True]
    normalized.sort(
        key=lambda s: (
            int(s.get("startMs", 0)),
            int(s.get("endMs", 0)),
            str(s.get("role") or ""),
            str(s.get("participantId") or ""),
        )
    )
    return normalized


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


@router.get("/transcripts/segments")
def list_transcript_segments(
    roomName: str = Query(min_length=1, max_length=256),
    finalOnly: bool = Query(default=True),
) -> dict[str, Any]:
    segments = _load_segments(roomName)
    timeline = _reconstruct_timeline(segments, final_only=finalOnly)
    return {
        "roomName": roomName,
        "finalOnly": finalOnly,
        "count": len(timeline),
        "segments": timeline,
    }


@router.get("/transcripts/export")
def export_transcript(
    roomName: str = Query(min_length=1, max_length=256),
    finalOnly: bool = Query(default=True),
    format: Literal["json", "text"] = Query(default="json"),
) -> Any:
    segments = _load_segments(roomName)
    timeline = _reconstruct_timeline(segments, final_only=finalOnly)

    if format == "json":
        return {
            "roomName": roomName,
            "finalOnly": finalOnly,
            "exportedAt": datetime.utcnow().isoformat() + "Z",
            "count": len(timeline),
            "segments": timeline,
        }

    # Plain text: one line per segment, time relative to first segment.
    if not timeline:
        return PlainTextResponse("", media_type="text/plain")

    base_ms = int(timeline[0]["startMs"])
    lines: list[str] = []
    for s in timeline:
        t0 = (int(s["startMs"]) - base_ms) / 1000.0
        t1 = (int(s["endMs"]) - base_ms) / 1000.0
        who = f'{s.get("role")}/{s.get("participantId")}'
        text = (s.get("text") or "").strip()
        lines.append(f"[{t0:0.3f}-{t1:0.3f}] {who}: {text}")

    return PlainTextResponse("\n".join(lines) + "\n", media_type="text/plain")

