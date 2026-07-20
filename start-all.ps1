<#
.SYNOPSIS
  Start the Agentic Meeting local stack (backend + agent-bot, optional F5-TTS).

.DESCRIPTION
  Opens a separate PowerShell window for each service so logs stay visible.
  Does NOT start the frontend or ngrok — run those separately (see README.md).

.PARAMETER WithF5
  Also start the F5-TTS clone-voice sidecar (conda env by default).

.PARAMETER F5CondaEnv
  Conda environment name for F5-TTS (default: agentic-f5).

.EXAMPLE
  .\start-all.ps1

.EXAMPLE
  .\start-all.ps1 -WithF5
#>
param(
    [switch]$WithF5,
    [string]$F5CondaEnv = "agentic-f5"
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

function Assert-Path([string]$Path, [string]$Hint) {
    if (-not (Test-Path $Path)) {
        throw "$Hint`nMissing: $Path"
    }
}

Assert-Path (Join-Path $Root "backend\.env") "Copy backend\.env.example to backend\.env and set OPENAI_API_KEY."
Assert-Path (Join-Path $Root "backend\.venv\Scripts\Activate.ps1") "Create the backend venv first (see README.md)."
Assert-Path (Join-Path $Root "agent-bot\package.json") "agent-bot folder missing."
Assert-Path (Join-Path $Root "agent-bot\node_modules") "Run npm install inside agent-bot/ first."

$tokenRegistry = Join-Path $Root "backend\data\token_registry.jsonl"
if (-not (Test-Path $tokenRegistry)) {
    $example = Join-Path $Root "backend\data\token_registry.example.jsonl"
    if (Test-Path $example) {
        Copy-Item $example $tokenRegistry
        Write-Host "Created backend\data\token_registry.jsonl from the example file."
    } else {
        Write-Warning "No token_registry.jsonl found — resolve-token will 404 until you add one."
    }
}

Write-Host "Starting backend on http://127.0.0.1:8000 ..."
Start-Process powershell -WorkingDirectory (Join-Path $Root "backend") -ArgumentList @(
    "-NoExit",
    "-Command",
    "& { .\.venv\Scripts\Activate.ps1; uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 }"
)

Write-Host "Starting agent-bot on http://127.0.0.1:3001 ..."
Start-Process powershell -WorkingDirectory (Join-Path $Root "agent-bot") -ArgumentList @(
    "-NoExit",
    "-Command",
    "& { .\start.ps1 }"
)

if ($WithF5) {
    Assert-Path (Join-Path $Root "f5-tts-service\.env") "Copy f5-tts-service\.env.example to .env and set F5_TTS_ALLOWED_AUDIO_ROOTS."
    Write-Host "Starting F5-TTS sidecar on http://127.0.0.1:8765 (conda env: $F5CondaEnv) ..."
    $f5Dir = Join-Path $Root "f5-tts-service"
    Start-Process powershell -WorkingDirectory $f5Dir -ArgumentList @(
        "-NoExit",
        "-Command",
        "& { `$env:F5_CONDA_ENV='$F5CondaEnv'; .\start.ps1 }"
    )
} else {
    Write-Host "Skipping F5-TTS (generic OpenAI TTS only). Re-run with -WithF5 for clone voice."
}

Write-Host ""
Write-Host "Stack launch requested."
Write-Host "  Backend:   http://127.0.0.1:8000/docs"
Write-Host "  Agent-bot: http://127.0.0.1:3001/health"
if ($WithF5) {
    Write-Host "  F5-TTS:    http://127.0.0.1:8765/health"
}
Write-Host ""
Write-Host "Next: start the frontend in another terminal:"
Write-Host "  cd frontend; npm run dev"
Write-Host "See README.md for ngrok / production build steps."
