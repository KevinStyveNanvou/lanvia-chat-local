import { app, Notification, shell } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import { LIMITS, TIMEOUTS_MS } from '../shared/constants/protocol.generated';
import { conversationId, validPort } from '../shared/protocol/schemas';
import type { AppEvent, AppSnapshot, ChatMessage, DiscoveredDevice, Envelope, PairingPrompt, Settings, TrustedDevice } from '../shared/types/models';
import { DiscoveryManager } from './discovery/manager';
import { Logger } from './logger';
import { ControlManager, type EnvelopeEvent } from './network/control';
import { isLocalLanAddress } from './network/interfaces';
import { LocalStore } from './storage/store';
import { TransferManager } from './transfers/manager';

const TRANSFER_CONTROL_TYPES = new Set([
  'transfer_accept', 'transfer_reject', 'transfer_progress', 'transfer_pause', 'transfer_resume',
  'transfer_cancel', 'transfer_complete', 'transfer_error',
]);

export class AppService extends EventEmitter {
  readonly logger = new Logger();
  readonly store = new LocalStore();
  readonly discovery: DiscoveryManager;
  readonly control: ControlManager;
  readonly transfers: TransferManager;
  private readonly pendingPairings = new Map<string, PairingPrompt>();
  private readonly outgoingPairings = new Map<string, { peerId: string; expiresAt: number }>();
  private readonly connecting = new Set<string>();
  private started = false;

  constructor() {
    super();
    this.discovery = new DiscoveryManager(
      () => this.store.identity,
      () => this.networkSettings(),
      () => this.store.trustedDevices,
      this.logger,
    );
    this.control = new ControlManager(
      () => this.store.identity,
      () => this.networkSettings(),
      (deviceId) => this.store.findTrusted(deviceId),
      (deviceId) => this.discovery.find(deviceId),
      (identity, address, controlPort, transferPort) => this.discovery.upsertFromSocket(identity, address, controlPort, transferPort),
      this.logger,
    );
    this.transfers = new TransferManager(
      () => this.store.settings,
      this.store,
      (peerId, type, payload) => { this.control.send(peerId, type, payload); },
      (peerId) => this.control.peerAddress(peerId),
      this.logger,
    );
    this.bindEvents();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.logger.info('APP', `Starting LANVIA ${app.getVersion()} as ${this.store.identity.deviceName}`);
    await this.control.start().catch((error: unknown) => this.logger.error('WS', error instanceof Error ? error.message : String(error)));
    await this.transfers.start().catch((error: unknown) => this.logger.error('TRANSFER', error instanceof Error ? error.message : String(error)));
    await this.discovery.start();
    app.setLoginItemSettings({ openAtLogin: this.store.settings.launchAtStartup });
    this.emitSnapshot();
  }

  stop(): void {
    this.discovery.stop();
    this.transfers.stop();
    this.control.stop();
    this.started = false;
  }

  snapshot(): AppSnapshot {
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
        wsConnections: this.control.connectionCount,
      }),
      pendingPairings: [...this.pendingPairings.values()],
    };
  }

  refreshDiscovery(): void { this.discovery.refresh(); }

  async connectManual(host: string, port: number): Promise<void> {
    const cleanHost = host.trim().replace(/^\[|\]$/g, '');
    if (!cleanHost || cleanHost.length > 253 || !isLocalLanAddress(cleanHost)) throw new Error('Enter a valid local IP address or LAN hostname');
    if (!validPort(port)) throw new Error('Port must be between 1 and 65535');
    let target = cleanHost;
    if (!/^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|(?:fc|fd|fe80):)/i.test(cleanHost)) {
      const addresses = await lookup(cleanHost, { all: true });
      const local = addresses.find((item) => isLocalLanAddress(item.address));
      if (!local) throw new Error('The hostname does not resolve to a local network address');
      target = local.address;
    }
    await this.control.connect(target, port);
    this.emitSnapshot();
  }

  async connectDevice(deviceId: string): Promise<void> {
    const device = this.requireDevice(deviceId);
    if (device.blocked) throw new Error('This device is blocked');
    this.discovery.markStatus(deviceId, 'connecting');
    try {
      await this.control.connectDevice(device);
      this.discovery.markStatus(deviceId, 'connected');
    } catch (error) {
      this.discovery.markStatus(deviceId, 'failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async pairDevice(deviceId: string): Promise<void> {
    const device = this.requireDevice(deviceId);
    if (!this.control.isConnected(deviceId)) await this.connectDevice(deviceId);
    if (this.store.findTrusted(deviceId)?.blocked) throw new Error('This device is blocked');
    const pairId = randomUUID();
    const expiresAt = Date.now() + TIMEOUTS_MS.pairing;
    this.outgoingPairings.set(pairId, { peerId: deviceId, expiresAt });
    this.discovery.markStatus(deviceId, 'pairing');
    this.control.send(deviceId, 'pair_request', { pairId, identity: this.store.identity, expiresAt });
    this.logger.info('SECURITY', `Pairing request sent to ${device.deviceName}`);
  }

  respondPairing(pairId: string, accept: boolean): void {
    const prompt = this.pendingPairings.get(pairId);
    if (!prompt) throw new Error('Pairing request expired');
    this.pendingPairings.delete(pairId);
    if (!accept) {
      this.control.send(prompt.peerId, 'pair_reject', { pairId, reason: 'user_rejected' });
      this.discovery.markStatus(prompt.peerId, 'connected');
      this.emitSnapshot();
      return;
    }
    const peer = this.requireDevice(prompt.peerId);
    const sharedToken = randomBytes(32).toString('base64url');
    this.store.saveTrusted(this.trustedRecord(peer, sharedToken));
    this.control.markAuthorized(peer.deviceId, true);
    this.control.send(peer.deviceId, 'pair_accept', { pairId, trustToken: sharedToken, deviceName: this.store.identity.deviceName });
    this.discovery.refreshTrust(peer.deviceId);
    this.discovery.markStatus(peer.deviceId, 'connected');
    this.logger.info('SECURITY', `Paired with ${peer.deviceName}`);
    this.emitSnapshot();
  }

  removeTrustedDevice(deviceId: string): void {
    this.store.removeTrusted(deviceId);
    this.control.markAuthorized(deviceId, false);
    this.control.disconnect(deviceId);
    this.discovery.refreshTrust(deviceId);
    this.emitSnapshot();
  }

  setDeviceBlocked(deviceId: string, blocked: boolean): void {
    const existing = this.store.findTrusted(deviceId);
    if (!existing) throw new Error('Device is not trusted');
    this.store.setBlocked(deviceId, blocked);
    if (blocked) this.control.disconnect(deviceId);
    this.discovery.refreshTrust(deviceId);
    this.emitSnapshot();
  }

  sendMessage(peerId: string, text: string): void {
    const clean = text.trim();
    if (!clean) return;
    if (Buffer.byteLength(clean, 'utf8') > LIMITS.textMessageBytes) throw new Error('Message exceeds 64 KiB');
    const trusted = this.store.findTrusted(peerId);
    if (!trusted || trusted.blocked) throw new Error('Pair with this device before sending messages');
    const message: ChatMessage = {
      id: randomUUID(),
      conversationId: conversationId(this.store.identity.deviceId, peerId),
      senderId: this.store.identity.deviceId,
      receiverId: peerId,
      text: clean,
      timestamp: Date.now(),
      status: 'sending',
    };
    this.store.saveMessage(message);
    this.emitSnapshot();
    try {
      this.control.send(peerId, 'message_send', { ...message, status: 'sent' });
      this.store.updateMessage(message.id, { status: 'sent' });
    } catch (error) {
      this.store.updateMessage(message.id, { status: 'failed' });
      this.emitSnapshot();
      throw error;
    }
    this.emitSnapshot();
  }

  retryMessage(messageId: string): void {
    const message = this.store.messages.find((item) => item.id === messageId);
    if (!message || message.senderId !== this.store.identity.deviceId) throw new Error('Message not found');
    this.control.send(message.receiverId, 'message_send', { ...message, status: 'sent' });
    this.store.updateMessage(message.id, { status: 'sent' });
    this.emitSnapshot();
  }

  async sendFiles(peerId: string, filePaths: string[]): Promise<void> {
    const trusted = this.store.findTrusted(peerId);
    if (!trusted || trusted.blocked || !this.control.isAuthorized(peerId)) throw new Error('Pair and connect before sending files');
    for (const filePath of filePaths.slice(0, 20)) await this.transfers.createOutgoing(peerId, filePath);
    this.emitSnapshot();
  }

  async acceptTransfer(transferId: string): Promise<void> { await this.transfers.accept(transferId); }
  rejectTransfer(transferId: string): void { this.transfers.reject(transferId); }
  pauseTransfer(transferId: string): void { this.transfers.pause(transferId); }
  async resumeTransfer(transferId: string): Promise<void> { await this.transfers.resume(transferId); }
  async cancelTransfer(transferId: string): Promise<void> { await this.transfers.cancel(transferId); }

  revealTransfer(transferId: string): void {
    const transfer = this.store.findTransfer(transferId);
    if (!transfer?.localPath || transfer.state !== 'completed') throw new Error('Completed file is not available');
    shell.showItemInFolder(transfer.localPath);
  }

  async updateDeviceName(name: string): Promise<void> {
    this.store.updateDeviceName(name);
    await this.discovery.restart();
    this.emitSnapshot();
  }

  updateSettings(patch: Partial<Settings>): void {
    for (const key of ['controlPort', 'transferPort', 'discoveryPort'] as const) {
      if (patch[key] !== undefined && !validPort(patch[key])) throw new Error(`${key} must be between 1 and 65535`);
    }
    const candidate = { ...this.store.settings, ...patch };
    if (candidate.controlPort === candidate.transferPort) throw new Error('Control and transfer TCP ports must be different');
    const settings = this.store.updateSettings(patch);
    app.setLoginItemSettings({ openAtLogin: settings.launchAtStartup });
    this.emitSnapshot();
  }

  private networkSettings(): Settings {
    const configured = this.store.settings;
    const actualTransferPort = this.transfers?.status.state === 'running' && this.transfers.status.port
      ? this.transfers.status.port
      : configured.transferPort;
    return { ...configured, transferPort: actualTransferPort };
  }

  private bindEvents(): void {
    this.logger.on('entry', (entry) => this.emit('event', { kind: 'log', entry } satisfies AppEvent));
    this.discovery.on('changed', () => this.emitSnapshot());
    this.discovery.on('device', (device: DiscoveredDevice) => this.autoConnect(device));
    this.discovery.on('network-changed', () => {
      this.control.resetConnectionsForNetworkChange();
      this.emit('event', { kind: 'network_changed', message: 'Network changed. Searching for devices…' } satisfies AppEvent);
      this.emitSnapshot();
    });
    this.control.on('status', () => this.emitSnapshot());
    this.control.on('peer-connected', (peerId: string) => {
      this.connecting.delete(peerId);
      this.discovery.markStatus(peerId, 'connected');
      this.emitSnapshot();
    });
    this.control.on('peer-disconnected', (peerId: string) => {
      this.discovery.markStatus(peerId, 'available');
      this.emitSnapshot();
    });
    this.control.on('envelope', (event: EnvelopeEvent) => this.onEnvelope(event));
    this.transfers.on('changed', () => this.emitSnapshot());
    this.transfers.on('incoming', (transfer) => {
      this.notify('LANVIA', `${this.discovery.find(transfer.peerId)?.deviceName ?? 'A device'} wants to send ${transfer.fileName}`);
      this.emit('event', { kind: 'incoming_transfer', transfer } satisfies AppEvent);
      this.emitSnapshot();
    });
  }

  private autoConnect(device: DiscoveredDevice): void {
    if (device.blocked || this.control.isConnected(device.deviceId) || this.connecting.has(device.deviceId)) return;
    if (this.store.identity.deviceId.localeCompare(device.deviceId) >= 0) return;
    this.connecting.add(device.deviceId);
    void this.connectDevice(device.deviceId).catch((error: unknown) => {
      this.logger.debug('WS', `Automatic connection to ${device.deviceName} deferred: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => this.connecting.delete(device.deviceId));
  }

  private onEnvelope({ peerId, envelope }: EnvelopeEvent): void {
    try {
      if (envelope.type === 'pair_request') this.onPairRequest(peerId, envelope);
      else if (envelope.type === 'pair_accept') this.onPairAccept(peerId, envelope);
      else if (envelope.type === 'pair_reject') this.onPairReject(peerId, envelope);
      else if (envelope.type === 'message_send') this.onMessage(peerId, envelope);
      else if (envelope.type === 'message_ack') this.onMessageAck(peerId, envelope);
      else if (envelope.type === 'transfer_request') this.transfers.registerIncoming(peerId, envelope.payload);
      else if (TRANSFER_CONTROL_TYPES.has(envelope.type)) this.transfers.handleControl(peerId, envelope);
    } catch (error) {
      this.logger.warn('APP', `Rejected ${envelope.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.emitSnapshot();
  }

  private onPairRequest(peerId: string, envelope: Envelope): void {
    const pairId = String(envelope.payload.pairId ?? '');
    const expiresAt = Number(envelope.payload.expiresAt);
    if (!/^[0-9a-f-]{36}$/i.test(pairId) || !Number.isSafeInteger(expiresAt) || expiresAt < Date.now() || expiresAt > Date.now() + TIMEOUTS_MS.pairing + 5000) throw new Error('Invalid pairing request');
    const peer = this.requireDevice(peerId);
    const prompt: PairingPrompt = { pairId, peerId, peerName: peer.deviceName, expiresAt };
    this.pendingPairings.set(pairId, prompt);
    this.discovery.markStatus(peerId, 'pairing');
    this.notify('LANVIA pairing request', `${peer.deviceName} wants to connect with this device.`);
    this.emit('event', { kind: 'pairing_prompt', prompt } satisfies AppEvent);
  }

  private onPairAccept(peerId: string, envelope: Envelope): void {
    const pairId = String(envelope.payload.pairId ?? '');
    const token = String(envelope.payload.trustToken ?? '');
    const pending = this.outgoingPairings.get(pairId);
    if (!pending || pending.peerId !== peerId || pending.expiresAt < Date.now() || token.length < 32 || token.length > 200) throw new Error('Unexpected pairing acceptance');
    const peer = this.requireDevice(peerId);
    this.store.saveTrusted(this.trustedRecord(peer, token));
    this.outgoingPairings.delete(pairId);
    this.control.markAuthorized(peerId, true);
    this.discovery.refreshTrust(peerId);
    this.discovery.markStatus(peerId, 'connected');
    this.logger.info('SECURITY', `Pairing accepted by ${peer.deviceName}`);
  }

  private onPairReject(peerId: string, envelope: Envelope): void {
    const pairId = String(envelope.payload.pairId ?? '');
    const pending = this.outgoingPairings.get(pairId);
    if (!pending || pending.peerId !== peerId) return;
    this.outgoingPairings.delete(pairId);
    this.discovery.markStatus(peerId, 'connected');
    this.logger.info('SECURITY', `Pairing rejected by ${this.discovery.find(peerId)?.deviceName ?? peerId}`);
  }

  private onMessage(peerId: string, envelope: Envelope): void {
    const payload = envelope.payload;
    const id = String(payload.id ?? '');
    const text = String(payload.text ?? '');
    const timestamp = Number(payload.timestamp);
    if (!/^[0-9a-f-]{36}$/i.test(id) || payload.senderId !== peerId || payload.receiverId !== this.store.identity.deviceId || !text || Buffer.byteLength(text, 'utf8') > LIMITS.textMessageBytes || !Number.isSafeInteger(timestamp)) throw new Error('Invalid message');
    const message: ChatMessage = {
      id,
      conversationId: conversationId(this.store.identity.deviceId, peerId),
      senderId: peerId,
      receiverId: this.store.identity.deviceId,
      text,
      timestamp,
      status: 'delivered',
    };
    this.store.saveMessage(message);
    this.control.send(peerId, 'message_ack', { messageId: id, status: 'delivered' });
    this.notify(this.discovery.find(peerId)?.deviceName ?? 'LANVIA', text.length > 100 ? `${text.slice(0, 100)}…` : text);
  }

  private onMessageAck(peerId: string, envelope: Envelope): void {
    const id = String(envelope.payload.messageId ?? '');
    const message = this.store.messages.find((item) => item.id === id);
    if (message?.receiverId === peerId) this.store.updateMessage(id, { status: 'delivered' });
  }

  private trustedRecord(peer: DiscoveredDevice, sharedToken: string): TrustedDevice {
    return {
      deviceId: peer.deviceId,
      lastName: peer.deviceName,
      platform: peer.platform,
      sharedToken,
      blocked: false,
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
  }

  private requireDevice(deviceId: string): DiscoveredDevice {
    const device = this.discovery.find(deviceId);
    if (!device) throw new Error('Device is no longer available');
    return device;
  }

  private notify(title: string, body: string): void {
    if (!this.store.settings.notifications || !Notification.isSupported()) return;
    new Notification({ title, body, silent: false }).show();
  }

  private emitSnapshot(): void { this.emit('event', { kind: 'snapshot', snapshot: this.snapshot() } satisfies AppEvent); }
}
