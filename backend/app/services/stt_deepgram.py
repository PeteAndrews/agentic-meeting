from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any
from urllib.parse import quote, urlencode

import websockets
from websockets.asyncio.client import ClientConnection

from app.domain.models import Condition, Role, TranscriptSegmentRequest
from app.services.stt_config import (
    deepgram_api_key,
    deepgram_model,
    stt_endpointing_ms,
    stt_keyterms,
    stt_language,
)
from app.services.transcript_store import append_transcript_segment

logger = logging.getLogger(__name__)


def _build_deepgram_url(*, language: str, interim_results: bool, keyterms: list[str]) -> str:
    params: dict[str, str] = {
        "model": deepgram_model(),
        "language": language,
        "encoding": "linear16",
        "sample_rate": "16000",
        "channels": "1",
        "interim_results": "true" if interim_results else "false",
        "endpointing": str(stt_endpointing_ms()),
        "punctuate": "true",
        "smart_format": "true",
    }
    query = urlencode(params)
    for term in keyterms:
        query += f"&keyterm={quote(term)}"
    return f"wss://api.deepgram.com/v1/listen?{query}"


class DeepgramStreamSession:
    """Proxies one browser mic stream to Deepgram and persists transcript segments."""

    def __init__(
        self,
        *,
        room_name: str,
        participant_id: str,
        role: Role,
        condition: Condition,
        language: str,
        send_interim: bool,
        keyterms: list[str] | None = None,
    ) -> None:
        self.room_name = room_name
        self.participant_id = participant_id
        self.role = role
        self.condition = condition
        self.language = language or stt_language()
        self.send_interim = send_interim
        self.keyterms = keyterms if keyterms is not None else stt_keyterms()

        self._dg: ClientConnection | None = None
        self._utterance_start_ms: int | None = None
        self._closed = False

    async def connect(self) -> None:
        api_key = deepgram_api_key()
        if not api_key:
            raise RuntimeError("DEEPGRAM_API_KEY is not configured")

        url = _build_deepgram_url(
            language=self.language,
            interim_results=self.send_interim,
            keyterms=self.keyterms,
        )
        self._dg = await websockets.connect(
            url,
            additional_headers={"Authorization": f"Token {api_key}"},
            open_timeout=15,
            close_timeout=5,
            max_size=8 * 1024 * 1024,
        )

    async def close(self) -> None:
        self._closed = True
        if self._dg is not None:
            try:
                await self._dg.send(json.dumps({"type": "CloseStream"}))
            except Exception:  # noqa: BLE001
                pass
            try:
                await self._dg.close()
            except Exception:  # noqa: BLE001
                pass
            self._dg = None

    async def send_audio(self, chunk: bytes) -> None:
        if self._closed or self._dg is None:
            return
        await self._dg.send(chunk)

    async def recv_event(self) -> dict[str, Any] | None:
        if self._closed or self._dg is None:
            return None
        try:
            raw = await self._dg.recv()
        except websockets.ConnectionClosed:
            return None
        if isinstance(raw, bytes):
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def _client_message(
        self,
        *,
        msg_type: str,
        text: str = "",
        start_ms: int | None = None,
        end_ms: int | None = None,
        confidence: float | None = None,
        message: str = "",
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"type": msg_type}
        if text:
            payload["text"] = text
        if start_ms is not None:
            payload["startMs"] = start_ms
        if end_ms is not None:
            payload["endMs"] = end_ms
        if confidence is not None:
            payload["confidence"] = confidence
        if message:
            payload["message"] = message
        return payload

    def handle_deepgram_message(self, message: dict[str, Any]) -> list[dict[str, Any]]:
        msg_type = message.get("type")
        if msg_type == "Metadata":
            return [self._client_message(msg_type="ready")]

        if msg_type != "Results":
            return []

        channel = message.get("channel") or {}
        alternatives = channel.get("alternatives") or []
        if not alternatives:
            return []

        alt = alternatives[0] or {}
        transcript = str(alt.get("transcript") or "").strip()
        if not transcript:
            return []

        confidence_raw = alt.get("confidence")
        confidence = float(confidence_raw) if isinstance(confidence_raw, (int, float)) else None

        is_final = bool(message.get("is_final"))
        speech_final = bool(message.get("speech_final"))
        now_ms = int(time.time() * 1000)

        if self._utterance_start_ms is None:
            self._utterance_start_ms = now_ms

        out: list[dict[str, Any]] = []

        if not is_final and self.send_interim:
            out.append(self._client_message(msg_type="partial", text=transcript, confidence=confidence))
            return out

        if is_final or speech_final:
            start_ms = self._utterance_start_ms
            end_ms = now_ms
            self._utterance_start_ms = None

            segment = TranscriptSegmentRequest(
                roomName=self.room_name,
                participantId=self.participant_id,
                role=self.role,
                condition=self.condition,
                startMs=start_ms or end_ms,
                endMs=end_ms,
                isFinal=True,
                text=transcript,
                confidence=confidence,
                source="server",
            )
            append_transcript_segment(segment, source="server")

            out.append(
                self._client_message(
                    msg_type="final",
                    text=transcript,
                    start_ms=segment.startMs,
                    end_ms=segment.endMs,
                    confidence=confidence,
                )
            )

        return out

    async def forward_deepgram_events(self, client_send_json) -> None:
        """Read Deepgram messages until the upstream socket closes."""
        while not self._closed:
            message = await self.recv_event()
            if message is None:
                break
            for client_msg in self.handle_deepgram_message(message):
                await client_send_json(client_msg)
