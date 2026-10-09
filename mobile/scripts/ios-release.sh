#!/bin/sh
# Archives the iOS app and uploads it to App Store Connect (runbook
# build-the-ios-app → Release to TestFlight). Run after `npm run build:ios`;
# the root `npm run ios:release` does both.
#
# The version is the Android app's: `versionName` and `versionCode` in
# android/app/build.gradle, so the two platforms cannot drift apart.
#
# Signing and upload go through the Apple account signed in to Xcode
# (Settings → Accounts). When ASC_KEY_PATH, ASC_KEY_ID and ASC_KEY_ISSUER are
# all set, they go through that App Store Connect API key instead, which is how
# .github/workflows/release.yml runs it on a runner with no account (runbook
# build-the-ios-app → Release from GitHub Actions).
set -eu
cd "$(dirname "$0")/.."
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

GRADLE=android/app/build.gradle
VERSION="$(sed -n 's/^ *versionName "\(.*\)"$/\1/p' "$GRADLE")"
BUILD="$(sed -n 's/^ *versionCode \([0-9][0-9]*\)$/\1/p' "$GRADLE")"
[ -n "$VERSION" ] && [ -n "$BUILD" ] || { echo "no versionName/versionCode in $GRADLE" >&2; exit 1; }

# Not under ios/App/build: `cap sync ios` cleans that and refuses a folder
# the build system did not create.
OUT=ios/App/output/release
rm -rf "$OUT"
mkdir -p "$OUT"

# xcodebuild prints the error that failed a build far above its closing
# summary, and an IDE console with a bounded buffer drops it. The full output
# goes to a log; a failure prints its error lines and where the log is, and
# returns xcodebuild's status.
run() {
  log="$PWD/$OUT/$1.log"
  echo "$1: log in $log"
  shift
  # Archive and export both sign, so both get the API key when there is one.
  if [ -n "${ASC_KEY_PATH:-}" ] && [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_KEY_ISSUER:-}" ]; then
    set -- -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" \
      -authenticationKeyIssuerID "$ASC_KEY_ISSUER" "$@"
  fi
  status=0
  xcodebuild "$@" >"$log" 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    grep 'error:' "$log" | sort -u >&2 || true
    tail -n 12 "$log" >&2
    echo "failed, full log: $log" >&2
  fi
  return "$status"
}

run archive -workspace ios/App/App.xcworkspace -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/Orbital.xcarchive" \
  -allowProvisioningUpdates \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
  archive || exit $?

export_upload() {
  run export -exportArchive -archivePath "$OUT/Orbital.xcarchive" \
    -exportOptionsPlist ios/ExportOptions.plist -exportPath "$OUT" \
    -allowProvisioningUpdates
}

# Export signs and uploads. It failed once for no reason of ours ("The data
# couldn't be read because it isn't in the correct format") and passed on the
# next run, so a failure is tried once more from the same archive — unless
# App Store Connect refused the build number as one it already has, which no
# retry changes. The workflow reads export.log for that refusal
# (scripts/store-duplicate.mjs); the first attempt's log stays as
# export-1.log.
status=0
export_upload || status=$?
if [ "$status" -ne 0 ]; then
  if node ../scripts/store-duplicate.mjs ios "$OUT/export.log" >/dev/null; then
    echo "App Store Connect already has Orbital $VERSION ($BUILD)" >&2
    exit "$status"
  fi
  mv "$OUT/export.log" "$OUT/export-1.log"
  echo "export failed, trying once more in 30s" >&2
  sleep 30
  export_upload || exit $?
fi
echo "uploaded Orbital $VERSION ($BUILD) to App Store Connect"
