import { z } from 'zod';
import { DEVICE_TYPES, LIMITS, MESSAGE_TYPES, PLATFORMS, PROTOCOL_VERSION } from '../constants/protocol.generated';
import type { DiscoveryPacket, Envelope } from '../types/models';

const portSchema = z.number().int().min(1).max(65535);
const uuidLike = z.string().min(8).max(128);

export const identitySchema = z.object({
  deviceId: uuidLike,
  deviceName: z.string().trim().min(1).max(80),
  deviceType: z.enum(DEVICE_TYPES),
  platform: z.enum(PLATFORMS),
  appVersion: z.string().min(1).max(32),
  protocolVersion: z.literal(String(PROTOCOL_VERSION)),
});

export const discoveryPacketSchema = z.object({
  lanvia: z.literal(true),
  version: z.literal(PROTOCOL_VERSION),
  type: z.literal('device_hello'),
  identity: identitySchema,
  controlPort: portSchema,
  transferPort: portSchema,
  timestamp: z.number().int().nonnegative(),
});

export const envelopeSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  type: z.enum(MESSAGE_TYPES),
  requestId: uuidLike,
  senderId: uuidLike,
  receiverId: uuidLike,
  timestamp: z.number().int().nonnegative(),
  payload: z.record(z.unknown()),
});

export function parseDiscoveryPacket(data: Buffer | Uint8Array | string): DiscoveryPacket | null {
  try {
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    if (bytes > LIMITS.udpPacketBytes) return null;
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    const result = discoveryPacketSchema.safeParse(JSON.parse(text));
    return result.success ? (result.data as DiscoveryPacket) : null;
  } catch {
    return null;
  }
}

export function parseEnvelope(data: Buffer | ArrayBuffer | Buffer[] | string): Envelope | null {
  try {
    let text: string;
    if (typeof data === 'string') text = data;
    else if (Array.isArray(data)) text = Buffer.concat(data).toString('utf8');
    else text = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('utf8');
    if (Buffer.byteLength(text) > LIMITS.webSocketMessageBytes) return null;
    const result = envelopeSchema.safeParse(JSON.parse(text));
    return result.success ? (result.data as Envelope) : null;
  } catch {
    return null;
  }
}

export function conversationId(a: string, b: string): string {
  return [a, b].sort().join(':');
}

export function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
