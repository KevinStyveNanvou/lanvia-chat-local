# Desktop ↔ Android physical integration gate

This is a real-device test sheet. Do not mark a row PASS from an emulator-only or mocked test. Record Windows build, phone model/Android version, network topology and both diagnostic logs.

## Preconditions

* Desktop `npm test` and `npm run build` pass.
* Mobile `flutter test` and `flutter analyze` pass on the Flutter toolchain.
* Windows network profile is Private and LANVIA has been allowed in Windows Firewall. Never disable the firewall.
* Both diagnostics screens show the intended interface, IP, and ports 53211/53212/53213.
* Test payloads include:
  * `small.txt` (<1 KiB)
  * `image.jpg`
  * `audio.mp3`
  * `video.mp4`
  * `large.bin` (at least 1 GiB, generated data)
* Record `sha256sum`/`Get-FileHash` for all payloads.

## Topology matrix

| ID | Topology | Expected | Result / notes |
|---|---|---|---|
| A | PC + Android, same Wi-Fi | mDNS or UDP discovers both | NOT RUN |
| B | Android hotspot, PC joins | UDP or manual IP works; HTTP/WS duplex | NOT RUN |
| C | Windows hotspot, Android joins | UDP or manual IP works; HTTP/WS duplex | NOT RUN |
| D | Two Windows PCs | discovery and duplex transfer | NOT RUN |
| E | Two Android phones | discovery and duplex transfer | NOT RUN |

## Ordered gate (stop on first failure)

### 1. Discovery

1. Launch both clients.
2. Within 15 seconds each device appears on the other.
3. Confirm identity, source IP and actual advertised ports.
4. Disable/re-enable Wi-Fi and verify `Network changed`, then rediscovery.
5. If automatic discovery fails, save diagnostics before trying manual IP.

**Stop and diagnose:** local IP/subnet, selected interface, directed broadcast, UDP bind 53213, mDNS state, AP client isolation, phone hotspot filtering and Windows Firewall.

### 2. WebSocket

1. Select the remote device; state moves `connecting` → `connected`.
2. Check one stable connection in both diagnostics.
3. Leave idle for 45 seconds; ping/pong keeps it active.
4. Toggle Wi-Fi; reconnection follows 1/2/4/8/16-second backoff and returns connected.

### 3. Pairing

1. Request from Desktop; Android displays local confirmation.
2. Reject once and verify no text/file operation is allowed.
3. Request again, accept, and verify Trusted persists after both apps restart.
4. Block and verify the socket is closed; unblock and reconnect.

### 4. Text

1. Send `Hello from LANVIA` Desktop → Android and Android → Desktop.
2. Verify `sent` then `delivered` and no duplicate after reconnect.
3. Disconnect receiver, send, verify local failed/offline state, reconnect and retry.

### 5. Files

For each payload and both directions:

1. Sender hashes before request.
2. Receiver sees real accept/reject UI/notification.
3. Reject once; no HTTP body is served.
4. Accept; progress bytes, speed and ETA change.
5. For `large.bin`, pause after >10 MiB, resume and verify HTTP 206/Range.
6. Cancel once and verify partial file removal.
7. Complete and compare exact size and SHA-256.
8. Verify no received file is automatically opened or executed.

### 6. Background Android

1. Start a large accepted transfer.
2. Put LANVIA in background and lock the screen briefly.
3. Foreground-service notification remains visible and progress continues.
4. Return to app; state and counters remain coherent.

## Evidence template

```text
Date/time:
Desktop commit/build:
Windows version:
Android phone/version:
Topology:
Desktop IP/interface:
Android IP/interface:
Discovery method observed:
Pairing: PASS/FAIL
Text both ways: PASS/FAIL
Small/image/audio/video: PASS/FAIL
Large pause/resume/hash: PASS/FAIL
Network reconnect: PASS/FAIL
Logs attached:
Notes:
```
