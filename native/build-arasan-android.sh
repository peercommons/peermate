#!/usr/bin/env bash
# Builds the Arasan engine for Android arm64 and installs it into the app's
# local Expo module (app/modules/arasan-engine), together with its network.
#
#   native/build-arasan-android.sh
#
# Requires the Android NDK (ANDROID_NDK_HOME, or the newest NDK under
# $ANDROID_HOME/ndk). Run after cloning, and whenever the submodule is bumped.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/arasan/src"
OUT="$ROOT/native/build/android-arm64"
MODULE="$ROOT/app/modules/arasan-engine/android/src/main"
API=29 # Bare Kit's minimum; see SPECS.md §11

SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
NDK="${ANDROID_NDK_HOME:-$(ls -d "$SDK"/ndk/* | sort -V | tail -1)}"
HOST="$(ls "$NDK/toolchains/llvm/prebuilt" | head -1)"
BIN="$NDK/toolchains/llvm/prebuilt/$HOST/bin"
CXX="$BIN/aarch64-linux-android$API-clang++"

# Fathom (tablebase probing) is a nested submodule. v26.1 doesn't compile with
# tablebases disabled, so it's built in; no tablebase files are shipped.
git -C "$ROOT/native/arasan" submodule update --init src/syzygy

mkdir -p "$OUT"
# 16 KB page alignment is required by Google Play for Android 15+ targets.
LDFLAGS="-O3 -flto -static-libstdc++ -Wl,-z,max-page-size=16384"

# Compile with Arasan's Makefile (NEON SIMD). Its link step hard-codes -lstdc++,
# which the NDK resolves to the shared C++ runtime, so relink statically below.
make -C "$SRC" -j"$(getconf _NPROCESSORS_ONLN)" default \
  CC="$CXX" ARCH=aarch64 OSTYPE=android BUILD_TYPE=neon \
  BUILD="$OUT/obj" EXPORT="$OUT" EXE=arasan-shared \
  LIBS="-lc -lm" SMPLIB= LDFLAGS="$LDFLAGS" | tee "$OUT/build.log" | grep -E "error" || true

OBJS=$(grep -E -- "-o $OUT/arasan-shared " "$OUT/build.log" | tail -1 | grep -oE "[a-z0-9_]+\.o")
[[ -n "$OBJS" ]] || { echo "Compile failed; see $OUT/build.log" >&2; exit 1; }
(cd "$OUT/obj" && "$CXX" $LDFLAGS $OBJS -o "$OUT/arasan" -lc -lm)
rm -f "$OUT/arasan-shared"

if "$BIN/llvm-readelf" -d "$OUT/arasan" | grep -q "c++_shared"; then
  echo "Engine still depends on libc++_shared.so" >&2
  exit 1
fi

# Install into the Expo module: the engine as a "library" so Android extracts it
# to nativeLibraryDir (executable), and the network as an asset.
NETWORK=$(grep -E '^NETWORK \?=' "$SRC/Makefile" | awk '{print $3}')
mkdir -p "$MODULE/jniLibs/arm64-v8a" "$MODULE/assets"
cp "$OUT/arasan" "$MODULE/jniLibs/arm64-v8a/libarasan.so"
rm -f "$MODULE/assets/"*.nnue
cp "$ROOT/native/arasan/network/$NETWORK" "$MODULE/assets/"

echo "Installed engine ($(du -h "$OUT/arasan" | cut -f1)) and $NETWORK into app/modules/arasan-engine"
