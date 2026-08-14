import { app } from 'electron';
import Store from 'electron-store';
import path from 'node:path';
import { PORTS } from '../../shared/constants/protocol.generated';
import type { ChatMessage, DeviceIdentity, Settings, TransferRecord, TrustedDevice } from '../../shared/types/models';
import { createDesktopIdentity } from './identity';

interface PersistedData {
  identity: DeviceIdentity;
  settings: Settings;
  trustedDevices: TrustedDevice[];
  messages: ChatMessage[];
  transfers: TransferRecord[];
}

function defaultName(): string {
  return process.env.COMPUTERNAME || process.env.HOSTNAME || 'LANVIA Desktop';
}

export class LocalStore {
  private readonly store: Store<PersistedData>;

  constructor() {
    const defaults: PersistedData = {
      identity: createDesktopIdentity({ deviceName: defaultName(), appVersion: app.getVersion() }),
      settings: {
        theme: 'dark',
        downloadFolder: path.join(app.getPath('downloads'), 'LANVIA'),
        notifications: true,
        launchAtStartup: false,
        minimizeToTray: true,
        controlPort: PORTS.control,
        transferPort: PORTS.transfer,
        discoveryPort: PORTS.discovery,
      },
      trustedDevices: [],
      messages: [],
      transfers: [],
    };
    this.store = new Store<PersistedData>({ name: 'lanvia', defaults, clearInvalidConfig: false });
  }

  get identity(): DeviceIdentity { return this.store.get('identity'); }
  get settings(): Settings { return this.store.get('settings'); }
  get trustedDevices(): TrustedDevice[] { return this.store.get('trustedDevices'); }
  get messages(): ChatMessage[] { return this.store.get('messages'); }
  get transfers(): TransferRecord[] { return this.store.get('transfers'); }

  updateDeviceName(deviceName: string): DeviceIdentity {
    const clean = deviceName.trim().slice(0, 80);
    if (!clean) throw new Error('Device name cannot be empty');
    const identity = { ...this.identity, deviceName: clean };
    this.store.set('identity', identity);
    return identity;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings, ...patch };
    this.store.set('settings', next);
    return next;
  }

  findTrusted(deviceId: string): TrustedDevice | undefined {
    return this.trustedDevices.find((device) => device.deviceId === deviceId);
  }

  saveTrusted(device: TrustedDevice): void {
    const devices = this.trustedDevices.filter((item) => item.deviceId !== device.deviceId);
    devices.push(device);
    this.store.set('trustedDevices', devices);
  }

  removeTrusted(deviceId: string): void {
    this.store.set('trustedDevices', this.trustedDevices.filter((item) => item.deviceId !== deviceId));
  }

  setBlocked(deviceId: string, blocked: boolean): void {
    const devices = this.trustedDevices.map((item) => item.deviceId === deviceId ? { ...item, blocked } : item);
    this.store.set('trustedDevices', devices);
  }

  saveMessage(message: ChatMessage): void {
    const messages = this.messages;
    const index = messages.findIndex((item) => item.id === message.id);
    if (index >= 0) messages[index] = message;
    else messages.push(message);
    this.store.set('messages', messages.slice(-10_000));
  }

  updateMessage(id: string, patch: Partial<ChatMessage>): void {
    const messages = this.messages.map((message) => message.id === id ? { ...message, ...patch } : message);
    this.store.set('messages', messages);
  }

  saveTransfer(transfer: TransferRecord): void {
    const transfers = this.transfers;
    const index = transfers.findIndex((item) => item.transferId === transfer.transferId);
    if (index >= 0) transfers[index] = transfer;
    else transfers.push(transfer);
    this.store.set('transfers', transfers.slice(-2000));
  }

  findTransfer(transferId: string): TransferRecord | undefined {
    return this.transfers.find((item) => item.transferId === transferId);
  }
}
