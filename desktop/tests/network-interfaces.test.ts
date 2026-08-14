import { describe, expect, it } from 'vitest';
import { broadcastAddress, isLocalLanAddress, normalizeRemoteAddress } from '../src/main/network/interfaces';

describe('network helpers', () => {
  it('calculates directed broadcasts', () => {
    expect(broadcastAddress('192.168.43.120', '255.255.255.0')).toBe('192.168.43.255');
    expect(broadcastAddress('10.2.4.8', '255.255.252.0')).toBe('10.2.7.255');
  });
  it('normalizes and limits manual LAN targets', () => {
    expect(normalizeRemoteAddress('::ffff:192.168.1.4')).toBe('192.168.1.4');
    expect(isLocalLanAddress('192.168.1.4')).toBe(true);
    expect(isLocalLanAddress('8.8.8.8')).toBe(false);
  });
});
