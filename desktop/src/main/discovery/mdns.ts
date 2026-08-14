import { EventEmitter } from 'node:events';
import Bonjour, { type Browser, type Service } from 'bonjour-service';
import type { DeviceIdentity } from '../../shared/types/models';
import type { Logger } from '../logger';

export interface MdnsDeviceEvent {
  identity: DeviceIdentity;
  address: string;
  controlPort: number;
  transferPort: number;
}

export class MdnsDiscovery extends EventEmitter {
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;
  private advertisement: Service | null = null;

  constructor(
    private readonly identity: () => DeviceIdentity,
    private readonly ports: () => { controlPort: number; transferPort: number },
    private readonly logger: Logger,
  ) { super(); }

  start(): void {
    if (this.bonjour) return;
    try {
      const bonjour = new Bonjour({}, (error: Error) => this.serviceError(error));
      this.bonjour = bonjour;
      const identity = this.identity();
      const ports = this.ports();
      this.advertisement = bonjour.publish({
        name: `LANVIA-${identity.deviceId.slice(0, 8)}`,
        type: 'lanvia',
        protocol: 'tcp',
        port: ports.controlPort,
        txt: {
          id: identity.deviceId,
          name: identity.deviceName,
          type: identity.deviceType,
          platform: identity.platform,
          version: identity.appVersion,
          protocol: identity.protocolVersion,
          control: String(ports.controlPort),
          transfer: String(ports.transferPort),
        },
      });
      this.advertisement.on('error', (error: Error) => this.serviceError(error));
      this.browser = bonjour.find({ type: 'lanvia', protocol: 'tcp' }, (service) => this.onService(service));
      this.logger.info('MDNS', 'Advertising and browsing _lanvia._tcp');
    } catch (error) {
      this.serviceError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  stop(): void {
    try { this.browser?.stop(); } catch { /* best effort */ }
    try { this.advertisement?.stop(); } catch { /* best effort */ }
    try { this.bonjour?.destroy(); } catch { /* best effort */ }
    this.browser = null;
    this.advertisement = null;
    this.bonjour = null;
  }

  private serviceError(error: Error): void {
    this.logger.warn('MDNS', `mDNS unavailable: ${error.message}`);
    this.emit('service-error', error);
  }

  private onService(service: Service): void {
    const txt = service.txt as Record<string, string> | undefined;
    if (!txt || txt.protocol !== '1' || !txt.id || txt.id === this.identity().deviceId) return;
    const controlPort = Number(txt.control || service.port);
    const transferPort = Number(txt.transfer);
    if (!Number.isInteger(controlPort) || !Number.isInteger(transferPort)) return;
    const address = service.addresses?.find((item) => /^\d+\.\d+\.\d+\.\d+$/.test(item));
    if (!address) return;
    const deviceType = txt.type === 'mobile' ? 'mobile' : txt.type === 'desktop' ? 'desktop' : null;
    const platform = ['windows', 'macos', 'linux', 'android'].includes(txt.platform ?? '') ? txt.platform as DeviceIdentity['platform'] : null;
    if (!deviceType || !platform) return;
    this.emit('device', {
      identity: {
        deviceId: txt.id,
        deviceName: (txt.name || service.name).slice(0, 80),
        deviceType,
        platform,
        appVersion: txt.version || 'unknown',
        protocolVersion: '1',
      },
      address,
      controlPort,
      transferPort,
    } satisfies MdnsDeviceEvent);
  }
}
