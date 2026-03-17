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

## Dev token convenience

By default, `POST /api/resolve-token` returns 404 for unknown tokens. For quick local testing:

```powershell
$env:ALLOW_TOKEN_AUTO_CREATE="true"
```

