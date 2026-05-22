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

- `http://localhost:5173/?token=demo-hh-A`
- `http://localhost:5173/?token=demo-hh-B`
- `http://localhost:5173/?token=demo-hh-C` (joins muted by default)

