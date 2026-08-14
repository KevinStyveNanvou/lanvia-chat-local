import type { MessageType } from '../constants/protocol.generated';

export type DeviceType = 'desktop' | 'mobile';
export type Platform = 'windows' | 'macos' | 'linux' | 'android';
export type DeviceStatus = 'searching' | 'available' | 'connecting' | 'connected' | 'pairing' | 'offline' | 'failed';
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'failed';
export type TransferState = 'hashing' | 'pending' | 'accepted' | 'transferring' | 'paused' | 'verifying' | 'completed' | 'rejected' | 'cancelled' | 'failed';

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  deviceType: DeviceType;
  platform: Platform;
  appVersion: string;
  protocolVersion: '1';
}

export interface DiscoveredDevice extends DeviceIdentity {
  address: string;
  controlPort: number;
  transferPort: number;
  status: DeviceStatus;
  trusted: boolean;
  blocked: boolean;
  methods: Array<'udp' | 'mdns' | 'manual'>;
  lastSeenAt: number;
  alias?: string;
  error?: string;
}

export interface TrustedDevice {
  deviceId: string;
  lastName: string;
  alias?: string;
  platform: Platform;
  sharedToken: string;
  blocked: boolean;
  pairedAt: number;
  lastSeenAt: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  receiverId: string;
  text: string;
  timestamp: number;
  status: MessageStatus;
}

export interface TransferRecord {
  transferId: string;
  peerId: string;
  direction: 'incoming' | 'outgoing';
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  localPath?: string;
  state: TransferState;
  bytesTransferred: number;
  speed: number;
  remainingTime: number | null;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface Settings {
  theme: 'dark' | 'light' | 'system';
  downloadFolder: string;
  notifications: boolean;
  launchAtStartup: boolean;
  minimizeToTray: boolean;
  controlPort: number;
  transferPort: number;
  discoveryPort: number;
}

export interface ServiceStatus {
  state: 'stopped' | 'starting' | 'running' | 'error';
  port?: number;
  error?: string;
}

export interface NetworkInterfaceInfo {
  name: string;
  address: string;
  netmask: string;
  broadcast: string;
}

export interface Diagnostics {
  localIps: NetworkInterfaceInfo[];
  control: ServiceStatus;
  transfer: ServiceStatus;
  discovery: ServiceStatus;
  mdns: ServiceStatus;
  udpBroadcastEnabled: boolean;
  webSocketConnections: number;
  devicesDiscovered: number;
  networkFingerprint: string;
  updatedAt: number;
  firewallHint?: string;
}

export interface PairingPrompt {
  pairId: string;
  peerId: string;
  peerName: string;
  expiresAt: number;
}

export interface AppSnapshot {
  identity: DeviceIdentity;
  settings: Settings;
  devices: DiscoveredDevice[];
  messages: ChatMessage[];
  transfers: TransferRecord[];
  trustedDevices: Array<Omit<TrustedDevice, 'sharedToken'>>;
  diagnostics: Diagnostics;
  pendingPairings: PairingPrompt[];
}

export interface Envelope<T extends Record<string, unknown> = Record<string, unknown>> {
  version: 1;
  type: MessageType;
  requestId: string;
  senderId: string;
  receiverId: string;
  timestamp: number;
  payload: T;
}

export interface DiscoveryPacket {
  lanvia: true;
  version: 1;
  type: 'device_hello';
  identity: DeviceIdentity;
  controlPort: number;
  transferPort: number;
  timestamp: number;
}

export interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: 'APP' | 'DISCOVERY' | 'MDNS' | 'WS' | 'TRANSFER' | 'STORAGE' | 'SECURITY';
  message: string;
}

export type AppEvent =
  | { kind: 'snapshot'; snapshot: AppSnapshot }
  | { kind: 'log'; entry: LogEntry }
  | { kind: 'pairing_prompt'; prompt: PairingPrompt }
  | { kind: 'incoming_transfer'; transfer: TransferRecord }
  | { kind: 'network_changed'; message: string };
