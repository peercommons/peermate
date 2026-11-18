#!/usr/bin/env bash
# Builds the Arasan engine for iOS (arm64 devices) as a static library and
# installs it into the app's local Expo module (app/modules/arasan-engine/ios),
# together with its network.
#
#   native/build-arasan-ios.sh
#
# iOS apps can't start child processes, so the engine runs inside the app: its
# `main` is renamed `arasan_main` and run on a thread by the module, which talks
# UCI over pipes (ios/ArasanBridge.mm). Run after cloning, and whenever the
# submodule is bumped. Requires Xcode.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/arasan/src"
OUT="$ROOT/native/build/ios-arm64"
MODULE="$ROOT/app/modules/arasan-engine/ios"
MIN_IOS=15.1 # Expo SDK 58's minimum

git -C "$ROOT/native/arasan" submodule update --init src/syzygy

NETWORK=$(grep -E '^NETWORK \?=' "$SRC/Makefile" | awk '{print $3}')
VERSION=$(grep -E '^VERSION = ' "$SRC/Makefile" | awk '{print $3}')
SOURCES=$(sed -n '/^ARASANX_SOURCES = /,/^$/p' "$SRC/Makefile" | sed 's/ARASANX_SOURCES = //; s/\\//g' | tr -s ' \n' ' ')

CXX=(xcrun -sdk iphoneos clang++ -arch arm64 -miphoneos-version-min=$MIN_IOS)
# The flags of Arasan's own neon build (native/build/macos-arm64/build.log) minus
# _MAC (macOS-only libproc), plus the in-process rename of main.
FLAGS=(-std=c++17 -fno-strict-aliasing -DUSE_INTRINSICS -DUSE_ASM -I "$SRC" -DSYZYGY_TBS
  -DSIMD -DNEON -DARASAN_VERSION=v$VERSION -D_64BIT -O3 -fno-rtti -DNDEBUG -DSMP_STATS
  -I "$SRC/nnue" -DNETWORK=$NETWORK -Dmain=arasan_main -w)

rm -rf "$OUT" && mkdir -p "$OUT/obj" "$OUT/patched"

# initGlobals() raises the process stack limit and exits if it can't; inside an
# app that would kill the app, and only the main thread uses that limit anyway
# (search threads set their own stack size). Build a patched copy without it.
perl -0pe 's/bool globals::initGlobals\(\) \{\n#ifndef _WIN32/bool globals::initGlobals() {\n#if !defined(_WIN32) \&\& !defined(PEERMATE_IN_PROCESS)/' \
  "$SRC/globals.cpp" > "$OUT/patched/globals.cpp"
grep -q "PEERMATE_IN_PROCESS" "$OUT/patched/globals.cpp" || { echo "globals.cpp patch didn't apply" >&2; exit 1; }

compile() { # source object [extra flags...]
  local src=$1 obj=$2
  shift 2
  "${CXX[@]}" "${FLAGS[@]}" -DPEERMATE_IN_PROCESS "$@" -c "$src" -o "$obj"
}

pids=()
for s in $SOURCES; do
  src="$SRC/$s"
  [[ $s == globals.cpp ]] && src="$OUT/patched/globals.cpp"
  compile "$src" "$OUT/obj/${s%.cpp}.o" &
  pids+=($!)
done
compile "$SRC/syzygy.cpp" "$OUT/obj/syzygy.o" &
pids+=($!)
compile "$SRC/syzygy/src/tbprobe.c" "$OUT/obj/tbprobe.o" -x c++ &
pids+=($!)
for p in "${pids[@]}"; do wait "$p"; done

xcrun -sdk iphoneos libtool -static -o "$OUT/libarasan.a" "$OUT"/obj/*.o
[[ "$(nm "$OUT/libarasan.a" 2>/dev/null)" == *arasan_main* ]] || { echo "arasan_main missing" >&2; exit 1; }

mkdir -p "$MODULE"
cp "$OUT/libarasan.a" "$MODULE/libarasan.a"
rm -f "$MODULE/"*.nnue
cp "$ROOT/native/arasan/network/$NETWORK" "$MODULE/"

echo "Installed libarasan.a ($(du -h "$OUT/libarasan.a" | cut -f1)) and $NETWORK into app/modules/arasan-engine/ios"
