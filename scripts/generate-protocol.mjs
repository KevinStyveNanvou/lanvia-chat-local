#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'protocol', 'lanvia-protocol.json');
const raw = await readFile(sourcePath, 'utf8');
const spec = JSON.parse(raw);
const hash = createHash('sha256').update(raw).digest('hex');
const q = (value) => JSON.stringify(value);

const ts = `// GENERATED from protocol/lanvia-protocol.json. Do not edit. Source SHA-256: ${hash}\n` +
`export const PROTOCOL_VERSION = ${spec.protocolVersion} as const;\n` +
`export const SERVICE_TYPE = ${q(spec.serviceType)} as const;\n` +
`export const CONTROL_PATH = ${q(spec.paths.control)} as const;\n` +
`export const TRANSFER_PATH_TEMPLATE = ${q(spec.paths.transfer)} as const;\n` +
`export const PORTS = ${JSON.stringify(spec.ports, null, 2)} as const;\n` +
`export const LIMITS = ${JSON.stringify(spec.limits, null, 2)} as const;\n` +
`export const INTERVALS_MS = ${JSON.stringify(spec.intervalsMs, null, 2)} as const;\n` +
`export const TIMEOUTS_MS = ${JSON.stringify(spec.timeoutsMs, null, 2)} as const;\n` +
`export const RECONNECT_BACKOFF_MS = ${JSON.stringify(spec.reconnectBackoffMs)} as const;\n` +
`export const MESSAGE_TYPES = ${JSON.stringify(spec.messageTypes, null, 2)} as const;\n` +
`export type MessageType = typeof MESSAGE_TYPES[number];\n` +
`export const DEVICE_TYPES = ${JSON.stringify(spec.deviceTypes)} as const;\n` +
`export const PLATFORMS = ${JSON.stringify(spec.platforms)} as const;\n` +
`export const MESSAGE_STATUSES = ${JSON.stringify(spec.messageStatuses)} as const;\n` +
`export const TRANSFER_STATES = ${JSON.stringify(spec.transferStates, null, 2)} as const;\n` +
`export const ERROR_CODES = ${JSON.stringify(spec.errorCodes, null, 2)} as const;\n` +
`export const PROTOCOL_SOURCE_SHA256 = ${q(hash)} as const;\n`;

const dartList = (items) => `[${items.map((x) => `'${x}'`).join(', ')}]`;
const dartMap = (obj) => `{${Object.entries(obj).map(([k, v]) => `'${k}': ${v}`).join(', ')}}`;
const dart = `// GENERATED from protocol/lanvia-protocol.json. Do not edit. Source SHA-256: ${hash}\n` +
`abstract final class LanviaProtocol {\n` +
`  static const int version = ${spec.protocolVersion};\n` +
`  static const String serviceType = '${spec.serviceType}';\n` +
`  static const String controlPath = '${spec.paths.control}';\n` +
`  static const String transferPathTemplate = '${spec.paths.transfer}';\n` +
`  static const int controlPort = ${spec.ports.control};\n` +
`  static const int transferPort = ${spec.ports.transfer};\n` +
`  static const int discoveryPort = ${spec.ports.discovery};\n` +
`  static const Map<String, int> limits = ${dartMap(spec.limits)};\n` +
`  static const Map<String, int> intervalsMs = ${dartMap(spec.intervalsMs)};\n` +
`  static const Map<String, int> timeoutsMs = ${dartMap(spec.timeoutsMs)};\n` +
`  static const List<int> reconnectBackoffMs = ${JSON.stringify(spec.reconnectBackoffMs)};\n` +
`  static const List<String> messageTypes = ${dartList(spec.messageTypes)};\n` +
`  static const List<String> deviceTypes = ${dartList(spec.deviceTypes)};\n` +
`  static const List<String> platforms = ${dartList(spec.platforms)};\n` +
`  static const List<String> messageStatuses = ${dartList(spec.messageStatuses)};\n` +
`  static const List<String> transferStates = ${dartList(spec.transferStates)};\n` +
`  static const List<String> errorCodes = ${dartList(spec.errorCodes)};\n` +
`  static const String sourceSha256 = '${hash}';\n` +
`}\n`;

await writeFile(path.join(root, 'desktop', 'src', 'shared', 'constants', 'protocol.generated.ts'), ts);
await writeFile(path.join(root, 'mobile', 'lib', 'core', 'constants', 'protocol_generated.dart'), dart);
console.log(`Generated protocol constants (${hash.slice(0, 12)})`);
