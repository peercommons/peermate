#!/usr/bin/env bash
# Builds Arasan for this Mac (Apple silicon) into native/build/macos-arm64, for
# level calibration (core/tools/calibrate.ts). Not shipped in the app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/arasan/src"
OUT="$ROOT/native/build/macos-arm64"
git -C "$ROOT/native/arasan" submodule update --init src/syzygy
mkdir -p "$OUT"
make -C "$SRC" -j"$(getconf _NPROCESSORS_ONLN)" default \
  CC=clang++ ARCH=aarch64 BUILD_TYPE=neon BUILD="$OUT/obj" EXPORT="$OUT" > "$OUT/build.log" 2>&1 \
  || { echo "Build failed; see $OUT/build.log" >&2; exit 1; }
NETWORK=$(grep -E '^NETWORK \?=' "$SRC/Makefile" | awk '{print $3}')
cp "$ROOT/native/arasan/network/$NETWORK" "$OUT/"
echo "Built $OUT/arasanx-64-neon with $NETWORK"
