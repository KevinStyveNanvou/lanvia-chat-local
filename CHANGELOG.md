# Changelog

## 1.0.1 — 2026-08-14

* Fixed Android → Desktop file transfer when Android TCP port 53212 is occupied.
* Added bounded, explicit transfer-port fallback on both clients; actual port is propagated through UDP, mDNS, WebSocket hello/info, diagnostics, and transfer requests.
* Added diagnostics warning showing configured and actual transfer ports.
* Added transfer fallback integration tests.
* Added automatic scroll to the latest item when opening a conversation or receiving/sending a message.
* Added copy controls to text bubbles on Desktop and Android.
* Added common inline rich-text conventions and composer controls for bold, italic, underline, strikethrough, and code.
* Applied the LANVIA icon to Desktop BrowserWindow, packaged EXE, installer, and resources.
* Kept file transfer binary transport and trust rules unchanged; this was a listener bind issue, not a pairing authorization issue.
