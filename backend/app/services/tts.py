from __future__ import annotations

import os
from typing import Literal

from app.domain.models import AgentProfile
from app.services.http_client import HttpClientError, post_bytes

VoiceMode = Literal["generic_tts", "cloned_voice_tts", "manual_test_audio"]
TtsVoiceGender = Literal["male", "female"]

# OpenAI speech API returns 24 kHz 16-bit signed little-endian PCM.
OPENAI_PCM_SAMPLE_RATE = 24_000


class TtsError(Exception):
    pass


def resolve_openai_voice(voice_gender: TtsVoiceGender | None = None) -> str:
    if voice_gender == "male":
        return os.environ.get("TTS_VOICE_MALE", "onyx").strip() or "onyx"
    if voice_gender == "female":
        return os.environ.get("TTS_VOICE_FEMALE", "nova").strip() or "nova"
    return os.environ.get("TTS_VOICE", "alloy").strip() or "alloy"


def synthesize_speech(
    text: str,
    *,
    voice_mode: VoiceMode = "generic_tts",
    voice_gender: TtsVoiceGender | None = None,
    profile: AgentProfile | None = None,
) -> tuple[bytes, int]:
    if voice_mode == "cloned_voice_tts":
        if profile is None:
            raise TtsError("Agent profile required for cloned_voice_tts")
        from app.services.tts_f5 import synthesize_f5_clone

        return synthesize_f5_clone(text, profile=profile)
    if voice_mode != "generic_tts":
        raise TtsError(f"Unsupported voice mode: {voice_mode}")

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise TtsError("OPENAI_API_KEY is required for generic_tts")

    voice = resolve_openai_voice(voice_gender)
    model = os.environ.get("TTS_MODEL", "tts-1").strip() or "tts-1"

    payload = {
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": "pcm",
    }
    try:
        audio = post_bytes(
            "https://api.openai.com/v1/audio/speech",
            payload,
            timeout=120.0,
            headers={"Authorization": f"Bearer {api_key}"},
        )
    except HttpClientError as exc:
        if exc.status_code is not None:
            raise TtsError(f"OpenAI TTS HTTP {exc.status_code}: {exc.body}") from exc
        raise TtsError(f"OpenAI TTS request failed: {exc.reason or exc}") from exc

    if not audio:
        raise TtsError("OpenAI TTS returned empty audio")

    return audio, OPENAI_PCM_SAMPLE_RATE


def pcm_duration_ms(pcm: bytes, sample_rate: int) -> int:
    if sample_rate <= 0:
        return 0
    samples = len(pcm) // 2
    return max(1, int(samples * 1000 / sample_rate))
