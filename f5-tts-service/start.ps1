# Start the F5-TTS sidecar.
# Preferred: conda env (set F5_CONDA_ENV, default agentic-f5).
# Fallback: local .venv if present.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# hf_xet can crash on some Windows CPUs during Hugging Face downloads; .env can override.
if (-not $env:HF_HUB_DISABLE_XET) {
    $env:HF_HUB_DISABLE_XET = "1"
}

$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Error "Missing .env — copy .env.example to .env and set F5_TTS_ALLOWED_AUDIO_ROOTS."
}

Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) {
        return
    }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) {
        return
    }
    $name = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim()
    if (
        ($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    Set-Item -Path "Env:$name" -Value $value
}

$listenHost = if ($env:F5_TTS_HOST) { $env:F5_TTS_HOST } else { "127.0.0.1" }
$port = if ($env:F5_TTS_PORT) { $env:F5_TTS_PORT } else { "8765" }
$condaEnv = if ($env:F5_CONDA_ENV) { $env:F5_CONDA_ENV } else { "agentic-f5" }

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
$useConda = $true
try {
    $null = Get-Command conda -ErrorAction Stop
} catch {
    $useConda = $false
}

Write-Host "F5-TTS sidecar starting on http://${listenHost}:${port}/"
Write-Host "F5_TTS_ALLOWED_AUDIO_ROOTS=$($env:F5_TTS_ALLOWED_AUDIO_ROOTS)"

if ($useConda) {
    Write-Host "Using conda env: $condaEnv"
    # conda run keeps activation inside the child process (reliable from scripts).
    conda run -n $condaEnv --no-capture-output python -m uvicorn main:app --host $listenHost --port $port
    exit $LASTEXITCODE
}

if (Test-Path $venvPython) {
    Write-Host "Conda not found — falling back to .venv"
    & $venvPython -m uvicorn main:app --host $listenHost --port $port
    exit $LASTEXITCODE
}

Write-Error @"
No Python environment found for F5-TTS.
Preferred:
  conda create -n $condaEnv python=3.11 -y
  conda activate $condaEnv
  pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
  pip install -r requirements.txt
Fallback:
  python -m venv .venv
  .\.venv\Scripts\Activate.ps1
  pip install -r requirements.txt
"@
