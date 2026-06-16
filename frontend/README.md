# Frontend (Vite + React)

## Run (Windows PowerShell)

```powershell
cd frontend
npm install
npm run dev
```

The app will be available at `http://localhost:5173/`.

## Backend proxy

During dev, requests to `/api/*` are proxied to `http://127.0.0.1:8000` via `vite.config.ts`.

## Jitsi (self-hosted)

Meetings use the self-hosted Jitsi domain `meet.uib-study.com` by default (loads `https://meet.uib-study.com/external_api.js`). Override with `VITE_JITSI_DOMAIN` in `.env.development` or `.env.production`.

## Quick test tokens

If you copied `backend/data/token_registry.example.jsonl` to `backend/data/token_registry.jsonl`, you can test:

**HH (Human–Human):**

- `http://localhost:5173/?token=demo-hh-A` → Jitsi meeting (moderator)
- `http://localhost:5173/?token=demo-hh-B` → Jitsi meeting (active)
- `http://localhost:5173/?token=demo-hh-C` → Jitsi meeting (silent / muted)

**HA (Human–Agent):**

- `http://localhost:5173/?token=demo-ha-A` → Jitsi meeting (moderator)
- `http://localhost:5173/?token=demo-ha-B` → Jitsi meeting (active)
- `http://localhost:5173/?token=demo-ha-C` → **Agent Console** (proxy; OpenAI TTS arm — intro only, then auto-join)
- `http://localhost:5173/?token=demo-ha-C-clone` → **Agent Console** (proxy; clone arm — intro + voice read-aloud, then auto-join)

Phase 6B: Person C sees a fixed Agent C introduction, scenario calibration questions, records a voice sample only on the clone arm, then Agent C joins the meeting automatically. Live prompts (approve / edit / reject) are available in the Agent Console after onboarding.

**HA scenario tokens (weekend trip example):**

- `http://localhost:5173/?token=demo-ha-A` → Jitsi meeting (moderator, weekend trip room)
- `http://localhost:5173/?token=demo-ha-B` → Jitsi meeting (active)
- `http://localhost:5173/?token=demo-ha-C-trip` → **Agent Console** (generic TTS, scenario `weekend_trip`, drops calibration question index 2)
- `http://localhost:5173/?token=demo-ha-C-trip-clone` → **Agent Console** (clone arm, same scenario)
- `http://localhost:5173/?token=demo-ha-C-party` → birthday party scenario
- `http://localhost:5173/?token=demo-ha-C-seminar` → team-building seminar scenario

Scenario calibration questions live in `backend/data/scenarios/*.json`. LLM system prompt template: `backend/data/prompts/agent_system.md`.
