# Agent Bot (Phase 5A–5C)

Programmable HA participant service that joins Jitsi rooms as **Echo**.

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
| `AGENT_DISPLAY_NAME` | `Echo` | Name shown in Jitsi |
| `AGENT_BOT_FAKE_JITSI` | `false` | `true` = API smoke test only (no real Jitsi) |
| `AGENT_BOT_DISABLE_FOCUS` | `false` | `true` = skip Jicofo at join (legacy). Default invites focus with a non-blocking conference-request. |
| `AGENT_BOT_NONBLOCKING_CONFERENCE_REQUEST` | `true` | Lets MUC join complete without waiting for Jicofo `ready=true`. |
| `AGENT_BOT_BRIDGE_TIMEOUT_MS` | `90000` | Wait for JVB media during speak-test |
| `AGENT_BOT_SPEAK_TEST_MS` | `5000` | Tone duration |
| `AGENT_BOT_SPEAK_TEST_HZ` | `440` | Tone frequency |
| `AGENT_BOT_CONNECT_TIMEOUT_MS` | `35000` | XMPP connect timeout |
| `AGENT_BOT_CONFERENCE_TIMEOUT_MS` | `35000` | MUC join timeout |
| `AGENT_BOT_LOG_SDP` | `false` | Debug SDP sanitization if JVB negotiation regresses |
| `AGENT_BOT_LOG_JINGLE` | `false` | Debug raw Jingle `session-initiate` if transport extraction regresses |

## Run (recommended)

Join sends a **non-blocking** conference-request to Jicofo (fast MUC + focus invite). Bridge media is established in the background and again on **speak-test** if needed. At least one browser participant should already be in the room; A+B is the normal HA demo setup.

```powershell
cd agent-bot
$env:JITSI_DOMAIN="meet.uib-study.com"
$env:AGENT_BOT_BACKEND_URL="http://127.0.0.1:8000"
npm run build
npm start
```

## Real server test

1. Start backend: `uvicorn app.main:app --reload --port 8000` (from `backend/`)
2. Start agent-bot (see above)
3. Open frontend with `demo-ha-A` (and optionally `demo-ha-B`); at least one human participant must join `am-demo-ha` first
4. Join Echo:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/agent/join `
  -ContentType "application/json" -Body '{"roomName":"am-demo-ha","displayName":"Echo"}' `
  -TimeoutSec 90
```

5. Confirm **Echo** in the Jitsi participant list.
6. Speak-test (waits for JVB bridge media, then plays tone):

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/agent/speak-test `
  -ContentType "application/json" -Body '{"roomName":"am-demo-ha"}' -TimeoutSec 60
```

7. Status / leave:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/agent/status
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/agent/leave `
  -ContentType "application/json" -Body '{"roomName":"am-demo-ha"}'
```

### Jicofo / bridge troubleshooting

- Logs should show `accepting JVB session-initiate from .../focus`, `JVB bridge media ready`, then `speak-test playing 440Hz...`.
- The headless Node path patches Jingle/SDP because `@roamhq/wrtc` and lib-jitsi disagree on several browser-only SDP details (DTLS/ICE extraction, VP8-only/audio-only SDP, configurable ICE candidate events).
- A later `Renegotiate failed: TypeError: Invalid SDP line` can appear after the tone works; it is currently non-blocking for Phase 5B but should be revisited before long-running listen/TTS sessions.
- If you see `conference request already in flight` with no JVB for 90s, upgrade to the latest agent-bot (retries reset `conferenceRequestSent`).
- Legacy `AGENT_BOT_DISABLE_FOCUS=true` skips Jicofo at join; only use if the default flow fails on your server.

## XMPP transport

By default the bot tries **WebSocket** first, then **BOSH** (`/http-bind`) automatically.

## API smoke test (no Jitsi)

```powershell
$env:AGENT_BOT_FAKE_JITSI="true"
npm run dev
```

## Bot endpoints

- `GET /health`
- `GET /bot/status` — includes `bridgeMedia` (true when JVB session is active)
- `POST /bot/join` — `{ "roomName": "am-demo-ha", "displayName": "Echo" }`
- `POST /bot/leave` — `{ "roomName": "am-demo-ha" }`
- `POST /bot/speak-test` — `{ "roomName": "am-demo-ha" }`
- `POST /bot/speak` — `{ "roomName": "am-demo-ha", "audioBase64": "...", "sampleRate": 24000, "durationMs": 3200, "text": "..." }` (normally called by backend after TTS)
