from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request

from app.domain.models import AgentProfile, VoiceMode
from app.services.tts import TtsError, pcm_duration_ms, synthesize_speech


class AgentSpeakError(Exception):
    pass


def _agent_bot_base_url() -> str:
    return os.environ.get("AGENT_BOT_BASE_URL", "http://127.0.0.1:3001").rstrip("/")


def _post_json(path: str, payload: dict, timeout: float) -> dict:
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
        raise AgentSpeakError(f"Agent-bot HTTP error: {detail}") from exc
    except urllib.error.URLError as exc:
        raise AgentSpeakError(f"Agent-bot unavailable: {exc.reason}") from exc


def speak_in_room(
    room_name: str,
    text: str,
    *,
    voice_mode: VoiceMode = "generic_tts",
    voice_gender: str | None = None,
    profile: AgentProfile | None = None,
) -> int:
    try:
        pcm, sample_rate = synthesize_speech(
            text,
            voice_mode=voice_mode,
            voice_gender=voice_gender,  # type: ignore[arg-type]
            profile=profile,
        )
    except TtsError as exc:
        raise AgentSpeakError(str(exc)) from exc

    duration_ms = pcm_duration_ms(pcm, sample_rate)
    bot_payload = {
        "roomName": room_name,
        "audioBase64": base64.b64encode(pcm).decode("ascii"),
        "sampleRate": sample_rate,
        "durationMs": duration_ms,
        "text": text,
    }
    timeout = max(120.0, duration_ms / 1000.0 + 90.0)
    _post_json("/bot/speak", bot_payload, timeout=timeout)
    return duration_ms


def speak_for_profile(room_name: str, profile: AgentProfile, text: str) -> int:
    return speak_in_room(
        room_name,
        text,
        voice_mode=profile.voiceOutputMode,
        voice_gender=profile.ttsVoiceGender,
        profile=profile,
    )


def start_thinking(room_name: str) -> None:
    """Best-effort: play soft ambient while Echo is processing."""
    try:
        _post_json("/bot/thinking/start", {"roomName": room_name}, timeout=30.0)
    except AgentSpeakError:
        # Don't block the agent loop if ambient feedback fails.
        return


def stop_thinking(room_name: str) -> None:
    """Best-effort: stop processing ambient before speech or idle."""
    try:
        _post_json("/bot/thinking/stop", {"roomName": room_name}, timeout=15.0)
    except AgentSpeakError:
        return
