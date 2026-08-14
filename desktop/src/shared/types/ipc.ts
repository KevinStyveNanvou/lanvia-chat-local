import type { AppEvent, AppSnapshot, Settings } from './models';

export interface LanviaApi {
  getSnapshot(): Promise<AppSnapshot>;
  refreshDiscovery(): Promise<void>;
  connectManual(host: string, port: number): Promise<void>;
  connectDevice(deviceId: string): Promise<void>;
  pairDevice(deviceId: string): Promise<void>;
  respondPairing(pairId: string, accept: boolean): Promise<void>;
  removeTrustedDevice(deviceId: string): Promise<void>;
  setDeviceBlocked(deviceId: string, blocked: boolean): Promise<void>;
  sendMessage(peerId: string, text: string): Promise<void>;
  retryMessage(messageId: string): Promise<void>;
  chooseAndSendFiles(peerId: string, category?: 'file' | 'image' | 'video' | 'audio' | 'document'): Promise<void>;
  sendDroppedFiles(peerId: string, files: File[]): Promise<void>;
  acceptTransfer(transferId: string): Promise<void>;
  rejectTransfer(transferId: string): Promise<void>;
  pauseTransfer(transferId: string): Promise<void>;
  resumeTransfer(transferId: string): Promise<void>;
  cancelTransfer(transferId: string): Promise<void>;
  revealTransfer(transferId: string): Promise<void>;
  updateDeviceName(name: string): Promise<void>;
  updateSettings(settings: Partial<Settings>): Promise<void>;
  chooseDownloadFolder(): Promise<string | null>;
  getLogs(): Promise<string>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}

declare global {
  interface Window {
    lanvia: LanviaApi;
  }
}
