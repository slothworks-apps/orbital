#!/bin/sh
# Sourced by mobile/'s npm scripts before Gradle or `cap run` (runbook
# build-the-android-app). A value already set in the environment wins.

# Where Android Studio installs the SDK unless told otherwise.
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"

# Gradle for Capacitor needs JDK 21; the system `java` may be older. A
# registered JDK 21 first, then Android Studio's bundled JBR, user install
# before system install.
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME="$(/usr/libexec/java_home -F -v 21 2>/dev/null || true)"
fi
if [ -z "$JAVA_HOME" ]; then
  for jbr in "$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
             "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    if [ -d "$jbr" ]; then
      JAVA_HOME="$jbr"
      break
    fi
  done
fi

export ANDROID_HOME JAVA_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
