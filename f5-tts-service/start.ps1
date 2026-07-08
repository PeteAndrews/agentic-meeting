# Start the F5-TTS sidecar, loading settings from f5-tts-service/.env
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

$venvActivate = Join-Path $PSScriptRoot ".venv\Scripts\Activate.ps1"
if (-not (Test-Path $venvActivate)) {
    Write-Error "Missing .venv — run: python -m venv .venv; pip install -r requirements.txt"
}

Write-Host "F5-TTS sidecar starting on http://${listenHost}:${port}/"
Write-Host "F5_TTS_ALLOWED_AUDIO_ROOTS=$($env:F5_TTS_ALLOWED_AUDIO_ROOTS)"

. $venvActivate
python -m uvicorn main:app --host $listenHost --port $port
