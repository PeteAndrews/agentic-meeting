from __future__ import annotations

import base64
import logging
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


def _load_env_file() -> None:
    """Load f5-tts-service/.env without requiring python-dotenv.

    Runs regardless of whether the service is started via start.ps1 or
    directly with ``python -m uvicorn main:app`` — the latter previously
    skipped .env entirely, silently defaulting F5_TTS_DEVICE/HF_HUB_DISABLE_XET.
    """
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_env_file()

# uvicorn's default logging config does not disable other loggers, so a plain
# basicConfig here is enough to make our INFO logs (e.g. selected device) visible.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

logger = logging.getLogger(__name__)

_engine: Any = None
_target_sample_rate = 24_000
# F5/Whisper share one process; serialize so ASR never starves clone speak.
_engine_lock = threading.Lock()
_engine_device = "uninitialized"


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4096)
    ref_audio_path: str = Field(min_length=1, max_length=1024)
    ref_text: str = Field(min_length=1, max_length=8000)


class SynthesizeResponse(BaseModel):
    pcm_base64: str
    sample_rate: int


class TranscribeRequest(BaseModel):
    ref_audio_path: str = Field(min_length=1, max_length=1024)
    language: str | None = Field(default=None, max_length=16)


class TranscribeResponse(BaseModel):
    ref_text: str


def _resolve_device(configured_device: str, *, cuda_available: bool) -> str:
    """Pick a runnable device. Never force cuda when the driver/torch build cannot use it."""
    requested = (configured_device or "").strip().lower()
    if not requested:
        return "cuda" if cuda_available else "cpu"
    if requested.startswith("cuda") and not cuda_available:
        print(
            "[f5-tts-service] WARNING: F5_TTS_DEVICE requests CUDA but "
            "torch.cuda.is_available() is False — falling back to cpu"
        )
        logger.warning(
            "F5_TTS_DEVICE=%s but CUDA is unavailable; using cpu",
            configured_device,
        )
        return "cpu"
    return configured_device.strip() or "cpu"


def _load_engine() -> Any:
    # Import torch BEFORE f5_tts. On this Windows/Anaconda stack, importing
    # f5_tts first can poison CUDA init so torch.cuda.is_available() becomes False
    # for the rest of the process (and F5 silently falls back to CPU).
    import torch

    configured_device = os.environ.get("F5_TTS_DEVICE", "").strip()
    cuda_available = bool(torch.cuda.is_available())
    device = _resolve_device(configured_device, cuda_available=cuda_available)
    model = os.environ.get("F5_TTS_MODEL", "F5TTS_v1_Base").strip() or "F5TTS_v1_Base"

    if device.startswith("cuda") and cuda_available:
        # Touch the device early so later f5_tts imports cannot undo CUDA init.
        _ = torch.cuda.get_device_name(0)
        print(f"[f5-tts-service] cuda device: {torch.cuda.get_device_name(0)}")

    from f5_tts.api import F5TTS

    # print(), not just logger.info(): F5-TTS internals print plain banners (vocab/token/model)
    # that bypass logging entirely, so this keeps the device choice equally visible.
    print(
        f"[f5-tts-service] device={device} "
        f"(configured={configured_device or '(auto)'}, torch.cuda.is_available()={torch.cuda.is_available()})"
    )
    logger.info("Loading F5-TTS model %s (device=%s)", model, device)
    engine = F5TTS(model=model, device=device)
    global _engine_device, _target_sample_rate
    _engine_device = device
    _target_sample_rate = int(getattr(engine, "target_sample_rate", 24_000))
    print(f"[f5-tts-service] ready (device={_engine_device}, target_sample_rate={_target_sample_rate})")
    logger.info(
        "F5-TTS ready (device=%s, target_sample_rate=%s)",
        _engine_device,
        _target_sample_rate,
    )
    return engine


def _wav_to_pcm16(wav: np.ndarray) -> bytes:
    arr = np.asarray(wav, dtype=np.float32)
    if arr.ndim > 1:
        arr = arr.mean(axis=1)
    clipped = np.clip(arr, -1.0, 1.0)
    return (clipped * 32767.0).astype(np.int16).tobytes()


def _validate_ref_path(path: Path) -> Path:
    resolved = path.resolve()
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail=f"Reference audio not found: {resolved}")

    allowed_roots = [
        Path(raw.strip()).resolve()
        for raw in os.environ.get("F5_TTS_ALLOWED_AUDIO_ROOTS", "").split(os.pathsep)
        if raw.strip()
    ]
    if allowed_roots and not any(resolved.is_relative_to(root) for root in allowed_roots):
        raise HTTPException(status_code=403, detail="Reference audio path is outside allowed roots")
    return resolved


def _infer_nfe_step() -> int:
    raw = os.environ.get("F5_TTS_NFE_STEP", "").strip()
    if not raw:
        return 32
    try:
        return max(4, min(64, int(raw)))
    except ValueError:
        return 32


def _infer_speed() -> float:
    raw = os.environ.get("F5_TTS_SPEED", "").strip()
    if not raw:
        return 1.0
    try:
        return max(0.5, min(2.0, float(raw)))
    except ValueError:
        return 1.0


def _warmup_engine(engine: Any) -> None:
    """Run a short dummy infer so the first real speak avoids CUDA cold start."""
    try:
        import tempfile
        import wave

        sr = int(getattr(engine, "target_sample_rate", 24_000) or 24_000)
        # ~0.5s of quiet noise as a disposable reference clip.
        samples = (np.random.randn(sr // 2).astype(np.float32) * 0.01)
        pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            with wave.open(tmp_path, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sr)
                wf.writeframes(pcm.tobytes())
            nfe_step = _infer_nfe_step()
            speed = _infer_speed()
            print(f"[f5-tts-service] warm-up infer (nfe_step={nfe_step}, speed={speed})...")
            with _engine_lock:
                engine.infer(
                    ref_file=tmp_path,
                    ref_text="Warm up.",
                    gen_text="Ready.",
                    nfe_step=nfe_step,
                    speed=speed,
                    show_info=lambda *_args, **_kwargs: None,
                    progress=None,
                )
            print("[f5-tts-service] warm-up complete")
            logger.info("F5-TTS warm-up complete (nfe_step=%s, speed=%s)", nfe_step, speed)
        finally:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except OSError:
                pass
    except Exception as exc:  # noqa: BLE001
        print(f"[f5-tts-service] warm-up skipped: {exc}")
        logger.warning("F5-TTS warm-up skipped: %s", exc)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _engine
    _engine = _load_engine()
    _warmup_engine(_engine)
    yield
    _engine = None


app = FastAPI(title="F5-TTS sidecar", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model_loaded": _engine is not None,
        "device": _engine_device,
        "target_sample_rate": _target_sample_rate,
    }


@app.post("/synthesize", response_model=SynthesizeResponse)
def synthesize(body: SynthesizeRequest) -> SynthesizeResponse:
    if _engine is None:
        raise HTTPException(status_code=503, detail="F5-TTS model not loaded")

    ref_path = _validate_ref_path(Path(body.ref_audio_path))
    nfe_step = _infer_nfe_step()
    speed = _infer_speed()
    try:
        with _engine_lock:
            wav, sample_rate, _spec = _engine.infer(
                ref_file=str(ref_path),
                ref_text=body.ref_text,
                gen_text=body.text,
                nfe_step=nfe_step,
                speed=speed,
                show_info=lambda *_args, **_kwargs: None,
                progress=None,
            )
    except Exception as exc:  # noqa: BLE001
        logger.exception("F5-TTS inference failed")
        raise HTTPException(status_code=500, detail=f"F5-TTS inference failed: {exc}") from exc

    pcm = _wav_to_pcm16(wav)
    if not pcm:
        raise HTTPException(status_code=500, detail="F5-TTS returned empty audio")

    return SynthesizeResponse(
        pcm_base64=base64.b64encode(pcm).decode("ascii"),
        sample_rate=int(sample_rate or _target_sample_rate),
    )


@app.post("/transcribe", response_model=TranscribeResponse)
def transcribe_ref(body: TranscribeRequest) -> TranscribeResponse:
    if _engine is None:
        raise HTTPException(status_code=503, detail="F5-TTS model not loaded")

    ref_path = _validate_ref_path(Path(body.ref_audio_path))
    try:
        # First call downloads Whisper weights; keep serialized with infer.
        with _engine_lock:
            ref_text = _engine.transcribe(str(ref_path), language=body.language)
    except Exception as exc:  # noqa: BLE001
        logger.exception("F5-TTS transcription failed")
        raise HTTPException(status_code=500, detail=f"F5-TTS transcription failed: {exc}") from exc

    cleaned = (ref_text or "").strip()
    if not cleaned:
        raise HTTPException(status_code=500, detail="F5-TTS transcription returned empty text")

    return TranscribeResponse(ref_text=cleaned)
