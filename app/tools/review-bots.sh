#!/usr/bin/env bash
# Test opponents while the app is in store review: one bot per Quick Match time
# control (src/net/online.ts TIME_CONTROLS), each restarting after every game,
# so a reviewer with a single device always finds a game. Keeps the Mac awake.
#
#   tools/review-bots.sh start | stop | status        (logs: /tmp/peermate-review-bots/)
#
# Stop it once review is over: after release the bots would pair with real players.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=/tmp/peermate-review-bots
TCS=(1+0 2+1 3+2 5+0 10+0 15+10)
case "${1:-status}" in
  start)
    mkdir -p "$DIR"
    [[ -f "$DIR/pids" ]] && { echo "Already running (tools/review-bots.sh stop first)."; exit 1; }
    for tc in "${TCS[@]}"; do
      nohup bash -c "while true; do node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tools/play-peer.mjs '$tc' --nick 'Test opponent' --think 1500; sleep 1; done" \
        >> "$DIR/$tc.log" 2>&1 &
      echo $! >> "$DIR/pids"
    done
    nohup caffeinate -i -s >/dev/null 2>&1 &
    echo $! >> "$DIR/pids"
    echo "Started ${#TCS[@]} bots (${TCS[*]}) and caffeinate; logs in $DIR"
    ;;
  stop)
    [[ -f "$DIR/pids" ]] || { echo "Not running."; exit 0; }
    while read -r pid; do pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; done < "$DIR/pids"
    rm -f "$DIR/pids"
    echo "Stopped."
    ;;
  status)
    [[ -f "$DIR/pids" ]] || { echo "Not running."; exit 0; }
    alive=0; while read -r pid; do kill -0 "$pid" 2>/dev/null && alive=$((alive + 1)); done < "$DIR/pids"
    echo "$alive of $(wc -l < "$DIR/pids" | tr -d ' ') processes alive"
    for tc in "${TCS[@]}"; do echo "  $tc: $(grep -c 'matched with' "$DIR/$tc.log" 2>/dev/null || true) games; last: $(tail -1 "$DIR/$tc.log" 2>/dev/null | cut -c1-90)"; done
    ;;
esac
