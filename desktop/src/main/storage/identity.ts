import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '../../shared/constants/protocol.generated';
import type { DeviceIdentity, Platform } from '../../shared/types/models';

export function desktopPlatform(value: NodeJS.Platform): Platform {
  if (value === 'win32') return 'windows';
  if (value === 'darwin') return 'macos';
  return 'linux';
}

export function createDesktopIdentity(input: { deviceName: string; appVersion: string; platform?: NodeJS.Platform; deviceId?: string }): DeviceIdentity {
  const deviceName = input.deviceName.trim().slice(0, 80);
  if (!deviceName) throw new Error('Device name cannot be empty');
  return {
    deviceId: input.deviceId ?? randomUUID(),
    deviceName,
    deviceType: 'desktop',
    platform: desktopPlatform(input.platform ?? process.platform),
    appVersion: input.appVersion,
    protocolVersion: String(PROTOCOL_VERSION) as '1',
  };
}
