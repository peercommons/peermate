# Peermate

Peer-to-peer chess for Android and iOS: play the CPU offline, or find opponents
worldwide with no servers involved. Full design: [SPECS.md](SPECS.md).

Status: **Phase 1** (offline game: vs CPU and pass & play). Phase 0 spikes are under **Dev tools** in the app.

## Layout

| Path | What |
|---|---|
| `app/` | Expo / React Native app. Screens in `app/src/app/` (Expo Router), board in `app/src/components/`, game state in `app/src/game/`. `app/p2p/worker.js` is the Hyperswarm worker that runs in a Bare worklet. |
| `app/tools/` | Runs the same worker under Node: a desktop test peer and an automated local-testnet test. |
| `core/` | Pure TypeScript game/protocol logic (no React Native). |
| `fastlane/` | Release automation (`android sideload` for now). |
| `native/` | Arasan chess engine (submodule), its Android build script, and a device benchmark (`native/tools/arasan-bench.mjs`). |
| `scripts/` | One-off setup scripts. |

## Requirements

Node 22, JDK 17, Android SDK + NDK (API 29+ arm64 device or emulator), Ruby + Bundler for Fastlane.

## Develop

```sh
git submodule update --init native/arasan
native/build-arasan-android.sh  # builds the chess engine into app/modules/arasan-engine
cd app && npm install
npm run android          # build and install a dev build on a connected phone/emulator
npm run test:p2p         # two P2P workers on a local testnet (no internet)
cd ../core && npm install && npm test   # install core before building the app: it's linked as @peermate/core
```

### P2P spike: test with one phone

1. Install the dev build (`npm run android`) and tap **Join** (room `lobby`).
2. On your computer: `cd app && npm run spike-peer -- lobby`
3. They should find each other through the public HyperDHT. Type to chat; `/ping` for round-trip time.

For a real NAT test, put the phone on **mobile data** (not your Wi-Fi), or use two phones on different networks.

## Sideload builds

One-time setup:

```sh
scripts/create-release-keystore.sh     # creates ~/.peermate/peermate-release.jks; BACK IT UP
cp fastlane/.env.example fastlane/.env # fill in passwords
bundle install
```

Then:

```sh
bundle exec fastlane android sideload              # -> dist/peermate-<version>-<code>.apk
bundle exec fastlane android sideload publish:true # also attach to a GitHub Release
adb install -r dist/peermate-*.apk                 # or send the APK to a tester
```
