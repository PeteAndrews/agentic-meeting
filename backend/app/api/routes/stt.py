from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.domain.models import Condition, Role
from app.services.stt_config import default_stt_mode, stt_keyterms
from app.services.stt_deepgram import DeepgramStreamSession

router = APIRouter()
logger = logging.getLogger(__name__)


def _parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "y", "on")


@router.websocket("/stt/stream")
async def stt_stream(websocket: WebSocket) -> None:
    if default_stt_mode() != "server_per_client":
        await websocket.close(code=1008, reason="Server STT is disabled (STT_MODE=browser)")
        return

    params = websocket.query_params
    room_name = (params.get("roomName") or "").strip()
    participant_id = (params.get("participantId") or "").strip()
    role_raw = (params.get("role") or "").strip().lower()
    condition_raw = (params.get("condition") or "").strip().upper()
    language = (params.get("sttLanguage") or "en-US").strip() or "en-US"
    send_interim = _parse_bool(params.get("sttSendInterim"))

    if not room_name or not participant_id:
        await websocket.close(code=1008, reason="roomName and participantId are required")
        return

    try:
        role = Role(role_raw)
        condition = Condition(condition_raw)
    except ValueError:
        await websocket.close(code=1008, reason="Invalid role or condition")
        return

    await websocket.accept()

    session = DeepgramStreamSession(
        room_name=room_name,
        participant_id=participant_id,
        role=role,
        condition=condition,
        language=language,
        send_interim=send_interim,
        keyterms=stt_keyterms(),
    )

    async def send_json(payload: dict) -> None:
        await websocket.send_json(payload)

    dg_task: asyncio.Task | None = None

    try:
        await session.connect()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Deepgram connect failed: %s", exc)
        await send_json({"type": "error", "message": str(exc)})
        await websocket.close(code=1011, reason="Deepgram connection failed")
        return

    dg_task = asyncio.create_task(session.forward_deepgram_events(send_json))

    try:
        while True:
            message = await websocket.receive()
            msg_type = message.get("type")

            if msg_type == "websocket.disconnect":
                break

            if msg_type == "websocket.receive":
                if "bytes" in message and message["bytes"]:
                    await session.send_audio(message["bytes"])
                    continue

                text = message.get("text")
                if text:
                    try:
                        control = json.loads(text)
                    except json.JSONDecodeError:
                        if text.strip().lower() == "stop":
                            break
                        continue
                    if control.get("type") == "stop":
                        break
    except WebSocketDisconnect:
        pass
    finally:
        await session.close()
        if dg_task is not None:
            dg_task.cancel()
            try:
                await dg_task
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001
                pass
