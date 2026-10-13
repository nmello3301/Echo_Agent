# One-time setup of Echo on a Windows device for Docker Desktop: fetch Hugin, make the data folders, write .env.
# Run in PowerShell from the repo folder:  .\setup.ps1   (if blocked: powershell -ExecutionPolicy Bypass -File setup.ps1)
# Safe to run again: an existing .env is kept.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if ((Test-Path .gitmodules) -and (Test-Path .git)) { git submodule update --init --recursive }
if (-not (Test-Path vendor/HuginVoiceNotes/docker-compose.yml)) { throw "vendor/HuginVoiceNotes is missing: clone the repo with --recursive" }
foreach ($d in "models", "data/hugin/models", "data/hugin/ollama", "data/hugin/ntfy") { New-Item -ItemType Directory -Force -Path $d | Out-Null }

if (Test-Path .env) {
  Write-Host ".env already exists; leaving it as it is."
} else {
  function Rand([int]$n) { -join ((1..$n) | ForEach-Object { "{0:x2}" -f (Get-Random -Maximum 256) }) }
  $projects = Join-Path $env:USERPROFILE "Projects"
  New-Item -ItemType Directory -Force -Path $projects | Out-Null
  # IANA time zone name for the containers (PowerShell 7 can convert it; Windows PowerShell 5 falls back to UTC)
  $tz = "UTC"
  try { $iana = $null; if ([TimeZoneInfo]::TryConvertWindowsIdToIanaId([TimeZoneInfo]::Local.Id, [ref]$iana)) { $tz = $iana } } catch {}
  $text = (Get-Content .env.example -Raw) `
    -replace "(?m)^HUGIN_API_TOKEN=.*", "HUGIN_API_TOKEN=$(Rand 32)" `
    -replace "(?m)^HUGIN_UI_PASSWORD=.*", "HUGIN_UI_PASSWORD=$(Rand 8)" `
    -replace "(?m)^PROJECTS_DIR=.*", "PROJECTS_DIR=$($projects -replace '\\', '/')" `
    -replace "(?m)^PROJECTS_MOUNT=.*", "PROJECTS_MOUNT=/projects" `
    -replace "(?m)^TZ=.*", "TZ=$tz"
  # UTF-8 without a BOM and with LF line ends, which Docker Compose reads cleanly
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot ".env"), ($text -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
  Write-Host "Wrote .env (Hugin UI password: $((Select-String -Path .env -Pattern '^HUGIN_UI_PASSWORD=(.*)').Matches[0].Groups[1].Value))"
  Write-Host "The agent works in $projects; in the Agent tab its paths start with /projects/"
}

docker info --format "{{.Name}}" *> $null
if ($LASTEXITCODE -ne 0) { Write-Warning "Can't reach Docker: start Docker Desktop (WSL2 backend) first." }
Write-Host "Next: docker compose up -d --build    then open http://127.0.0.1:7777"
