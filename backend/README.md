# Backend (FastAPI)

## Run (Windows PowerShell)

Create a venv, install deps, and start the API:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Requires **Python 3.10+** (3.12 recommended). The codebase uses modern type syntax (`str | None`) that FastAPI evaluates at import time.

### Troubleshooting

If you upgraded Python in an existing env and see `No module named 'pydantic_core._pydantic_core'`, reinstall the native wheels:

```powershell
pip install --force-reinstall --no-cache-dir -r requirements.txt
```

That error means `pydantic-core` was built for an older Python (e.g. `cp39`) than the interpreter you are running.

## Environment variables

Copy `backend/.env.example` to `backend/.env` and set your OpenAI key:

```powershell
cd backend
Copy-Item .env.example .env
# Edit .env and set OPENAI_API_KEY=sk-...
```

The API loads `backend/.env` automatically on startup. You can still override any variable in PowerShell for a single session:

```powershell
$env:OPENAI_API_KEY="sk-..."
```

Key variables:

- `OPENAI_API_KEY` — required for TTS and agent LLM
- `AGENT_LLM_MODEL` — default `gpt-5-nano`
- `TTS_VOICE_MALE` / `TTS_VOICE_FEMALE` — OpenAI voices for HA generic TTS (`onyx` / `nova` by default)
- `AGENT_TRIGGER_PHRASES` — default wake phrase list (comma-separated); per-token override via `agentTriggerPhrases`
- `AGENT_TRANSCRIPT_MAX_CHARS` — transcript budget for the agent LLM (default `12000`)
- `AGENT_ROUTING_TRANSCRIPT_MAX_CHARS` — smaller transcript budget for routing LLM calls (default `2500`)
- `AGENT_CALIBRATION_TRANSCRIPT_MAX_CHARS` — transcript budget when calibration polish is on (default `2000`)
- `AGENT_LLM_MAX_TOKENS` — token budget for LLM replies (default `600`). For reasoning models (gpt-5*) this covers hidden reasoning tokens plus visible output; too low a value makes replies come back empty
- `AGENT_LLM_REASONING_EFFORT` — reasoning effort for gpt-5*/o* models: `minimal` / `low` / `medium` / `high` (default `low`; keeps replies fast and leaves budget for visible output)
- `AGENT_CALIBRATION_LLM_POLISH` — set `true` to run an extra LLM pass on calibration replies (default `false`; template-only is faster)
- `AGENT_TRIGGER_ALIASES_EXTRA` — extra literal STT mishearings of "echo" (comma-separated), merged with built-in aliases (`eko`, `eco`, `ekko`, `ecco`, `hecho`, `ako`, `ayako`, `aiko`)
- `F5_TTS_SERVICE_URL` — HTTP sidecar for `cloned_voice_tts` (default `http://127.0.0.1:8765`; see [`f5-tts-service/README.md`](../f5-tts-service/README.md))
- `F5_TTS_REQUEST_TIMEOUT_SEC` — clone synthesis timeout (default `120`)
- `FFMPEG_PATH` — optional path to `ffmpeg` (converts WebM voice samples to WAV for F5-TTS)

## Data storage

Append-only JSONL files under `backend/data/` by default (override with `BACKEND_DATA_DIR`).

## Example study tokens (for quick testing)

An example token registry is provided at `backend/data/token_registry.example.jsonl`.

To use it, copy it to `backend/data/token_registry.jsonl` before starting the API.

HA tokens include:

- `demo-ha-C-trip` — role **`proxy`**, `scenario: weekend_trip`, `calibrationDropQuestionIndex: 2`, `voiceOutputMode: generic_tts`, `ttsVoiceGender: female`, wake phrase `echo`
- `demo-ha-C-trip-male` — same scenario with `ttsVoiceGender: male`
- `demo-ha-C-trip-clone` — role **`proxy`**, clone arm (`voiceOutputMode: cloned_voice_tts`); requires **f5-tts-service** running (see below)

Person C is routed to the Agent Console (Phase 6A), not Jitsi. Re-copy the example file if you created your registry before scenarios were added.

### Scenarios and calibration

Each HA proxy token can set:

- `scenario` — one of `weekend_trip`, `birthday_party`, `team_building_seminar`
- `calibrationDropQuestionIndex` — `0`–`4`; that question is skipped during onboarding (study intervention #1)
- `maxInterventions` — default `3`
- `agentTriggerPhrases` — wake phrases for the embodied agent (default `["echo"]`)
- `agentDisplayName` — Jitsi / console name (default `Echo`)
- `ttsVoiceGender` — `male` or `female` for `generic_tts` (maps to OpenAI `onyx` / `nova`)

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
- `POST /api/agent-profile/complete` — marks onboarding done and **auto-joins Echo** in the room

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

`POST /api/agent/speak` accepts `{ "roomName": "am-demo-ha", "text": "Hello everyone." }` and uses OpenAI speech synthesis before forwarding PCM audio to `agent-bot`. Voice gender is resolved from the proxy token's `ttsVoiceGender` when a profile exists for the room.

Set `OPENAI_API_KEY` in `backend/.env` (see above).

Optional overrides in `.env`:

```env
TTS_VOICE_MALE=onyx
TTS_VOICE_FEMALE=nova
TTS_MODEL=tts-1
```

### Voice clone TTS (Phase 5D)

Tokens with `voiceOutputMode: cloned_voice_tts` (e.g. `demo-ha-C-trip-clone`) use [F5-TTS](https://github.com/SWivid/F5-TTS) via a separate sidecar — **not** OpenAI TTS.

1. Start **f5-tts-service** (see [`f5-tts-service/README.md`](../f5-tts-service/README.md))
2. Set `F5_TTS_SERVICE_URL` in `backend/.env` (default `http://127.0.0.1:8765`)
3. Ensure **ffmpeg** is on PATH (converts browser WebM voice samples to WAV)
4. Person C records a voice sample during onboarding (existing clone-arm flow)
5. Echo speaks with the cloned voice when triggered in the meeting

`generic_tts` tokens are unchanged and still use OpenAI.

Example:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/agent/speak `
  -ContentType "application/json" `
  -Body '{"roomName":"am-demo-ha-trip","text":"Hello from the clone arm.","voiceMode":"cloned_voice_tts"}' `
  -TimeoutSec 180
```

Generic TTS example:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/agent/speak `
  -ContentType "application/json" `
  -Body '{"roomName":"am-demo-ha","text":"Hello, this is Echo speaking through TTS."}' `
  -TimeoutSec 180
```

## Study flow (HA demo)

1. Start backend, **f5-tts-service** (clone arm only), agent-bot, and frontend.
2. Person A joins Jitsi with `demo-ha-A` (moderator should be in the room first).
3. Person B joins with `demo-ha-B`.
4. Person C opens Agent Console with `demo-ha-C-trip` or `demo-ha-C-trip-clone`.
5. C completes onboarding; Echo joins automatically when onboarding finishes.
6. In the meeting, A or B must say **Echo** in the same utterance to trigger a draft or proxy question.
