import { app, shell, Notification, nativeImage, Tray, Menu, BrowserWindow, protocol, dialog, net, ipcMain } from "electron";
import path, { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { lookup } from "node:dns/promises";
import { z } from "zod";
import os from "node:os";
import Bonjour from "bonjour-service";
import dgram from "node:dgram";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import Store from "electron-store";
import { createReadStream, existsSync, createWriteStream } from "node:fs";
import { stat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import mime from "mime-types";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const PROTOCOL_VERSION = 1;
const CONTROL_PATH = "/v1/control";
const PORTS = {
  "control": 53211,
  "transfer": 53212,
  "discovery": 53213
};
const LIMITS = {
  "udpPacketBytes": 16384,
  "webSocketMessageBytes": 1048576,
  "textMessageBytes": 65536,
  "fileBytes": 1099511627776,
  "concurrentTransfers": 3,
  "requestsPerMinute": 600,
  "transferPortFallbackAttempts": 20
};
const INTERVALS_MS = {
  "discoveryAnnouncement": 5e3,
  "peerExpiry": 15e3,
  "ping": 15e3,
  "networkCheck": 5e3,
  "progressNotification": 500
};
const TIMEOUTS_MS = {
  "webSocketConnect": 5e3,
  "webSocketHandshake": 5e3,
  "request": 1e4,
  "pairing": 6e4,
  "transferDecision": 12e4,
  "httpIdle": 3e4,
  "pong": 1e4
};
const RECONNECT_BACKOFF_MS = [1e3, 2e3, 4e3, 8e3, 16e3];
const MESSAGE_TYPES = [
  "device_hello",
  "device_info",
  "pair_request",
  "pair_accept",
  "pair_reject",
  "message_send",
  "message_ack",
  "transfer_request",
  "transfer_accept",
  "transfer_reject",
  "transfer_progress",
  "transfer_pause",
  "transfer_resume",
  "transfer_cancel",
  "transfer_complete",
  "transfer_error",
  "ping",
  "pong"
];
const DEVICE_TYPES = ["desktop", "mobile"];
const PLATFORMS = ["windows", "macos", "linux", "android"];
const portSchema = z.number().int().min(1).max(65535);
const uuidLike = z.string().min(8).max(128);
const identitySchema = z.object({
  deviceId: uuidLike,
  deviceName: z.string().trim().min(1).max(80),
  deviceType: z.enum(DEVICE_TYPES),
  platform: z.enum(PLATFORMS),
  appVersion: z.string().min(1).max(32),
  protocolVersion: z.literal(String(PROTOCOL_VERSION))
});
const discoveryPacketSchema = z.object({
  lanvia: z.literal(true),
  version: z.literal(PROTOCOL_VERSION),
  type: z.literal("device_hello"),
  identity: identitySchema,
  controlPort: portSchema,
  transferPort: portSchema,
  timestamp: z.number().int().nonnegative()
});
const envelopeSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  type: z.enum(MESSAGE_TYPES),
  requestId: uuidLike,
  senderId: uuidLike,
  receiverId: uuidLike,
  timestamp: z.number().int().nonnegative(),
  payload: z.record(z.unknown())
});
function parseDiscoveryPacket(data) {
  try {
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (bytes > LIMITS.udpPacketBytes) return null;
    const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    const result = discoveryPacketSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
function parseEnvelope(data) {
  try {
    let text;
    if (typeof data === "string") text = data;
    else if (Array.isArray(data)) text = Buffer.concat(data).toString("utf8");
    else text = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString("utf8");
    if (Buffer.byteLength(text) > LIMITS.webSocketMessageBytes) return null;
    const result = envelopeSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
function conversationId(a, b) {
  return [a, b].sort().join(":");
}
function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8 | Number(octet)) >>> 0, 0) >>> 0;
}
function intToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => value >>> shift & 255).join(".");
}
function broadcastAddress(address, netmask) {
  const ip = ipv4ToInt(address);
  const mask = ipv4ToInt(netmask);
  return intToIpv4((ip | ~mask >>> 0) >>> 0);
}
function getLanInterfaces() {
  const result = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const item of addresses ?? []) {
      if (item.family !== "IPv4" || item.internal || item.address.startsWith("169.254.")) continue;
      result.push({ name, address: item.address, netmask: item.netmask, broadcast: broadcastAddress(item.address, item.netmask) });
    }
  }
  const virtualPattern = /vEthernet|Hyper-V|WSL|VMware|VirtualBox|Docker|Default Switch/i;
  const rank = (item) => virtualPattern.test(item.name) ? 1 : 0;
  return result.sort((a, b) => rank(a) - rank(b) || `${a.name}:${a.address}`.localeCompare(`${b.name}:${b.address}`));
}
function networkFingerprint() {
  return getLanInterfaces().map((item) => `${item.name}:${item.address}/${item.netmask}`).join("|");
}
function normalizeRemoteAddress(address) {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}
function isLocalLanAddress(host) {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const match = /^172\.(\d{1,3})\./.exec(host);
  if (match) {
    const second = Number(match[1]);
    return second >= 16 && second <= 31;
  }
  if (/^(fc|fd|fe80):/i.test(host)) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  return /^[a-z0-9][a-z0-9.-]{0,252}$/i.test(host);
}
class MdnsDiscovery extends EventEmitter {
  constructor(identity, ports, logger) {
    super();
    this.identity = identity;
    this.ports = ports;
    this.logger = logger;
  }
  bonjour = null;
  browser = null;
  advertisement = null;
  start() {
    if (this.bonjour) return;
    try {
      const bonjour = new Bonjour({}, (error) => this.serviceError(error));
      this.bonjour = bonjour;
      const identity = this.identity();
      const ports = this.ports();
      this.advertisement = bonjour.publish({
        name: `LANVIA-${identity.deviceId.slice(0, 8)}`,
        type: "lanvia",
        protocol: "tcp",
        port: ports.controlPort,
        txt: {
          id: identity.deviceId,
          name: identity.deviceName,
          type: identity.deviceType,
          platform: identity.platform,
          version: identity.appVersion,
          protocol: identity.protocolVersion,
          control: String(ports.controlPort),
          transfer: String(ports.transferPort)
        }
      });
      this.advertisement.on("error", (error) => this.serviceError(error));
      this.browser = bonjour.find({ type: "lanvia", protocol: "tcp" }, (service2) => this.onService(service2));
      this.logger.info("MDNS", "Advertising and browsing _lanvia._tcp");
    } catch (error) {
      this.serviceError(error instanceof Error ? error : new Error(String(error)));
    }
  }
  stop() {
    try {
      this.browser?.stop();
    } catch {
    }
    try {
      this.advertisement?.stop();
    } catch {
    }
    try {
      this.bonjour?.destroy();
    } catch {
    }
    this.browser = null;
    this.advertisement = null;
    this.bonjour = null;
  }
  serviceError(error) {
    this.logger.warn("MDNS", `mDNS unavailable: ${error.message}`);
    this.emit("service-error", error);
  }
  onService(service2) {
    const txt = service2.txt;
    if (!txt || txt.protocol !== "1" || !txt.id || txt.id === this.identity().deviceId) return;
    const controlPort = Number(txt.control || service2.port);
    const transferPort = Number(txt.transfer);
    if (!Number.isInteger(controlPort) || !Number.isInteger(transferPort)) return;
    const address = service2.addresses?.find((item) => /^\d+\.\d+\.\d+\.\d+$/.test(item));
    if (!address) return;
    const deviceType = txt.type === "mobile" ? "mobile" : txt.type === "desktop" ? "desktop" : null;
    const platform = ["windows", "macos", "linux", "android"].includes(txt.platform ?? "") ? txt.platform : null;
    if (!deviceType || !platform) return;
    this.emit("device", {
      identity: {
        deviceId: txt.id,
        deviceName: (txt.name || service2.name).slice(0, 80),
        deviceType,
        platform,
        appVersion: txt.version || "unknown",
        protocolVersion: "1"
      },
      address,
      controlPort,
      transferPort
    });
  }
}
class UdpDiscovery extends EventEmitter {
  constructor(identity, ports, interfaces, logger) {
    super();
    this.identity = identity;
    this.ports = ports;
    this.interfaces = interfaces;
    this.logger = logger;
  }
  socket = null;
  announceTimer = null;
  lastReply = /* @__PURE__ */ new Map();
  async start() {
    if (this.socket) return;
    const { discoveryPort } = this.ports();
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;
    socket.on("error", (error) => {
      this.logger.error("DISCOVERY", `UDP error: ${error.message}`);
      this.emit("service-error", error);
    });
    socket.on("message", (data, info) => this.onMessage(data, normalizeRemoteAddress(info.address)));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        socket.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        socket.off("error", onError);
        resolve();
      };
      socket.once("error", onError);
      socket.once("listening", onListening);
      socket.bind(discoveryPort, "0.0.0.0");
    });
    socket.setBroadcast(true);
    this.logger.info("DISCOVERY", `UDP fallback listening on 0.0.0.0:${discoveryPort}`);
    this.announce();
    this.announceTimer = setInterval(() => this.announce(), INTERVALS_MS.discoveryAnnouncement);
  }
  stop() {
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
      }
    }
    this.lastReply.clear();
  }
  refresh() {
    this.announce();
  }
  packet() {
    const identity = this.identity();
    const { controlPort, transferPort } = this.ports();
    return { lanvia: true, version: PROTOCOL_VERSION, type: "device_hello", identity, controlPort, transferPort, timestamp: Date.now() };
  }
  announce() {
    const socket = this.socket;
    if (!socket) return;
    const data = Buffer.from(JSON.stringify(this.packet()));
    const targets = new Set(this.interfaces().map((item) => item.broadcast));
    targets.add("255.255.255.255");
    const { discoveryPort } = this.ports();
    for (const target of targets) this.send(data, discoveryPort, target);
    this.logger.debug("DISCOVERY", `Broadcast hello to ${[...targets].join(", ")}`);
  }
  send(data, port, address) {
    this.socket?.send(data, port, address, (error) => {
      if (error) this.logger.warn("DISCOVERY", `UDP send to ${address}:${port} failed: ${error.message}`);
    });
  }
  onMessage(data, address) {
    const packet = parseDiscoveryPacket(data);
    if (!packet || packet.identity.deviceId === this.identity().deviceId) return;
    this.emit("device", { packet, address });
    const now = Date.now();
    const last = this.lastReply.get(packet.identity.deviceId) ?? 0;
    if (now - last >= INTERVALS_MS.discoveryAnnouncement) {
      this.lastReply.set(packet.identity.deviceId, now);
      this.send(Buffer.from(JSON.stringify(this.packet())), this.ports().discoveryPort, address);
    }
  }
}
class DiscoveryManager extends EventEmitter {
  constructor(identity, settings, trusted, logger) {
    super();
    this.identity = identity;
    this.settings = settings;
    this.trusted = trusted;
    this.logger = logger;
  }
  devices = /* @__PURE__ */ new Map();
  udp = null;
  mdns = null;
  expiryTimer = null;
  networkTimer = null;
  fingerprint = "";
  udpStatus = { state: "stopped" };
  mdnsStatus = { state: "stopped" };
  async start() {
    this.fingerprint = networkFingerprint();
    await this.startServices();
    this.expiryTimer = setInterval(() => this.expireDevices(), 1e3);
    this.networkTimer = setInterval(() => this.checkNetwork(), INTERVALS_MS.networkCheck);
  }
  stop() {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    if (this.networkTimer) clearInterval(this.networkTimer);
    this.expiryTimer = null;
    this.networkTimer = null;
    this.stopServices();
  }
  async restart() {
    this.stopServices();
    this.fingerprint = networkFingerprint();
    await this.startServices();
  }
  refresh() {
    this.udp?.refresh();
    this.logger.info("DISCOVERY", "Manual discovery refresh");
  }
  getDevices() {
    return [...this.devices.values()].sort((a, b) => {
      const rank = (status) => status === "connected" ? 0 : status === "available" ? 1 : 2;
      return rank(a.status) - rank(b.status) || a.deviceName.localeCompare(b.deviceName);
    });
  }
  find(deviceId) {
    return this.devices.get(deviceId);
  }
  upsertFromSocket(identity, address, controlPort, transferPort) {
    return this.upsert(identity, address, controlPort, transferPort, "manual", "connected");
  }
  markStatus(deviceId, status, error) {
    const device = this.devices.get(deviceId);
    if (!device) return;
    const next = { ...device, status };
    if (error) next.error = error;
    else delete next.error;
    this.devices.set(deviceId, next);
    this.emit("changed");
  }
  remove(deviceId) {
    this.devices.delete(deviceId);
    this.emit("changed");
  }
  refreshTrust(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return;
    const trust = this.trusted().find((item) => item.deviceId === deviceId);
    const next = {
      ...device,
      trusted: Boolean(trust) && !trust?.blocked,
      blocked: trust?.blocked ?? false
    };
    if (trust?.alias) next.alias = trust.alias;
    else delete next.alias;
    this.devices.set(deviceId, next);
    this.emit("changed");
  }
  diagnostics(base) {
    const interfaces = getLanInterfaces();
    const firewallHint = process.platform === "win32" && base.control.state === "running" && this.devices.size === 0 ? "If other devices cannot connect, allow LANVIA on Private networks in Windows Firewall." : void 0;
    const result = {
      localIps: interfaces,
      control: base.control,
      transfer: base.transfer,
      discovery: this.udpStatus,
      mdns: this.mdnsStatus,
      udpBroadcastEnabled: this.udpStatus.state === "running",
      webSocketConnections: base.wsConnections,
      devicesDiscovered: [...this.devices.values()].filter((item) => item.status !== "offline").length,
      networkFingerprint: this.fingerprint,
      updatedAt: Date.now()
    };
    if (firewallHint) result.firewallHint = firewallHint;
    return result;
  }
  async startServices() {
    const ports = () => ({
      controlPort: this.settings().controlPort,
      transferPort: this.settings().transferPort,
      discoveryPort: this.settings().discoveryPort
    });
    this.logger.info("DISCOVERY", `Local interfaces: ${getLanInterfaces().map((item) => `${item.name}=${item.address}, broadcast=${item.broadcast}`).join("; ") || "none"}`);
    this.udpStatus = { state: "starting", port: this.settings().discoveryPort };
    this.udp = new UdpDiscovery(this.identity, ports, getLanInterfaces, this.logger);
    this.udp.on("device", (event) => this.upsert(event.packet.identity, event.address, event.packet.controlPort, event.packet.transferPort, "udp"));
    this.udp.on("service-error", (error) => {
      this.udpStatus = { state: "error", port: this.settings().discoveryPort, error: error.message };
      this.emit("changed");
    });
    try {
      await this.udp.start();
      this.udpStatus = { state: "running", port: this.settings().discoveryPort };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.udpStatus = { state: "error", port: this.settings().discoveryPort, error: message };
      this.logger.error("DISCOVERY", `Cannot bind UDP ${this.settings().discoveryPort}: ${message}`);
    }
    this.mdnsStatus = { state: "starting" };
    this.mdns = new MdnsDiscovery(this.identity, ports, this.logger);
    this.mdns.on("device", (event) => this.upsert(event.identity, event.address, event.controlPort, event.transferPort, "mdns"));
    this.mdns.on("service-error", (error) => {
      this.mdnsStatus = { state: "error", error: error.message };
      this.emit("changed");
    });
    this.mdns.start();
    if (this.mdnsStatus.state !== "error") this.mdnsStatus = { state: "running", port: this.settings().controlPort };
    this.emit("changed");
  }
  stopServices() {
    this.udp?.stop();
    this.mdns?.stop();
    this.udp = null;
    this.mdns = null;
    this.udpStatus = { state: "stopped" };
    this.mdnsStatus = { state: "stopped" };
  }
  upsert(identity, address, controlPort, transferPort, method, status = "available") {
    if (identity.deviceId === this.identity().deviceId) throw new Error("Self discovery must be ignored");
    const existing = this.devices.get(identity.deviceId);
    const trusted = this.trusted().find((item) => item.deviceId === identity.deviceId);
    const methods = new Set(existing?.methods ?? []);
    methods.add(method);
    const device = {
      ...identity,
      address,
      controlPort,
      transferPort,
      status: existing?.status === "connected" ? "connected" : status,
      trusted: Boolean(trusted) && !trusted?.blocked,
      blocked: trusted?.blocked ?? false,
      methods: [...methods],
      lastSeenAt: Date.now()
    };
    if (trusted?.alias) device.alias = trusted.alias;
    this.devices.set(identity.deviceId, device);
    if (!existing) this.logger.info("DISCOVERY", `Device found: ${identity.deviceName} at ${address}:${controlPort} via ${method}`);
    this.emit("device", device);
    this.emit("changed");
    return device;
  }
  expireDevices() {
    const now = Date.now();
    let changed = false;
    for (const [id, device] of this.devices) {
      if (device.status !== "connected" && device.status !== "connecting" && now - device.lastSeenAt > INTERVALS_MS.peerExpiry && device.status !== "offline") {
        this.devices.set(id, { ...device, status: "offline" });
        changed = true;
      }
    }
    if (changed) this.emit("changed");
  }
  checkNetwork() {
    const current = networkFingerprint();
    if (current === this.fingerprint) return;
    const previous = this.fingerprint;
    this.fingerprint = current;
    this.logger.warn("DISCOVERY", `Network changed (${previous || "none"} -> ${current || "none"})`);
    this.emit("network-changed");
    void this.restart();
  }
}
class Logger extends EventEmitter {
  entries = [];
  maxEntries = 1e3;
  log(scope, level, message) {
    const sanitized = message.replace(/(trustToken|transferToken|Authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]");
    const entry = { timestamp: Date.now(), scope, level, message: sanitized };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    method(`[${scope}] ${sanitized}`);
    this.emit("entry", entry);
  }
  info(scope, message) {
    this.log(scope, "info", message);
  }
  warn(scope, message) {
    this.log(scope, "warn", message);
  }
  error(scope, message) {
    this.log(scope, "error", message);
  }
  debug(scope, message) {
    this.log(scope, "debug", message);
  }
  exportText() {
    return this.entries.map((entry) => `${new Date(entry.timestamp).toISOString()} [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}`).join("\n");
  }
}
const PRE_AUTH_TYPES = /* @__PURE__ */ new Set(["device_hello", "device_info", "pair_request", "pair_accept", "pair_reject", "ping", "pong"]);
class ControlManager extends EventEmitter {
  constructor(identity, settings, trusted, deviceLookup, onSocketIdentity, logger) {
    super();
    this.identity = identity;
    this.settings = settings;
    this.trusted = trusted;
    this.deviceLookup = deviceLookup;
    this.onSocketIdentity = onSocketIdentity;
    this.logger = logger;
  }
  httpServer = null;
  wsServer = null;
  statusValue = { state: "stopped" };
  connections = /* @__PURE__ */ new Map();
  allConnections = /* @__PURE__ */ new Set();
  reconnectAttempts = /* @__PURE__ */ new Map();
  reconnectTimers = /* @__PURE__ */ new Map();
  pingTimer = null;
  shuttingDown = false;
  get status() {
    return this.statusValue;
  }
  get connectionCount() {
    return this.connections.size;
  }
  isConnected(peerId) {
    return this.connections.get(peerId)?.ws.readyState === WebSocket.OPEN;
  }
  isAuthorized(peerId) {
    return this.connections.get(peerId)?.authorized ?? false;
  }
  peerAddress(peerId) {
    return this.connections.get(peerId)?.address || this.deviceLookup(peerId)?.address;
  }
  async start() {
    if (this.httpServer) return;
    this.shuttingDown = false;
    const port = this.settings().controlPort;
    this.statusValue = { state: "starting", port };
    const server = http.createServer((_request, response) => {
      response.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end('{"error":"not_found"}');
    });
    const wsServer = new WebSocketServer({ noServer: true, maxPayload: LIMITS.webSocketMessageBytes, perMessageDeflate: false });
    this.httpServer = server;
    this.wsServer = wsServer;
    server.on("upgrade", (request, socket, head) => {
      let pathname = "";
      try {
        pathname = new URL(request.url ?? "/", "http://lanvia.local").pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== CONTROL_PATH) {
        socket.destroy();
        return;
      }
      wsServer.handleUpgrade(request, socket, head, (ws) => {
        const address = normalizeRemoteAddress(request.socket.remoteAddress);
        this.attach(ws, address, false, null, this.settings().controlPort);
      });
    });
    server.on("error", (error) => {
      this.statusValue = { state: "error", port, error: error.message };
      this.logger.error("WS", `Control server error on ${port}: ${error.message}`);
      this.emit("status");
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "0.0.0.0");
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.statusValue = { state: "error", port, error: message };
      this.httpServer = null;
      this.wsServer = null;
      try {
        server.close();
      } catch {
      }
      throw new Error(`Control port ${port} unavailable: ${message}`);
    });
    this.statusValue = { state: "running", port };
    this.logger.info("WS", `Control WebSocket listening on 0.0.0.0:${port}${CONTROL_PATH}`);
    this.pingTimer = setInterval(() => this.pingAll(), INTERVALS_MS.ping);
    this.emit("status");
  }
  stop(code = 1e3, reason = "LANVIA stopping") {
    this.shuttingDown = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const connection of this.allConnections) {
      clearTimeout(connection.handshakeTimer);
      try {
        connection.ws.close(code, reason);
      } catch {
        connection.ws.terminate();
      }
    }
    this.allConnections.clear();
    this.connections.clear();
    try {
      this.wsServer?.close();
    } catch {
    }
    try {
      this.httpServer?.close();
    } catch {
    }
    this.wsServer = null;
    this.httpServer = null;
    this.statusValue = { state: "stopped" };
    this.emit("status");
  }
  resetConnectionsForNetworkChange() {
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    for (const connection of this.allConnections) {
      try {
        connection.ws.close(4002, "Network changed");
      } catch {
        connection.ws.terminate();
      }
    }
  }
  async connectDevice(device) {
    if (this.isConnected(device.deviceId)) return;
    await this.connect(device.address, device.controlPort, device.deviceId);
  }
  async connect(host, port, expectedPeerId = null) {
    if (expectedPeerId && this.isConnected(expectedPeerId)) return expectedPeerId;
    this.logger.info("WS", `Connecting to ${host}:${port}`);
    const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${urlHost}:${port}${CONTROL_PATH}`, {
        handshakeTimeout: TIMEOUTS_MS.webSocketConnect,
        maxPayload: LIMITS.webSocketMessageBytes,
        perMessageDeflate: false
      });
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.terminate();
        this.logger.warn("WS", `Connection to ${host}:${port} timed out`);
        reject(new Error("WebSocket handshake timed out"));
      }, TIMEOUTS_MS.webSocketHandshake + TIMEOUTS_MS.webSocketConnect);
      ws.once("open", () => {
        const connection = this.attach(ws, host, true, expectedPeerId, port);
        const onReady = (peerId) => {
          if (connection !== this.connections.get(peerId)) return;
          clearTimeout(timeout);
          this.off("peer-connected", onReady);
          if (!settled) {
            settled = true;
            resolve(peerId);
          }
        };
        this.on("peer-connected", onReady);
        this.sendHello(connection);
      });
      ws.once("error", (error) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          this.logger.warn("WS", `Connection to ${host}:${port} failed: ${error.message}`);
          reject(error);
        }
      });
    });
  }
  send(peerId, type, payload) {
    const connection = this.connections.get(peerId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) throw new Error("Device offline");
    if (!connection.authorized && !PRE_AUTH_TYPES.has(type)) throw new Error("Device is not paired");
    const requestId = randomUUID();
    this.sendEnvelope(connection, {
      version: 1,
      type,
      requestId,
      senderId: this.identity().deviceId,
      receiverId: peerId,
      timestamp: Date.now(),
      payload
    });
    return requestId;
  }
  markAuthorized(peerId, authorized = true) {
    const connection = this.connections.get(peerId);
    if (connection) connection.authorized = authorized;
  }
  disconnect(peerId) {
    const connection = this.connections.get(peerId);
    if (connection) connection.ws.close(1e3, "Disconnected locally");
  }
  attach(ws, address, isClient, expectedPeerId, remoteControlPort) {
    const connection = {
      ws,
      address,
      peerId: expectedPeerId,
      peerIdentity: null,
      controlPort: remoteControlPort,
      transferPort: 0,
      initiatorId: isClient ? this.identity().deviceId : null,
      nonce: randomUUID(),
      authorized: false,
      isClient,
      helloWithTokenSent: false,
      handshakeTimer: setTimeout(() => {
        if (!connection.peerIdentity) ws.close(1002, "Hello timeout");
      }, TIMEOUTS_MS.webSocketHandshake),
      lastPongAt: Date.now(),
      rateWindowStartedAt: Date.now(),
      rateCount: 0
    };
    this.allConnections.add(connection);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.close(1003, "Binary control frames are forbidden");
        return;
      }
      this.onMessage(connection, data);
    });
    ws.on("close", (_code, reason) => this.onClose(connection, reason.toString()));
    ws.on("error", (error) => this.logger.warn("WS", `Socket ${address} error: ${error.message}`));
    return connection;
  }
  sendHello(connection) {
    const expectedId = connection.peerId;
    const trust = expectedId ? this.trusted(expectedId) : void 0;
    const payload = {
      identity: this.identity(),
      controlPort: this.settings().controlPort,
      transferPort: this.settings().transferPort,
      connectionNonce: connection.nonce
    };
    if (trust && !trust.blocked) {
      payload.trustToken = trust.sharedToken;
      connection.helloWithTokenSent = true;
    }
    const receiverId = expectedId ?? "unknown-peer";
    this.sendEnvelope(connection, {
      version: 1,
      type: "device_hello",
      requestId: randomUUID(),
      senderId: this.identity().deviceId,
      receiverId,
      timestamp: Date.now(),
      payload
    });
  }
  onMessage(connection, raw) {
    const now = Date.now();
    if (now - connection.rateWindowStartedAt >= 6e4) {
      connection.rateWindowStartedAt = now;
      connection.rateCount = 0;
    }
    connection.rateCount += 1;
    if (connection.rateCount > LIMITS.requestsPerMinute) {
      connection.ws.close(1008, "Rate limit exceeded");
      return;
    }
    const envelope = parseEnvelope(raw);
    if (!envelope) {
      connection.ws.close(1002, "Invalid envelope");
      return;
    }
    if (envelope.receiverId !== this.identity().deviceId && envelope.receiverId !== "unknown-peer") {
      connection.ws.close(1008, "Wrong receiver");
      return;
    }
    if (connection.peerId && envelope.senderId !== connection.peerId) {
      connection.ws.close(1008, "Sender identity changed");
      return;
    }
    if (envelope.type === "device_hello") {
      this.handleHello(connection, envelope);
      return;
    }
    if (envelope.type === "device_info") {
      this.handleDeviceInfo(connection, envelope);
      return;
    }
    if (!connection.peerIdentity || !connection.peerId) {
      connection.ws.close(1002, "Hello required");
      return;
    }
    if (!connection.authorized && !PRE_AUTH_TYPES.has(envelope.type)) {
      this.logger.warn("SECURITY", `Rejected ${envelope.type} from unpaired ${connection.peerIdentity.deviceName}`);
      return;
    }
    if (envelope.type === "ping") {
      this.send(connection.peerId, "pong", { nonce: envelope.payload.nonce });
      return;
    }
    if (envelope.type === "pong") {
      connection.lastPongAt = Date.now();
      return;
    }
    this.emit("envelope", { peerId: connection.peerId, envelope });
  }
  handleHello(connection, envelope) {
    const identityResult = identitySchema.safeParse(envelope.payload.identity);
    const controlPort = Number(envelope.payload.controlPort);
    const transferPort = Number(envelope.payload.transferPort);
    const nonce = typeof envelope.payload.connectionNonce === "string" ? envelope.payload.connectionNonce : "";
    if (!identityResult.success || identityResult.data.deviceId !== envelope.senderId || !nonce || !this.validPort(controlPort) || !this.validPort(transferPort)) {
      connection.ws.close(1002, "Invalid hello");
      return;
    }
    const identity = identityResult.data;
    if (identity.deviceId === this.identity().deviceId) {
      connection.ws.close(1008, "Self identity");
      return;
    }
    const trust = this.trusted(identity.deviceId);
    if (trust?.blocked) {
      connection.ws.close(1008, "Blocked");
      return;
    }
    connection.peerId = identity.deviceId;
    connection.peerIdentity = identity;
    connection.controlPort = controlPort;
    connection.transferPort = transferPort;
    connection.initiatorId = identity.deviceId;
    connection.nonce = nonce;
    connection.authorized = Boolean(trust && envelope.payload.trustToken === trust.sharedToken);
    clearTimeout(connection.handshakeTimer);
    this.onSocketIdentity(identity, connection.address, controlPort, transferPort);
    this.register(connection);
    this.sendEnvelope(connection, {
      version: 1,
      type: "device_info",
      requestId: envelope.requestId,
      senderId: this.identity().deviceId,
      receiverId: identity.deviceId,
      timestamp: Date.now(),
      payload: {
        identity: this.identity(),
        controlPort: this.settings().controlPort,
        transferPort: this.settings().transferPort,
        connectionNonce: nonce,
        trusted: connection.authorized
      }
    });
  }
  handleDeviceInfo(connection, envelope) {
    const identityResult = identitySchema.safeParse(envelope.payload.identity);
    const controlPort = Number(envelope.payload.controlPort);
    const transferPort = Number(envelope.payload.transferPort);
    if (!identityResult.success || identityResult.data.deviceId !== envelope.senderId || !this.validPort(controlPort) || !this.validPort(transferPort)) {
      connection.ws.close(1002, "Invalid device info");
      return;
    }
    const identity = identityResult.data;
    if (identity.deviceId === this.identity().deviceId) {
      connection.ws.close(1008, "Self identity");
      return;
    }
    const trust = this.trusted(identity.deviceId);
    if (trust?.blocked) {
      connection.ws.close(1008, "Blocked");
      return;
    }
    connection.peerId = identity.deviceId;
    connection.peerIdentity = identity;
    connection.controlPort = controlPort;
    connection.transferPort = transferPort;
    connection.authorized = Boolean(trust && envelope.payload.trusted === true);
    clearTimeout(connection.handshakeTimer);
    this.onSocketIdentity(identity, connection.address, controlPort, transferPort);
    this.register(connection);
    if (trust && !connection.authorized && !connection.helloWithTokenSent) this.sendHello(connection);
  }
  register(connection) {
    const peerId = connection.peerId;
    if (!peerId) return;
    const existing = this.connections.get(peerId);
    if (existing && existing !== connection && existing.ws.readyState === WebSocket.OPEN) {
      const oldKey = `${existing.initiatorId ?? ""}:${existing.nonce}`;
      const newKey = `${connection.initiatorId ?? ""}:${connection.nonce}`;
      if (oldKey <= newKey) {
        connection.ws.close(4001, "Duplicate connection");
        return;
      }
      existing.ws.close(4001, "Duplicate connection");
    }
    this.connections.set(peerId, connection);
    this.reconnectAttempts.delete(peerId);
    const timer = this.reconnectTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(peerId);
    this.logger.info("WS", `Connected to ${connection.peerIdentity?.deviceName ?? peerId} (${connection.authorized ? "trusted" : "unpaired"})`);
    this.emit("peer-connected", peerId);
  }
  onClose(connection, reason) {
    clearTimeout(connection.handshakeTimer);
    this.allConnections.delete(connection);
    const peerId = connection.peerId;
    if (!peerId) return;
    if (this.connections.get(peerId) === connection) {
      this.connections.delete(peerId);
      this.logger.warn("WS", `Disconnected from ${connection.peerIdentity?.deviceName ?? peerId}${reason ? `: ${reason}` : ""}`);
      this.emit("peer-disconnected", peerId);
      if (!this.shuttingDown) this.scheduleReconnect(peerId);
    }
  }
  scheduleReconnect(peerId) {
    if (this.reconnectTimers.has(peerId)) return;
    const device = this.deviceLookup(peerId);
    if (!device || device.blocked || device.status === "offline") return;
    const attempt = this.reconnectAttempts.get(peerId) ?? 0;
    const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)] ?? 16e3;
    this.reconnectAttempts.set(peerId, attempt + 1);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(peerId);
      const current = this.deviceLookup(peerId);
      if (!current || this.isConnected(peerId)) return;
      void this.connectDevice(current).catch((error) => {
        this.logger.warn("WS", `Reconnect to ${current.deviceName} failed: ${error instanceof Error ? error.message : String(error)}`);
        this.scheduleReconnect(peerId);
      });
    }, delay);
    this.reconnectTimers.set(peerId, timer);
  }
  pingAll() {
    const now = Date.now();
    for (const [peerId, connection] of this.connections) {
      if (now - connection.lastPongAt > INTERVALS_MS.ping + TIMEOUTS_MS.pong) {
        connection.ws.terminate();
        continue;
      }
      try {
        this.send(peerId, "ping", { nonce: randomUUID() });
      } catch {
      }
    }
  }
  sendEnvelope(connection, envelope) {
    if (connection.ws.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
    connection.ws.send(JSON.stringify(envelope));
  }
  validPort(port) {
    return Number.isInteger(port) && port > 0 && port <= 65535;
  }
}
function desktopPlatform(value) {
  if (value === "win32") return "windows";
  if (value === "darwin") return "macos";
  return "linux";
}
function createDesktopIdentity(input) {
  const deviceName = input.deviceName.trim().slice(0, 80);
  if (!deviceName) throw new Error("Device name cannot be empty");
  return {
    deviceId: input.deviceId ?? randomUUID(),
    deviceName,
    deviceType: "desktop",
    platform: desktopPlatform(input.platform ?? process.platform),
    appVersion: input.appVersion,
    protocolVersion: String(PROTOCOL_VERSION)
  };
}
function defaultName() {
  return process.env.COMPUTERNAME || process.env.HOSTNAME || "LANVIA Desktop";
}
class LocalStore {
  store;
  constructor() {
    const defaults = {
      identity: createDesktopIdentity({ deviceName: defaultName(), appVersion: app.getVersion() }),
      settings: {
        theme: "dark",
        downloadFolder: path.join(app.getPath("downloads"), "LANVIA"),
        notifications: true,
        launchAtStartup: false,
        minimizeToTray: true,
        controlPort: PORTS.control,
        transferPort: PORTS.transfer,
        discoveryPort: PORTS.discovery
      },
      trustedDevices: [],
      messages: [],
      transfers: []
    };
    this.store = new Store({ name: "lanvia", defaults, clearInvalidConfig: false });
  }
  get identity() {
    return this.store.get("identity");
  }
  get settings() {
    return this.store.get("settings");
  }
  get trustedDevices() {
    return this.store.get("trustedDevices");
  }
  get messages() {
    return this.store.get("messages");
  }
  get transfers() {
    return this.store.get("transfers");
  }
  updateDeviceName(deviceName) {
    const clean = deviceName.trim().slice(0, 80);
    if (!clean) throw new Error("Device name cannot be empty");
    const identity = { ...this.identity, deviceName: clean };
    this.store.set("identity", identity);
    return identity;
  }
  updateSettings(patch) {
    const next = { ...this.settings, ...patch };
    this.store.set("settings", next);
    return next;
  }
  findTrusted(deviceId) {
    return this.trustedDevices.find((device) => device.deviceId === deviceId);
  }
  saveTrusted(device) {
    const devices = this.trustedDevices.filter((item) => item.deviceId !== device.deviceId);
    devices.push(device);
    this.store.set("trustedDevices", devices);
  }
  removeTrusted(deviceId) {
    this.store.set("trustedDevices", this.trustedDevices.filter((item) => item.deviceId !== deviceId));
  }
  setBlocked(deviceId, blocked) {
    const devices = this.trustedDevices.map((item) => item.deviceId === deviceId ? { ...item, blocked } : item);
    this.store.set("trustedDevices", devices);
  }
  saveMessage(message) {
    const messages = this.messages;
    const index = messages.findIndex((item) => item.id === message.id);
    if (index >= 0) messages[index] = message;
    else messages.push(message);
    this.store.set("messages", messages.slice(-1e4));
  }
  updateMessage(id, patch) {
    const messages = this.messages.map((message) => message.id === id ? { ...message, ...patch } : message);
    this.store.set("messages", messages);
  }
  saveTransfer(transfer) {
    const transfers = this.transfers;
    const index = transfers.findIndex((item) => item.transferId === transfer.transferId);
    if (index >= 0) transfers[index] = transfer;
    else transfers.push(transfer);
    this.store.set("transfers", transfers.slice(-2e3));
  }
  findTransfer(transferId) {
    return this.transfers.find((item) => item.transferId === transferId);
  }
}
function sanitizeFileName(input) {
  const base = path.basename(input).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim();
  const safe = base.slice(0, 180);
  return safe && safe !== "." && safe !== ".." ? safe : "LANVIA-file";
}
function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function safeDestination(root, requestedName) {
  await mkdir(root, { recursive: true });
  const safeName = sanitizeFileName(requestedName);
  const parsed = path.parse(safeName);
  for (let index = 0; index < 1e4; index += 1) {
    const suffix = index === 0 ? "" : ` (${index})`;
    const finalPath = path.join(root, `${parsed.name}${suffix}${parsed.ext}`);
    const partPath = `${finalPath}.lanvia.part`;
    if (!isPathInside(root, finalPath) || !isPathInside(root, partPath)) throw new Error("Unsafe destination path");
    if (!existsSync(finalPath) && !existsSync(partPath)) return { finalPath, partPath };
  }
  throw new Error("Unable to allocate destination file name");
}
async function validateSourceFile(filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("Selected path is not a regular file");
  if (info.size < 0 || info.size > LIMITS.fileBytes) throw new Error("File exceeds LANVIA size limit");
  return { size: info.size, fileName: sanitizeFileName(path.basename(filePath)) };
}
async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}
async function finalizePart(partPath, finalPath) {
  if (path.dirname(partPath) !== path.dirname(finalPath)) throw new Error("Part and final path must share a directory");
  await rename(partPath, finalPath);
}
class TransferManager extends EventEmitter {
  constructor(settings, store, send, peerAddress, logger) {
    super();
    this.settings = settings;
    this.store = store;
    this.send = send;
    this.peerAddress = peerAddress;
    this.logger = logger;
  }
  server = null;
  statusValue = { state: "stopped" };
  outgoing = /* @__PURE__ */ new Map();
  incoming = /* @__PURE__ */ new Map();
  activeDownloads = 0;
  requestRates = /* @__PURE__ */ new Map();
  get status() {
    return this.statusValue;
  }
  async start() {
    if (this.server) return;
    const configuredPort = this.settings().transferPort;
    this.statusValue = { state: "starting", port: configuredPort };
    const server = http.createServer((request, response) => void this.handleHttp(request, response));
    server.requestTimeout = 0;
    server.headersTimeout = TIMEOUTS_MS.httpIdle;
    server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    let actualPort = null;
    let lastError = null;
    const candidates = Array.from(
      { length: LIMITS.transferPortFallbackAttempts + 1 },
      (_, index) => configuredPort + index
    ).filter(
      (candidate) => candidate <= 65535 && candidate !== this.settings().controlPort && candidate !== this.settings().discoveryPort
    );
    for (const candidate of candidates) {
      try {
        await this.listen(server, candidate);
        actualPort = candidate;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const code = error.code;
        if (code !== "EADDRINUSE") break;
      }
    }
    if (actualPort === null && lastError?.code === "EADDRINUSE") {
      try {
        await this.listen(server, 0);
        const address = server.address();
        if (address && typeof address !== "string") actualPort = address.port;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (actualPort === null) {
      const message = lastError?.message ?? "Unable to bind transfer server";
      this.statusValue = { state: "error", port: configuredPort, error: message };
      try {
        server.close();
      } catch {
      }
      throw new Error(`Transfer port ${configuredPort} unavailable: ${message}`);
    }
    this.server = server;
    server.on("error", (error) => {
      this.statusValue = { state: "error", port: actualPort ?? configuredPort, error: error.message };
      this.logger.error("TRANSFER", `Transfer server error on ${actualPort ?? configuredPort}: ${error.message}`);
      this.emit("changed");
    });
    const fallbackMessage = actualPort !== configuredPort ? `Configured transfer port ${configuredPort} was occupied; using ${actualPort}` : void 0;
    this.statusValue = fallbackMessage ? { state: "running", port: actualPort, error: fallbackMessage } : { state: "running", port: actualPort };
    if (fallbackMessage) this.logger.warn("TRANSFER", fallbackMessage);
    this.logger.info("TRANSFER", `HTTP transfer server listening on 0.0.0.0:${actualPort}`);
    this.emit("changed");
  }
  stop() {
    for (const context of this.incoming.values()) context.request?.destroy(new Error("LANVIA stopping"));
    this.incoming.clear();
    this.outgoing.clear();
    try {
      this.server?.close();
    } catch {
    }
    this.server = null;
    this.statusValue = { state: "stopped" };
    this.emit("changed");
  }
  async createOutgoing(peerId, filePath) {
    const { size, fileName } = await validateSourceFile(filePath);
    const transferId = randomUUID();
    const now = Date.now();
    let record = {
      transferId,
      peerId,
      direction: "outgoing",
      fileName,
      mimeType: mime.lookup(fileName) || "application/octet-stream",
      size,
      sha256: "",
      localPath: filePath,
      state: "hashing",
      bytesTransferred: 0,
      speed: 0,
      remainingTime: null,
      createdAt: now,
      updatedAt: now
    };
    this.save(record);
    try {
      const hash = await sha256File(filePath);
      record = { ...record, sha256: hash, state: "pending", updatedAt: Date.now() };
      const token = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + TIMEOUTS_MS.transferDecision;
      this.outgoing.set(transferId, { transferId, peerId, filePath, token, size, accepted: false, expiresAt });
      this.save(record);
      this.send(peerId, "transfer_request", {
        transferId,
        fileName,
        mimeType: record.mimeType,
        size,
        sha256: hash,
        transferPort: this.statusValue.port ?? this.settings().transferPort,
        transferToken: token,
        expiresAt
      });
      this.logger.info("TRANSFER", `Transfer request sent: ${fileName} (${size} bytes)`);
      return record;
    } catch (error) {
      record = { ...record, state: "failed", error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() };
      this.save(record);
      throw error;
    }
  }
  registerIncoming(peerId, payload) {
    const parsed = this.parseRequest(payload);
    if (parsed.expiresAt < Date.now()) throw new Error("Transfer request expired");
    const existing = this.store.findTransfer(parsed.transferId);
    if (existing) return existing;
    const now = Date.now();
    const record = {
      transferId: parsed.transferId,
      peerId,
      direction: "incoming",
      fileName: parsed.fileName,
      mimeType: parsed.mimeType,
      size: parsed.size,
      sha256: parsed.sha256,
      state: "pending",
      bytesTransferred: 0,
      speed: 0,
      remainingTime: null,
      createdAt: now,
      updatedAt: now
    };
    const address = this.peerAddress(peerId);
    if (!address) throw new Error("Peer address unavailable");
    this.incoming.set(parsed.transferId, {
      transferId: parsed.transferId,
      peerId,
      address,
      transferPort: parsed.transferPort,
      token: parsed.transferToken,
      finalPath: "",
      partPath: "",
      request: null,
      intentionalStop: null
    });
    this.save(record);
    this.logger.info("TRANSFER", `Incoming request: ${record.fileName} (${record.size} bytes)`);
    this.emit("incoming", record);
    return record;
  }
  async accept(transferId) {
    const record = this.requireIncomingRecord(transferId);
    const context = this.requireIncomingContext(transferId);
    if (this.activeDownloads >= LIMITS.concurrentTransfers) throw new Error("Concurrent transfer limit reached");
    if (!context.finalPath) {
      const destination = await safeDestination(this.settings().downloadFolder, record.fileName);
      context.finalPath = destination.finalPath;
      context.partPath = destination.partPath;
    }
    this.send(record.peerId, "transfer_accept", { transferId, offset: 0 });
    this.save({ ...record, localPath: context.finalPath, state: "accepted", updatedAt: Date.now() });
    await this.download(transferId);
  }
  reject(transferId) {
    const record = this.requireIncomingRecord(transferId);
    this.send(record.peerId, "transfer_reject", { transferId, reason: "user_rejected" });
    this.save({ ...record, state: "rejected", updatedAt: Date.now() });
    this.incoming.delete(transferId);
  }
  pause(transferId) {
    const context = this.requireIncomingContext(transferId);
    const record = this.requireIncomingRecord(transferId);
    context.intentionalStop = "pause";
    context.request?.destroy();
    this.send(record.peerId, "transfer_pause", { transferId });
    this.save({ ...record, state: "paused", updatedAt: Date.now() });
  }
  async resume(transferId) {
    const record = this.requireIncomingRecord(transferId);
    if (record.state !== "paused" && record.state !== "failed") throw new Error("Transfer is not paused");
    const context = this.requireIncomingContext(transferId);
    context.intentionalStop = null;
    context.address = this.peerAddress(record.peerId) ?? context.address;
    const offset = context.partPath && existsSync(context.partPath) ? (await stat(context.partPath)).size : 0;
    this.send(record.peerId, "transfer_resume", { transferId, offset });
    await this.download(transferId);
  }
  async cancel(transferId) {
    const record = this.store.findTransfer(transferId);
    if (!record) throw new Error("Transfer not found");
    const context = this.incoming.get(transferId);
    if (context) {
      context.intentionalStop = "cancel";
      context.request?.destroy();
      if (context.partPath) await unlink(context.partPath).catch(() => void 0);
      this.incoming.delete(transferId);
    }
    this.outgoing.delete(transferId);
    this.send(record.peerId, "transfer_cancel", { transferId });
    this.save({ ...record, state: "cancelled", updatedAt: Date.now() });
  }
  handleControl(peerId, envelope) {
    const transferId = typeof envelope.payload.transferId === "string" ? envelope.payload.transferId : "";
    if (!transferId) return;
    const record = this.store.findTransfer(transferId);
    switch (envelope.type) {
      case "transfer_accept": {
        const source = this.outgoing.get(transferId);
        if (!source || source.peerId !== peerId || !record) return;
        source.accepted = true;
        this.save({ ...record, state: "accepted", updatedAt: Date.now() });
        break;
      }
      case "transfer_reject":
        if (record) this.save({ ...record, state: "rejected", updatedAt: Date.now() });
        this.outgoing.delete(transferId);
        break;
      case "transfer_progress":
        if (record && record.peerId === peerId) {
          const bytes = this.number(payloadValue(envelope, "bytesTransferred"), 0, record.size);
          const speed = this.number(payloadValue(envelope, "speed"), 0, Number.MAX_SAFE_INTEGER);
          const remainingRaw = payloadValue(envelope, "remainingTime");
          const remainingTime = typeof remainingRaw === "number" && Number.isFinite(remainingRaw) ? Math.max(0, Math.floor(remainingRaw)) : null;
          this.save({ ...record, state: "transferring", bytesTransferred: bytes, speed, remainingTime, updatedAt: Date.now() });
        }
        break;
      case "transfer_pause":
        if (record) this.save({ ...record, state: "paused", updatedAt: Date.now() });
        break;
      case "transfer_resume":
        if (record) this.save({ ...record, state: "transferring", updatedAt: Date.now() });
        break;
      case "transfer_cancel": {
        if (record) this.save({ ...record, state: "cancelled", updatedAt: Date.now() });
        const context = this.incoming.get(transferId);
        if (context) {
          context.intentionalStop = "cancel";
          context.request?.destroy();
          if (context.partPath) void unlink(context.partPath).catch(() => void 0);
          this.incoming.delete(transferId);
        }
        this.outgoing.delete(transferId);
        break;
      }
      case "transfer_complete":
        if (record && envelope.payload.sha256 === record.sha256 && Number(envelope.payload.size) === record.size) {
          this.save({ ...record, state: "completed", bytesTransferred: record.size, speed: 0, remainingTime: 0, updatedAt: Date.now() });
          this.outgoing.delete(transferId);
        }
        break;
      case "transfer_error":
        if (record) this.save({ ...record, state: "failed", error: String(envelope.payload.message ?? "Transfer failed"), updatedAt: Date.now() });
        break;
    }
  }
  async handleHttp(request, response) {
    try {
      const remote = request.socket.remoteAddress ?? "unknown";
      if (!this.allowRequest(remote)) {
        response.writeHead(429, { "Retry-After": "60" }).end();
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" }).end();
        return;
      }
      const pathname = new URL(request.url ?? "/", "http://lanvia.local").pathname;
      const match = /^\/v1\/transfers\/([0-9a-f-]{36})$/i.exec(pathname);
      if (!match?.[1]) {
        response.writeHead(404).end();
        return;
      }
      const transferId = match[1];
      const source = this.outgoing.get(transferId);
      if (!source) {
        response.writeHead(404).end();
        return;
      }
      if (!source.accepted && source.expiresAt < Date.now()) {
        response.writeHead(410).end();
        this.outgoing.delete(transferId);
        return;
      }
      if (!source.accepted) {
        response.writeHead(403).end();
        return;
      }
      if (request.headers["x-lanvia-receiver"] !== source.peerId) {
        response.writeHead(403).end();
        return;
      }
      const supplied = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!this.safeTokenEqual(supplied, source.token)) {
        response.writeHead(401).end();
        return;
      }
      const fileInfo = await stat(source.filePath);
      if (!fileInfo.isFile() || fileInfo.size !== source.size) {
        response.writeHead(410).end();
        return;
      }
      let start = 0;
      const range = request.headers.range;
      if (range) {
        const rangeMatch = /^bytes=(\d+)-$/.exec(range);
        if (!rangeMatch?.[1]) {
          response.writeHead(416, { "Content-Range": `bytes */${source.size}` }).end();
          return;
        }
        start = Number(rangeMatch[1]);
        if (!Number.isSafeInteger(start) || start < 0 || start >= source.size) {
          response.writeHead(416, { "Content-Range": `bytes */${source.size}` }).end();
          return;
        }
      }
      const headers = {
        "Content-Type": "application/octet-stream",
        "Content-Length": source.size - start,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      };
      if (start > 0) headers["Content-Range"] = `bytes ${start}-${source.size - 1}/${source.size}`;
      response.writeHead(start > 0 ? 206 : 200, headers);
      const stream = createReadStream(source.filePath, { start });
      stream.on("error", (error) => {
        this.logger.warn("TRANSFER", `Source read failed: ${error.message}`);
        response.destroy(error);
      });
      request.on("aborted", () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      this.logger.warn("TRANSFER", `HTTP transfer request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  }
  async download(transferId) {
    const context = this.requireIncomingContext(transferId);
    let record = this.requireIncomingRecord(transferId);
    const existing = context.partPath && existsSync(context.partPath) ? (await stat(context.partPath)).size : 0;
    if (existing > record.size) throw new Error("Partial file exceeds expected size");
    if (existing === record.size) {
      if (!existsSync(context.partPath)) await writeFile(context.partPath, Buffer.alloc(0));
      await this.verifyAndFinalize(context, record);
      return;
    }
    this.activeDownloads += 1;
    context.intentionalStop = null;
    record = { ...record, state: "transferring", bytesTransferred: existing, updatedAt: Date.now() };
    this.save(record);
    const startedAt = Date.now();
    let bytes = existing;
    let lastReportAt = startedAt;
    let lastReportBytes = existing;
    try {
      await new Promise((resolve, reject) => {
        const host = context.address.includes(":") && !context.address.startsWith("[") ? `[${context.address}]` : context.address;
        const headers = {
          Authorization: `Bearer ${context.token}`,
          "X-LANVIA-Receiver": this.store.identity.deviceId
        };
        if (existing > 0) headers.Range = `bytes=${existing}-`;
        const request = http.get({ hostname: host.replace(/^\[|\]$/g, ""), port: context.transferPort, path: `/v1/transfers/${transferId}`, headers, timeout: TIMEOUTS_MS.httpIdle }, (response) => {
          const expectedStatus = existing > 0 ? 206 : 200;
          if (response.statusCode !== expectedStatus) {
            response.resume();
            reject(new Error(`Transfer HTTP status ${response.statusCode ?? "unknown"}`));
            return;
          }
          const output = createWriteStream(context.partPath, { flags: existing > 0 ? "a" : "w" });
          response.on("data", (chunk) => {
            bytes += chunk.length;
            const now = Date.now();
            if (now - lastReportAt >= INTERVALS_MS.progressNotification) {
              const speed = Math.round((bytes - lastReportBytes) * 1e3 / Math.max(1, now - lastReportAt));
              const remainingTime = speed > 0 ? Math.ceil((record.size - bytes) / speed) : null;
              record = { ...record, bytesTransferred: bytes, speed, remainingTime, updatedAt: now };
              this.save(record);
              this.send(record.peerId, "transfer_progress", { transferId, bytesTransferred: bytes, totalBytes: record.size, speed, remainingTime });
              lastReportAt = now;
              lastReportBytes = bytes;
            }
          });
          response.once("error", reject);
          output.once("error", reject);
          output.once("finish", resolve);
          response.pipe(output);
        });
        context.request = request;
        request.once("timeout", () => request.destroy(new Error("Transfer idle timeout")));
        request.once("error", reject);
      });
      if (bytes !== record.size) throw new Error(`Received ${bytes} of ${record.size} bytes`);
      record = { ...record, state: "verifying", bytesTransferred: bytes, speed: 0, remainingTime: 0, updatedAt: Date.now() };
      this.save(record);
      await this.verifyAndFinalize(context, record);
      const elapsed = Math.max(1, Date.now() - startedAt);
      this.logger.info("TRANSFER", `Received ${record.fileName} in ${(elapsed / 1e3).toFixed(1)}s`);
    } catch (error) {
      const stopped = context.intentionalStop;
      if (!stopped) {
        const message = error instanceof Error ? error.message : String(error);
        this.save({ ...record, state: "failed", error: message, bytesTransferred: bytes, updatedAt: Date.now() });
        this.send(record.peerId, "transfer_error", { transferId, code: "internal_error", message, retryable: true });
        this.logger.error("TRANSFER", `${record.fileName} failed: ${message}`);
        throw error;
      }
    } finally {
      context.request = null;
      this.activeDownloads = Math.max(0, this.activeDownloads - 1);
    }
  }
  async verifyAndFinalize(context, record) {
    const actual = await sha256File(context.partPath);
    if (actual !== record.sha256) {
      const failed = { ...record, state: "failed", error: "SHA-256 integrity verification failed", updatedAt: Date.now() };
      this.save(failed);
      this.send(record.peerId, "transfer_error", { transferId: record.transferId, code: "hash_mismatch", message: failed.error, retryable: true });
      throw new Error(failed.error);
    }
    await finalizePart(context.partPath, context.finalPath);
    this.save({ ...record, localPath: context.finalPath, state: "completed", bytesTransferred: record.size, speed: 0, remainingTime: 0, updatedAt: Date.now() });
    this.send(record.peerId, "transfer_complete", { transferId: record.transferId, sha256: actual, size: record.size });
    this.incoming.delete(record.transferId);
  }
  parseRequest(payload) {
    const result = {
      transferId: String(payload.transferId ?? ""),
      fileName: String(payload.fileName ?? ""),
      mimeType: String(payload.mimeType ?? "application/octet-stream"),
      size: Number(payload.size),
      sha256: String(payload.sha256 ?? ""),
      transferPort: Number(payload.transferPort),
      transferToken: String(payload.transferToken ?? ""),
      expiresAt: Number(payload.expiresAt)
    };
    if (!/^[0-9a-f-]{36}$/i.test(result.transferId) || !result.fileName || result.fileName.length > 255 || result.mimeType.length > 200 || !Number.isSafeInteger(result.size) || result.size < 0 || result.size > LIMITS.fileBytes || !/^[0-9a-f]{64}$/.test(result.sha256) || !Number.isInteger(result.transferPort) || result.transferPort < 1 || result.transferPort > 65535 || result.transferToken.length < 20 || result.transferToken.length > 200 || !Number.isSafeInteger(result.expiresAt)) {
      throw new Error("Invalid transfer request");
    }
    return result;
  }
  save(record) {
    this.store.saveTransfer(record);
    this.emit("changed");
  }
  requireIncomingRecord(id) {
    const record = this.store.findTransfer(id);
    if (!record || record.direction !== "incoming") throw new Error("Incoming transfer not found");
    return record;
  }
  requireIncomingContext(id) {
    const context = this.incoming.get(id);
    if (!context) throw new Error("Transfer session expired; ask the sender to retry");
    return context;
  }
  listen(server, port) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "0.0.0.0");
    });
  }
  allowRequest(address) {
    const now = Date.now();
    const current = this.requestRates.get(address);
    if (!current || now - current.startedAt >= 6e4) {
      this.requestRates.set(address, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= LIMITS.requestsPerMinute;
  }
  safeTokenEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  number(value, min, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : min;
  }
}
function payloadValue(envelope, key) {
  return envelope.payload[key];
}
const TRANSFER_CONTROL_TYPES = /* @__PURE__ */ new Set([
  "transfer_accept",
  "transfer_reject",
  "transfer_progress",
  "transfer_pause",
  "transfer_resume",
  "transfer_cancel",
  "transfer_complete",
  "transfer_error"
]);
class AppService extends EventEmitter {
  logger = new Logger();
  store = new LocalStore();
  discovery;
  control;
  transfers;
  pendingPairings = /* @__PURE__ */ new Map();
  outgoingPairings = /* @__PURE__ */ new Map();
  connecting = /* @__PURE__ */ new Set();
  started = false;
  constructor() {
    super();
    this.discovery = new DiscoveryManager(
      () => this.store.identity,
      () => this.networkSettings(),
      () => this.store.trustedDevices,
      this.logger
    );
    this.control = new ControlManager(
      () => this.store.identity,
      () => this.networkSettings(),
      (deviceId) => this.store.findTrusted(deviceId),
      (deviceId) => this.discovery.find(deviceId),
      (identity, address, controlPort, transferPort) => this.discovery.upsertFromSocket(identity, address, controlPort, transferPort),
      this.logger
    );
    this.transfers = new TransferManager(
      () => this.store.settings,
      this.store,
      (peerId, type, payload) => {
        this.control.send(peerId, type, payload);
      },
      (peerId) => this.control.peerAddress(peerId),
      this.logger
    );
    this.bindEvents();
  }
  async start() {
    if (this.started) return;
    this.started = true;
    this.logger.info("APP", `Starting LANVIA ${app.getVersion()} as ${this.store.identity.deviceName}`);
    await this.control.start().catch((error) => this.logger.error("WS", error instanceof Error ? error.message : String(error)));
    await this.transfers.start().catch((error) => this.logger.error("TRANSFER", error instanceof Error ? error.message : String(error)));
    await this.discovery.start();
    app.setLoginItemSettings({ openAtLogin: this.store.settings.launchAtStartup });
    this.emitSnapshot();
  }
  stop() {
    this.discovery.stop();
    this.transfers.stop();
    this.control.stop();
    this.started = false;
  }
  snapshot() {
    const now = Date.now();
    for (const [id, pairing] of this.pendingPairings) if (pairing.expiresAt < now) this.pendingPairings.delete(id);
    return {
      identity: this.store.identity,
      settings: this.store.settings,
      devices: this.discovery.getDevices(),
      messages: this.store.messages,
      transfers: this.store.transfers,
      trustedDevices: this.store.trustedDevices.map(({ sharedToken: _secret, ...device }) => device),
      diagnostics: this.discovery.diagnostics({
        control: this.control.status,
        transfer: this.transfers.status,
        wsConnections: this.control.connectionCount
      }),
      pendingPairings: [...this.pendingPairings.values()]
    };
  }
  refreshDiscovery() {
    this.discovery.refresh();
  }
  async connectManual(host, port) {
    const cleanHost = host.trim().replace(/^\[|\]$/g, "");
    if (!cleanHost || cleanHost.length > 253 || !isLocalLanAddress(cleanHost)) throw new Error("Enter a valid local IP address or LAN hostname");
    if (!validPort(port)) throw new Error("Port must be between 1 and 65535");
    let target = cleanHost;
    if (!/^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|(?:fc|fd|fe80):)/i.test(cleanHost)) {
      const addresses = await lookup(cleanHost, { all: true });
      const local = addresses.find((item) => isLocalLanAddress(item.address));
      if (!local) throw new Error("The hostname does not resolve to a local network address");
      target = local.address;
    }
    await this.control.connect(target, port);
    this.emitSnapshot();
  }
  async connectDevice(deviceId) {
    const device = this.requireDevice(deviceId);
    if (device.blocked) throw new Error("This device is blocked");
    this.discovery.markStatus(deviceId, "connecting");
    try {
      await this.control.connectDevice(device);
      this.discovery.markStatus(deviceId, "connected");
    } catch (error) {
      this.discovery.markStatus(deviceId, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  async pairDevice(deviceId) {
    const device = this.requireDevice(deviceId);
    if (!this.control.isConnected(deviceId)) await this.connectDevice(deviceId);
    if (this.store.findTrusted(deviceId)?.blocked) throw new Error("This device is blocked");
    const pairId = randomUUID();
    const expiresAt = Date.now() + TIMEOUTS_MS.pairing;
    this.outgoingPairings.set(pairId, { peerId: deviceId, expiresAt });
    this.discovery.markStatus(deviceId, "pairing");
    this.control.send(deviceId, "pair_request", { pairId, identity: this.store.identity, expiresAt });
    this.logger.info("SECURITY", `Pairing request sent to ${device.deviceName}`);
  }
  respondPairing(pairId, accept) {
    const prompt = this.pendingPairings.get(pairId);
    if (!prompt) throw new Error("Pairing request expired");
    this.pendingPairings.delete(pairId);
    if (!accept) {
      this.control.send(prompt.peerId, "pair_reject", { pairId, reason: "user_rejected" });
      this.discovery.markStatus(prompt.peerId, "connected");
      this.emitSnapshot();
      return;
    }
    const peer = this.requireDevice(prompt.peerId);
    const sharedToken = randomBytes(32).toString("base64url");
    this.store.saveTrusted(this.trustedRecord(peer, sharedToken));
    this.control.markAuthorized(peer.deviceId, true);
    this.control.send(peer.deviceId, "pair_accept", { pairId, trustToken: sharedToken, deviceName: this.store.identity.deviceName });
    this.discovery.refreshTrust(peer.deviceId);
    this.discovery.markStatus(peer.deviceId, "connected");
    this.logger.info("SECURITY", `Paired with ${peer.deviceName}`);
    this.emitSnapshot();
  }
  removeTrustedDevice(deviceId) {
    this.store.removeTrusted(deviceId);
    this.control.markAuthorized(deviceId, false);
    this.control.disconnect(deviceId);
    this.discovery.refreshTrust(deviceId);
    this.emitSnapshot();
  }
  setDeviceBlocked(deviceId, blocked) {
    const existing = this.store.findTrusted(deviceId);
    if (!existing) throw new Error("Device is not trusted");
    this.store.setBlocked(deviceId, blocked);
    if (blocked) this.control.disconnect(deviceId);
    this.discovery.refreshTrust(deviceId);
    this.emitSnapshot();
  }
  sendMessage(peerId, text) {
    const clean = text.trim();
    if (!clean) return;
    if (Buffer.byteLength(clean, "utf8") > LIMITS.textMessageBytes) throw new Error("Message exceeds 64 KiB");
    const trusted = this.store.findTrusted(peerId);
    if (!trusted || trusted.blocked) throw new Error("Pair with this device before sending messages");
    const message = {
      id: randomUUID(),
      conversationId: conversationId(this.store.identity.deviceId, peerId),
      senderId: this.store.identity.deviceId,
      receiverId: peerId,
      text: clean,
      timestamp: Date.now(),
      status: "sending"
    };
    this.store.saveMessage(message);
    this.emitSnapshot();
    try {
      this.control.send(peerId, "message_send", { ...message, status: "sent" });
      this.store.updateMessage(message.id, { status: "sent" });
    } catch (error) {
      this.store.updateMessage(message.id, { status: "failed" });
      this.emitSnapshot();
      throw error;
    }
    this.emitSnapshot();
  }
  retryMessage(messageId) {
    const message = this.store.messages.find((item) => item.id === messageId);
    if (!message || message.senderId !== this.store.identity.deviceId) throw new Error("Message not found");
    this.control.send(message.receiverId, "message_send", { ...message, status: "sent" });
    this.store.updateMessage(message.id, { status: "sent" });
    this.emitSnapshot();
  }
  async sendFiles(peerId, filePaths) {
    const trusted = this.store.findTrusted(peerId);
    if (!trusted || trusted.blocked || !this.control.isAuthorized(peerId)) throw new Error("Pair and connect before sending files");
    for (const filePath of filePaths.slice(0, 20)) await this.transfers.createOutgoing(peerId, filePath);
    this.emitSnapshot();
  }
  async acceptTransfer(transferId) {
    await this.transfers.accept(transferId);
  }
  rejectTransfer(transferId) {
    this.transfers.reject(transferId);
  }
  pauseTransfer(transferId) {
    this.transfers.pause(transferId);
  }
  async resumeTransfer(transferId) {
    await this.transfers.resume(transferId);
  }
  async cancelTransfer(transferId) {
    await this.transfers.cancel(transferId);
  }
  revealTransfer(transferId) {
    const transfer = this.store.findTransfer(transferId);
    if (!transfer?.localPath || transfer.state !== "completed") throw new Error("Completed file is not available");
    shell.showItemInFolder(transfer.localPath);
  }
  async updateDeviceName(name) {
    this.store.updateDeviceName(name);
    await this.discovery.restart();
    this.emitSnapshot();
  }
  updateSettings(patch) {
    for (const key of ["controlPort", "transferPort", "discoveryPort"]) {
      if (patch[key] !== void 0 && !validPort(patch[key])) throw new Error(`${key} must be between 1 and 65535`);
    }
    const candidate = { ...this.store.settings, ...patch };
    if (candidate.controlPort === candidate.transferPort) throw new Error("Control and transfer TCP ports must be different");
    const settings = this.store.updateSettings(patch);
    app.setLoginItemSettings({ openAtLogin: settings.launchAtStartup });
    this.emitSnapshot();
  }
  networkSettings() {
    const configured = this.store.settings;
    const actualTransferPort = this.transfers?.status.state === "running" && this.transfers.status.port ? this.transfers.status.port : configured.transferPort;
    return { ...configured, transferPort: actualTransferPort };
  }
  bindEvents() {
    this.logger.on("entry", (entry) => this.emit("event", { kind: "log", entry }));
    this.discovery.on("changed", () => this.emitSnapshot());
    this.discovery.on("device", (device) => this.autoConnect(device));
    this.discovery.on("network-changed", () => {
      this.control.resetConnectionsForNetworkChange();
      this.emit("event", { kind: "network_changed", message: "Network changed. Searching for devices…" });
      this.emitSnapshot();
    });
    this.control.on("status", () => this.emitSnapshot());
    this.control.on("peer-connected", (peerId) => {
      this.connecting.delete(peerId);
      this.discovery.markStatus(peerId, "connected");
      this.emitSnapshot();
    });
    this.control.on("peer-disconnected", (peerId) => {
      this.discovery.markStatus(peerId, "available");
      this.emitSnapshot();
    });
    this.control.on("envelope", (event) => this.onEnvelope(event));
    this.transfers.on("changed", () => this.emitSnapshot());
    this.transfers.on("incoming", (transfer) => {
      this.notify("LANVIA", `${this.discovery.find(transfer.peerId)?.deviceName ?? "A device"} wants to send ${transfer.fileName}`);
      this.emit("event", { kind: "incoming_transfer", transfer });
      this.emitSnapshot();
    });
  }
  autoConnect(device) {
    if (device.blocked || this.control.isConnected(device.deviceId) || this.connecting.has(device.deviceId)) return;
    if (this.store.identity.deviceId.localeCompare(device.deviceId) >= 0) return;
    this.connecting.add(device.deviceId);
    void this.connectDevice(device.deviceId).catch((error) => {
      this.logger.debug("WS", `Automatic connection to ${device.deviceName} deferred: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => this.connecting.delete(device.deviceId));
  }
  onEnvelope({ peerId, envelope }) {
    try {
      if (envelope.type === "pair_request") this.onPairRequest(peerId, envelope);
      else if (envelope.type === "pair_accept") this.onPairAccept(peerId, envelope);
      else if (envelope.type === "pair_reject") this.onPairReject(peerId, envelope);
      else if (envelope.type === "message_send") this.onMessage(peerId, envelope);
      else if (envelope.type === "message_ack") this.onMessageAck(peerId, envelope);
      else if (envelope.type === "transfer_request") this.transfers.registerIncoming(peerId, envelope.payload);
      else if (TRANSFER_CONTROL_TYPES.has(envelope.type)) this.transfers.handleControl(peerId, envelope);
    } catch (error) {
      this.logger.warn("APP", `Rejected ${envelope.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.emitSnapshot();
  }
  onPairRequest(peerId, envelope) {
    const pairId = String(envelope.payload.pairId ?? "");
    const expiresAt = Number(envelope.payload.expiresAt);
    if (!/^[0-9a-f-]{36}$/i.test(pairId) || !Number.isSafeInteger(expiresAt) || expiresAt < Date.now() || expiresAt > Date.now() + TIMEOUTS_MS.pairing + 5e3) throw new Error("Invalid pairing request");
    const peer = this.requireDevice(peerId);
    const prompt = { pairId, peerId, peerName: peer.deviceName, expiresAt };
    this.pendingPairings.set(pairId, prompt);
    this.discovery.markStatus(peerId, "pairing");
    this.notify("LANVIA pairing request", `${peer.deviceName} wants to connect with this device.`);
    this.emit("event", { kind: "pairing_prompt", prompt });
  }
  onPairAccept(peerId, envelope) {
    const pairId = String(envelope.payload.pairId ?? "");
    const token = String(envelope.payload.trustToken ?? "");
    const pending = this.outgoingPairings.get(pairId);
    if (!pending || pending.peerId !== peerId || pending.expiresAt < Date.now() || token.length < 32 || token.length > 200) throw new Error("Unexpected pairing acceptance");
    const peer = this.requireDevice(peerId);
    this.store.saveTrusted(this.trustedRecord(peer, token));
    this.outgoingPairings.delete(pairId);
    this.control.markAuthorized(peerId, true);
    this.discovery.refreshTrust(peerId);
    this.discovery.markStatus(peerId, "connected");
    this.logger.info("SECURITY", `Pairing accepted by ${peer.deviceName}`);
  }
  onPairReject(peerId, envelope) {
    const pairId = String(envelope.payload.pairId ?? "");
    const pending = this.outgoingPairings.get(pairId);
    if (!pending || pending.peerId !== peerId) return;
    this.outgoingPairings.delete(pairId);
    this.discovery.markStatus(peerId, "connected");
    this.logger.info("SECURITY", `Pairing rejected by ${this.discovery.find(peerId)?.deviceName ?? peerId}`);
  }
  onMessage(peerId, envelope) {
    const payload = envelope.payload;
    const id = String(payload.id ?? "");
    const text = String(payload.text ?? "");
    const timestamp = Number(payload.timestamp);
    if (!/^[0-9a-f-]{36}$/i.test(id) || payload.senderId !== peerId || payload.receiverId !== this.store.identity.deviceId || !text || Buffer.byteLength(text, "utf8") > LIMITS.textMessageBytes || !Number.isSafeInteger(timestamp)) throw new Error("Invalid message");
    const message = {
      id,
      conversationId: conversationId(this.store.identity.deviceId, peerId),
      senderId: peerId,
      receiverId: this.store.identity.deviceId,
      text,
      timestamp,
      status: "delivered"
    };
    this.store.saveMessage(message);
    this.control.send(peerId, "message_ack", { messageId: id, status: "delivered" });
    this.notify(this.discovery.find(peerId)?.deviceName ?? "LANVIA", text.length > 100 ? `${text.slice(0, 100)}…` : text);
  }
  onMessageAck(peerId, envelope) {
    const id = String(envelope.payload.messageId ?? "");
    const message = this.store.messages.find((item) => item.id === id);
    if (message?.receiverId === peerId) this.store.updateMessage(id, { status: "delivered" });
  }
  trustedRecord(peer, sharedToken) {
    return {
      deviceId: peer.deviceId,
      lastName: peer.deviceName,
      platform: peer.platform,
      sharedToken,
      blocked: false,
      pairedAt: Date.now(),
      lastSeenAt: Date.now()
    };
  }
  requireDevice(deviceId) {
    const device = this.discovery.find(deviceId);
    if (!device) throw new Error("Device is no longer available");
    return device;
  }
  notify(title, body) {
    if (!this.store.settings.notifications || !Notification.isSupported()) return;
    new Notification({ title, body, silent: false }).show();
  }
  emitSnapshot() {
    this.emit("event", { kind: "snapshot", snapshot: this.snapshot() });
  }
}
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#5B21B6"/><path d="M8 8h5v12h11v5H8z" fill="#fff"/><circle cx="22" cy="10" r="3" fill="#A78BFA"/></svg>`;
class SystemTray {
  constructor(window, onQuit) {
    this.window = window;
    this.onQuit = onQuit;
    const image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(ICON_SVG)}`);
    this.tray = new Tray(image.resize({ width: 20, height: 20 }));
    this.tray.setToolTip("LANVIA");
    this.tray.on("double-click", () => this.open());
    this.rebuild();
  }
  tray;
  deviceCount = 0;
  updateDeviceCount(count) {
    this.deviceCount = count;
    this.rebuild();
  }
  destroy() {
    this.tray.destroy();
  }
  open() {
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }
  rebuild() {
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: "LANVIA", enabled: false },
      { type: "separator" },
      { label: "Open LANVIA", click: () => this.open() },
      { label: `Devices (${this.deviceCount})`, enabled: false },
      { label: "Settings", click: () => this.open() },
      { type: "separator" },
      { label: "Quit", click: this.onQuit }
    ]));
  }
}
function createMainWindow(onCloseToTray) {
  const iconPath = app.isPackaged ? join(process.resourcesPath, "icon.png") : join(process.cwd(), "resources", "icon.png");
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: "#0F0A1A",
    icon: iconPath,
    title: "LANVIA",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.on("close", (event) => {
    if (onCloseToTray()) {
      event.preventDefault();
      window.hide();
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
  return window;
}
protocol.registerSchemesAsPrivileged([{ scheme: "lanvia-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
let mainWindow = null;
let tray = null;
let service = null;
let quitting = false;
function requireService() {
  if (!service) throw new Error("LANVIA is not ready");
  return service;
}
function requireString(value, label, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`);
  return value;
}
function registerIpc() {
  ipcMain.handle("app:snapshot", () => requireService().snapshot());
  ipcMain.handle("discovery:refresh", () => requireService().refreshDiscovery());
  ipcMain.handle("device:connect-manual", (_event, host, port) => requireService().connectManual(requireString(host, "host"), Number(port)));
  ipcMain.handle("device:connect", (_event, id) => requireService().connectDevice(requireString(id, "device ID", 128)));
  ipcMain.handle("pairing:start", (_event, id) => requireService().pairDevice(requireString(id, "device ID", 128)));
  ipcMain.handle("pairing:respond", (_event, id, accept) => requireService().respondPairing(requireString(id, "pair ID", 128), accept === true));
  ipcMain.handle("trusted:remove", (_event, id) => requireService().removeTrustedDevice(requireString(id, "device ID", 128)));
  ipcMain.handle("trusted:block", (_event, id, blocked) => requireService().setDeviceBlocked(requireString(id, "device ID", 128), blocked === true));
  ipcMain.handle("message:send", (_event, peerId, text) => requireService().sendMessage(requireString(peerId, "device ID", 128), requireString(text, "message", 65536)));
  ipcMain.handle("message:retry", (_event, id) => requireService().retryMessage(requireString(id, "message ID", 128)));
  ipcMain.handle("transfer:choose", async (_event, peerId, category) => {
    const filters = {
      image: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
      video: [{ name: "Videos", extensions: ["mp4", "mkv", "mov", "webm", "avi"] }],
      audio: [{ name: "Audio", extensions: ["mp3", "wav", "flac", "ogg", "m4a", "aac"] }],
      document: [{ name: "Documents", extensions: ["pdf", "docx", "xlsx", "pptx", "txt", "csv", "zip"] }],
      file: [{ name: "All files", extensions: ["*"] }]
    };
    const key = typeof category === "string" && category in filters ? category : "file";
    const options = { properties: ["openFile", "multiSelections"], filters: filters[key] ?? filters.file };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (!result.canceled && result.filePaths.length) await requireService().sendFiles(requireString(peerId, "device ID", 128), result.filePaths);
  });
  ipcMain.handle("transfer:send-paths", (_event, peerId, paths) => {
    if (!Array.isArray(paths) || paths.some((item) => typeof item !== "string") || paths.length > 20) throw new Error("Invalid dropped files");
    return requireService().sendFiles(requireString(peerId, "device ID", 128), paths);
  });
  ipcMain.handle("transfer:accept", (_event, id) => requireService().acceptTransfer(requireString(id, "transfer ID", 128)));
  ipcMain.handle("transfer:reject", (_event, id) => requireService().rejectTransfer(requireString(id, "transfer ID", 128)));
  ipcMain.handle("transfer:pause", (_event, id) => requireService().pauseTransfer(requireString(id, "transfer ID", 128)));
  ipcMain.handle("transfer:resume", (_event, id) => requireService().resumeTransfer(requireString(id, "transfer ID", 128)));
  ipcMain.handle("transfer:cancel", (_event, id) => requireService().cancelTransfer(requireString(id, "transfer ID", 128)));
  ipcMain.handle("transfer:reveal", (_event, id) => requireService().revealTransfer(requireString(id, "transfer ID", 128)));
  ipcMain.handle("identity:name", (_event, name) => requireService().updateDeviceName(requireString(name, "device name", 80)));
  ipcMain.handle("settings:update", (_event, patch) => {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid settings");
    const allowed = ["theme", "notifications", "launchAtStartup", "minimizeToTray", "controlPort", "transferPort", "discoveryPort"];
    if (Object.keys(patch).some((key) => !allowed.includes(key))) throw new Error("Unknown setting");
    const input = patch;
    if (input.theme !== void 0 && !["dark", "light", "system"].includes(String(input.theme))) throw new Error("Invalid theme");
    for (const key of ["notifications", "launchAtStartup", "minimizeToTray"]) if (input[key] !== void 0 && typeof input[key] !== "boolean") throw new Error(`Invalid ${key}`);
    for (const key of ["controlPort", "transferPort", "discoveryPort"]) if (input[key] !== void 0 && typeof input[key] !== "number") throw new Error(`Invalid ${key}`);
    requireService().updateSettings(patch);
  });
  ipcMain.handle("settings:choose-folder", async () => {
    const options = { properties: ["openDirectory", "createDirectory"] };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = path.resolve(result.filePaths[0]);
    requireService().updateSettings({ downloadFolder: selected });
    return selected;
  });
  ipcMain.handle("diagnostics:logs", () => requireService().logger.exportText());
}
async function bootstrap() {
  app.setAppUserModelId("ai.arena.lanvia");
  registerIpc();
  service = new AppService();
  protocol.handle("lanvia-media", (request) => {
    const url = new URL(request.url);
    const transferId = url.hostname === "transfer" ? url.pathname.replace(/^\//, "") : "";
    const transfer = service?.store.findTransfer(transferId);
    if (!transfer?.localPath || transfer.state !== "completed") return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(transfer.localPath).toString(), { headers: request.headers });
  });
  mainWindow = createMainWindow(() => !quitting && (service?.store.settings.minimizeToTray ?? true));
  tray = new SystemTray(mainWindow, () => {
    quitting = true;
    app.quit();
  });
  service.on("event", (event) => {
    if (event.kind === "snapshot") tray?.updateDeviceCount(event.snapshot.devices.filter((device) => device.status !== "offline").length);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("lanvia:event", event);
  });
  await service.start();
}
app.whenReady().then(() => void bootstrap().catch((error) => {
  dialog.showErrorBox("LANVIA failed to start", error instanceof Error ? error.message : String(error));
}));
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
app.on("activate", () => {
  if (mainWindow) mainWindow.show();
});
app.on("before-quit", () => {
  quitting = true;
  service?.stop();
  tray?.destroy();
});
app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  if (quitting || !(service?.store.settings.minimizeToTray ?? true)) {
    quitting = true;
    app.quit();
  }
});
