#!/usr/bin/env bash
# App Store preview video on the iOS SIMULATOR: fresh install, then the app's
# own video tour (src/demo.ts runVideoTour), recorded from "video start" to
# "video done" and converted to Apple's 6.9" preview format (886x1920, 30 fps,
# H.264, silent stereo AAC: a preview must have an audio track).
#
#   tools/preview-ios.sh [path/to/Peermate.app]
#
# Build the simulator app first (see tools/screenshots-ios.sh). Writes
# dist/peermate-preview-ios.mp4 (upload it in App Store Connect: fastlane
# deliver doesn't upload previews) and dist/peermate-preview-raw.mov.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${1:-$ROOT/app/ios/build-sim/Build/Products/Release-iphonesimulator/Peermate.app}"
DEVICE="${PEERMATE_SIM_DEVICE:-iPhone 17 Pro Max}"
BUNDLE=com.peermate.app
OUT="$ROOT/dist"
RAW="$OUT/peermate-preview-raw.mov"
MP4="$OUT/peermate-preview-ios.mp4"
[[ -d "$APP" ]] || { echo "No app at $APP (build it first, see screenshots-ios.sh)." >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "Needs ffmpeg." >&2; exit 1; }
mkdir -p "$OUT"
rm -f "$RAW" "$MP4"

UDID="$(xcrun simctl list devices available | grep -F "    $DEVICE (" | head -1 | grep -oE '[0-9A-F-]{36}')"
[[ -n "$UDID" ]] || { echo "No simulator named '$DEVICE'." >&2; exit 1; }
xcrun simctl shutdown "$UDID" 2>/dev/null || true
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null
/usr/bin/open "$(xcode-select -p)/Applications/Simulator.app" --args -CurrentDeviceUDID "$UDID" || true

echo "Installing $(basename "$APP") fresh on $DEVICE"
xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl status_bar "$UDID" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100

LOG="$(mktemp)"
xcrun simctl spawn "$UDID" log stream --style compact --predicate 'subsystem == "com.peermate.app"' > "$LOG" 2>/dev/null &
LOGPID=$!
RECPID=
cleanup() {
  kill $LOGPID 2>/dev/null || true
  [[ -n "$RECPID" ]] && kill -INT "$RECPID" 2>/dev/null || true
  rm -f "$LOG"
  xcrun simctl status_bar "$UDID" clear
}
trap cleanup EXIT
sleep 2
xcrun simctl launch "$UDID" "$BUNDLE" -peermateDemoTour video >/dev/null

wait_for() { # a log line, up to $2 seconds
  for _ in $(seq 1 $(($2 * 4))); do
    grep -q "\[demo\] tour failed" "$LOG" && { grep "\[demo\] tour failed" "$LOG" >&2; exit 1; }
    grep -q "$1" "$LOG" && return 0
    sleep 0.25
  done
  echo "Timed out waiting for '$1'." >&2
  exit 1
}

wait_for '\[demo\] video start' 60
xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$RAW" 2>/dev/null &
RECPID=$!
echo "Recording…"
wait_for '\[demo\] video done' 90
sleep 0.5
kill -INT "$RECPID"
wait "$RECPID" 2>/dev/null || true
RECPID=

# 30 fps constant frame rate, scaled to 886x1920, at most 30 s, with a silent track.
ffmpeg -loglevel error -y -i "$RAW" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
  -vf "fps=30,scale=886:1920,setsar=1" -t 29.5 -shortest \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -b:v 10M -c:a aac -b:a 256k -movflags +faststart "$MP4"
echo "Saved $MP4 ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$MP4") s)"
