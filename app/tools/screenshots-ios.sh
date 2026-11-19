#!/usr/bin/env bash
# Store screenshots on the iOS SIMULATOR (SPECS §13.3): fresh install, then the
# app's own demo tour (src/demo.ts), captured screen by screen. The 6.9" size App Store Connect
# requires comes from an iPhone Pro Max simulator.
#
#   tools/screenshots-ios.sh [path/to/Peermate.app]
#
# Build the app first (Release, for the simulator, signed "to run locally": no
# team or certificate, but the keychain works, which the player's ID needs):
#   cd app/ios && xcodebuild -workspace Peermate.xcworkspace -scheme Peermate -configuration Release \
#     -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build-sim \
#     ARCHS=arm64 CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= build
# (needs native/build-arasan-ios.sh's XCFramework, which has a simulator slice).
#
# Writes fastlane/screenshots/en-US/*.png (the layout `deliver` uploads).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${1:-$ROOT/app/ios/build-sim/Build/Products/Release-iphonesimulator/Peermate.app}"
DEVICE="${PEERMATE_SIM_DEVICE:-iPhone 17 Pro Max}"
BUNDLE=com.peermate.app
OUT="$ROOT/fastlane/screenshots/en-US"
[[ -d "$APP" ]] || { echo "No app at $APP (build it first, see the header)." >&2; exit 1; }
mkdir -p "$OUT"
rm -f "$OUT"/*.png

UDID="$(xcrun simctl list devices available | grep -F "    $DEVICE (" | head -1 | grep -oE '[0-9A-F-]{36}')"
[[ -n "$UDID" ]] || { echo "No simulator named '$DEVICE'." >&2; exit 1; }
# A fresh boot: dialogs from earlier runs (e.g. "Open in …?") stay queued otherwise.
xcrun simctl shutdown "$UDID" 2>/dev/null || true
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null
/usr/bin/open "$(xcode-select -p)/Applications/Simulator.app" --args -CurrentDeviceUDID "$UDID" || true # to watch; not needed

echo "Installing $(basename "$APP") fresh on $DEVICE"
xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"

xcrun simctl status_bar "$UDID" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100

# The app tours its own screens (src/demo.ts maybeRunDemoTour): iOS asks
# "Open in Peermate?" for every deep link from the simulator, which would spoil
# every shot. It logs "demo shot <name>" on each screen; capture right then.
LOG="$(mktemp)"
xcrun simctl spawn "$UDID" log stream --style compact --predicate 'subsystem == "com.peermate.app"' > "$LOG" 2>/dev/null &
LOGPID=$!
trap 'kill $LOGPID 2>/dev/null; rm -f "$LOG"; xcrun simctl status_bar "$UDID" clear' EXIT
sleep 2
xcrun simctl launch "$UDID" "$BUNDLE" -peermateDemoTour 1 >/dev/null

echo "Capturing:"
seen=0
for _ in $(seq 1 240); do # up to 2 minutes
  while IFS= read -r line; do
    name="$(sed -nE 's/.*\[demo\] shot ([A-Za-z0-9_]+).*/\1/p' <<<"$line")"
    if [[ -n "$name" ]]; then
      xcrun simctl io "$UDID" screenshot --type=png "$OUT/$name.png" >/dev/null 2>&1
      echo "  $name"
    fi
    [[ "$line" == *"[demo] tour failed"* ]] && { echo "$line" >&2; exit 1; }
    [[ "$line" == *"[demo] tour done"* ]] && { echo "Saved to $OUT"; exit 0; }
  done < <(tail -n +$((seen + 1)) "$LOG")
  seen=$(wc -l < "$LOG")
  sleep 0.5
done
echo "Timed out waiting for the demo tour." >&2
exit 1
