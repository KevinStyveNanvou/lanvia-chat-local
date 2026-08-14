# LANVIA architecture and delivery plan

## 1. Global architecture

LANVIA is one peer architecture implemented twice, not two applications bridged after the fact. `protocol/lanvia-protocol.json` and `protocol/protocol.md` are authoritative. A generator emits constants for TypeScript and Dart. Each peer owns the same five layers:

```text
UI (React / Flutter)
  -> typed application facade
    -> pairing + chat + transfer coordinators
      -> common envelope / state machines
        -> WS control | HTTP binary | mDNS + UDP discovery
          -> local LAN
    -> local metadata store + safe file store
```

Electron keeps all network, filesystem, persistence and cryptographic work in the main process. Its renderer receives a narrow typed preload API. Flutter keeps transport in services/repositories and exposes state to widgets through one controller/provider boundary.

The initial implementation is deliberately direct and diagnosable: plain LAN WS/HTTP plus explicit local pairing. No cloud, relay, BLE, WebRTC, transcoding, or media indexing is hidden behind the UI.

## 2. Protocol strategy

* One versioned JSON source of truth.
* Generated port, timing, enum and limit constants in both clients.
* Golden JSON examples parsed by TypeScript and Dart tests.
* Identical envelope and payload names.
* Forward-compatible optional object fields, strict required fields/enums.
* Stable transfer state machine and shared error codes.

See `../protocol/protocol.md`.

## 3. Repository structure

```text
LANVIA/
  protocol/               wire specification, source JSON, golden packets
  scripts/                cross-client protocol code generation/check
  desktop/                Electron + React + TypeScript + Vite
    src/main/              privileged network/storage/files/tray
    src/preload/           allow-listed contextBridge API
    src/renderer/          chat UI only
    src/shared/            generated/common TS contracts
    tests/
  mobile/                  Flutter/Dart, Android host integration
    lib/core/
    lib/discovery/
    lib/network/
    lib/transfers/
    lib/storage/
    lib/pairing/
    lib/chat/
    lib/ui/
    android/               NSD/network method channels + manifest
    test/
  integration-tests/      real-device checklist and desktop peer harness
  docs/
```

## 4. Discovery flow

1. Load persistent identity and configured ports.
2. Bind control, transfer and UDP listeners; report each result independently.
3. Register and browse `_lanvia._tcp`.
4. Enumerate IPv4 LAN interfaces and broadcast immediately to directed addresses and `255.255.255.255`.
5. Validate incoming identity/version/ports, ignore self, and derive address from socket metadata.
6. Merge mDNS and UDP sightings by `deviceId`; expiry is 15 seconds.
7. The lexicographically lower device ID auto-opens one WS connection. Selecting a device also connects immediately.
8. If discovery is filtered, manual host/port enters at step 7.
9. An interface fingerprint change tears down stale discovery and reconnects.

## 5. WebSocket flow

1. Connect to `/v1/control`; send `device_hello` as first frame.
2. Receiver validates source identity and responds `device_info`.
3. Existing token marks the link trusted. Otherwise only pair/keepalive control is allowed.
4. Pairing is locally approved and persists a random shared token.
5. Chat messages are stored before send and before ACK. IDs make retries idempotent.
6. Ping/pong detects dead links. Reconnect uses 1/2/4/8/16-second backoff.
7. Envelope events update the local store and are pushed to UI; transport never directly mutates widgets.

## 6. Transfer flow

1. Picker returns a local path/file handle to the privileged service.
2. Validate existence, regular-file type and size; stream SHA-256.
3. Register source by random transfer ID and one-time capability.
4. Send `transfer_request` over WS.
5. Receiver displays a real local approval UI/notification.
6. On accept, receiver starts a constrained HTTP GET from the control peer address and advertised transfer port.
7. Bytes go to a `.lanvia.part` beneath the chosen folder. Progress is measured locally and reported over WS.
8. Receiver checks exact length and SHA-256, atomically renames, then sends `transfer_complete`.
9. Pause aborts HTTP but keeps the part; resume uses Range. Cancel removes the part and source capability.

## 7. Data model

Persistent entities:

* `Identity(deviceId, deviceName, deviceType, platform, appVersion, protocolVersion)`
* `Settings(theme, ports, downloadFolder, notifications, launchAtStartup, minimizeToTray)`
* `TrustedDevice(deviceId, lastName, alias?, platform, sharedToken, blocked, pairedAt, lastSeenAt)`
* `Conversation(id, peerId, updatedAt)`
* `Message(id, conversationId, senderId, receiverId, text, timestamp, status)`
* `Transfer(id, peerId, direction, fileName, mimeType, size, sha256, localPath?, state, progress, timestamps, error?)`

Ephemeral `DiscoveredDevice` includes source address, actual ports, discovery methods and last seen time. File bodies are never stored in metadata storage. Secrets are omitted from renderer/mobile logs and diagnostics exports.

## 8. Android strategy

* Dart `RawDatagramSocket`, `HttpServer`, `HttpClient`, and `WebSocket` provide the same wire transports as Desktop.
* Kotlin `NsdManager` advertises/browses DNS-SD and reports resolved services through a method/event channel.
* Kotlin reports active interface IP/broadcast pairs, avoiding guessed subnet masks.
* App-specific external `LANVIA` storage is the no-broad-permission default on Android 10+; a future SAF folder picker can grant a user-selected shared folder.
* `POST_NOTIFICATIONS` is requested only on Android 13+ and only when notifications are enabled.
* A foreground-task notification is started for active accepted transfers so Android is less likely to suspend the process; it stops at the last terminal transfer.
* Connectivity changes restart discovery. No Internet capability or remote endpoint is used.

## 9. Electron strategy

* `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer, strict CSP.
* Main process owns dgram, bonjour, ws, HTTP, crypto, path validation, store and tray.
* Preload exposes an allow-list; the renderer cannot submit arbitrary paths for reads/writes or arbitrary IPC channel names.
* User-selected files come from the native dialog or validated drop-file metadata. Incoming names are sanitized and constrained to the download root.
* Window close minimizes to tray according to setting. Quit is explicit.
* Listener errors and likely firewall symptoms are shown in diagnostics; LANVIA never disables Windows Firewall.

## 10. Test strategy and phase gates

### Automated

Desktop Vitest:

* stable identity and editable name;
* strict envelope and UDP parsing;
* discovery merge/self-ignore/expiry;
* WS hello, text and reconnect behavior;
* SHA-256 streaming;
* basename/path containment and collision handling;
* HTTP full/Range transfer and mismatch failure.

Flutter test:

* protocol constants against source/golden fixtures;
* identity persistence abstraction;
* discovery packet parsing/self-ignore;
* envelope/message round trips;
* transfer transition validation;
* SHA-256 vectors and safe names.

### Integration

A desktop two-peer harness proves discovery, WS, pairing, text and HTTP before Android. The physical-device matrix then covers Wi-Fi, phone hotspot, PC hotspot, two PCs and two Android phones. Every failed layer is a stop gate: discovery before WS, WS before pairing, pairing before text, and text before transfer.

`integration-tests/desktop-android.md` records commands, expected diagnostics, firewall observations, file hashes and pass/fail results. Tests requiring a Windows host/Android device are explicit manual gates; they are not falsely marked passed in CI.
