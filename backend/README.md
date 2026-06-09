# Backend (FastAPI)

## Run (Windows PowerShell)

Create a venv, install deps, and start the API:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install fastapi uvicorn pydantic
uvicorn app.main:app --reload --port 8000
```

## Data storage

Append-only JSONL files under `backend/data/` by default (override with `BACKEND_DATA_DIR`).

## Example study tokens (for quick testing)

An example token registry is provided at `backend/data/token_registry.example.jsonl`.

To use it, copy it to `backend/data/token_registry.jsonl` before starting the API.

HA tokens include `demo-ha-C` with role **`proxy`** — Person C is routed to the Agent Console (Phase 6A), not Jitsi. Re-copy the example file if you created your registry before 6A.

## Dev token convenience

By default, `POST /api/resolve-token` returns 404 for unknown tokens. For quick local testing:

```powershell
$env:ALLOW_TOKEN_AUTO_CREATE="true"
```

## Agent bot proxy endpoints (Phase 5A–5C)

Backend exposes thin proxy endpoints for the separate `agent-bot` service:

- `POST /api/agent/join`
- `POST /api/agent/leave`
- `GET /api/agent/status`
- `POST /api/agent/speak-test` — plays ~440 Hz tone (A+B should be in room first; bot requests JVB on demand)
- `POST /api/agent/speak` — TTS text → OpenAI → publish speech in Jitsi (Phase 5C)

Configure bot URL with:

```powershell
$env:AGENT_BOT_BASE_URL="http://127.0.0.1:3001"
```

### TTS (Phase 5C)

`POST /api/agent/speak` accepts `{ "roomName": "am-demo-ha", "text": "Hello everyone." }` and uses OpenAI speech synthesis before forwarding PCM audio to `agent-bot`.

Required:

```powershell
$env:OPENAI_API_KEY="sk-..."
```

Optional:

```powershell
$env:TTS_VOICE="alloy"   # OpenAI voice name
$env:TTS_MODEL="tts-1"
```

Example:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/agent/speak `
  -ContentType "application/json" `
  -Body '{"roomName":"am-demo-ha","text":"Hello, this is Agent C speaking through TTS."}' `
  -TimeoutSec 180
```

