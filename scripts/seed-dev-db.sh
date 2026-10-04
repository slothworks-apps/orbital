#!/usr/bin/env bash
#
# Copies the desktop app's database into the dev one, so `npm run dev` starts with
# the settings, tags and tag rules you actually use instead of the defaults
# (runbook: docs/ops/dogfood-and-dev-side-by-side.md).
#
# Losing them is not a cosmetic annoyance: `model_context_windows` is LEARNED
# from turns as they run, so a fresh database leaves the map's context arc
# without a denominator until it has relearned every model.
set -euo pipefail

SUPPORT="$HOME/Library/Application Support"
SRC="${ORBITAL_DATA_DIR:-$SUPPORT/orbital}/index.db"
DEST_DIR="${ORBITAL_DEV_DATA_DIR:-$SUPPORT/orbital-dev}"
DEST="$DEST_DIR/index.db"

[ -f "$SRC" ] || { echo "no desktop app database at $SRC" >&2; exit 1; }

if [ -e "$DEST" ] && [ "${1:-}" != "--force" ]; then
  echo "$DEST already exists; re-seeding would discard it." >&2
  echo "Run 'npm run dev:seed -- --force' if that is what you want." >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
# `.backup`, not `cp`: the source is a live WAL database, and copying
# index.db alone leaves behind whatever is still sitting in index.db-wal.
sqlite3 "$SRC" ".backup '$DEST'"

# The one thing that must NOT come across. `runner_status` is the Runner's
# claim on a session (spec 2026-09-21-session-autoheal-design); carried into
# a second database, the dev server would autoheal at boot and spawn its own
# `claude --resume` for a session the desktop app is already running —
# two CLI processes writing one transcript.
sqlite3 "$DEST" "UPDATE sessions SET runner_status = NULL, interrupted_at = NULL;"

echo "seeded $DEST ($(sqlite3 "$DEST" 'select count(*) from settings;') settings, \
$(sqlite3 "$DEST" 'select count(*) from tags;') tags, \
$(sqlite3 "$DEST" 'select count(*) from sessions;') sessions)"
