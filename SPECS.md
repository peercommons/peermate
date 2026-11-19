# Peermate: Product & Technical Specification

| | |
|---|---|
| **Status** | Draft v0.1 |
| **Date** | 2026-11-17 |
| **Platforms** | iOS, Android |
| **Name** | **Peermate** (store listing: "Peermate: P2P Chess"). Pending availability checks (§14.1) |

---

## 0. TL;DR / Key Decisions

| Area | Decision |
|---|---|
| App framework | **React Native (Expo, prebuild / dev-client)**. It is the best-supported host for the Bare P2P runtime (`react-native-bare-kit`) and has a viable 3D path (react-three-fiber). |
| CPU opponent | **Arasan** (MIT-licensed C++ engine, native module) with 10 calibrated difficulty levels. The permissive licence means the app can be closed source; only a licence notice is required (§5.3). |
| Identity | One on-device seed (BIP-39 backup phrase) → derived **Ed25519** key (P2P layer) + **secp256k1** key (Nostr layer). No accounts, no sign-up. |
| Discovery (primary) | **Kademlia, via HyperDHT / Hyperswarm** (Holepunch). Kademlia DHT with built-in UDP hole-punching and Noise encryption, already running in production on mobile (Keet). |
| Discovery (secondary) + async messaging | **Nostr public relays.** Signed events, many independent public relays, offline delivery, encrypted DMs (NIP-17/44/59). |
| Live game transport | Direct P2P Noise-encrypted stream (HyperDHT). **Fallback:** encrypted Nostr ephemeral events when hole-punching fails. |
| Chat | In-game: over the P2P stream. Friends/offline: Nostr NIP-17 gift-wrapped DMs. |
| MQTT (public brokers) | **Not recommended as a core dependency** (§4.4). Kept as an optional pluggable transport adapter, off by default. |
| Board | **2D at launch** (Skia). **3D mode** (react-three-fiber + expo-gl) as a toggle in v1.1, sharing the same game state. |
| Release automation | **Fastlane** (`match`, `gym`, `pilot`, `deliver`, `supply`, `snapshot`/`screengrab`) driven by GitHub Actions. |
| Servers we own | **Zero.** The only hosted things are static files on free hosting (privacy policy, optional universal-link files) and the Git repo used by `fastlane match`. |

---

## 1. Goals & Non-Goals

### 1.1 Goals
1. Play chess against the CPU at clearly differentiated difficulty levels, fully offline.
2. Play live games against people anywhere in the world, **discovered peer-to-peer**, without any backend we operate.
3. Chat with opponents and friends without any backend we operate.
4. Ship a 2D board, with an optional 3D board.
5. Fully automated builds and store submissions for iOS and Android via Fastlane.

### 1.2 Non-Goals (v1)
- Centralized, authoritative ratings / leaderboards (impossible to make trustworthy without a server; see §7.5).
- Server-grade anti-cheat (engine-assist detection).
- Remote push notifications (APNs/FCM both require a provider server; see §8.4).
- Spectating, tournaments, puzzles, opening explorer (candidate v2 features).
- Web / desktop clients (the architecture keeps this possible later).

---

## 2. Feature Specification

### 2.1 Game modes
| Mode | Description | Network |
|---|---|---|
| vs CPU | 10 difficulty levels, choose color or random, optional time control, takebacks and hints allowed (configurable). | Offline |
| Pass & Play | Two humans, one device, optional auto-flip. | Offline |
| Quick Match | Join global lobby for a time control; auto-paired with a peer of similar (self-reported) rating. | P2P |
| Open Seeks | Browse a live list of open challenges; tap to accept. | P2P |
| Challenge a Friend | Send a challenge to a contact (by public key). | P2P + Nostr |
| Correspondence (v1.1) | Days-per-move games; moves delivered asynchronously via Nostr. | Nostr |

### 2.2 Time controls
Bullet 1+0, 2+1 · Blitz 3+0, 3+2, 5+0, 5+3 · Rapid 10+0, 10+5, 15+10 · Classical 30+0, 30+20 · Custom · Correspondence (1/3/7 days per move, v1.1).

> Bullet over the Nostr fallback transport will feel laggy (100–800 ms per hop). The client warns when a bullet game is running on fallback transport, and Quick Match for bullet prefers peers with a direct connection (§6.6).
>
> **Status (2026-11-18):** Quick Match offers 1+0, 2+1, 3+2, 5+0, 10+0 and 15+10. Field tests measured 1–3 s per relayed move. The lobby notes that bullet plays best direct, and the game screen warns while a bullet game is on the relays. **Not done yet:** preferring direct peers in bullet Quick Match.

### 2.3 Chess rules
- Full FIDE rules: castling, en passant, promotion (with picker), check/checkmate/stalemate.
- Draws: threefold repetition (claim + auto at fivefold), 50-move rule (claim + auto at 75), insufficient material, mutual agreement, timeout vs. insufficient material.
- Rules library: **chess.js** (BSD-2) for move generation/validation in JS; Arasan is only for the AI.
- Import/export **PGN** and **FEN**; share a game as PGN text.

### 2.4 In-game actions
Resign · Offer/accept/decline draw · Request/accept takeback (online: opponent must accept) · Abort (before both sides have moved) · Rematch · Flip board · Chat / quick-chat · Report & block.

### 2.5 Post-game
- Local engine analysis (Arasan): eval graph, best-move arrows, inaccuracy/mistake/blunder annotations.
- Save to local history; export PGN; optionally publish a signed result (§7.5).

### 2.6 Social
- **Profile:** nickname, avatar (emoji or generated identicon; no image upload in v1), country flag (optional), self-reported rating per time control.
- **Contacts:** add via QR code, share link (`peermate://p/<npub>`), or "add opponent as friend" after a game.
- **Presence:** online/in-game/away for friends (§6.5).
- **Block list:** local, also published as a Nostr mute list (NIP-51, kind 10000) so it follows the user's key across devices.

### 2.7 Settings
Board theme, piece set, 2D/3D, sound, haptics, move confirmation, auto-queen, coordinates, highlight legal moves, premoves (online), language, **network privacy mode** (§9.2), relay list editor (advanced), backup/restore identity.

---

## 3. System Architecture

### 3.1 High-level

```
┌──────────────────────────────── Mobile App (React Native) ───────────────────────────────┐
│                                                                                           │
│  UI Layer:   2D Board (Skia) │ 3D Board (R3F/expo-gl) │ Lobby │ Chat │ Profile │ Settings │
│                                     │                                                     │
│  Domain:     GameController ── chess.js rules ── ClockManager ── MoveLog (signed)         │
│              EngineService ── Arasan (native C++ TurboModule, own thread)                 │
│                                     │                                                     │
│  Net (JS):   SessionManager ─┬─ TransportRouter (picks best available transport)          │
│                              ├─ NostrClient (nostr-tools, WebSocket to N public relays)   │
│                              └─ [optional] MqttAdapter (off by default)                   │
│                                     │ IPC (bare-rpc)                                      │
│  P2P Worklet (Bare runtime via react-native-bare-kit):                                    │
│              Hyperswarm ── HyperDHT (Kademlia + hole-punching) ── Noise/UDX streams       │
│                                                                                           │
│  Storage:    SQLite (games, contacts, messages) │ Keychain/Keystore (seed)                │
└───────────────────────────────────────────────────────────────────────────────────────────┘
            │ UDP (DHT + holepunch)                         │ WSS
            ▼                                               ▼
   ┌───────────────────────────┐                ┌─────────────────────────────┐
   │ HyperDHT public network   │                │ Public Nostr relays          │
   │ (Kademlia; public         │                │ (damus, nos.lol, primal,     │
   │  bootstrap nodes)         │                │  etc. User-editable list)    │
   └───────────────────────────┘                └─────────────────────────────┘
            ▲                                               ▲
            └──────────── other players' devices ───────────┘
```

### 3.2 Why React Native
| Option | P2P runtime fit | 3D | Native engine | Verdict |
|---|---|---|---|---|
| **React Native + Expo** | `react-native-bare-kit` runs Hyperswarm in a Bare worklet (the same stack Keet ships on iOS/Android); `nostr-tools` is native JS | react-three-fiber/native + expo-gl, good | Native TurboModule (C++) | **Chosen** |
| Flutter | Bare would need custom platform channels; Dart Nostr libs exist; no maintained Dart HyperDHT | `flutter_scene` still immature | FFI to C++ engine | Good for 2D, weaker for P2P + 3D |
| Native ×2 (Swift + Kotlin) | Bare Kit has native Swift/Kotlin APIs | SceneKit/RealityKit + Filament | Easy | 2× the UI work |
| Unity | Poor P2P library fit | Excellent | Plugin | Overkill, heavy binary |

### 3.3 Module boundaries
- `core/` (pure TS, no RN imports): rules wrapper, clock logic, protocol codecs, rating math, signed-log verification. 100% unit-testable in Node.
- `engine/`: Arasan TurboModule + `EngineService` (UCI driver, level mapping).
- `p2p/worklet/`: Bare JS bundle (Hyperswarm/HyperDHT). Exposes a small RPC API to RN.
- `net/`: `Transport` interface + implementations (`HyperswarmTransport`, `NostrTransport`, `MqttTransport`), `SessionManager`, `DiscoveryService`.
- `ui/`: screens, 2D board, 3D board.
- `storage/`: SQLite repositories, secure key storage.

```ts
interface Transport {
  id: 'hyperswarm' | 'nostr' | 'mqtt';
  isAvailable(): Promise<boolean>;
  connect(peer: PeerId, ctx: SessionCtx): Promise<Channel>;   // reliable, ordered, E2E-encrypted
}
interface Channel {
  send(msg: ProtocolMessage): Promise<void>;
  onMessage(cb: (msg: ProtocolMessage) => void): Unsubscribe;
  quality(): { rttMs: number; direct: boolean };
  close(reason?: string): void;
}
```

---

## 4. P2P Technology Evaluation

### 4.1 Requirements for the networking layer
1. No servers we own or operate.
2. Works on mobile: behind NAT/CGNAT, on cellular, with iOS/Android backgrounding limits and battery limits.
3. Global discovery of strangers (lobby) **and** targeted reach of a known person (friends).
4. Low latency for live moves; reliable delivery for chat.
5. End-to-end encryption and authenticated identity.
6. Works at **small scale on day 1** (cold-start problem).

### 4.2 Is Kademlia a fit?

**Raw Kademlia (our own DHT of app users): no.**
- **Cold start:** a DHT made only of our users needs bootstrap nodes (servers we'd have to run) and is fragile with few nodes.
- **Mobile nodes make bad DHT servers:** iOS suspends apps seconds after backgrounding, Android Doze throttles network, battery and data costs, constant churn, and most phones sit behind CGNAT and cannot accept inbound connections. Mobile peers must run in **client mode**.
- **Kademlia does discovery only.** It doesn't solve NAT traversal, so finding a peer's address doesn't mean you can connect to it.

**Kademlia on top of a large existing public network: yes.** Three candidates:

| Network | What it gives | Mobile fit | Notes |
|---|---|---|---|
| **HyperDHT / Hyperswarm** (Holepunch) | Kademlia DHT + **topic-based peer discovery** + **UDP hole-punching** + **Noise-encrypted** streams + connect-by-public-key | **Proven:** Keet (P2P chat/video) ships on iOS & Android on this stack via Bare | Public bootstrap nodes are run by Holepunch (third-party; we can add community nodes). Hole-punching fails for some NAT pairs (symmetric↔symmetric), so we need a fallback. |
| BitTorrent Mainline DHT (BEP 5 / BEP 44) | Huge (millions of nodes), very resilient; BEP 44 stores **signed mutable records ≤1000 bytes** keyed by an Ed25519 key | Client-mode lookups only; UDP sometimes blocked on cellular | Good for presence/rendezvous records; **no hole-punching or transport**. Needs a separate connectivity layer. |
| libp2p Kademlia (IPFS Amino DHT) | DHT + AutoNAT + Circuit Relay v2 + DCUtR hole-punching + GossipSub | rust-libp2p / go-libp2p on mobile is doable but heavy; relay capacity on the public network is limited | Most flexible, highest integration cost. |

**Verdict:** Kademlia **is** a fit, but in the form of **HyperDHT/Hyperswarm**, which bundles discovery, NAT traversal, encryption, and connect-by-public-key into one stack that already runs in production mobile apps. Mainline DHT (BEP 44) is a reasonable *future* addition for redundant presence records.

### 4.3 Public pub/sub & messaging options compared

| Option | P2P-ness | Serverless for us? | Identity / auth | Offline delivery | Mobile maturity | Verdict |
|---|---|---|---|---|---|---|
| **Nostr** (public relays) | Federated relays (client↔relay), many independent operators | ✅ Hundreds of free public relays; user-editable list | ✅ Every event signed (secp256k1 Schnorr) | ✅ Relays store events | ✅ Mature JS libs, many mobile clients | **Secondary layer: chosen** |
| **Waku** (Logos/Status) | True P2P gossip (libp2p) with light-client protocols (filter/lightpush/store) | ✅ "The Waku Network" public fleet | Partial (RLN rate-limiting) | ✅ Store protocol | ⚠️ js-waku works; RN integration less proven | Strong future alternative to Nostr |
| **MQTT public brokers** (HiveMQ, EMQX, test.mosquitto.org) | Centralized broker per host | ⚠️ Free brokers exist but are explicitly **for testing**, with no SLA | ❌ None. Anyone can read/write any topic | ⚠️ Retained msgs only, no guarantees | ✅ Libraries available | **Optional adapter only** |
| libp2p GossipSub | True P2P | ✅ | Peer IDs | ❌ | ⚠️ Heavy on mobile | Not needed given Hyperswarm |
| Matrix | Federated homeservers | ❌ Needs accounts on someone's homeserver | ✅ | ✅ | ✅ | Not serverless enough |
| Tor onion services (Briar-style) | True P2P over Tor | ✅ | ✅ | ❌ | ⚠️ Battery, latency, large binary | Too slow for live chess |
| WebRTC data channels | P2P media/data | Needs signaling (could use Nostr) + public STUN; **TURN needs a server** | DTLS | ❌ | ✅ | Alternative to HyperDHT for the direct link; keep as plan B |

### 4.4 MQTT verdict (detail)
Public MQTT brokers *can* work technically (topic = `peermate/v1/lobby/blitz`, payloads E2E-encrypted), but:
1. **Terms of use:** HiveMQ's and EMQX's public brokers and test.mosquitto.org are for testing/evaluation; shipping a production app on them is against their intent and could be throttled or blocked at any time.
2. **No identity:** anyone can publish to or subscribe to any topic, so we would rebuild signing and spam control ourselves, which is everything Nostr already provides.
3. **Single operator per broker:** less resilient than a pool of independent Nostr relays.
4. **No P2P benefit:** MQTT is client→broker. It is no more "P2P" than Nostr, and worse at it.

→ Implement `MqttTransport` behind the same `Transport` interface (messages still signed + E2E-encrypted), **disabled by default** and exposed only in Advanced settings / for experimentation. Nostr is better on every axis that matters here.

### 4.5 Final networking stack

| Concern | Primary | Fallback |
|---|---|---|
| Find strangers (lobby) | Hyperswarm topic join (Kademlia) | Nostr ephemeral seek events |
| Reach a known friend | HyperDHT `connect(friendPublicKey)` | Nostr encrypted DM / ephemeral events |
| Live moves + in-game chat | Direct Noise/UDX stream | Nostr ephemeral events (NIP-44 encrypted) |
| Offline chat, challenges, correspondence moves | Nostr NIP-17 DMs | n/a |
| Presence of friends | HyperDHT reachability probe + Nostr ephemeral heartbeat | n/a |
| Profile, contact list, mute list, game records | Nostr replaceable events (kinds 0, 3, 10000, 64) | n/a |

**Rationale:** P2P is the first choice everywhere it can work (live, both peers online, NAT permits). Nostr covers the cases P2P physically cannot handle on mobile (one peer offline, CGNAT↔CGNAT, iOS background). Neither layer needs a server we run.

---

## 5. CPU Opponent

### 5.1 Engine
- **Arasan** (C++, by Jon Dart; MIT-style licence; actively maintained), pinned as a Git submodule at `native/arasan` (v26.1). Fathom (MIT), its tablebase-probing code, is built in because v26.1 doesn't compile without it; no tablebase files ship.
- **Android:** `native/build-arasan-android.sh` cross-compiles a statically linked arm64 executable (NEON, 16 KB page-aligned, ~2 MB; 0.56 MB compressed in the APK) and installs it into the local Expo module `app/modules/arasan-engine` as `libarasan.so`. Android extracts it to `nativeLibraryDir`, the only place an app may execute files from on Android 10+. The module runs it as a **child process** and speaks UCI over stdin/stdout, so an engine crash can't take down the app.
- **iOS** can't spawn processes, so the engine runs **in process**. `native/build-arasan-ios.sh` compiles it as a static library (`libarasan.a`, arm64, NEON, ~2 MB) with `main` renamed `arasan_main`, from a copy of `globals.cpp` that skips raising the process stack limit (which would `exit()` the app on failure; search threads set their own 4 MB stacks). The module's bridge (`ios/ArasanBridge.mm`) replaces fds 0 and 1 with pipes and runs `arasan_main` on an 8 MB-stack thread for the life of the app; it never sends `quit`, since the engine's globals can't be initialised twice. The network ships in the app bundle and is used in place. An engine crash takes the app down on iOS, unlike Android. Verified on an iPhone 15 (iOS 27.2.1) at levels 3 and 10 (2026-11-18).
- **Network:** `arasanv8-20261005.nnue`, 24 MB raw, **13.6 MB compressed in the APK**. Shipped as an asset and copied once to `filesDir` (the engine needs a file path), then set via `setoption name NNUE file value <path>`.
- **Opening book: not shipped in v1.** `book.bin` is 27 MB (13 MB compressed), which would blow the download budget. Opening variety comes from the level randomness and, for strong levels, a small curated opening list (≤ 200 KB) chosen in Phase 1.
- Android: native libs must be built with **16 KB page alignment** (Google Play requirement for apps targeting Android 15+).
- **Fallback engine:** Caissa (MIT, stronger, no built-in strength limiting) if Arasan fails later checks. Use Caissa 0.7 or later only, since 0.6 used Stockfish's network.

**Phase 0 measurements** (Android emulator, arm64 on Apple silicon; re-measure on real mid-range phones):

| Metric | Result |
|---|---|
| Full strength, 1 thread, 16 MB hash, 1 s/move | ~104k nodes/s, depth 15–19 |
| Peak memory | 67 MB |
| Depth 1–6 search | 5–15 ms |
| `UCI_Elo` limited search, `movetime 1000` | ~840 ms; moves visibly weaker (e.g. `g2g4` at 1200) |
| Moves differing from full strength (18 tries) | 1000: 13 · 1200/1400/1650: 9 each · 1950: 1 · 2300: 2 |

The identical results for 1200–1650 suggest Arasan's limiter may not separate those settings well. The level table below must be **re-derived from game-based calibration** (§12.3), not taken from `UCI_Elo` labels.

### 5.1a Analysis score scale
Arasan's centipawns run about 2× larger than "normalized" engines. Post-game judgments use a logistic win-chance curve that assumes normalized centipawns, so Arasan scores are multiplied by `ARASAN_CP_SCALE` = **0.48** (`core/src/analysis.ts`) before judging and display. Fitted by `core/tools/cp-scale.ts`: 101 positions from calibration games scored by Arasan v26.1 and Stockfish 19 at 300 ms; median ratio 0.481, least squares 0.509, correlation 0.98. Raw scores are stored, so refitting needs no re-analysis.

### 5.2 Difficulty levels
Calibrated by self-play (§12.3). Every level beats the one below it; steps are roughly 100–350 Elo (wider at the top). Absolute human Elo isn't measured yet, so the app describes levels in words instead of numbers.

| Level | Label | Arasan config | Extra behavior |
|---|---|---|---|
| 1 | Newcomer | depth 1, `MultiPV 8` | 40% chance: random move from the weaker half of the candidates |
| 2 | Beginner | depth 1, `MultiPV 8` | 30%: random choice from the top 8 |
| 3 | Novice | depth 2, `MultiPV 6` | 25%: random from the top 6 |
| 4 | Casual | depth 3, `MultiPV 5` | 20%: random from the top 5 |
| 5 | Club | depth 3, `MultiPV 4` | 10%: random from the top 4 |
| 6 | Intermediate | depth 4, `MultiPV 4` | 10%: random from the top 4 |
| 7 | Advanced | depth 5, `MultiPV 3` | 3%: random from the top 3 |
| 8 | Expert | depth 6, `MultiPV 2` | 2%: random from the top 2 |
| 9 | Master | depth 8 | n/a |
| 10 | Grandmaster | Full strength, `movetime` 1000 ms | n/a |

**Why not `UCI_Elo`:** calibration showed Arasan's limiter is far weaker than its labels below ~2000. `UCI_Elo` 1000 lost 24–0 to a depth-3 search, and 1000–1650 all rated below a depth-1 search with random moves. Depth caps plus random picks are also smooth to tune and cost milliseconds per move.

Notes:
- Levels pick among the `MultiPV` candidate lines (`pickMove` in `core/src/levels.ts`).
- Send `ucinewgame` between games and when changing level, so hash-table results from a stronger search don't leak into a weaker one.
- **Humanized think time:** levels 1–9 search in milliseconds, so the reply is padded to 0.55–1.8 s (longer at higher levels).
- Engine runs with `Threads=1` and `Hash=16` (**MB**; the UCI option is in megabytes, min 4) to limit memory, battery and thermal load.
- Post-game analysis (§2.5) uses the same engine at full strength with a time budget.
- Adaptive mode (v1.1): suggests the next level after 3 wins/losses in a row.

### 5.3 Licensing
Arasan's licence is MIT-style and explicitly covers its source, opening book and network files. **The app does not need to be open source.**
- **Obligation:** include Arasan's copyright and licence text in the app's "Open-source licences" screen and in a `THIRD_PARTY_NOTICES` file in the repo.
- Other core dependencies are also permissive: chess.js (BSD-2), Hyperswarm/HyperDHT (Apache-2.0/MIT), nostr-tools (Unlicense/MIT). CI runs a licence check (e.g. `license-checker` for npm and a manual review of native submodules) that **fails the build if a GPL/AGPL/LGPL dependency is added**.
- **Avoid:** Stockfish, Leela Chess Zero, Weiss, Black Marlin and Sunfish (GPLv3), Viridithas (AGPL-3.0), and any network file trained by or derived from those engines unless its own licence is confirmed permissive.
- Whether to open-source Peermate anyway is now a product choice, not a requirement (see §16).

---

## 6. Networking: Detailed Design

### 6.1 Identity & keys
```
seed (32 bytes, CSPRNG) ──► BIP-39 24-word backup phrase (shown once, optional export)
   ├─ HKDF(seed, "peermate/v1/ed25519")   ──► Ed25519 keypair  → HyperDHT identity (PeerKey)
   └─ HKDF(seed, "peermate/v1/secp256k1") ──► secp256k1 keypair → Nostr identity (npub)
```
- Seed stored in **iOS Keychain** (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) / **Android Keystore**-wrapped (via `expo-secure-store`).
- **Binding proof:** the Nostr profile (kind 0) includes the Ed25519 PeerKey, signed by the Ed25519 key over the npub, so peers can verify both keys belong to the same player.
- Display identity: nickname + 4-word fingerprint (44 bits, BIP-39 words) of the Ed25519 PeerKey, the key that signs every game message (protects against impersonation by nickname).
- **Implemented** in `core/src/net/identity.ts`: the seed is the BIP-39 entropy, so the 24-word phrase *is* the seed; keys via HKDF-SHA256; `@noble/curves`, `@noble/hashes`, `@scure/bip39` (MIT, audited).
- Restore on new device: enter backup phrase → same keys → profile, contacts, mute list re-fetched from Nostr.
- (Advanced) Import an existing Nostr `nsec` instead of deriving one.

### 6.2 Discovery: global lobby (Hyperswarm)
- **Topic derivation:** `topic = BLAKE2b-256("peermate/v1/lobby/" + timeControlClass + "/" + ratingBand)`
  - `timeControlClass` ∈ {bullet, blitz, rapid, classical}
  - `ratingBand` = 200-point buckets (e.g. `1400-1599`) plus one `any` topic per class.
- A device in Quick Match **joins** (announces + looks up) its band topic and the `any` topic, and **looks up** (without announcing) adjacent bands after 15 s with no match.
- On connection to a lobby peer, the two exchange `HELLO` (§6.7) and `SEEK` messages; pairing uses the handshake in §6.8.
- **Limits:** max 8 concurrent lobby connections; drop lobby connections immediately after pairing; leave topic when not seeking (battery).

### 6.3 Discovery: Nostr fallback lobby
Runs in parallel with §6.2. The first successful pairing on either path wins.
- **Seek event:** ephemeral kind `2xxxx` (exact kind number TBD in the 20000–29999 ephemeral range; register intent on the NIPs repo as an application-specific kind), tags: `["t","peermate-v1-blitz-1400"]`, `["tc","3+2"]`, `["r","1450"]`, `["pk", <ed25519 hex>]`, `["expiration", now+60]` (NIP-40).
- **Proof-of-work:** NIP-13, difficulty 16 on seek events, to deter lobby spam.
- Subscription filter: `{"kinds":[2xxxx], "#t":["peermate-v1-blitz-1400","peermate-v1-blitz-any"], "since": now-30}`.
- On seeing a seek, the client first tries **HyperDHT `connect(pk)`** directly (so even Nostr-discovered games usually end up on a direct P2P link), falling back to Nostr transport.

### 6.4 Reaching a known peer (friends, reconnects)
1. `HyperDHT.connect(friendEd25519PublicKey)`: the friend's device listens on a DHT server keyed by its own public key **while the app is in the foreground**.
2. If unreachable within 5 s → send via Nostr (NIP-17 DM for challenges/chat; ephemeral event for live moves).

### 6.5 Presence
- While foregrounded: device keeps its HyperDHT key-server announced (cheap) and publishes a Nostr ephemeral heartbeat every 60 s to its relays (`status: online|in-game`), **visible only to contacts** (NIP-44 encrypted per contact, or batched to a contact-list-derived topic).
- Presence shown as "online" if a heartbeat was seen in the last 120 s.

### 6.6 Transport selection (TransportRouter)
```
try HyperswarmTransport (direct, hole-punched)   timeout 6 s
   └─ success → use it; measure RTT
   └─ fail    → NostrTransport (relay-mediated, encrypted)
background: keep retrying direct every 30 s; migrate session to direct if it later succeeds
```
- Session migration is seamless because all messages carry `(gameId, seq)` and are idempotent (§6.7).
- UI shows a connection badge: 🟢 Direct · 🟡 Relayed · 🔴 Reconnecting.

**Phase 0 findings for the Nostr path:**
- Delivery is **best effort**. In testing, 1 of ~10 app messages was silently lost across all 4 relays. On this path, `MOVE`, `CHAT` and control messages **must** use `ACK` + retransmit (with exponential backoff), and receivers dedupe by `(gid, seq)`.
- Most relays run strfry, which keeps ephemeral events for a few minutes instead of dropping them, and replays them to new subscribers. Subscriptions use `since: now − 5 s` and dedupe by event id.
- Measured round trip (ping → pong through relays): ~590 ms desktop↔desktop, ~860 ms emulator↔desktop. Discovery via `hello`: ~1–2.5 s.

### 6.7 Wire protocol
- **Encoding:** JSON in v1 (a signed move is ~400 bytes; JSON is debuggable and Nostr content is text). Signatures cover a **canonical** form (sorted keys), so CBOR can replace JSON later without changing what is signed. Inside Nostr events the JSON is NIP-44 encrypted.
- **Implemented** in `core/src/net/` (`envelope.ts`, `channel.ts`, `pairing.ts`, `session.ts`, `clock.ts`), with tests that play whole games over a simulated link losing, duplicating and reordering messages.
- **Envelope:**
```ts
type Envelope = {
  v: 1;                        // protocol version
  gid?: string;                // game id (UUIDv7), absent for lobby/chat-only msgs
  seq: number;                 // per-sender 1,2,3… for reliable messages; 0 for ACK/SYNC/PING/PONG
  ts: number;                  // sender wall-clock ms (informational)
  from: string;                // sender Ed25519 key, hex
  body: Message;
  sig: string;                 // Ed25519 over canonical(v,gid,seq,ts,from,body), hex
};
```
- **Messages:**

| Type | Fields | Notes |
|---|---|---|
| `HELLO` | appVersion, protoVersions[], nickname, npub, rating{} | First msg on any channel |
| `SEEK` | tc, ratingRange, colorPref | Lobby only |
| `CHALLENGE` | tc, color, rated:bool, commit | §6.8 |
| `ACCEPT` / `DECLINE` | reveal / reason | |
| `START` | gid, white, black, tc, initialFEN | Signed by both (two-step) |
| `MOVE` | ply, uci, fenAfterHash, clockMs, prevHash | Hash-chained (§7.2) |
| `REVEAL` | nonce | §6.8 step 3 |
| `ACK` | seq | Acks any reliable message; unacked messages are retransmitted (backoff 0.6 s doubling to 8 s), duplicates re-acked, early arrivals buffered and delivered in order |
| `SYNC` | delivered | After a reconnect or transport switch: peer resends everything unacked |
| `DRAW_OFFER` / `DRAW_RESP` | ply, accept | |
| `TAKEBACK_REQ` / `TAKEBACK_RESP` | toPly, accept | |
| `RESIGN` / `ABORT` | ply | |
| `FLAG_CLAIM` / `FLAG_RESP` | ply / accept | §7.3 |
| `RESULT` | result, reason, finalHash, pgnHash | Co-signed (§7.5) |
| `CHAT` | text (≤ 280 chars) or `quickId` | |
| `PING` / `PONG` | nonce | RTT for clock compensation |
| `REMATCH` | | |

- **Versioning:** peers pick the highest common `protoVersion`; unknown message types are ignored; incompatible majors show "Update required".

### 6.8 Pairing & color assignment (fair, no server)
1. A sends `CHALLENGE` containing `commit = H(nonceA)`.
2. B replies `ACCEPT` with `nonceB`.
3. A reveals `nonceA`; both compute `color = (H(nonceA ‖ nonceB)[0] & 1)`, giving a fair coin flip neither side can bias.
4. Both sign `START`; game begins when each has the other's signature.
- Race handling: if a device receives two ACCEPTs, it keeps the first with a valid `START` exchange and sends `DECLINE{reason:"taken"}` to others.

### 6.9 Reconnection
- On disconnect: both clients keep the game alive for **60 s** (clocks keep running for the side to move). The disconnected side's UI shows a reconnect spinner.
- Reconnect path: `HyperDHT.connect(opponentKey)` → Nostr fallback. On reconnect, peers exchange `(lastSeq, lastPly, lastHash)` and replay missing messages.
- After 60 s: the connected player may **claim win by abandonment** (or wait, or offer draw). Unilateral claims are recorded as *unconfirmed* (§7.5).
- **App restart (implemented):** the running game is saved on the device *before* each new message goes out, so a restored game never reuses a sequence number for different content. Each side keeps every message it sent during the game, and a `SYNC` after reconnecting replays everything after the peer's last delivered seq, including messages that were already acknowledged. So a save taken before a received move doesn't lose that move. Tested by restarting a player from a stale save mid-game (`core/src/net/restore.test.ts`).
- **Known limitation:** after an outage, the returning side's own view of its clock starts late (it can't tell when the opponent's move was sent), so the opponent's measurement prevails and may be logged as a discrepancy.

---

## 7. Trust, Fairness & Integrity Without a Server

### 7.1 Threat model (v1)
| Threat | Mitigation | Residual risk |
|---|---|---|
| Illegal moves from a modified client | Both peers independently validate every move with chess.js; illegal move → game ends, offender flagged locally | None |
| Tampering with move history | Hash-chained, signed moves (§7.2) | None |
| Clock manipulation | Receiver-side measurement (§7.3) | Small (±RTT) |
| Engine-assisted cheating | Cannot prevent. "Friends-only" mode; block/report; no prized ratings | **Accepted** |
| Rating inflation / Sybil accounts | Ratings are unofficial and opponent-verifiable (§7.5); PoW on seeks | **Accepted** |
| Lobby spam / DoS | PoW, per-peer rate limits, connection caps, local blocklists | Low |
| Impersonation | Keys + fingerprint; nickname is not identity | Low |
| IP exposure to opponent | Disclosure + "Relay-only privacy mode" (§9.2) | User choice |

### 7.2 Signed hash-chained move log
`h_n = BLAKE2b(h_{n-1} ‖ ply ‖ uci ‖ fenAfter ‖ clockMs)`, with `h_0 = H(START)`. Each `MOVE` is signed by its author. A complete game is a self-verifying transcript any third party can check.

### 7.3 Clocks
- **Clocks start once both sides have moved;** until then either side may `ABORT` (no result).
- Each client is authoritative for **displaying** both clocks, but timing disputes are resolved conservatively:
  - The mover reports its remaining time in `MOVE.clockMs`.
  - The receiver computes `elapsed_observed = recvTime(move_n) − sendTime(move_{n-1}) − RTT_est/2`.
  - If the reported time exceeds the receiver's computed time by > `max(500 ms, RTT_est)` + **2.5 s delivery allowance**, the receiver uses its own computation and logs a discrepancy. Three discrepancies → warn the user.
  - *As implemented:* the check compares **time used on the move** (the drop since the opponent's previous report), not absolute clocks. Comparing absolute clocks made one overrule cascade into overruling every later move. The opponent's turn is timed from when my move reached them (my move's ACK minus RTT/2, credit capped at 3 s), so retransmissions on my side don't count against them.
  - **Measured** (30 random 60-ply games per setting, simulated): honest clocks are overruled on < 1% of moves at 20% message loss. At 40% loss it's 11% (the slowest moves arrive later than the allowance), but games stay in sync. The allowance is also the most a dishonest client can gain unnoticed per move.
- **Flagging:** a player claims a flag with `FLAG_CLAIM`; the opponent's client answers `FLAG_RESP` and accepts if its own clock view is within `max(500 ms, RTT)` of zero, otherwise the game continues and the dispute is logged. A flag against a side that can't mate (lone king, or king + one minor) is a draw.
- **Draw offers** are only sent on the opponent's turn, so an offer can't cross a move in flight; moving declines a pending offer.
- Latency compensation: up to `RTT_est/2` (capped at 1 s) is credited back to the mover each move (similar to "lag compensation" on major chess sites).

### 7.4 Disputes
No arbiter exists. Disputed games are marked *disputed* and excluded from both players' rating calculations. The signed transcript is kept for the user's records.

### 7.5 Ratings (unofficial, verifiable)
- **Glicko-2**, computed **locally** from the user's own completed games.
- When both players sign a `RESULT`, either may publish it as a **NIP-64 chess game event (kind 64, PGN content)** with tags carrying both players' Ed25519 signatures and the final hash.
- A peer's displayed rating can be **spot-checked**: the client fetches the peer's last N kind-64 events from relays, verifies the co-signatures, and recomputes. Mismatch → rating shown as "unverified".
- Copy in UI: "Ratings are community-calculated and not official."
- **Status (2026-11-19): local Glicko-2 is implemented and checked on the phones (build 64): two finished games took Android's Blitz rating 1662 → 1720 → 1753, and both phones showed "Your rating".** The code is in `core/src/rating.ts`, and its unit test matches Glickman's worked example. There is one rating per time-control class, kept in `app/src/net/ratings.ts`. A new player starts at 1500 with RD 350, and a rating is shown with "?" while RD > 110. HELLO carries `rating`/`rd`, and Quick Match joins the player's 200-point band room plus "any". A game is rated once, by game ID. Games that were aborted or unconfirmed, and games against an opponent that sends no rating, are unrated. **NIP-64 (build 71, checked on the phones 2026-11-19: game 1's RESULTs were co-signed 1.2 s after the resignation and published; in game 2 the spot-check of the opponent came back `verified` 2 s after pairing):** after a decided game (not aborted, not one-sided, no protocol violation) each side sends a signed `RESULT`. It carries the winner, reason, move-hash head, plies, the sender's colour and npub, the class, and the sender's pre-game `r`/`rd`/`vol` if rated. The two envelopes are the co-signed record (`core/src/net/result.ts`, `checkCosigned`). Records are kept on the device (`app/src/net/results.ts`). They're published as kind 64 only if the player agrees: PGN content, tags `t=peermate`, two `peermate-result` envelopes, and `alt`. The player is **asked once** after their first co-signed game, and can change it in Settings → Online games (default off). On pairing, the app fetches the opponent's last 50 published games and runs `checkRatingChain`: both signatures, each game's pre-game rating following from the previous result under Glicko-2 (±2), and the newest result matching the rating in their HELLO. Their rating shows "✓" or "(unverified)"; nothing published shows no mark. Older builds ignore `RESULT` (unknown types are dropped, §6.7).

---

## 8. Chat

### 8.1 In-game chat
- Carried as `CHAT` messages on the active game channel (direct or Nostr fallback), so it is E2E-encrypted either way.
- **Strangers (Quick Match / seeks):** **quick-chat presets by default** ("Good luck!", "Have fun", "Good game", "Thanks", "Oops", "Well played"). Free-text with strangers is opt-in per user in settings (off by default; both players must have it enabled).
- **Friends:** free text enabled.
- Client-side profanity filter (toggle, on by default), local message rate limit (5 msgs / 10 s).

### 8.2 Friend / offline chat
- **NIP-17 private direct messages** (kind 14 rumor → sealed kind 13 → gift-wrapped kind 1059, NIP-44 v2 encryption, NIP-59 gift wrap). Metadata-minimizing: relays see neither sender nor content.
- Published to the recipient's **DM inbox relays** (kind 10050) per NIP-17; fallback to their NIP-65 relay list; fallback to app default relays.
- Message history stored locally in SQLite; relays are not treated as permanent storage.

### 8.3 Default relays
Ship a default list of public relays chosen by `app/tools/nostr-probe.mjs`, user-editable. Phase 0 probe (2026-11-17, 12 candidates): 7 delivered 5/5 ephemeral events with median latency 260–440 ms (`relay.snort.social`, `relay.damus.io`, `offchain.pub`, `nos.lol`, `nostr.mom`, `relay.nostr.net`, `relay.primal.net`); 5 were unreachable (including `relay.nostr.band`). Re-run the probe before each release and keep ≥ 6 healthy relays. Publish to ≥3, read from ≥3. Auto-demote relays that fail health checks. **Re-check (2026-11-19, phone relay check, Android on home Wi‑Fi):** 5 of 12 passed: `relay.snort.social` (251 ms), `nostr.bitcoiner.social` (305), `relay.nostr.net` (324), `offchain.pub` (327), `relay.primal.net` (335). `relay.damus.io`, `nos.lol` and `nostr.mom` failed from both the phone and a Mac on that network, two days after working; they may be limiting that connection after the soak test. `offchain.pub` once rejected a new key as "not in our web of trust". The default list is now those five plus damus and nos.lol (7). Sending a private message or the mute list now counts as done at the first relay's OK, instead of waiting out dead relays. **Auto-demotion (build 69):** `core/src/net/relayHealth.ts` (unit-tested) rests a relay after 3 failed publishes in a row, for 10 min, doubling on each repeat up to 6 h. After a rest, one more failure rests it again; one success clears its record. At least 3 relays always stay in use. A failure counts only if another relay took the same event, since otherwise we're probably offline. Every RelayNet follows it, moving subscriptions when the set changes, and the app saves it between runs (`relayHealthStore.ts`). The Relay check screen shows resting relays. A desktop bot rested `nos.lol` 23 s after start. **Slow relay starts (build 65):** seeks, challenges and listening waited for the P2P worker's `ready`, which comes only after `swarm.listen()` (9 s on Wi‑Fi at app start, longer on mobile data, 20 s timeout). A relay Quick Match took 38 s. They now start on the relays at once, and the worker joins when ready. Two relay-only desktop bots paired in 3 s. **Relay resync storm (build 68):** the app also called `matchmaker.peerConnected()` on every relay message. For a known peer that means "new connection" and resyncs (SYNC plus a resend of everything unacknowledged), so the phones answered every message with more: about 60 messages in 6 s for a 6-message handshake, and 15–21 s from discovery to the board. The desktop bots never did this. Now it's called once per peer per search (again after `HELLO_TIMEOUT_MS`). **Field result:** with Wi‑Fi off on one phone, first HELLO to matched took 3.3 s over relays, with about 20 messages. The `hs` handshake trace stays in the field log (pairing only). The **Relay check** screen (home → Relay check) runs this test on any phone.

### 8.4 Notifications (limitation)
- Remote push (APNs/FCM) requires a server holding provider credentials, so **out of scope** under the "no servers we own" rule.
- **In-app:** live banners while app is open.
- **Background (best effort):** iOS `BGAppRefreshTask` / Android `WorkManager` (≥15 min, OS-scheduled) polls Nostr relays for new DMs/challenges/correspondence moves and posts **local notifications**.
- **Status (2026-11-18): implemented for friends' messages and field-tested.** `expo-notifications` posts local notifications: while the app is open, unless that conversation is on screen; tapping one opens it. `expo-background-task` runs `checkMessages()` (`app/src/background.ts`, defined from the custom entry `index.ts` so it exists in a headless start), a one-off relay fetch with NIP-42 AUTH. Results: iPhone with the app open showed a banner; Android in the background got a notification; and with Android's process stopped, a forced WorkManager run started the app headless, fetched the message and notified. Two build fixes: a config plugin drops expo-notifications' `aps-environment` entitlement (no push, and the profile lacks the capability), and R8 keep rules for WorkManager's Room database (the release build crashed on launch). Not verified yet: an unforced iOS BGTask run (iOS decides when). Challenges aren't in the background check yet.
- **Android live games:** optional foreground service ("Game in progress") keeps the P2P connection alive while backgrounded.
- **iOS live games:** connection is lost ~30 s after backgrounding; the 60 s reconnect window (§6.9) covers quick app switches. Document clearly in onboarding.
- Future option (documented, not v1): third-party Nostr push-notification services exist; adopting one would trade some privacy for push.

---

## 9. Privacy & Security

### 9.1 Data handling
- No accounts, no analytics SDKs, no ads, no tracking. Crash reporting: **none by default**. Optional opt-in that exports a log file the user can share manually.
- All data local (SQLite) except what the user publishes to Nostr (profile, contacts, mute list, game records, encrypted DMs).
- **Store privacy labels:** "Data Not Collected" (developer collects nothing) — but disclose in the privacy policy that **peers can see your IP address** in direct P2P mode and public Nostr relays receive your published events.

### 9.2 Relay-only privacy mode
Setting: "Hide my IP from opponents" → disables HyperDHT direct connections; all traffic via Nostr relays (relays still see IP; opponents do not). Warns about higher latency.

### 9.3 Crypto summary
| Purpose | Primitive |
|---|---|
| P2P transport | Noise (XX/IK) via HyperDHT secret-stream, Ed25519/X25519, ChaCha20-Poly1305 |
| Message signing | Ed25519 |
| Nostr events | secp256k1 Schnorr (BIP-340) |
| Nostr encryption | NIP-44 v2 (ECDH + HKDF + ChaCha20 + HMAC-SHA256) |
| Hashing | BLAKE2b-256 |

**Export compliance:** uses only standard, published cryptography. Set `ITSAppUsesNonExemptEncryption` per legal review (likely eligible for the mass-market/standard-crypto exemption; confirm whether the annual BIS self-classification report applies).

---

## 10. Board Rendering

### 10.1 Shared
- Single source of truth: `GameState` (FEN + move list + selection + premove + arrows). Both renderers are pure views over it; switching 2D↔3D mid-game is instant.
- Input: tap-tap and drag-and-drop; promotion picker; premove (online); arrows/highlights by long-press-drag.
- Animations: 150–250 ms move tweens; capture fade; check pulse.
- Sound + haptics on move, capture, check, low time (<10 s).

### 10.2 2D (v1.0)
- **react-native-skia** board: 60 fps on mid-range devices, crisp vector pieces. *(Phase 1 ships plain views plus `react-native-svg`; move to Skia only if profiling on low-end phones demands it.)*
- Original piece sets (SVG) — at least 3 built-in — plus board themes (wood, green, blue, high-contrast). **Set 1 ("Peermate classic") is done:** drawn for this project as path data on a 100×100 canvas (`app/src/components/pieces.ts`; preview sheet via `node app/tools/pieces-preview.mjs out.svg`).
- **Drag-and-drop** (done): one responder on the board decides tap vs drag (travel > 20% of a square from a movable piece). The lifted piece follows the finger on an `Animated` value (no board re-render per frame), the square under the finger gets a hover outline, an illegal drop snaps back with the piece still selected. The source square keeps a faded copy mounted: unmounting the view a touch started on makes Android drop the rest of the gesture. Squares expose an `activate` accessibility action, so screen readers still work.
- Coordinates, last-move highlight, legal-move dots, check highlight.

### 10.3 3D (v1.1)
- **react-three-fiber/native + expo-gl**, Three.js.
- **Original** low-poly glTF piece models (≤ 8k triangles per piece type, Draco/meshopt compressed, total 3D assets ≤ 6 MB), PBR materials, baked AO.
- Camera: default angled view from player's side; pinch-zoom, orbit limited to ±60°, double-tap to reset; optional "top-down" snap.
- Picking via raycast on board squares (not meshes) for reliable touch targets.
- Performance budget: 60 fps on iPhone 12 / Pixel 6, 30 fps floor on low-end Android with auto quality reduction (shadows off, lower DPR).
- Fallback: devices failing a GL capability check hide the 3D toggle.

### 10.4 Accessibility
VoiceOver/TalkBack: squares labelled ("e4, white knight"), move announcements, an accessible move-entry text field (SAN). Dynamic Type for UI. Color-blind-safe highlight themes. Reduced-motion setting respected.

---

## 11. Platform Constraints & Requirements

| Item | iOS | Android |
|---|---|---|
| Min OS | iOS 16 (Bare Kit itself supports 15.1+) | **Android 10 / API 29** (required by Bare Kit; confirmed in Phase 0) |
| Target SDK | Latest Xcode/iOS SDK required by App Store Connect at submission time | Play's current target-API requirement (API 36 for new apps/updates since Aug 2026) |
| Native archs | arm64 | arm64-v8a, armeabi-v7a, x86_64; **16 KB page-aligned** `.so` files |
| Background | No persistent sockets; `BGAppRefreshTask` | Foreground service type `connectedDevice`/`dataSync` (verify allowed type) for live games; WorkManager |
| Permissions | None required for internet P2P. If LAN discovery is added later: `NSLocalNetworkUsageDescription` + Bonjour services | `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE` (+ type) |
| Secure storage | Keychain | Keystore (via expo-secure-store) |
| App size target | < 60 MB download | < 50 MB AAB download (per-ABI splits) |

---

## 12. Quality & Testing

### 12.1 Unit / property tests (`core/`, Node, Jest/Vitest)
- Rules edge cases (castling through check, en passant pins, promotions, 50-move/threefold).
- Protocol codec round-trips; signature verification; hash-chain verification; Glicko-2 vs reference values.
- **Fuzzing** of message decoder and state machine (random/malformed/out-of-order/duplicate messages).

### 12.2 Network integration tests (CI, no internet needed)
- `hyperdht/testnet` spins up a **local bootstrap DHT** inside CI. Simulate N peers pairing, disconnect/reconnect, transport migration.
- Local Nostr relay (e.g. `strfry` or `nostr-rs-relay` in Docker) for the fallback path.
- Network chaos via `tc netem`: latency 50–800 ms, 5% loss, partitions.

### 12.3 Engine calibration
`core/tools/calibrate.ts` (see README) plays levels against each other and against Stockfish at fixed `UCI_Elo` anchors on a Mac, driving each level exactly as the app does. Timed searches are scaled to the phone (`--phone-speed 0.41`: Galaxy A56 258k vs M-series 626k nodes/s). It fits ratings by maximum likelihood with the anchors fixed. Stockfish is a local measuring stick only, never shipped.

**Results (November 2026):**
- **First run** (old table, 24 games per pairing, 18 pairings): Level 3 (depth 3) beat Level 4 (`UCI_Elo` 1000) 24–0. Fitted order: L4 < L5 < L6 < L1 < L7 < L2 < L8 < L3 < L9 < L10. That led to dropping `UCI_Elo` (§5.2).
- **Three rounds of candidate tables** (16 games per neighbouring pair) produced the current table. Pooled steps: L1→2 ~220, L2→3 ~160, L3→4 ~100, L4→5 ~160, L5→6 ~340 (before softening L6), L6→7 ~70, L7→8 ~340, L8→9 ~470, L9→10 600+.
- **Absolute scale not trusted:** Stockfish's limited-strength ratings look inflated at 300 ms per move (depth 3 with 15% random moves beat "SF 1320" 22–2).

**Still to do:**
- Re-run with ≥ 64 games per pair; at 16 games the error is ±150 Elo.
- Anchor to human ratings, for example with opt-in result reporting from beta testers.
- Add a nightly job that fails if levels aren't monotonic.
- One engine timeout (no `bestmove` within 120 s) happened in a `UCI_Elo` 2700 vs full-strength game. It did not reproduce in 16 more games of that pairing; the app's 60 s timeout turns a hang into "CPU unavailable" rather than a freeze. A restart-and-retry on timeout should be added.

### 12.4 E2E
**Maestro** flows on iOS simulator + Android emulator: onboarding, vs-CPU game to mate, pass & play, two-emulator online game over local testnet, chat, block/report.

### 12.5 Field testing (Phase 0 + beta)
Measure real-world **hole-punch success rate** across Wi-Fi/4G/5G/carrier CGNAT pairs in ≥ 5 countries. Target ≥ 70% direct; 100% connect (with fallback).

**Phase 0 field results (2026-11-17, Samsung Galaxy A56 / Exynos 1580 / Android 17):**

| Test | Result |
|---|---|
| Direct P2P, phone on home Wi-Fi ↔ Mac (same LAN) | Connected in 3.3 s, RTT ~119 ms |
| Direct P2P, phone on **5G behind carrier-grade NAT** (`100.64.0.0/10`) ↔ Mac behind home router | **Hole-punched direct path** in 4.7 s; RTT 93–137 ms (one 341 ms spike); chat both ways |
| Arasan, full strength, 1 thread, 1 s/move | 258k nodes/s, depth 16; 67 MB peak memory |
| Nostr fallback, phone on **5G behind carrier-grade NAT** ↔ Mac | Discovery 2.8 s; RTT 685–972 ms; delivery both ways |
| Direct P2P while the phone is **locked** | Connection timed out, reconnected once, then dropped again: Android cuts background networking. Confirms the need for the reconnect window (§6.9) and the optional foreground service during live games (§8.4) |

One device and one carrier: keep collecting results from testers on other carriers and countries toward the ≥ 70% direct-connection target.

**Phase 2 field test (18 Nov 2026), first online games in the app:**
- Desktop bot (home Wi-Fi) vs Galaxy A56 on **5G**: both announced on the lobby topic within seconds, but every connection attempt failed with `HOLEPUNCH_ABORTED`. In Phase 0 the same pairing punched through in 4.7 s, so success depends on the carrier NAT's behaviour at the time. **Quick Match therefore needs the relay fallback (§6.3, §6.6) to be dependable;** it was pulled forward to the next slice.
- Same pairing with the phone on **home Wi-Fi**: matched in about 1 s and a full game was played (24 plies, tap and drag moves, quick chat both ways, resignation). Both sides agreed on the result, and the game appeared in history and Review.
- **With the relay fallback (build 14), phone on 5G:** the phone's seek reached the bot through the relays and they matched 3 s later. The whole game was played through relays: the direct connection never punched through, but Hyperswarm kept trying in the background. 12 plies ended in checkmate, with quick chat delivered. Moves arrived in about 1–3 s, including the bot's think time.
- Desktop-only check: two relay-only bots paired in about 4 s and played 63 plies to a flag claim through public relays, both agreeing on the result.
- **Resume after the app is killed (builds 19–21, Android):** swiping the app away mid-game and reopening it restored the game at the saved ply and play carried on with the bot. The P2P worker took about 12 s to start (DHT listen) on a cold start, so the game is now restored as soon as the identity loads, over the relays, and goes direct once the worker is up; a resume left the app looking idle before, and a new seek then discarded it.
- **iOS (2026-11-18, iPhone 15 / iOS 27.2.1, Release build):** the Bare worklet aborted on start with "Failed to reserve virtual memory for process-wide V8 pointer compression cage" until the app got the `com.apple.developer.kernel.extended-virtual-addressing` entitlement (paid team; set in app.json). With it, iPhone on home Wi-Fi vs the desktop bot paired over a **direct** Hyperswarm connection, and swipe-kill resume worked.
- **Phone vs phone (2026-11-18): iPhone 15 (iOS 27.2.1) vs Galaxy A56 (Android 17), on different networks (one on mobile data).** Matched through the relays 21 s after the seek and played the game with chat; no direct connection was made, as in the earlier 5G test. iOS Release builds drop JS `console.info`, so the iPhone side has no `[online]` lines; native logging would be needed for iOS field diagnostics (since added: `app/tools/ios-log.sh`).
- **Phone vs phone on the same home Wi-Fi (2026-11-18):** iPhone 15 vs Galaxy A56 paired over a **direct** Hyperswarm connection 12 s after the seek, and played normally.
- **iOS backgrounding (2026-11-18, iPhone 15 vs desktop bot, direct on Wi-Fi):** a ~10 s switch away dropped the direct link and it came back by itself in 5 s. A ~3.5 min absence: the phone came back over the relays within a second and confirmed the bot's pending flag claim. But the bot kept treating the dead direct link as up for the whole absence. **Fix (build 32):** a direct link silent for 12 s (pings every 5 s) is dropped in favour of the relays and re-dialled, and the app resyncs and re-dials as soon as it returns to the foreground. Checked by freezing one of two desktop bots for 30 s (SIGSTOP): the other switched to relays after 13 s, and they were back on direct within a second of resuming. A second iPhone test didn't exercise it: iOS kept the app's connection alive through a ~35 s switch. Timing of the suspension is iOS's choice.
- **Dual-dial flapping (fixed):** when both players dialled a direct link at once, one side's route flapped direct/relay up to 7 times in 2 s. `p2p/worker.js` now tracks every live connection per peer, writes to the newest, and reports a peer gone only 1.5 s after its last connection closes (an explicit drop is immediate).
- **Friends and challenges (2026-11-18, build 40):** friends are local (`app/src/net/friends.ts`), added from a share link `peermate://p/<peerKey>?n=<nostrKey>&nick=…` (deep link or paste) or "Add as friend" after an online game. A challenge is a friends-only matchmaker (`Matchmaker` `only`/`invite`) whose HELLO carries the time control (`HELLO.invite`), sent direct if reachable and through the relays otherwise. The app listens for challenges whenever it's open (worker + relay inbox). It shows any non-blocked player's challenge, marking ones from non-friends, and accepting adds the challenger as a friend: the first version listened only to existing friends, so a one-sided add never arrived. Decline and Cancel are sent at once, and an unanswered challenge ends after 2 min. **Field test:** Android challenged the iPhone (which hadn't added it) and the game started 6.7 s later over a direct link. **Offline challenges (2026-11-19, build 58):** a challenge also goes as a NIP-17 message (`♟ Challenge: <tc>`) when the friend hasn't been seen lately or doesn't answer within 2 min. The receiver is notified (in the app, or by the background check) and gets a "challenged you" dialog. "Challenge back" sends a live challenge, which the original challenger's app shows as "accepted your challenge". Pending challenges last 24 h. This was tested between the phones with the iPhone app closed: the iPhone showed the dialog when opened, and the game started after Challenge back. **QR codes (2026-11-19, build 55):** Friends shows your friend link as a QR code, and "Scan their QR code" (expo-camera, camera permission only, no microphone) opens the same confirmation as a tapped link. Scanning worked in both directions between the Android phone and the iPhone.
- **Presence (2026-11-18, build 42):** while the app is open, each friend gets an encrypted note over the relays every 60 s (`P:online|playing`; `away` when the app goes to the background), and a friend who just appeared is answered at once. Online means a note in the last 2 min. Only friends receive notes, and relays see only that a message was sent. **Field test:** the iPhone going to the home screen showed as Away on the Android phone, then Offline after about 2 min, and Online again within seconds of reopening. The HyperDHT reachability probe from §6.5 isn't used; relay notes were enough. **Traffic trim (2026-11-19):** the keep-alive (now every 45 s, each note counting for 150 s, so one lost note never shows a friend offline) goes only to friends heard from in the last 5 min. Others get a note every 5 min as a safety net: a friend coming online announces itself and is answered at once. That immediate answer is now only for a friend who was offline or away; answering every keep-alive had doubled one side's notes. Simulated over an hour (`presence-sim`, 200 runs): alone 60 → 12 notes, two friends online 160 → 136, about the same accuracy at 10% note loss. **QA on the phones (2026-11-19, build 97, `app/tools/presence-probe.mjs` as a desktop friend):** adding a friend sent one greeting. To an offline friend, notes went 314–315 s apart and none in between. Opening a chat and sending a message sent no presence; the message arrived within 1 s. With the friend online, the iPhone answered once when it appeared, then sent notes exactly 45 s apart and didn't answer the friend's own keep-alives. Away and online went out at once on background and foreground. iPhone ↔ Android: presence, away and chat all worked, quickly. **Relay finding (`app/tools/relay-delivery.mjs`):** relay.damus.io and relay.nostr.net accept kind-1059 messages but never release them: their NIP-42 AUTH fails with "relay needs serviceUrl". nos.lol refused our events in both runs, and nostr.bitcoiner.social in one of two. Chat still arrives through the others; relay health can't see this, because those relays answer OK. A note to everyone goes out only on start and on a status change. `listen()`, which the chat screen calls on open and `sendMessage` calls before every send, used to re-announce to all friends each time; now it only greets friends never told (one just added). The NIP-17 subscription reads its `since` from the newest stored message on every reconnect, instead of re-fetching from the app's start.
- **Messages (2026-11-18, build 47):** NIP-17 private messages (kind-14 rumor, sealed, gift-wrapped as kind 1059) through the default relays, which store them, so a friend whose app is closed gets them when it next opens. History is local (`app/src/net/messages.ts`). Only friends' messages are kept, and `unwrapEvent` verifies the seal signature and that the rumor's author matches the seal's. Two field fixes: relays release gift wraps only after **NIP-42 AUTH**, which the pool now answers automatically (without it, messages were stored but never delivered); and a device's first fetch started at time 0, which the NIP-59 two-day margin made negative. It now looks back 30 days. **Field test:** a message sent to the iPhone 23 min earlier (it couldn't fetch then) arrived 1 s after the fetch started; a live message took 2 s end to end; the reply went back. No notification while the app is closed (that would need a push server). Kind 10050 inbox-relay lists aren't used yet: both sides assume the default relays.
- **Soak test (2026-11-18), `app/tools/soak.mjs`:** bot-vs-bot games over the public HyperDHT and Nostr relays, each in a private room, 15+10, 4 at a time, cycling direct / relay-only / freeze (one bot SIGSTOPped for 20–40 s mid-game). A game passes only if both sides report the same result and final position, with no unconfirmed claim.
  - **Run 1: 100 games, 4 failed (4.0%).** (a) A lost direct link mid-pairing made one side drop the handshake while the other completed it over relays. (b), (c) The side that ended the game exited before its last message (final move, draw acceptance) was acknowledged, and relay publishes were failing at that moment, so the other side never learnt the game was over. (d) A relay subscription went deaf after a hung nostr-tools reconnect.
  - **Fixes:** the matchmaker keeps a peer the relays can still reach, and resyncs on a second connection. Leaving a finished game keeps the transports up until its last messages are acknowledged (15 s in the app). Relay subscriptions probe themselves with our own events and reconnect from scratch after 60 s of silence. Plus the worker change above.
  - **Run 2: 100 games, 0 failed** (direct 34/34, relay 33/33, freeze 33/33). Pairing took a median 3.7 s, p95 4.5 s, max 4.9 s.
  - Caveats: every bot ran from one Mac and IP address, so relay rate limits are worse than for real users. And it's bots, not phones: phone-to-phone games are covered by the field results above, not by this run.

### 12.6 Performance targets
| Metric | Target |
|---|---|
| Cold start to home screen | < 2 s (mid-range) |
| Quick Match time-to-pair (active lobby) | p50 < 10 s |
| Direct connect time | p50 < 3 s, p95 < 6 s |
| Move latency, direct | p50 < 150 ms |
| Move latency, Nostr fallback | p50 < 600 ms |
| CPU move (levels 1–9) | < 1.5 s incl. humanized delay |
| Battery during 10-min online game | < 3% on reference devices |

---

## 13. Build, CI/CD & Store Automation (Fastlane)

### 13.1 Repository layout
```
/app                 # Expo/React Native app (prebuild generates ios/ and android/)
/app/p2p-worklet     # Bare bundle (hyperswarm), built with bare-pack
/native/arasan       # Arasan submodule (v26.1); build script in /native
/app/modules/arasan-engine  # Expo module running the engine over UCI (child process on Android, in process on iOS)
/core                # Pure TS domain logic
/fastlane            # Fastfile, Appfile, Matchfile, Pluginfile, metadata/, screenshots/
/.github/workflows   # ci.yml, release.yml
/docs                # privacy-policy.md (published via GitHub Pages)
```

### 13.2 Versioning
- Marketing version from `package.json` (`semver`), set via `increment_version_number` / Gradle `versionName`.
- Build numbers: iOS `latest_testflight_build_number + 1`; Android `max(google_play_track_version_codes(all tracks)) + 1`.
- Git tag `vX.Y.Z` per release.

### 13.3 Fastlane lanes

**iOS** (`fastlane ios <lane>`)
| Lane | Steps |
|---|---|
| `device` | **Implemented (pre-store).** Builds `native/build-arasan-ios.sh` output if missing → `expo prebuild -p ios --clean` (outside Bundler, so the system CocoaPods runs) → `build_app` with automatic signing, team `QGLA89KHM7`, `export_method: development` → `dist/peermate-X.Y.Z-N.ipa` (N = commit count, as on Android) → `devicectl device install` on the connected iPhone (`install:false` to skip; `PEERMATE_IOS_DEVICE` picks a UDID). For our own registered devices until Phase 4 |
| `certs` | `match(type: "appstore", readonly: is_ci)`. Certificates/profiles stored encrypted in a **private Git repo** (no server needed) |
| `build` | `expo prebuild` (if needed) → `cocoapods` → bump build number → `build_app` (gym) → output `.ipa` + dSYMs |
| `beta` | `certs` → `build` → `upload_to_testflight` (pilot) with changelog from `CHANGELOG.md`; distribute to external group |
| `screenshots` | `capture_screenshots` (snapshot) for 6.9" and 13" iPad (if iPad supported) in all locales → `frame_screenshots` (optional) |
| `release` | `deliver` (metadata, screenshots, review notes, privacy URL, age-rating config) with `submit_for_review: true`, `automatic_release: false`, `phased_release: true` |

**Android** (`fastlane android <lane>`)
| Lane | Steps |
|---|---|
| `build` | `expo prebuild` → `gradle(task: "bundle", build_type: "Release")` signed with upload key from CI secrets |
| `sideload` | `gradle(task: "assemble", build_type: "Release")` → universal signed APK → `set_github_release` (tag `vX.Y.Z-buildN`, APK attached). Used in Phases 0–3 |
| `beta` | `build` → `upload_to_play_store(track: "internal")` (supply) |
| `promote` | `upload_to_play_store(track: "internal", track_promote_to: "production", rollout: "0.1")` |
| `rollout` | Increase staged rollout (`0.1 → 0.5 → 1.0`) |
| `screenshots` | `capture_android_screenshots` (screengrab) |
| `metadata` | `supply(skip_upload_aab: true)` to sync listing text/images from `fastlane/metadata/android` |

**Status (2026-11-19):** all store lanes are written in `fastlane/Fastfile`: Android `build`/`beta`/`promote`/`rollout`/`metadata`, and iOS `certs`/`build`/`beta`/`metadata`/`release`. Only `android build` can run without accounts. It produced a signed `dist/peermate-0.1.0-78.aab` (123 MB, all ABIs; Play serves per-device splits), with 0 password occurrences in the log. Differences from the tables above:
- Build numbers stay the commit count on both stores (§13.2), shared with sideload/device builds, so a store build always supersedes a sideloaded one. Because of that, upload lanes refuse to run with uncommitted changes (`force:true` overrides).
- `ios certs` is read-only unless `setup:true`.
- `ios release` submits the newest TestFlight build for the marketing version (or `build:N`).
- Export compliance is left to the developer in App Store Connect (the app uses end-to-end encryption).
- Metadata lanes refuse `{{…}}` placeholders.
- Screenshots come from `app/tools/screenshots-{android,ios}.sh`, not snapshot/screengrab.
- `android beta status:draft` is needed until Play has reviewed the app once.
- Settings are in `fastlane/.env.example`.
- **iOS live (2026-11-19):** `ios certs setup:true` created the Apple Distribution certificate and the "match AppStore com.peermate.app" profile. They're stored in the private `peercommons/certificates` repo. `ios beta` uploaded build 0.1.0 (84) to TestFlight (app ID 6836654483); it was processed in 4 minutes, and the changelog was set. The first upload was rejected (90057): BareKit's Info.plist lacks `CFBundleShortVersionString`. `fix_barekit_plist` now resolves the Swift packages and writes bare-kit-swift's version into the unsigned xcframework before every iOS build.
- **Submitted for App Store review (2026-11-19 15:11):** version 0.1.0, build 89, with the new icon and iPhone only. Manual release, phased. App Privacy says "Data not collected". `app/tools/review-bots.sh` keeps a "Test opponent" in every Quick Match time control during review; stop it after approval.

**Shared**
- Auth: **App Store Connect API key** (`app_store_connect_api_key`, `.p8` in CI secret) and **Google Play service-account JSON**. No Apple ID passwords / 2FA in CI.
- `before_all`: `ensure_git_status_clean` (local), set up `ENV` from secrets.
- `error`: post failure summary to the GitHub job log (no external chat integration required).

### 13.4 GitHub Actions
- `ci.yml` (every PR): lint, typecheck, unit tests, protocol fuzz (short), network integration tests (local testnet + local relay), Android debug build, iOS simulator build.
- `release.yml` (on tag `v*`): matrix `macos-latest` (iOS `beta`) + `ubuntu-latest` (Android `beta`); manual `workflow_dispatch` jobs for `ios release`, `android promote`, `android rollout`.
- Secrets: `MATCH_PASSWORD`, `MATCH_GIT_BASIC_AUTHORIZATION`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`, `PLAY_JSON_KEY`, `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
- Caching: CocoaPods, Gradle, node_modules, Arasan native build artifacts.

### 13.5 Store metadata (in repo, versioned)
`fastlane/metadata/{ios,android}/<locale>/`: name, subtitle, description, keywords, release notes, privacy URL, support URL (GitHub Issues), marketing URL (GitHub Pages). Age-rating questionnaire answers kept in `fastlane/rating_config.json`.

**Status (2026-11-19):** en-US listing text for both stores is written and within the length limits. **Publisher (2026-11-19): Peercommons**: domain `peercommons.org` (Cloudflare), GitHub organisation `peercommons`, contact `support@peercommons.org`. Support URL `github.com/peercommons/peermate/issues`; privacy policy `peercommons.org/peermate/privacy/`, served by GitHub Pages from this repo's `docs/` (Jekyll, `permalink: /privacy/`); the org site repo `peercommons.github.io` carries the custom domain. The policy is also linked in the app (More → Privacy policy). `docs/privacy-policy.md` is drafted. Licence notices are generated by `app/tools/gen-notices.mjs` (637 components, no GPL-only ones) into the in-app **More → Licences** screen and `THIRD_PARTY_NOTICES.md`. **Screenshots:** `peermate://demo` (fresh installs only, `app/src/demo.ts`) seeds sample content. It plays the online game as two real in-memory sessions, so the board, clocks and ✓ rating are genuine. `app/tools/screenshots-android.sh` captures 7 screens on an emulator, with the clean status bar, into `fastlane/metadata/android/en-US/images/phoneScreenshots/`. **iOS:** `native/build-arasan-ios.sh` now builds `Arasan.xcframework` (device plus arm64 simulator). `app/tools/screenshots-ios.sh` captures the same 7 screens on an iPhone 17 Pro Max simulator, at the required 6.9" size (1320×2868), into `fastlane/screenshots/en-US/`. The simulator build is signed "to run locally" because the ID's keychain needs a signature; this involves no team. iOS asks "Open in Peermate?" for every deep link from `simctl`, so instead the app tours its own screens when launched with `-peermateDemoTour 1` (`maybeRunDemoTour`). It logs `[demo] shot <name>`, and the script captures from the simulator's log stream. The simulator is rebooted first, because dialogs from earlier runs stay queued.

---

## 14. Compliance, Legal & Store Review Risks

### 14.1 Naming / trademark ⚠️
**"Chessmaster" is a registered trademark of Ubisoft** (the long-running *Chessmaster* game series). Using it as the store name invites rejection and legal risk, so the app is named **Peermate** (peer + checkmate). Before Phase 2, confirm the name is free: (1) App Store and Google Play search for exact and similar names, (2) USPTO/EUIPO trademark search in classes 9 and 41 (software, games), (3) reserve the name in App Store Connect and Play Console, (4) claim a matching GitHub organisation and Pages site. Rename the project folder and bundle IDs (e.g. `com.<you>.peermate`) at the same time. Also: all art, piece models, sounds, and UI must be original or properly licensed.

### 14.2 User-generated content (Apple Guideline 1.2, Google UGC policy)
Apps with user chat must provide: content filtering, **report**, **block**, and a way for the developer to act on reports. Serverless plan:
- Filter: on-device profanity filter; quick-chat-only default with strangers.
- Block: instant, local + NIP-51 mute list.
- **Status (2026-11-18): block, report and the chat filter are implemented, and checked on an iPhone 15 against a fixed-identity bot.** Blocking resigned the game, and the same bot was then dropped on every connection over a minute of searching without pairing. Unblocking re-enabled pairing. The report opened in the share sheet with name, ID, moves and chat. **Mute list (2026-11-19, build 64):** the block list syncs as an encrypted NIP-51 kind-10000 list (all items private, NIP-44 to self; whole-list last-writer-wins), at app start and 2 s after a change. On Android, block published 1 entry and unblock published 0. Still to do: NIP-56 reports (with friends, Phase 3), the developer support address in the report flow (Phase 4), and the signed denylist. Free text from opponents is dropped entirely; there's no on-device profanity filter, because the app offers only quick chat.
- Report: generates a **NIP-56 report event (kind 1984)** and offers a pre-filled email to the developer's support address with the signed transcript; the developer can ship a **signed denylist** (fetched from a GitHub-hosted static file or a Nostr list signed by the developer key) that clients honor.
- Publish contact info (support email) in-app and in listings.
- Expect the **age rating** to rise due to unrestricted chat; quick-chat-only default may help. Fill questionnaires accurately.

### 14.3 Other
- Privacy policy hosted on GitHub Pages (static, not "our server").
- Open-source licence notices: in-app licences screen and `THIRD_PARTY_NOTICES` for all third-party components (Arasan, chess.js, Hyperswarm, nostr-tools, etc.).
- No gambling, no real-money wagering.
- EU DSA / trader status: complete the developer trader declarations on both stores.

---

## 15. Delivery Plan

**Android first.** Phases 0–3 target Android only, distributed by **sideloading** (no Play Console or Apple account needed). All code stays cross-platform: no Android-only APIs in shared code, and platform-specific pieces (foreground service, background polling) sit behind interfaces with an iOS implementation planned. iOS is validated at the Phase 2 checkpoint and becomes a release target in Phase 4.

Sideloading notes:
- Dev loop: `npx expo run:android` to a USB- or Wi-Fi-connected phone.
- Tester builds: universal release **APK** (AABs can't be sideloaded) attached to a GitHub Release by `fastlane android sideload`.
- The **release signing key is created on day one** and reused forever (it later becomes the Play upload key's source or is enrolled in Play App Signing). Changing keys forces testers to uninstall, losing local data.
- Google's developer verification for apps installed outside Play is rolling out on certified devices. `adb` installs are exempt; re-check status before distributing beyond a small tester group.
- Testing needs ≥ 2 physical phones on different networks for realistic NAT results; an emulator is fine for basic checks.


| Phase | Duration | Scope | Exit criteria |
|---|---|---|---|
| **0: Spikes (Android)** | 3 wks | (a) RN + Bare Kit + Hyperswarm on real Android devices; (b) hole-punch success field test; (c) Nostr ephemeral-event support across candidate relays; (d) Arasan TurboModule on device: network-file size, CPU/battery use, and `UCI_Elo` behaviour at low levels; (e) R3F/expo-gl 3D perf prototype; (f) Fastlane `android sideload` lane producing a signed APK on a GitHub Release | Go/no-go per spike; fallback plans (WebRTC instead of HyperDHT; Flutter for 2D-only) decided |
| **1: Offline core** | 4 wks | Rules, 2D board, vs CPU (10 levels), pass & play, PGN, history, settings, analysis | Levels strictly ordered by self-play calibration (done); human-Elo anchoring moves to beta |
| **2: Online MVP** (**done** 2026-11-18: protocol core, Hyperswarm play, relay fallback, iOS checkpoint, 100-game soak at 0% failed, block/report) | 6 wks | Identity/backup, Hyperswarm lobby + Nostr fallback, protocol, clocks, reconnect, in-game quick-chat, block/report. **iOS checkpoint:** run spike (a) and a full online game on a real iPhone, including backgrounding behaviour | 100 internal games across networks, < 2% failed games; iOS checkpoint passed |
| **3: Social** (**done** 2026-11-19: friends, QR codes, challenges incl. offline, presence, NIP-17 messages, local notifications, Glicko-2 ratings, NIP-64 co-signed publishing with rating spot-checks, NIP-51 mute list, relay auto-demotion) | 3 wks | Friends, presence, NIP-17 DMs, challenges, ratings + NIP-64 publishing | n/a |
| **4: Store readiness** | 2 wks | Developer accounts (start the Play 12-tester / 14-day closed test early), Fastlane `ios` lanes + `match`, store name, metadata, screenshots automation, privacy policy, UGC compliance, accessibility pass, public beta (TestFlight external + Play open testing) | Passes App Review + Play review |
| **5: v1.1** | 4 wks | 3D board, correspondence games, adaptive CPU, more themes | n/a |

---

## 16. Open Questions
1. Do we want **iPad** layouts in v1 (affects screenshots and `deliver` config)?
2. Exact Nostr ephemeral kind number for seeks/live moves. Use an unclaimed range and propose a NIP, or reuse a generic app-data kind (NIP-78, kind 30078, for non-ephemeral data)?
3. Should Mainline DHT (BEP 44) presence records be added for redundancy, or is HyperDHT + Nostr enough?
4. HyperDHT bootstrap: rely on Holepunch's public bootstrap nodes only, or also hard-code community bootstrap nodes? (Running our own would violate the no-servers goal; it's possible as an optional, community-runnable node.)
5. Is free-text chat with strangers worth the moderation and age-rating cost, or should strangers be quick-chat-only permanently?
6. Confirm "Peermate" is available as a store name and trademark (§14.1).
7. Open-source Peermate anyway (for trust in a serverless app, community relays/bootstrap nodes, contributions), or keep it closed source? The Arasan licence allows either.

---

## Appendix A: Glossary
- **Kademlia:** XOR-distance distributed hash table used for decentralized lookup.
- **HyperDHT / Hyperswarm:** Holepunch's Kademlia-based DHT with NAT hole-punching and Noise-encrypted connections; Hyperswarm adds topic-based peer discovery.
- **Bare:** Holepunch's lightweight JS runtime that embeds into iOS/Android apps (Bare Kit).
- **Nostr:** protocol of signed JSON events relayed by independent servers ("relays"); identity = keypair.
- **NIP:** Nostr Implementation Possibility (spec document). Used here: 01, 13, 17, 40, 44, 51, 56, 59, 64, 65.
- **CGNAT:** carrier-grade NAT; common on mobile networks and the main obstacle to direct P2P.
- **UCI:** Universal Chess Interface, the protocol used to drive the Arasan engine.
