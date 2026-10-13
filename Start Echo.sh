#!/usr/bin/env bash
# Double-click (or run) to start Echo: backend, main model, decision model and the UI.
# If Echo is already running, it just opens the UI again.
cd "$(dirname "$(readlink -f "$0")")"
export PATH="/usr/local/bin:/usr/bin:$HOME/.local/bin:$PATH"

note() { command -v notify-send >/dev/null && notify-send -a Echo "$@"; }

if ./echo status 2>/dev/null | grep -q "^Echo running"; then
  ./echo open
  note "Echo" "Already running — opened the UI."
  exit 0
fi

note "Echo" "Starting… models load in the background (~15 s)."
if out=$(./echo up 2>&1); then
  note "Echo" "Ready at http://127.0.0.1:7777"
else
  note -u critical "Echo failed to start" "$(echo "$out" | tail -5)"
  echo "$out"
  exit 1
fi
