import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { CONTROL_PATH, INTERVALS_MS, LIMITS, RECONNECT_BACKOFF_MS, TIMEOUTS_MS } from '../../shared/constants/protocol.generated';
import { identitySchema, parseEnvelope } from '../../shared/protocol/schemas';
import type { DeviceIdentity, DiscoveredDevice, Envelope, ServiceStatus, Settings, TrustedDevice } from '../../shared/types/models';
import type { Logger } from '../logger';
import { normalizeRemoteAddress } from './interfaces';

interface Connection {
  ws: WebSocket;
  address: string;
  peerId: string | null;
  peerIdentity: DeviceIdentity | null;
  controlPort: number;
  transferPort: number;
  initiatorId: string | null;
  nonce: string;
  authorized: boolean;
  isClient: boolean;
  helloWithTokenSent: boolean;
  handshakeTimer: NodeJS.Timeout;
  lastPongAt: number;
  rateWindowStartedAt: number;
  rateCount: number;
}

const PRE_AUTH_TYPES = new Set(['device_hello', 'device_info', 'pair_request', 'pair_accept', 'pair_reject', 'ping', 'pong']);

export interface EnvelopeEvent { peerId: string; envelope: Envelope }

export class ControlManager extends EventEmitter {
  private httpServer: http.Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private statusValue: ServiceStatus = { state: 'stopped' };
  private readonly connections = new Map<string, Connection>();
  private readonly allConnections = new Set<Connection>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private pingTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(
    private readonly identity: () => DeviceIdentity,
    private readonly settings: () => Settings,
    private readonly trusted: (deviceId: string) => TrustedDevice | undefined,
    private readonly deviceLookup: (deviceId: string) => DiscoveredDevice | undefined,
    private readonly onSocketIdentity: (identity: DeviceIdentity, address: string, controlPort: number, transferPort: number) => void,
    private readonly logger: Logger,
  ) { super(); }

  get status(): ServiceStatus { return this.statusValue; }
  get connectionCount(): number { return this.connections.size; }
  isConnected(peerId: string): boolean { return this.connections.get(peerId)?.ws.readyState === WebSocket.OPEN; }
  isAuthorized(peerId: string): boolean { return this.connections.get(peerId)?.authorized ?? false; }
  peerAddress(peerId: string): string | undefined { return this.connections.get(peerId)?.address || this.deviceLookup(peerId)?.address; }

  async start(): Promise<void> {
    if (this.httpServer) return;
    this.shuttingDown = false;
    const port = this.settings().controlPort;
    this.statusValue = { state: 'starting', port };
    const server = http.createServer((_request, response) => {
      response.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end('{"error":"not_found"}');
    });
    const wsServer = new WebSocketServer({ noServer: true, maxPayload: LIMITS.webSocketMessageBytes, perMessageDeflate: false });
    this.httpServer = server;
    this.wsServer = wsServer;
    server.on('upgrade', (request, socket, head) => {
      let pathname = '';
      try { pathname = new URL(request.url ?? '/', 'http://lanvia.local').pathname; } catch { socket.destroy(); return; }
      if (pathname !== CONTROL_PATH) { socket.destroy(); return; }
      wsServer.handleUpgrade(request, socket, head, (ws) => {
        const address = normalizeRemoteAddress(request.socket.remoteAddress);
        this.attach(ws, address, false, null, this.settings().controlPort);
      });
    });
    server.on('error', (error) => {
      this.statusValue = { state: 'error', port, error: error.message };
      this.logger.error('WS', `Control server error on ${port}: ${error.message}`);
      this.emit('status');
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { server.off('listening', onListening); reject(error); };
      const onListening = (): void => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.statusValue = { state: 'error', port, error: message };
      this.httpServer = null;
      this.wsServer = null;
      try { server.close(); } catch { /* no-op */ }
      throw new Error(`Control port ${port} unavailable: ${message}`);
    });
    this.statusValue = { state: 'running', port };
    this.logger.info('WS', `Control WebSocket listening on 0.0.0.0:${port}${CONTROL_PATH}`);
    this.pingTimer = setInterval(() => this.pingAll(), INTERVALS_MS.ping);
    this.emit('status');
  }

  stop(code = 1000, reason = 'LANVIA stopping'): void {
    this.shuttingDown = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const connection of this.allConnections) {
      clearTimeout(connection.handshakeTimer);
      try { connection.ws.close(code, reason); } catch { connection.ws.terminate(); }
    }
    this.allConnections.clear();
    this.connections.clear();
    try { this.wsServer?.close(); } catch { /* no-op */ }
    try { this.httpServer?.close(); } catch { /* no-op */ }
    this.wsServer = null;
    this.httpServer = null;
    this.statusValue = { state: 'stopped' };
    this.emit('status');
  }

  resetConnectionsForNetworkChange(): void {
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    for (const connection of this.allConnections) {
      try { connection.ws.close(4002, 'Network changed'); } catch { connection.ws.terminate(); }
    }
  }

  async connectDevice(device: DiscoveredDevice): Promise<void> {
    if (this.isConnected(device.deviceId)) return;
    await this.connect(device.address, device.controlPort, device.deviceId);
  }

  async connect(host: string, port: number, expectedPeerId: string | null = null): Promise<string> {
    if (expectedPeerId && this.isConnected(expectedPeerId)) return expectedPeerId;
    this.logger.info('WS', `Connecting to ${host}:${port}`);
    const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://${urlHost}:${port}${CONTROL_PATH}`, {
        handshakeTimeout: TIMEOUTS_MS.webSocketConnect,
        maxPayload: LIMITS.webSocketMessageBytes,
        perMessageDeflate: false,
      });
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.terminate();
        this.logger.warn('WS', `Connection to ${host}:${port} timed out`);
        reject(new Error('WebSocket handshake timed out'));
      }, TIMEOUTS_MS.webSocketHandshake + TIMEOUTS_MS.webSocketConnect);
      ws.once('open', () => {
        const connection = this.attach(ws, host, true, expectedPeerId, port);
        const onReady = (peerId: string): void => {
          if (connection !== this.connections.get(peerId)) return;
          clearTimeout(timeout);
          this.off('peer-connected', onReady);
          if (!settled) { settled = true; resolve(peerId); }
        };
        this.on('peer-connected', onReady);
        this.sendHello(connection);
      });
      ws.once('error', (error) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          this.logger.warn('WS', `Connection to ${host}:${port} failed: ${error.message}`);
          reject(error);
        }
      });
    });
  }

  send(peerId: string, type: Envelope['type'], payload: Record<string, unknown>): string {
    const connection = this.connections.get(peerId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) throw new Error('Device offline');
    if (!connection.authorized && !PRE_AUTH_TYPES.has(type)) throw new Error('Device is not paired');
    const requestId = randomUUID();
    this.sendEnvelope(connection, {
      version: 1,
      type,
      requestId,
      senderId: this.identity().deviceId,
      receiverId: peerId,
      timestamp: Date.now(),
      payload,
    });
    return requestId;
  }

  markAuthorized(peerId: string, authorized = true): void {
    const connection = this.connections.get(peerId);
    if (connection) connection.authorized = authorized;
  }

  disconnect(peerId: string): void {
    const connection = this.connections.get(peerId);
    if (connection) connection.ws.close(1000, 'Disconnected locally');
  }

  private attach(ws: WebSocket, address: string, isClient: boolean, expectedPeerId: string | null, remoteControlPort: number): Connection {
    const connection: Connection = {
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
        if (!connection.peerIdentity) ws.close(1002, 'Hello timeout');
      }, TIMEOUTS_MS.webSocketHandshake),
      lastPongAt: Date.now(),
      rateWindowStartedAt: Date.now(),
      rateCount: 0,
    };
    this.allConnections.add(connection);
    ws.on('message', (data, isBinary) => {
      if (isBinary) { ws.close(1003, 'Binary control frames are forbidden'); return; }
      this.onMessage(connection, data);
    });
    ws.on('close', (_code, reason) => this.onClose(connection, reason.toString()));
    ws.on('error', (error) => this.logger.warn('WS', `Socket ${address} error: ${error.message}`));
    return connection;
  }

  private sendHello(connection: Connection): void {
    const expectedId = connection.peerId;
    const trust = expectedId ? this.trusted(expectedId) : undefined;
    const payload: Record<string, unknown> = {
      identity: this.identity(),
      controlPort: this.settings().controlPort,
      transferPort: this.settings().transferPort,
      connectionNonce: connection.nonce,
    };
    if (trust && !trust.blocked) {
      payload.trustToken = trust.sharedToken;
      connection.helloWithTokenSent = true;
    }
    const receiverId = expectedId ?? 'unknown-peer';
    this.sendEnvelope(connection, {
      version: 1,
      type: 'device_hello',
      requestId: randomUUID(),
      senderId: this.identity().deviceId,
      receiverId,
      timestamp: Date.now(),
      payload,
    });
  }

  private onMessage(connection: Connection, raw: RawData): void {
    const now = Date.now();
    if (now - connection.rateWindowStartedAt >= 60_000) { connection.rateWindowStartedAt = now; connection.rateCount = 0; }
    connection.rateCount += 1;
    if (connection.rateCount > LIMITS.requestsPerMinute) { connection.ws.close(1008, 'Rate limit exceeded'); return; }
    const envelope = parseEnvelope(raw as Buffer | ArrayBuffer | Buffer[]);
    if (!envelope) { connection.ws.close(1002, 'Invalid envelope'); return; }
    if (envelope.receiverId !== this.identity().deviceId && envelope.receiverId !== 'unknown-peer') {
      connection.ws.close(1008, 'Wrong receiver'); return;
    }
    if (connection.peerId && envelope.senderId !== connection.peerId) {
      connection.ws.close(1008, 'Sender identity changed'); return;
    }
    if (envelope.type === 'device_hello') { this.handleHello(connection, envelope); return; }
    if (envelope.type === 'device_info') { this.handleDeviceInfo(connection, envelope); return; }
    if (!connection.peerIdentity || !connection.peerId) { connection.ws.close(1002, 'Hello required'); return; }
    if (!connection.authorized && !PRE_AUTH_TYPES.has(envelope.type)) {
      this.logger.warn('SECURITY', `Rejected ${envelope.type} from unpaired ${connection.peerIdentity.deviceName}`);
      return;
    }
    if (envelope.type === 'ping') {
      this.send(connection.peerId, 'pong', { nonce: envelope.payload.nonce });
      return;
    }
    if (envelope.type === 'pong') { connection.lastPongAt = Date.now(); return; }
    this.emit('envelope', { peerId: connection.peerId, envelope } satisfies EnvelopeEvent);
  }

  private handleHello(connection: Connection, envelope: Envelope): void {
    const identityResult = identitySchema.safeParse(envelope.payload.identity);
    const controlPort = Number(envelope.payload.controlPort);
    const transferPort = Number(envelope.payload.transferPort);
    const nonce = typeof envelope.payload.connectionNonce === 'string' ? envelope.payload.connectionNonce : '';
    if (!identityResult.success || identityResult.data.deviceId !== envelope.senderId || !nonce || !this.validPort(controlPort) || !this.validPort(transferPort)) {
      connection.ws.close(1002, 'Invalid hello'); return;
    }
    const identity = identityResult.data as DeviceIdentity;
    if (identity.deviceId === this.identity().deviceId) { connection.ws.close(1008, 'Self identity'); return; }
    const trust = this.trusted(identity.deviceId);
    if (trust?.blocked) { connection.ws.close(1008, 'Blocked'); return; }
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
      type: 'device_info',
      requestId: envelope.requestId,
      senderId: this.identity().deviceId,
      receiverId: identity.deviceId,
      timestamp: Date.now(),
      payload: {
        identity: this.identity(),
        controlPort: this.settings().controlPort,
        transferPort: this.settings().transferPort,
        connectionNonce: nonce,
        trusted: connection.authorized,
      },
    });
  }

  private handleDeviceInfo(connection: Connection, envelope: Envelope): void {
    const identityResult = identitySchema.safeParse(envelope.payload.identity);
    const controlPort = Number(envelope.payload.controlPort);
    const transferPort = Number(envelope.payload.transferPort);
    if (!identityResult.success || identityResult.data.deviceId !== envelope.senderId || !this.validPort(controlPort) || !this.validPort(transferPort)) {
      connection.ws.close(1002, 'Invalid device info'); return;
    }
    const identity = identityResult.data as DeviceIdentity;
    if (identity.deviceId === this.identity().deviceId) { connection.ws.close(1008, 'Self identity'); return; }
    const trust = this.trusted(identity.deviceId);
    if (trust?.blocked) { connection.ws.close(1008, 'Blocked'); return; }
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

  private register(connection: Connection): void {
    const peerId = connection.peerId;
    if (!peerId) return;
    const existing = this.connections.get(peerId);
    if (existing && existing !== connection && existing.ws.readyState === WebSocket.OPEN) {
      const oldKey = `${existing.initiatorId ?? ''}:${existing.nonce}`;
      const newKey = `${connection.initiatorId ?? ''}:${connection.nonce}`;
      if (oldKey <= newKey) { connection.ws.close(4001, 'Duplicate connection'); return; }
      existing.ws.close(4001, 'Duplicate connection');
    }
    this.connections.set(peerId, connection);
    this.reconnectAttempts.delete(peerId);
    const timer = this.reconnectTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(peerId);
    this.logger.info('WS', `Connected to ${connection.peerIdentity?.deviceName ?? peerId} (${connection.authorized ? 'trusted' : 'unpaired'})`);
    this.emit('peer-connected', peerId);
  }

  private onClose(connection: Connection, reason: string): void {
    clearTimeout(connection.handshakeTimer);
    this.allConnections.delete(connection);
    const peerId = connection.peerId;
    if (!peerId) return;
    if (this.connections.get(peerId) === connection) {
      this.connections.delete(peerId);
      this.logger.warn('WS', `Disconnected from ${connection.peerIdentity?.deviceName ?? peerId}${reason ? `: ${reason}` : ''}`);
      this.emit('peer-disconnected', peerId);
      if (!this.shuttingDown) this.scheduleReconnect(peerId);
    }
  }

  private scheduleReconnect(peerId: string): void {
    if (this.reconnectTimers.has(peerId)) return;
    const device = this.deviceLookup(peerId);
    if (!device || device.blocked || device.status === 'offline') return;
    const attempt = this.reconnectAttempts.get(peerId) ?? 0;
    const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)] ?? 16000;
    this.reconnectAttempts.set(peerId, attempt + 1);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(peerId);
      const current = this.deviceLookup(peerId);
      if (!current || this.isConnected(peerId)) return;
      void this.connectDevice(current).catch((error: unknown) => {
        this.logger.warn('WS', `Reconnect to ${current.deviceName} failed: ${error instanceof Error ? error.message : String(error)}`);
        this.scheduleReconnect(peerId);
      });
    }, delay);
    this.reconnectTimers.set(peerId, timer);
  }

  private pingAll(): void {
    const now = Date.now();
    for (const [peerId, connection] of this.connections) {
      if (now - connection.lastPongAt > INTERVALS_MS.ping + TIMEOUTS_MS.pong) {
        connection.ws.terminate();
        continue;
      }
      try { this.send(peerId, 'ping', { nonce: randomUUID() }); } catch { /* close handler reconnects */ }
    }
  }

  private sendEnvelope(connection: Connection, envelope: Envelope): void {
    if (connection.ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
    connection.ws.send(JSON.stringify(envelope));
  }

  private validPort(port: number): boolean { return Number.isInteger(port) && port > 0 && port <= 65535; }
}
