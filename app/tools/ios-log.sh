#!/usr/bin/env bash
# Prints Peermate's own log lines (subsystem com.peermate.app) from a USB-connected
# iPhone, for field testing: the iOS counterpart of `adb logcat -s ReactNativeJS`.
#
#   tools/ios-log.sh [minutes]     (default 30)
#
# Needs pymobiledevice3 (pipx install pymobiledevice3). The archive can be large.
set -euo pipefail
MINUTES=${1:-30}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
pymobiledevice3 syslog collect --start-time $(( $(date +%s) - MINUTES * 60 )) "$TMP/device.logarchive" >/dev/null
/usr/bin/log show --archive "$TMP/device.logarchive" --style compact \
  --predicate 'subsystem == "com.peermate.app"' | grep -v '^Timestamp'
