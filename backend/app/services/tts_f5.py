from __future__ import annotations

import base64
import binascii
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np

from app.domain.models import AgentProfile
from app.services.http_client import HttpClientError, post_json
from app.services.scenario_loader import load_scenario
from app.services.tts import TtsError
from app.storage.jsonl import data_dir

TARGET_PCM_SAMPLE_RATE = 24_000

DEFAULT_VOICE_SAMPLE_PASSAGE = """I am recording this sample so Echo can represent my voice during the meeting.
Today we will discuss timelines and trip organisations where my decisions that affect the outcome.
I will speak clearly and at a natural pace, as I would in a normal conversation with colleagues.
Please capture the full range of my voice from beginning to end."""


def f5_service_url() -> str:
    return os.environ.get("F5_TTS_SERVICE_URL", "http://127.0.0.1:8765").rstrip("/")


def f5_request_timeout_sec() -> float:
    raw = os.environ.get("F5_TTS_REQUEST_TIMEOUT_SEC", "120").strip()
    try:
        return max(30.0, float(raw))
    except ValueError:
        return 120.0


def _ffmpeg_executable() -> str:
    configured = os.environ.get("FFMPEG_PATH", "").strip()
    if configured:
        return configured
    found = shutil.which("ffmpeg")
    if not found:
        raise TtsError("ffmpeg is required for cloned_voice_tts (convert voice sample WebM to WAV)")
    return found


def voice_samples_dir() -> Path:
    return data_dir() / "voice_samples"


def resolve_voice_sample_path(profile: AgentProfile) -> Path:
    if not profile.voiceSampleStored or not profile.voiceSamplePath:
        raise TtsError("Voice sample not recorded for cloned_voice_tts")
    path = voice_samples_dir() / profile.voiceSamplePath
    if not path.is_file():
        raise TtsError(f"Voice sample file missing: {path.name}")
    return path


def resolve_ref_text(profile: AgentProfile) -> str:
    stored = (profile.voiceSampleRefText or "").strip()
    if stored:
        return stored
    if profile.scenario:
        try:
            scenario = load_scenario(profile.scenario)
            if scenario.voiceSamplePassage and scenario.voiceSamplePassage.strip():
                return scenario.voiceSamplePassage.strip()
        except (FileNotFoundError, ValueError):
            pass
    return DEFAULT_VOICE_SAMPLE_PASSAGE.strip()


def ensure_profile_ref_text(profile: AgentProfile) -> AgentProfile:
    """Ensure a ref transcript exists without calling F5 ASR.

    F5's ``/transcribe`` lazy-loads Whisper (large HF download) and contends with
    ``/synthesize`` on the same process — never invoke it on the speak path.
    """
    if (profile.voiceSampleRefText or "").strip():
        return profile

    from app.services.agent_store import save_profile
    from app.storage.jsonl import now_iso

    ref_text = resolve_ref_text(profile)
    updated = profile.model_copy(
        update={"voiceSampleRefText": ref_text, "updatedAt": now_iso()},
    )
    return save_profile(updated)


def wav_cache_path(sample_path: Path) -> Path:
    return sample_path.with_suffix(".wav")


def ensure_ref_wav(sample_path: Path, *, force_rebuild: bool = False) -> Path:
    cached = wav_cache_path(sample_path)
    if (
        not force_rebuild
        and cached.exists()
        and cached.stat().st_mtime >= sample_path.stat().st_mtime
    ):
        return cached

    if sample_path.suffix.lower() == ".wav":
        return sample_path

    cached.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = _ffmpeg_executable()
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(sample_path),
        "-ar",
        "24000",
        "-ac",
        "1",
        str(cached),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or b"").decode("utf-8", errors="replace")
        raise TtsError(f"ffmpeg failed converting voice sample: {detail[:500]}") from exc
    except OSError as exc:
        raise TtsError(f"ffmpeg failed: {exc}") from exc

    if not cached.is_file() or cached.stat().st_size < 256:
        raise TtsError("ffmpeg produced an empty WAV from the voice sample")
    return cached


def resample_pcm16(pcm: bytes, from_rate: int, to_rate: int) -> bytes:
    if from_rate == to_rate or not pcm:
        return pcm
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    if len(samples) == 0:
        return pcm
    out_len = max(1, int(len(samples) * to_rate / from_rate))
    x_old = np.linspace(0.0, 1.0, num=len(samples), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=out_len, endpoint=False)
    resampled = np.interp(x_new, x_old, samples)
    return resampled.astype(np.int16).tobytes()


def _post_f5_synthesize(
    *,
    text: str,
    ref_wav_path: Path,
    ref_text: str,
) -> tuple[bytes, int]:
    payload = {
        "text": text,
        "ref_audio_path": str(ref_wav_path.resolve()),
        "ref_text": ref_text,
    }
    timeout = f5_request_timeout_sec()
    try:
        body = post_json(f"{f5_service_url()}/synthesize", payload, timeout=timeout)
    except HttpClientError as exc:
        if exc.status_code is not None:
            raise TtsError(f"F5-TTS service HTTP {exc.status_code}: {exc.body}") from exc
        if "timed out" in str(exc).lower():
            raise TtsError(f"F5-TTS synthesize timed out after {timeout:.0f}s") from exc
        raise TtsError(f"F5-TTS service unavailable at {f5_service_url()}: {exc.reason or exc}") from exc

    pcm_b64 = body.get("pcm_base64")
    sample_rate = body.get("sample_rate")
    if not pcm_b64 or not sample_rate:
        raise TtsError("F5-TTS service returned invalid synthesize response")
    try:
        pcm = base64.b64decode(pcm_b64, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise TtsError("F5-TTS service returned invalid pcm_base64") from exc
    if not pcm:
        raise TtsError("F5-TTS service returned empty audio")
    return pcm, int(sample_rate)


def synthesize_f5_clone(text: str, *, profile: AgentProfile) -> tuple[bytes, int]:
    if profile.voiceOutputMode != "cloned_voice_tts":
        raise TtsError("synthesize_f5_clone requires cloned_voice_tts profile")

    profile = ensure_profile_ref_text(profile)
    sample_path = resolve_voice_sample_path(profile)
    ref_wav = ensure_ref_wav(sample_path)
    ref_text = resolve_ref_text(profile)

    pcm, sample_rate = _post_f5_synthesize(
        text=text.strip(),
        ref_wav_path=ref_wav,
        ref_text=ref_text,
    )
    pcm = resample_pcm16(pcm, sample_rate, TARGET_PCM_SAMPLE_RATE)
    return pcm, TARGET_PCM_SAMPLE_RATE
