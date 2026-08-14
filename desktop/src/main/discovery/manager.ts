import { EventEmitter } from 'node:events';
import { INTERVALS_MS } from '../../shared/constants/protocol.generated';
import type { DeviceIdentity, Diagnostics, DiscoveredDevice, ServiceStatus, Settings, TrustedDevice } from '../../shared/types/models';
import type { Logger } from '../logger';
import { getLanInterfaces, networkFingerprint } from '../network/interfaces';
import { MdnsDiscovery, type MdnsDeviceEvent } from './mdns';
import { UdpDiscovery, type UdpDeviceEvent } from './udp';

export class DiscoveryManager extends EventEmitter {
  private readonly devices = new Map<string, DiscoveredDevice>();
  private udp: UdpDiscovery | null = null;
  private mdns: MdnsDiscovery | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private networkTimer: NodeJS.Timeout | null = null;
  private fingerprint = '';
  private udpStatus: ServiceStatus = { state: 'stopped' };
  private mdnsStatus: ServiceStatus = { state: 'stopped' };

  constructor(
    private readonly identity: () => DeviceIdentity,
    private readonly settings: () => Settings,
    private readonly trusted: () => TrustedDevice[],
    private readonly logger: Logger,
  ) { super(); }

  async start(): Promise<void> {
    this.fingerprint = networkFingerprint();
    await this.startServices();
    this.expiryTimer = setInterval(() => this.expireDevices(), 1000);
    this.networkTimer = setInterval(() => this.checkNetwork(), INTERVALS_MS.networkCheck);
  }

  stop(): void {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    if (this.networkTimer) clearInterval(this.networkTimer);
    this.expiryTimer = null;
    this.networkTimer = null;
    this.stopServices();
  }

  async restart(): Promise<void> {
    this.stopServices();
    this.fingerprint = networkFingerprint();
    await this.startServices();
  }

  refresh(): void {
    this.udp?.refresh();
    this.logger.info('DISCOVERY', 'Manual discovery refresh');
  }

  getDevices(): DiscoveredDevice[] {
    return [...this.devices.values()].sort((a, b) => {
      const rank = (status: DiscoveredDevice['status']): number => status === 'connected' ? 0 : status === 'available' ? 1 : 2;
      return rank(a.status) - rank(b.status) || a.deviceName.localeCompare(b.deviceName);
    });
  }

  find(deviceId: string): DiscoveredDevice | undefined { return this.devices.get(deviceId); }

  upsertFromSocket(identity: DeviceIdentity, address: string, controlPort: number, transferPort: number): DiscoveredDevice {
    return this.upsert(identity, address, controlPort, transferPort, 'manual', 'connected');
  }

  markStatus(deviceId: string, status: DiscoveredDevice['status'], error?: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    const next: DiscoveredDevice = { ...device, status };
    if (error) next.error = error;
    else delete next.error;
    this.devices.set(deviceId, next);
    this.emit('changed');
  }

  remove(deviceId: string): void {
    this.devices.delete(deviceId);
    this.emit('changed');
  }

  refreshTrust(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    const trust = this.trusted().find((item) => item.deviceId === deviceId);
    const next: DiscoveredDevice = {
      ...device,
      trusted: Boolean(trust) && !trust?.blocked,
      blocked: trust?.blocked ?? false,
    };
    if (trust?.alias) next.alias = trust.alias;
    else delete next.alias;
    this.devices.set(deviceId, next);
    this.emit('changed');
  }

  diagnostics(base: { control: ServiceStatus; transfer: ServiceStatus; wsConnections: number }): Diagnostics {
    const interfaces = getLanInterfaces();
    const firewallHint = process.platform === 'win32' && base.control.state === 'running' && this.devices.size === 0
      ? 'If other devices cannot connect, allow LANVIA on Private networks in Windows Firewall.'
      : undefined;
    const result: Diagnostics = {
      localIps: interfaces,
      control: base.control,
      transfer: base.transfer,
      discovery: this.udpStatus,
      mdns: this.mdnsStatus,
      udpBroadcastEnabled: this.udpStatus.state === 'running',
      webSocketConnections: base.wsConnections,
      devicesDiscovered: [...this.devices.values()].filter((item) => item.status !== 'offline').length,
      networkFingerprint: this.fingerprint,
      updatedAt: Date.now(),
    };
    if (firewallHint) result.firewallHint = firewallHint;
    return result;
  }

  private async startServices(): Promise<void> {
    const ports = (): { controlPort: number; transferPort: number; discoveryPort: number } => ({
      controlPort: this.settings().controlPort,
      transferPort: this.settings().transferPort,
      discoveryPort: this.settings().discoveryPort,
    });
    this.logger.info('DISCOVERY', `Local interfaces: ${getLanInterfaces().map((item) => `${item.name}=${item.address}, broadcast=${item.broadcast}`).join('; ') || 'none'}`);
    this.udpStatus = { state: 'starting', port: this.settings().discoveryPort };
    this.udp = new UdpDiscovery(this.identity, ports, getLanInterfaces, this.logger);
    this.udp.on('device', (event: UdpDeviceEvent) => this.upsert(event.packet.identity, event.address, event.packet.controlPort, event.packet.transferPort, 'udp'));
    this.udp.on('service-error', (error: Error) => {
      this.udpStatus = { state: 'error', port: this.settings().discoveryPort, error: error.message };
      this.emit('changed');
    });
    try {
      await this.udp.start();
      this.udpStatus = { state: 'running', port: this.settings().discoveryPort };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.udpStatus = { state: 'error', port: this.settings().discoveryPort, error: message };
      this.logger.error('DISCOVERY', `Cannot bind UDP ${this.settings().discoveryPort}: ${message}`);
    }

    this.mdnsStatus = { state: 'starting' };
    this.mdns = new MdnsDiscovery(this.identity, ports, this.logger);
    this.mdns.on('device', (event: MdnsDeviceEvent) => this.upsert(event.identity, event.address, event.controlPort, event.transferPort, 'mdns'));
    this.mdns.on('service-error', (error: Error) => {
      this.mdnsStatus = { state: 'error', error: error.message };
      this.emit('changed');
    });
    this.mdns.start();
    if (this.mdnsStatus.state !== 'error') this.mdnsStatus = { state: 'running', port: this.settings().controlPort };
    this.emit('changed');
  }

  private stopServices(): void {
    this.udp?.stop();
    this.mdns?.stop();
    this.udp = null;
    this.mdns = null;
    this.udpStatus = { state: 'stopped' };
    this.mdnsStatus = { state: 'stopped' };
  }

  private upsert(
    identity: DeviceIdentity,
    address: string,
    controlPort: number,
    transferPort: number,
    method: 'udp' | 'mdns' | 'manual',
    status: DiscoveredDevice['status'] = 'available',
  ): DiscoveredDevice {
    if (identity.deviceId === this.identity().deviceId) throw new Error('Self discovery must be ignored');
    const existing = this.devices.get(identity.deviceId);
    const trusted = this.trusted().find((item) => item.deviceId === identity.deviceId);
    const methods = new Set(existing?.methods ?? []);
    methods.add(method);
    const device: DiscoveredDevice = {
      ...identity,
      address,
      controlPort,
      transferPort,
      status: existing?.status === 'connected' ? 'connected' : status,
      trusted: Boolean(trusted) && !trusted?.blocked,
      blocked: trusted?.blocked ?? false,
      methods: [...methods],
      lastSeenAt: Date.now(),
    };
    if (trusted?.alias) device.alias = trusted.alias;
    this.devices.set(identity.deviceId, device);
    if (!existing) this.logger.info('DISCOVERY', `Device found: ${identity.deviceName} at ${address}:${controlPort} via ${method}`);
    this.emit('device', device);
    this.emit('changed');
    return device;
  }

  private expireDevices(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, device] of this.devices) {
      if (device.status !== 'connected' && device.status !== 'connecting' && now - device.lastSeenAt > INTERVALS_MS.peerExpiry && device.status !== 'offline') {
        this.devices.set(id, { ...device, status: 'offline' });
        changed = true;
      }
    }
    if (changed) this.emit('changed');
  }

  private checkNetwork(): void {
    const current = networkFingerprint();
    if (current === this.fingerprint) return;
    const previous = this.fingerprint;
    this.fingerprint = current;
    this.logger.warn('DISCOVERY', `Network changed (${previous || 'none'} -> ${current || 'none'})`);
    this.emit('network-changed');
    void this.restart();
  }
}
