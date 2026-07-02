from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.request
from typing import Any

from fastapi import HTTPException

from app.domain.models import Condition, LogEventRequest, Role
from app.storage.jsonl import append_jsonl, data_dir, now_iso, safe_room_slug


def _agent_bot_base_url() -> str:
    return os.environ.get("AGENT_BOT_BASE_URL", "http://127.0.0.1:3001").rstrip("/")


def _post_json(path: str, payload: dict[str, Any], timeout: float = 10) -> dict[str, Any]:
    url = f"{_agent_bot_base_url()}{path}"
    req = urllib.request.Request(
        url=url,
        method="POST",
        headers={"Content-Type": "application/json"},
        data=json.dumps(payload).encode("utf-8"),
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            content = resp.read().decode("utf-8")
            return json.loads(content) if content else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8") or str(exc)
        try:
            parsed = json.loads(detail) if detail else {}
        except json.JSONDecodeError:
            parsed = {"raw": detail}
        if exc.code == 409:
            note = parsed.get("note") if isinstance(parsed, dict) else None
            raise HTTPException(status_code=409, detail=note or parsed) from exc
        raise HTTPException(status_code=502, detail=f"Agent-bot HTTP error: {detail}") from exc
    except (urllib.error.URLError, socket.timeout, TimeoutError) as exc:
        reason = getattr(exc, "reason", str(exc))
        raise HTTPException(status_code=503, detail=f"Agent-bot unavailable: {reason}") from exc


def _backend_event(room_name: str, event_type: str, payload: dict[str, Any]) -> LogEventRequest:
    return LogEventRequest(
        roomName=room_name,
        participantId="agent-c",
        role=Role.AGENT,
        condition=Condition.HA,
        tsMs=int(__import__("time").time() * 1000),
        eventType=event_type,
        payload={"loggedAt": now_iso(), **payload},
    )


def _events_path(room_name: str):
    return data_dir() / "events" / f"{safe_room_slug(room_name)}.events.jsonl"


def _persist_event(event: LogEventRequest) -> None:
    append_jsonl(
        _events_path(event.roomName),
        {
            "loggedAt": now_iso(),
            **event.model_dump(),
        },
    )


def join_agent_room(room_name: str, display_name: str | None = None) -> dict[str, Any]:
    name = display_name or "Echo"
    event = _backend_event(room_name, "agent.join_requested", {"displayName": name})
    _persist_event(event)
    result = _post_json("/bot/join", {"roomName": room_name, "displayName": name}, timeout=90)
    return {"status": "ok", "event": event.model_dump(), "bot": result}
