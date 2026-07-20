# Agentic Meeting

Human–agent meeting prototype: participants join a Jitsi room while **Echo** (an embodied agent) can listen, think, and speak. A separate **Agent Console** lets a proxy user (User C) calibrate Echo and approve answers.

This README is the colleague onboarding guide: architecture, one-time setup, how to run each piece, and how **ngrok** fits in.

---

## Architecture (what talks to what)

```text
Browser (frontend :5173 or static host)
    │  REST / WS  (/api/*)
    ▼
FastAPI backend (:8000)
    ├── Deepgram STT (optional, STT_MODE=server_per_client)
    ├── OpenAI (LLM + generic TTS)
    ├── F5-TTS sidecar (:8765)          ← clone-voice arm only
    └── agent-bot (:3001)
            └── joins Jitsi (meet.uib-study.com) as "Echo"
```

| Service | Port | Role |
|---------|------|------|
| **frontend** | `5173` (dev) | Lobby, Jitsi embed, Agent Console |
| **backend** | `8000` | Tokens, transcripts, agent loop, TTS orchestration |
| **agent-bot** | `3001` | Headless Jitsi participant that plays TTS / ambient audio |
| **f5-tts-service** | `8765` | Optional voice-clone TTS (not needed for generic OpenAI TTS) |

Jitsi itself is hosted at **`meet.uib-study.com`** (not run from this repo).

---

## Prerequisites

- **Windows** (PowerShell) — primary path documented here
- **Python 3.10+** (3.12 recommended for backend)
- **Node.js 20+**
- **ffmpeg** on PATH (voice-sample conversion + waiting-audio decode)
- **OpenAI API key**
- Network access to `meet.uib-study.com`
- Optional for clone voice:
  - **Miniconda / Anaconda**
  - NVIDIA GPU + CUDA-capable PyTorch
  - Deepgram key only if using `STT_MODE=server_per_client`

---

## Recommended environments

| Piece | Environment | Why |
|-------|-------------|-----|
| **backend** | local **`venv`** in `backend/.venv` | Lightweight FastAPI deps |
| **f5-tts-service** | **conda** env `agentic-f5` | Heavy PyTorch / CUDA stack — keep isolated |
| **agent-bot** | Node / npm | No Python |
| **frontend** | Node / npm | No Python |

Do **not** install backend and F5 into the same conda env.

---

## One-time setup

From the repo root:

### 1) Backend (`venv`)

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt

Copy-Item .env.example .env
# Edit .env → set OPENAI_API_KEY=sk-...

Copy-Item .\data\token_registry.example.jsonl .\data\token_registry.jsonl
```

### 2) Agent-bot (Node)

```powershell
cd agent-bot
npm install
Copy-Item .env.example .env
# Defaults are fine for local use (backend at http://127.0.0.1:8000)
```

### 3) Frontend (Node)

```powershell
cd frontend
npm install
Copy-Item .env.example .env.development
# Leave VITE_API_BASE_URL empty for local Vite proxy
```

### 4) F5-TTS (conda) — only for clone-voice testing

```powershell
conda create -n agentic-f5 python=3.11 -y
conda activate agentic-f5

# Install PyTorch with CUDA first — pick the index URL that matches your CUDA from https://pytorch.org
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124

cd f5-tts-service
pip install -r requirements.txt

Copy-Item .env.example .env
# Edit .env → set F5_TTS_ALLOWED_AUDIO_ROOTS to YOUR absolute path, e.g.
# F5_TTS_ALLOWED_AUDIO_ROOTS=D:\Projects\Agentic-Meeting\backend\data\voice_samples
```

First F5 startup downloads model weights (~several GB) and can take several minutes. Keep `HF_HUB_DISABLE_XET=1` (already in `.env.example`) on Windows if downloads crash at 0%.

---

## Quick start (local)

### Option A — helper script (recommended)

Starts **backend** + **agent-bot** in separate PowerShell windows:

```powershell
cd D:\Projects\Agentic-Meeting
.\start-all.ps1
```

Include F5 (clone voice):

```powershell
.\start-all.ps1 -WithF5
```

Then start the frontend yourself:

```powershell
cd frontend
npm run dev
```

Open: http://localhost:5173/

### Option B — start each service manually

**Terminal 1 — backend**

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

**Terminal 2 — agent-bot**

```powershell
cd agent-bot
.\start.ps1
# (builds TypeScript, then npm start)
```

Or during development:

```powershell
cd agent-bot
npm run dev
```

**Terminal 3 — frontend**

```powershell
cd frontend
npm run dev
```

**Terminal 4 — F5 (optional)**

```powershell
cd f5-tts-service
$env:F5_CONDA_ENV="agentic-f5"
.\start.ps1
```

### Health checks

| URL | Expect |
|-----|--------|
| http://127.0.0.1:8000/docs | FastAPI Swagger UI |
| http://127.0.0.1:3001/health | `{ "ok": true, ... }` |
| http://127.0.0.1:8765/health | `{ "ok": true, "model_loaded": true, ... }` |

---

## Build commands

### Frontend (dev vs production)

**Dev** (hot reload, Vite proxies `/api` → backend):

```powershell
cd frontend
npm run dev
```

**Production build** (bundles for a static host / server):

```powershell
cd frontend
Copy-Item .env.production.example .env.production
# Edit .env.production → set VITE_API_BASE_URL to your public backend URL (often ngrok)
npm run build
```

Output is in `frontend/dist/`. Preview locally:

```powershell
npm run preview
```

Important:

- `VITE_*` values are baked in at **build time**. Changing ngrok URL means rebuild.
- In local **dev**, leave `VITE_API_BASE_URL` empty so the Vite proxy handles `/api` (see `vite.config.ts`).
- In **production** builds, set `VITE_API_BASE_URL` to the backend’s public HTTPS URL.

### Agent-bot

```powershell
cd agent-bot
npm run build   # compiles to dist/
npm start       # runs dist/index.js
# or: .\start.ps1
```

### Backend

No separate “build” step — run with uvicorn (see above). Keep the `venv` activated.

### F5-TTS

No separate build — run with uvicorn via `.\start.ps1` (conda env).

---

## Demo tokens (after copying the example registry)

Paste a token on the lobby page, or open with `?token=...`:

**HA (Human–Agent) — typical study path**

| URL | Role |
|-----|------|
| http://localhost:5173/?token=demo-ha-A | Moderator in Jitsi |
| http://localhost:5173/?token=demo-ha-B | Active attendee in Jitsi |
| http://localhost:5173/?token=demo-ha-C-trip | Agent Console (generic TTS, female) |
| http://localhost:5173/?token=demo-ha-C-trip-male | Agent Console (generic TTS, male) |
| http://localhost:5173/?token=demo-ha-C-trip-clone | Agent Console (clone voice — needs F5) |

**Smoke flow**

1. Start backend + agent-bot (+ F5 if clone).
2. Open User A and User B in the meeting.
3. Open User C → complete calibration → Echo auto-joins.
4. In the meeting, say **“Echo …”** in the same utterance to trigger Echo.
5. Approve / answer prompts in the Agent Console.

Wake phrase defaults to **Echo** (fuzzy STT aliases included).

---

## Using ngrok

Use ngrok when browsers outside your machine need to reach the **backend** (and optionally a hosted frontend). Agent-bot and F5 usually stay on localhost; only the backend must be reachable from the frontend.

### Typical pattern (frontend on your PC, backend public)

1. Start the local stack (`.\start-all.ps1`, then `npm run dev` in `frontend`).
2. Tunnel the backend:

```powershell
ngrok http 8000
```

3. Copy the HTTPS URL, e.g. `https://abc123.ngrok-free.app`.
4. Point the frontend at it:

**During Vite dev** — either:

```powershell
# frontend/.env.development
VITE_API_BASE_URL=https://abc123.ngrok-free.app
VITE_DEV_BACKEND_TARGET=http://127.0.0.1:8000
```

…then restart `npm run dev`,

**or** keep `VITE_API_BASE_URL` empty and only use the Vite proxy for same-machine testing (no ngrok needed for pure local).

**For a production frontend build** served to colleagues:

```powershell
# frontend/.env.production
VITE_API_BASE_URL=https://abc123.ngrok-free.app
VITE_JITSI_DOMAIN=meet.uib-study.com
npm run build
```

5. Free ngrok interstitial pages: the frontend already sends `ngrok-skip-browser-warning: true` when `VITE_API_BASE_URL` is set.

### What to tunnel (and what not to)

| Service | Tunnel? | Notes |
|---------|---------|-------|
| **backend :8000** | Yes (usual) | Frontend + STT websocket need this |
| **frontend :5173** | Optional | Only if remote testers should hit Vite itself |
| **agent-bot :3001** | No | Backend calls it on localhost |
| **f5 :8765** | No | Backend calls it on localhost |
| **Jitsi** | No | Already public at `meet.uib-study.com` |

### WebSockets (server STT)

If `STT_MODE=server_per_client`, the browser opens a WebSocket to `/api/stt/stream`. With `VITE_API_BASE_URL=https://….ngrok-free.app`, the client automatically uses `wss://….ngrok-free.app`. Ensure your ngrok agent allows WebSockets (default for `ngrok http`).

### CORS

Backend CORS currently allows:

- `http://localhost:5173` / `http://127.0.0.1:5173`
- `https://uib-study.com` / `https://www.uib-study.com`

If you serve the frontend from another origin (e.g. a frontend ngrok URL), add that origin to `allow_origins` in [`backend/app/main.py`](backend/app/main.py) and restart the backend.

### Agent-bot ↔ backend when using ngrok

Keep:

```env
# agent-bot/.env
AGENT_BOT_BACKEND_URL=http://127.0.0.1:8000
```

```env
# backend/.env
AGENT_BOT_BASE_URL=http://127.0.0.1:3001
F5_TTS_SERVICE_URL=http://127.0.0.1:8765
```

Remote browsers talk to the **ngrok backend URL**; the backend still talks to agent-bot / F5 on localhost.

---

## Environment cheat sheet

### `backend/.env`

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | Yes | LLM + generic TTS |
| `AGENT_BOT_BASE_URL` | No | Default `http://127.0.0.1:3001` |
| `F5_TTS_SERVICE_URL` | No | Default `http://127.0.0.1:8765` |
| `STT_MODE` | No | `browser` (default) or `server_per_client` |
| `DEEPGRAM_API_KEY` | If server STT | Deepgram streaming |
| `FFMPEG_PATH` | If ffmpeg not on PATH | WebM → WAV for clone samples |

### `agent-bot/.env`

| Variable | Purpose |
|----------|---------|
| `AGENT_BOT_BACKEND_URL` | Event logging (`http://127.0.0.1:8000`) |
| `AGENT_BOT_PORT` | Default `3001` |
| `JITSI_DOMAIN` | Default `meet.uib-study.com` |
| `AGENT_BOT_WAITING_AUDIO_GAIN` | Ambient “thinking” volume |

### `f5-tts-service/.env`

| Variable | Purpose |
|----------|---------|
| `F5_TTS_ALLOWED_AUDIO_ROOTS` | Absolute path to `backend/data/voice_samples` |
| `F5_TTS_DEVICE` | `cuda` / `cpu` / omit for auto |
| `F5_TTS_NFE_STEP` | Optional speed/quality knob (default 32) |
| `F5_CONDA_ENV` | Optional; `start.ps1` / `start-all.ps1` default `agentic-f5` |

### Frontend

| File | When |
|------|------|
| `.env.development` | `npm run dev` |
| `.env.production` | `npm run build` |

---

## Troubleshooting

| Symptom | Likely fix |
|---------|------------|
| `OPENAI_API_KEY is not set` | Fill `backend/.env` and restart uvicorn |
| Unknown studyToken / 404 | Copy `token_registry.example.jsonl` → `token_registry.jsonl` |
| Echo never joins | agent-bot running? Check http://127.0.0.1:3001/health and backend logs |
| Clone TTS fails | F5 running? `F5_TTS_ALLOWED_AUDIO_ROOTS` absolute path correct? ffmpeg installed? |
| F5 download dies at 0% | Keep `HF_HUB_DISABLE_XET=1` |
| Browser can’t reach API via ngrok | Rebuild/restart frontend after changing `VITE_API_BASE_URL`; check CORS origins |
| `@roamhq/wrtc` install fails (Windows) | Install VS Build Tools with **Desktop development with C++**, retry `npm install` |
| No audio / STT silent | Mic permissions; for server STT ensure Deepgram key + `STT_MODE=server_per_client` |

More detail lives in the per-service docs:

- [`backend/README.md`](backend/README.md)
- [`agent-bot/README.md`](agent-bot/README.md)
- [`frontend/README.md`](frontend/README.md)
- [`f5-tts-service/README.md`](f5-tts-service/README.md)

---

## Suggested startup order for a live HA demo

1. `.\start-all.ps1` (add `-WithF5` for clone arm)
2. `cd frontend; npm run dev` (or serve a production build)
3. Optional: `ngrok http 8000` if remote browsers need the API
4. Open tokens for Users A, B, then C
5. Complete C’s onboarding → Echo joins → trigger with “Echo …”
