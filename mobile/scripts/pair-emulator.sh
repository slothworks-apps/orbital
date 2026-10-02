#!/bin/sh
# Dev only (runbook build-the-android-app): opens a pairing code on a local
# Orbital server, types it into the paste field of a dev build running on
# the emulator, and accepts the pairing on the Mac once the phone redeemed.
# Usage: mobile/scripts/pair-emulator.sh [server-port]   (default 4838)
# The Mac's name must be plain ASCII without quotes (`input text` types
# nothing else); the runbook's local stack names it studio.
set -eu
PORT="${1:-4838}"
. "$(dirname "$0")/android-env.sh"
adb reverse tcp:4840 tcp:4840 >/dev/null

json_field() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],JSON.parse(s));process.stdout.write(v==null?"":String(v))})' "$1"
}

QR="$(curl -sf -X POST "http://127.0.0.1:$PORT/api/remote/pair" | json_field qr)"
# `input text` ends a word at a space; %s is its escape for one.
adb shell input text "'$(printf %s "$QR" | sed 's/ /%s/g')'"

for _ in $(seq 1 30); do
  PHONE="$(curl -sf "http://127.0.0.1:$PORT/api/remote" | json_field pendingPair.phone)"
  if [ -n "$PHONE" ]; then
    curl -sf -X POST "http://127.0.0.1:$PORT/api/remote/pair/confirm" \
      -H 'content-type: application/json' -d "{\"accept\":true,\"phone\":\"$PHONE\"}" >/dev/null
    echo "paired $PHONE"
    exit 0
  fi
  sleep 1
done
echo "no pairing request reached the Mac" >&2
exit 1
