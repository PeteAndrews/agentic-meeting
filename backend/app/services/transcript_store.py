from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

from app.domain.models import TranscriptSegmentRequest
from app.services.agent_loop import process_transcript_update
from app.storage.jsonl import append_jsonl, data_dir, now_iso, safe_room_slug

logger = logging.getLogger(__name__)

def segments_path(room_name: str) -> Path:
    return data_dir() / "transcripts" / f"{safe_room_slug(room_name)}.segments.jsonl"


def _run_transcript_agent_loop(room_name: str) -> None:
    try:
        logger.info("Running Echo agent loop after final transcript in room %s", room_name)
        process_transcript_update(room_name)
    except Exception:  # noqa: BLE001
        logger.exception("Agent loop failed after transcript segment for room %s", room_name)


def schedule_transcript_agent_loop(room_name: str) -> None:
    """Run Echo trigger handling off the STT/WebSocket event loop."""
    thread = threading.Thread(
        target=_run_transcript_agent_loop,
        args=(room_name,),
        name=f"agent-loop-{safe_room_slug(room_name)}",
        daemon=True,
    )
    thread.start()


def append_transcript_segment(    body: TranscriptSegmentRequest,
    *,
    source: str | None = None,
) -> None:
    payload: dict[str, Any] = {
        "loggedAt": now_iso(),
        **body.model_dump(),
    }
    if source:
        payload["source"] = source

    append_jsonl(segments_path(body.roomName), payload)

    if body.isFinal and body.condition.value == "HA":
        logger.info(
            "Received final %s transcript for Echo in %s: %r",
            source or "browser",
            body.roomName,
            body.text,
        )
        schedule_transcript_agent_loop(body.roomName)