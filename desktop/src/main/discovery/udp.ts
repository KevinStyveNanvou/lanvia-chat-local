import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { INTERVALS_MS, PROTOCOL_VERSION } from '../../shared/constants/protocol.generated';
import { parseDiscoveryPacket } from '../../shared/protocol/schemas';
import type { DeviceIdentity, DiscoveryPacket, NetworkInterfaceInfo } from '../../shared/types/models';
import type { Logger } from '../logger';
import { normalizeRemoteAddress } from '../network/interfaces';

export interface UdpDeviceEvent { packet: DiscoveryPacket; address: string }

export class UdpDiscovery extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private announceTimer: NodeJS.Timeout | null = null;
  private readonly lastReply = new Map<string, number>();

  constructor(
    private readonly identity: () => DeviceIdentity,
    private readonly ports: () => { controlPort: number; transferPort: number; discoveryPort: number },
    private readonly interfaces: () => NetworkInterfaceInfo[],
    private readonly logger: Logger,
  ) { super(); }

  async start(): Promise<void> {
    if (this.socket) return;
    const { discoveryPort } = this.ports();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('error', (error) => {
      this.logger.error('DISCOVERY', `UDP error: ${error.message}`);
      this.emit('service-error', error);
    });
    socket.on('message', (data, info) => this.onMessage(data, normalizeRemoteAddress(info.address)));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { socket.off('listening', onListening); reject(error); };
      const onListening = (): void => { socket.off('error', onError); resolve(); };
      socket.once('error', onError);
      socket.once('listening', onListening);
      socket.bind(discoveryPort, '0.0.0.0');
    });
    socket.setBroadcast(true);
    this.logger.info('DISCOVERY', `UDP fallback listening on 0.0.0.0:${discoveryPort}`);
    this.announce();
    this.announceTimer = setInterval(() => this.announce(), INTERVALS_MS.discoveryAnnouncement);
  }

  stop(): void {
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(); } catch { /* already closed */ }
    }
    this.lastReply.clear();
  }

  refresh(): void { this.announce(); }

  private packet(): DiscoveryPacket {
    const identity = this.identity();
    const { controlPort, transferPort } = this.ports();
    return { lanvia: true, version: PROTOCOL_VERSION, type: 'device_hello', identity, controlPort, transferPort, timestamp: Date.now() };
  }

  private announce(): void {
    const socket = this.socket;
    if (!socket) return;
    const data = Buffer.from(JSON.stringify(this.packet()));
    const targets = new Set(this.interfaces().map((item) => item.broadcast));
    targets.add('255.255.255.255');
    const { discoveryPort } = this.ports();
    for (const target of targets) this.send(data, discoveryPort, target);
    this.logger.debug('DISCOVERY', `Broadcast hello to ${[...targets].join(', ')}`);
  }

  private send(data: Buffer, port: number, address: string): void {
    this.socket?.send(data, port, address, (error) => {
      if (error) this.logger.warn('DISCOVERY', `UDP send to ${address}:${port} failed: ${error.message}`);
    });
  }

  private onMessage(data: Buffer, address: string): void {
    const packet = parseDiscoveryPacket(data);
    if (!packet || packet.identity.deviceId === this.identity().deviceId) return;
    this.emit('device', { packet, address } satisfies UdpDeviceEvent);
    const now = Date.now();
    const last = this.lastReply.get(packet.identity.deviceId) ?? 0;
    if (now - last >= INTERVALS_MS.discoveryAnnouncement) {
      this.lastReply.set(packet.identity.deviceId, now);
      this.send(Buffer.from(JSON.stringify(this.packet())), this.ports().discoveryPort, address);
    }
  }
}
