# Agent Bot (Phase 5A)

Programmable HA participant service that joins Jitsi rooms as `Agent C`.

## Prerequisites

- Node.js 20+ recommended (matches `@roamhq/wrtc` prebuilds)
- Network access to `meet.uib-study.com` (or your `JITSI_DOMAIN`)
- Backend running on port 8000 for event logging

## Install

```powershell
cd agent-bot
npm install
npm run build
```

`@roamhq/wrtc` provides WebRTC in Node. If install fails on Windows, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with **Desktop development with C++**, then retry.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENT_BOT_PORT` | `3001` | Bot HTTP API port |
| `JITSI_DOMAIN` | `meet.uib-study.com` | Jitsi host (no protocol) |
| `JITSI_LIB_URL` | `https://{domain}/libs/lib-jitsi-meet.min.js` | lib-jitsi-meet bundle from your server |
| `JITSI_SERVICE_URL` | `wss://{domain}/xmpp-websocket` | Primary XMPP transport (WebSocket) |
| `JITSI_BOSH_URL` | `https://{domain}/http-bind` | BOSH fallback if WebSocket fails |
| `AGENT_BOT_BACKEND_URL` | `http://127.0.0.1:8000` | FastAPI for event logging |
| `AGENT_DISPLAY_NAME` | `Agent C` | Name shown in Jitsi |
| `AGENT_BOT_FAKE_JITSI` | `false` | `true` = API smoke test only (no real Jitsi) |
| `AGENT_BOT_CONNECT_TIMEOUT_MS` | `20000` | XMPP connect timeout |
| `AGENT_BOT_CONFERENCE_TIMEOUT_MS` | `20000` | MUC join timeout |

## Run (real Jitsi join)

```powershell
cd agent-bot
$env:JITSI_DOMAIN="meet.uib-study.com"
$env:AGENT_BOT_BACKEND_URL="http://127.0.0.1:8000"
npm run dev
```

Do **not** set `AGENT_BOT_FAKE_JITSI` for real server tests.

## Real server test (with A + B in the meeting)

1. Start backend: `uvicorn app.main:app --reload --port 8000` (from `backend/`)
2. Start agent-bot: `npm run dev` (from `agent-bot/`)
3. Open frontend with `demo-ha-A` and `demo-ha-B`; both join room `am-demo-ha`
4. Join the bot:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/agent/join `
  -ContentType "application/json" -Body '{"roomName":"am-demo-ha","displayName":"Agent C"}'
```

5. Confirm in Jitsi: **Agent C** appears in the participant list (silent, no mic track).
6. Check status:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/agent/status
```

7. Leave:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/agent/leave `
  -ContentType "application/json" -Body '{"roomName":"am-demo-ha"}'
```

## XMPP transport

By default the bot tries **WebSocket** first, then **BOSH** (`/http-bind`) automatically.

To force BOSH only:

```powershell
$env:JITSI_SERVICE_URL="https://meet.uib-study.com/http-bind"
npm start
```

## API smoke test (no Jitsi)

```powershell
$env:AGENT_BOT_FAKE_JITSI="true"
npm run dev
```

## Bot endpoints

- `GET /health`
- `GET /bot/status`
- `POST /bot/join` — `{ "roomName": "am-demo-ha", "displayName": "Agent C" }`
- `POST /bot/leave` — `{ "roomName": "am-demo-ha" }`
- `POST /bot/speak-test` — placeholder (Task 2)
