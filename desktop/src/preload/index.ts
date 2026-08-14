import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppEvent } from '../shared/types/models';
import type { LanviaApi } from '../shared/types/ipc';

const api: LanviaApi = {
  getSnapshot: () => ipcRenderer.invoke('app:snapshot'),
  refreshDiscovery: () => ipcRenderer.invoke('discovery:refresh'),
  connectManual: (host, port) => ipcRenderer.invoke('device:connect-manual', host, port),
  connectDevice: (deviceId) => ipcRenderer.invoke('device:connect', deviceId),
  pairDevice: (deviceId) => ipcRenderer.invoke('pairing:start', deviceId),
  respondPairing: (pairId, accept) => ipcRenderer.invoke('pairing:respond', pairId, accept),
  removeTrustedDevice: (deviceId) => ipcRenderer.invoke('trusted:remove', deviceId),
  setDeviceBlocked: (deviceId, blocked) => ipcRenderer.invoke('trusted:block', deviceId, blocked),
  sendMessage: (peerId, text) => ipcRenderer.invoke('message:send', peerId, text),
  retryMessage: (messageId) => ipcRenderer.invoke('message:retry', messageId),
  chooseAndSendFiles: (peerId, category) => ipcRenderer.invoke('transfer:choose', peerId, category),
  sendDroppedFiles: (peerId, files) => {
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke('transfer:send-paths', peerId, paths);
  },
  acceptTransfer: (transferId) => ipcRenderer.invoke('transfer:accept', transferId),
  rejectTransfer: (transferId) => ipcRenderer.invoke('transfer:reject', transferId),
  pauseTransfer: (transferId) => ipcRenderer.invoke('transfer:pause', transferId),
  resumeTransfer: (transferId) => ipcRenderer.invoke('transfer:resume', transferId),
  cancelTransfer: (transferId) => ipcRenderer.invoke('transfer:cancel', transferId),
  revealTransfer: (transferId) => ipcRenderer.invoke('transfer:reveal', transferId),
  updateDeviceName: (name) => ipcRenderer.invoke('identity:name', name),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  chooseDownloadFolder: () => ipcRenderer.invoke('settings:choose-folder'),
  getLogs: () => ipcRenderer.invoke('diagnostics:logs'),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: AppEvent): void => listener(value);
    ipcRenderer.on('lanvia:event', handler);
    return () => ipcRenderer.removeListener('lanvia:event', handler);
  },
};

contextBridge.exposeInMainWorld('lanvia', api);
