#!/bin/sh
# Sourced by mobile/'s npm scripts before Gradle or `cap run` (runbook
# build-the-android-app). A value already set in the environment wins,
# except a JAVA_HOME that is not JDK 21.

# Where Android Studio installs the SDK unless told otherwise.
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"

# Gradle for Capacitor needs JDK 21; the system `java` may be older. A
# JAVA_HOME of another version is dropped rather than kept: an IDE hands
# scripts its own runtime (WebStorm's JBR 25), and Gradle on that finds no
# JDK 21 for the toolchain. Then a registered JDK 21, then Homebrew's
# openjdk@21, then Android Studio's bundled JBR (user install before system
# install) — each only if it is 21: Studio updates its JBR on its own.
if [ -n "${JAVA_HOME:-}" ] && ! grep -q '^JAVA_VERSION="21[."]' "$JAVA_HOME/release" 2>/dev/null; then
  JAVA_HOME=""
fi
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME="$(/usr/libexec/java_home -F -v 21 2>/dev/null || true)"
fi
if [ -z "$JAVA_HOME" ]; then
  for jdk in "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" \
             "/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" \
             "$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
             "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    if grep -q '^JAVA_VERSION="21[."]' "$jdk/release" 2>/dev/null; then
      JAVA_HOME="$jdk"
      break
    fi
  done
fi

export ANDROID_HOME JAVA_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
