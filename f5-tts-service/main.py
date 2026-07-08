from __future__ import annotations

import base64
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

_engine: Any = None
_target_sample_rate = 24_000


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4096)
    ref_audio_path: str = Field(min_length=1, max_length=1024)
    ref_text: str = Field(min_length=1, max_length=8000)


class SynthesizeResponse(BaseModel):
    pcm_base64: str
    sample_rate: int


def _load_engine() -> Any:
    from f5_tts.api import F5TTS

    device = os.environ.get("F5_TTS_DEVICE", "").strip() or None
    model = os.environ.get("F5_TTS_MODEL", "F5TTS_v1_Base").strip() or "F5TTS_v1_Base"
    logger.info("Loading F5-TTS model %s (device=%s)", model, device or "auto")
    engine = F5TTS(model=model, device=device)
    global _target_sample_rate
    _target_sample_rate = int(getattr(engine, "target_sample_rate", 24_000))
    logger.info("F5-TTS ready (target_sample_rate=%s)", _target_sample_rate)
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
        p.resolve()
        for raw in os.environ.get("F5_TTS_ALLOWED_AUDIO_ROOTS", "").split(os.pathsep)
        if raw.strip()
    ]
    if allowed_roots and not any(resolved.is_relative_to(root) for root in allowed_roots):
        raise HTTPException(status_code=403, detail="Reference audio path is outside allowed roots")
    return resolved


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _engine
    _engine = _load_engine()
    yield
    _engine = None


app = FastAPI(title="F5-TTS sidecar", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model_loaded": _engine is not None,
        "target_sample_rate": _target_sample_rate,
    }


@app.post("/synthesize", response_model=SynthesizeResponse)
def synthesize(body: SynthesizeRequest) -> SynthesizeResponse:
    if _engine is None:
        raise HTTPException(status_code=503, detail="F5-TTS model not loaded")

    ref_path = _validate_ref_path(Path(body.ref_audio_path))
    try:
        wav, sample_rate, _spec = _engine.infer(
            ref_file=str(ref_path),
            ref_text=body.ref_text,
            gen_text=body.text,
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
