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
- `http://localhost:5173/?token=demo-ha-C-trip` → **Agent Console** (generic TTS, female voice, scenario `weekend_trip`, wake phrase `echo`)
- `http://localhost:5173/?token=demo-ha-C-trip-male` → **Agent Console** (generic TTS, male voice, same scenario)
- `http://localhost:5173/?token=demo-ha-C-trip-clone` → **Agent Console** (clone arm, same scenario; speak fails until Phase 5D)

Phase 6B/7: Person C sees a fixed **Echo** introduction, scenario calibration questions, records a voice sample only on the clone arm, then Echo joins the meeting automatically. Live prompts (approve / edit / reject) appear when A or B address Echo by name in the meeting.
- `http://localhost:5173/?token=demo-ha-C-party` → birthday party scenario
- `http://localhost:5173/?token=demo-ha-C-seminar` → team-building seminar scenario

Scenario calibration questions live in `backend/data/scenarios/*.json`. LLM system prompt template: `backend/data/prompts/agent_system.md`.
