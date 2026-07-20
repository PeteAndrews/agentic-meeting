# F5-TTS sidecar (Phase 5D)

Long-running HTTP service that loads [F5-TTS](https://github.com/SWivid/F5-TTS) once and synthesizes cloned speech for the `cloned_voice_tts` study arm.

The FastAPI backend calls this service; it does **not** replace generic OpenAI TTS.

## Prerequisites

- Python 3.10+ (3.11 recommended)
- **Conda** (recommended) or a local `.venv`
- NVIDIA GPU with CUDA (CPU works but is very slow)
- [ffmpeg](https://ffmpeg.org/) on PATH (backend uses it to convert browser WebM samples to WAV)
- ~4 GB disk for Hugging Face model weights (first run downloads automatically)

## Setup (Windows PowerShell) — conda recommended

```powershell
conda create -n agentic-f5 python=3.11 -y
conda activate agentic-f5

# Install PyTorch with CUDA first — match your CUDA version from https://pytorch.org
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124

cd f5-tts-service
pip install -r requirements.txt
Copy-Item .env.example .env
# Edit .env → set F5_TTS_ALLOWED_AUDIO_ROOTS to your absolute voice_samples path
```

### Fallback: local venv

```powershell
cd f5-tts-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt
Copy-Item .env.example .env
```

## Run

```powershell
cd f5-tts-service
.\start.ps1
```

`start.ps1` prefers conda env `agentic-f5` (override with `$env:F5_CONDA_ENV`), then falls back to `.venv`.

Or from the repo root (with the rest of the stack):

```powershell
.\start-all.ps1 -WithF5
```

First startup downloads model weights and may take several minutes.

### Windows: server exits during `pytorch_model.bin` download

If uvicorn returns to the prompt at 0% during the Vocos/F5 download (no Python traceback), Hugging Face’s `hf_xet` backend is likely crashing on your CPU. Set `HF_HUB_DISABLE_XET=1` (included in `.env.example` and `start.ps1`). The download then uses plain HTTP and should complete.

Health check: `GET http://127.0.0.1:8765/health`

## API

### `POST /synthesize`

```json
{
  "text": "We are meeting in the hotel lobby at 10 a.m.",
  "ref_audio_path": "D:/Projects/Agentic-Meeting/backend/data/voice_samples/am-demo-ha-trip__p-demo-C2-trip-clone.wav",
  "ref_text": "I am recording this sample so Echo can represent my voice..."
}
```

Response:

```json
{
  "pcm_base64": "...",
  "sample_rate": 24000
}
```

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `F5_TTS_PORT` | `8765` | Listen port (`start.ps1` / uvicorn) |
| `F5_TTS_HOST` | `127.0.0.1` | Bind address (`start.ps1`) |
| `F5_TTS_MODEL` | `F5TTS_v1_Base` | F5-TTS model name |
| `F5_TTS_DEVICE` | auto | `cuda`, `cpu`, etc. |
| `F5_TTS_ALLOWED_AUDIO_ROOTS` | (none) | `;`-separated paths; ref audio must live under one |
| `F5_CONDA_ENV` | `agentic-f5` | Conda env name used by `start.ps1` |
| `HF_HUB_DISABLE_XET` | `1` in `.env` / `start.ps1` | Avoid `hf_xet` crash on some Windows hosts during model download |
| `HF_TOKEN` | (none) | Optional Hugging Face token for faster downloads |
| `F5_TTS_NFE_STEP` | `32` | Diffusion steps (lower ≈ faster, modest quality cost) |
| `F5_TTS_SPEED` | `1.0` | Speech speed multiplier |

## Study session startup order

1. **f5-tts-service** (this folder)
2. **backend** (`uvicorn app.main:app --reload --port 8000`)
3. **agent-bot** (`npm start`)
4. Frontend / ngrok as usual

Test token: `demo-ha-C-trip-clone` — record voice sample in Agent Console, then trigger Echo in the meeting.
