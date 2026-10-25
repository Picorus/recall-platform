#!/bin/sh
# P2.2 proof on an Android 11 emulator: the player becomes device owner, locks the screen to itself,
# and comes back within 5 seconds after a crash. Run by CI with the emulator up.
set -eu
PKG=app.recall.player
APK=app/build/outputs/apk/debug/app-debug.apk

fail() { echo "FAIL: $*"; adb shell dumpsys activity activities | head -60 || true; adb logcat -d -t 300 | grep -iE "recall|AndroidRuntime" || true; exit 1; }
pid() { adb shell pidof "$PKG" 2>/dev/null | tr -d '\r' || true; }
locked() { adb shell dumpsys activity activities | tr -d '\r' | grep -qE "mLockTaskModeState=LOCKED|LockTaskController.*LOCKED|mLockTaskModeState=1"; }
front() { adb shell dumpsys activity activities | tr -d '\r' | grep -E "mResumedActivity|topResumedActivity" | grep -q "$PKG/.MainActivity"; }

adb install -r "$APK"
adb shell dpm set-device-owner "$PKG/.RecallAdminReceiver" || fail "could not make the player device owner"
adb shell am start -W -n "$PKG/.MainActivity"
sleep 5

front || fail "the player is not on screen"
locked || fail "the screen is not locked to the player"
echo "OK: device owner, on screen, locked"

# Home goes back to the player (no launcher can be opened).
adb shell input keyevent KEYCODE_HOME
sleep 2
front || fail "pressing home left the player"
echo "OK: home stays on the player"

# Crash it: the watchdog must bring it back within 5 seconds. First the player alone, then the
# whole app (the watchdog too: Android restarts the watchdog, which then restarts the player).
back_within_5s() { # $1: how to crash, $2: name of the case
  BEFORE=$(pid)
  [ -n "$BEFORE" ] || fail "player process not found"
  sh -c "$1"
  T0=$(date +%s)
  BACK=""
  while [ $(( $(date +%s) - T0 )) -le 5 ]; do
    NOW=$(pid)
    if [ -n "$NOW" ] && [ "$NOW" != "$BEFORE" ] && front; then BACK=yes; break; fi
    sleep 0.5
  done
  [ -n "$BACK" ] || fail "the player was not back within 5 seconds ($2)"
  echo "OK: back within $(( $(date +%s) - T0 )) s ($2)"
  sleep 3
}
back_within_5s "adb shell am crash \$(adb shell pidof $PKG | tr -d '\\r')" "the player crashed"
back_within_5s "adb shell am crash $PKG" "the whole app crashed, watchdog included"

# The crash was written down for the health report.
adb shell run-as "$PKG" cat files/crashes.log | grep -q "restart\|crash" || fail "the crash was not logged"
echo "OK: crash logged"
locked || fail "not locked after the restart"
echo "All kiosk checks passed."
