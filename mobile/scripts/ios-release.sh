#!/bin/sh
# Archives the iOS app and uploads it to App Store Connect (runbook
# build-the-ios-app → Release to TestFlight). Run after `npm run build:ios`;
# the root `npm run ios:release` does both.
#
# The version is the Android app's: `versionName` and `versionCode` in
# android/app/build.gradle, so the two platforms cannot drift apart. Upload
# goes through the Apple account signed in to Xcode (Settings → Accounts).
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
xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/Orbital.xcarchive" \
  -allowProvisioningUpdates \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
  archive
xcodebuild -exportArchive -archivePath "$OUT/Orbital.xcarchive" \
  -exportOptionsPlist ios/ExportOptions.plist -exportPath "$OUT" \
  -allowProvisioningUpdates
echo "uploaded Orbital $VERSION ($BUILD) to App Store Connect"
