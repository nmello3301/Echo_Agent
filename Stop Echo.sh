#!/usr/bin/env bash
# Stops Echo and frees the GPU and RAM (UI, main model, decision model).
cd "$(dirname "$(readlink -f "$0")")"
out=$(./echo down 2>&1)
command -v notify-send >/dev/null && notify-send -a Echo "Echo" "$out"
echo "$out"
