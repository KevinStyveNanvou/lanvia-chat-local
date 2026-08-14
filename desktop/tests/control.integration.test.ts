import net from 'node:net';
import { describe, expect, it } from 'vitest';
import type { DeviceIdentity, DiscoveredDevice, Settings } from '../src/shared/types/models';
import { Logger } from '../src/main/logger';
import { ControlManager, type EnvelopeEvent } from '../src/main/network/control';

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ephemeral port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
function identity(id: string, name: string): DeviceIdentity { return { deviceId: id, deviceName: name, deviceType: 'desktop', platform: 'windows', appVersion: '1.0.0', protocolVersion: '1' }; }
function settings(controlPort: number): Settings { return { theme: 'dark', downloadFolder: '.', notifications: false, launchAtStartup: false, minimizeToTray: false, controlPort, transferPort: 53212, discoveryPort: 53213 }; }

function device(value: DeviceIdentity, port: number): DiscoveredDevice { return { ...value, address: '127.0.0.1', controlPort: port, transferPort: 53212, status: 'available', trusted: false, blocked: false, methods: ['manual'], lastSeenAt: Date.now() }; }

describe('Desktop ↔ Desktop control phase gate', () => {
  it('handshakes and transports a common pre-pair envelope', async () => {
    const aId = identity('00000000-0000-4000-8000-000000000001', 'Desktop A');
    const bId = identity('00000000-0000-4000-8000-000000000002', 'Desktop B');
    const aPort = await freePort();
    let bPort = await freePort();
    while (bPort === aPort) bPort = await freePort();
    const aSettings = settings(aPort); const bSettings = settings(bPort);
    const aDevice = device(bId, bSettings.controlPort); const bDevice = device(aId, aSettings.controlPort);
    const logger = new Logger();
    const a = new ControlManager(() => aId, () => aSettings, () => undefined, () => aDevice, () => undefined, logger);
    const b = new ControlManager(() => bId, () => bSettings, () => undefined, () => bDevice, () => undefined, logger);
    try {
      await a.start(); await b.start();
      const received = new Promise<EnvelopeEvent>((resolve) => b.once('envelope', resolve));
      await a.connectDevice(aDevice);
      expect(a.connectionCount).toBe(1);
      expect(b.connectionCount).toBe(1);
      a.send(bId.deviceId, 'pair_request', { pairId: '11111111-1111-4111-8111-111111111111', identity: aId, expiresAt: Date.now() + 60_000 });
      expect((await received).envelope.type).toBe('pair_request');
    } finally { a.stop(); b.stop(); }
  });
});
