from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Literal

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
) -> tuple[bytes, int]:
    if voice_mode == "cloned_voice_tts":
        raise TtsError("cloned_voice_tts is not implemented yet (Phase 5D)")
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
    req = urllib.request.Request(
        url="https://api.openai.com/v1/audio/speech",
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        data=json.dumps(payload).encode("utf-8"),
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            audio = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") or str(exc)
        raise TtsError(f"OpenAI TTS HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise TtsError(f"OpenAI TTS request failed: {exc.reason}") from exc

    if not audio:
        raise TtsError("OpenAI TTS returned empty audio")

    return audio, OPENAI_PCM_SAMPLE_RATE


def pcm_duration_ms(pcm: bytes, sample_rate: int) -> int:
    if sample_rate <= 0:
        return 0
    samples = len(pcm) // 2
    return max(1, int(samples * 1000 / sample_rate))
