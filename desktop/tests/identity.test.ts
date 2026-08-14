import { describe, expect, it } from 'vitest';
import { createDesktopIdentity } from '../src/main/storage/identity';
import { identitySchema } from '../src/shared/protocol/schemas';

describe('desktop identity', () => {
  it('keeps an existing ID and maps Windows consistently', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const identity = createDesktopIdentity({ deviceId: id, deviceName: '  Kevin-PC  ', appVersion: '1.0.0', platform: 'win32' });
    expect(identity.deviceId).toBe(id);
    expect(identity.deviceName).toBe('Kevin-PC');
    expect(identity.platform).toBe('windows');
    expect(identitySchema.safeParse(identity).success).toBe(true);
  });

  it('generates different UUIDs for new installations', () => {
    const a = createDesktopIdentity({ deviceName: 'A', appVersion: '1' });
    const b = createDesktopIdentity({ deviceName: 'B', appVersion: '1' });
    expect(a.deviceId).not.toBe(b.deviceId);
  });
});
