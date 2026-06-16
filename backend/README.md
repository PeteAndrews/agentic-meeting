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

HA tokens include:

- `demo-ha-C-trip` — role **`proxy`**, `scenario: weekend_trip`, `calibrationDropQuestionIndex: 2`, `voiceOutputMode: generic_tts`
- `demo-ha-C-trip-clone` — role **`proxy`**, clone arm for the same scenario

Person C is routed to the Agent Console (Phase 6A), not Jitsi. Re-copy the example file if you created your registry before scenarios were added.

### Scenarios and calibration

Each HA proxy token can set:

- `scenario` — one of `weekend_trip`, `birthday_party`, `team_building_seminar`
- `calibrationDropQuestionIndex` — `0`–`4`; that question is skipped during onboarding (study intervention #1)
- `maxInterventions` — default `3`

Scenario content (editable JSON):

- `backend/data/scenarios/weekend_trip.json`
- `backend/data/scenarios/birthday_party.json`
- `backend/data/scenarios/team_building_seminar.json`

LLM system prompt template (editable):

- `backend/data/prompts/agent_system.md`

API:

- `GET /api/scenarios/{scenarioId}`
- `GET /api/agent-profile/calibration-plan`
- `POST /api/agent-profile/calibration-answer`
- `GET /api/agent/prompts` — live approve/edit/reject queue (Phase 6C)

### Agent profile / onboarding (Phase 6B)

Proxy users complete a short onboarding in the Agent Console. Profiles are stored under `backend/data/agent_profiles/` (gitignored). Voice samples under `backend/data/voice_samples/`.

- `GET /api/agent-profile?roomName=...&participantId=...&voiceOutputMode=...`
- `PUT /api/agent-profile`
- `POST /api/agent-profile/voice-sample` (clone arm only)
- `POST /api/agent-profile/complete` — marks onboarding done and **auto-joins Agent C** in the room

`voiceOutputMode` is pre-assigned on the proxy token and returned from `POST /api/resolve-token`.

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

## Study flow (HA demo)

1. Start backend, agent-bot, and frontend.
2. Person A joins Jitsi with `demo-ha-A` (moderator should be in the room first).
3. Person B joins with `demo-ha-B`.
4. Person C opens Agent Console with `demo-ha-C` or `demo-ha-C-clone`.
5. C completes onboarding; Agent C joins automatically when onboarding finishes.
