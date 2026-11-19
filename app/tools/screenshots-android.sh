#!/usr/bin/env bash
# Store screenshots on an Android EMULATOR (SPECS §13.3): fresh install, demo
# mode (src/demo.ts), then each screen by deep link.
#
#   tools/screenshots-android.sh [path/to.apk]     (default: newest dist/*.apk)
#
# Writes fastlane/metadata/android/en-US/images/phoneScreenshots/*.png (the
# layout `supply` uploads). Refuses to run on a real phone: it uninstalls the app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APK="${1:-$(ls -t "$ROOT"/dist/*.apk | head -1)}"
SERIAL="$(adb devices | awk '/^emulator-[0-9]+\tdevice$/ {print $1; exit}')"
[[ -n "$SERIAL" ]] || { echo "No emulator running (this never runs on a real phone)." >&2; exit 1; }
ADB=(adb -s "$SERIAL")
PKG=com.peermate.app
OUT="$ROOT/fastlane/metadata/android/en-US/images/phoneScreenshots"
mkdir -p "$OUT"
rm -f "$OUT"/*.png

# Maya, the first demo friend (src/demo.ts seeds keys from fixed seeds).
MAYA="$(cd "$ROOT/core" && node -e "import('./src/net/identity.ts').then(m => console.log(m.deriveIdentity(new Uint8Array(32).fill(11)).peer.publicKey))")"

echo "Installing $APK fresh on $SERIAL"
"${ADB[@]}" uninstall "$PKG" >/dev/null 2>&1 || true
"${ADB[@]}" install "$APK" >/dev/null
"${ADB[@]}" shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS 2>/dev/null || true

# Clean status bar (Android's demo mode); turned off again at the end.
"${ADB[@]}" shell settings put global sysui_demo_allowed 1
bar() { "${ADB[@]}" shell am broadcast -a com.android.systemui.demo -e command "$@" >/dev/null; }
bar enter
bar clock -e hhmm 0941
bar battery -e level 100 -e plugged false
bar network -e wifi show -e level 4 -e mobile show -e level 4 -e datatype none
bar notifications -e visible false
trap 'bar exit; "${ADB[@]}" shell settings put global sysui_demo_allowed 0' EXIT

open() { "${ADB[@]}" shell am start -W -a android.intent.action.VIEW -d "$1" "$PKG" >/dev/null; sleep "${2:-3}"; }
shot() { "${ADB[@]}" exec-out screencap -p > "$OUT/$1.png"; echo "  $1"; }

"${ADB[@]}" shell am start -W -n "$PKG/.MainActivity" >/dev/null
sleep 8
open "peermate://demo" 6
echo "Capturing:"
shot 1_home
open "peermate://game?resume=demo-cpu" 8   # the engine starts up first
shot 3_vs_computer
open "peermate://friends" 3
shot 4_friends
open "peermate://chat/$MAYA" 3
shot 5_chat
open "peermate://online" 3
shot 6_play_online
open "peermate://history" 3
shot 7_games
open "peermate://demo?game=1" 12           # the sample moves play out first
shot 2_online_game
echo "Saved to $OUT"
