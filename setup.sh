#!/usr/bin/env bash
# One-time setup of Echo on a Linux device for Docker: fetch Hugin, make the data folders, write .env.
# Safe to run again: an existing .env is kept.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

if [[ -f .gitmodules && -d .git ]]; then git submodule update --init --recursive; fi
[[ -f vendor/HuginVoiceNotes/docker-compose.yml ]] || { echo "vendor/HuginVoiceNotes is missing: clone the repo with --recursive"; exit 1; }
mkdir -p models data/hugin/models data/hugin/ollama data/hugin/ntfy

if [[ -f .env ]]; then
  echo ".env already exists; leaving it as it is."
else
  rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  esc() { printf '%s' "$1" | sed -e 's/[|&\\]/\\&/g'; }  # for the sed replacements below
  # Reuse a native Hugin install's secrets, so its clients and login keep working
  old=vendor/HuginVoiceNotes/.env
  token=$( [[ -f $old ]] && grep -m1 '^HUGIN_API_TOKEN=' "$old" | cut -d= -f2- || true )
  pass=$( [[ -f $old ]] && grep -m1 '^HUGIN_UI_PASSWORD=' "$old" | cut -d= -f2- || true )
  tz=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)
  mkdir -p "$HOME/Projects"
  sed -e "s|^HUGIN_API_TOKEN=.*|HUGIN_API_TOKEN=$(esc "${token:-$(rand)}")|" \
      -e "s|^HUGIN_UI_PASSWORD=.*|HUGIN_UI_PASSWORD=$(esc "${pass:-$(rand | head -c 16)}")|" \
      -e "s|^PROJECTS_DIR=.*|PROJECTS_DIR=$(esc "$HOME/Projects")|" \
      -e "s|^PROJECTS_MOUNT=.*|PROJECTS_MOUNT=$(esc "$HOME/Projects")|" \
      -e "s|^ECHO_UID=.*|ECHO_UID=$(id -u)|" \
      -e "s|^ECHO_GID=.*|ECHO_GID=$(id -g)|" \
      -e "s|^TZ=.*|TZ=$tz|" .env.example > .env
  chmod 600 .env
  echo "Wrote .env (Hugin UI password: $(grep '^HUGIN_UI_PASSWORD=' .env | cut -d= -f2-))"
fi

# A credential helper left behind by Docker Desktop breaks every image pull
if grep -q '"credsStore": *"desktop"' "${DOCKER_CONFIG:-$HOME/.docker}/config.json" 2>/dev/null && ! command -v docker-credential-desktop >/dev/null; then
  echo "WARNING: ~/.docker/config.json has \"credsStore\": \"desktop\" but Docker Desktop isn't installed, so pulls fail."
  echo "         Remove that line (or the whole file if you have no registry logins), then continue."
fi
docker info --format '{{.Name}}' >/dev/null 2>&1 || echo "WARNING: can't reach Docker (is it running, and are you in the docker group?)"

echo "Next: docker compose up -d --build    then open http://127.0.0.1:${ECHO_PORT:-7777}"
