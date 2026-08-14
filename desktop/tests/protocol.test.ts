import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PORTS, PROTOCOL_SOURCE_SHA256, PROTOCOL_VERSION } from '../src/shared/constants/protocol.generated';
import { conversationId, parseDiscoveryPacket, parseEnvelope } from '../src/shared/protocol/schemas';

const root = new URL('../', import.meta.url);

describe('common protocol', () => {
  it('uses the generated source of truth and fixed default ports', async () => {
    const raw = readFileSync(new URL('../../protocol/lanvia-protocol.json', import.meta.url), 'utf8');
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(raw).digest('hex')).toBe(PROTOCOL_SOURCE_SHA256);
    expect(PROTOCOL_VERSION).toBe(1);
    expect(PORTS).toEqual({ control: 53211, transfer: 53212, discovery: 53213 });
  });

  it('parses golden UDP and rejects an incompatible or oversized packet', () => {
    const golden = readFileSync(new URL('../../protocol/examples/udp-device-hello.json', import.meta.url));
    const packet = parseDiscoveryPacket(golden);
    expect(packet?.identity.deviceName).toBe('Kevin-PC');
    expect(parseDiscoveryPacket(JSON.stringify({ ...packet, version: 2 }))).toBeNull();
    expect(parseDiscoveryPacket('x'.repeat(16_385))).toBeNull();
  });

  it('parses the golden envelope and computes symmetric conversations', () => {
    const golden = readFileSync(new URL('../../protocol/examples/message-send.json', import.meta.url));
    expect(parseEnvelope(golden)?.type).toBe('message_send');
    expect(conversationId('b', 'a')).toBe('a:b');
    expect(conversationId('a', 'b')).toBe('a:b');
  });
});
