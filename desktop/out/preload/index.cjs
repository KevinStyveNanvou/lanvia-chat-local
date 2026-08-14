"use strict";
const electron = require("electron");
const api = {
  getSnapshot: () => electron.ipcRenderer.invoke("app:snapshot"),
  refreshDiscovery: () => electron.ipcRenderer.invoke("discovery:refresh"),
  connectManual: (host, port) => electron.ipcRenderer.invoke("device:connect-manual", host, port),
  connectDevice: (deviceId) => electron.ipcRenderer.invoke("device:connect", deviceId),
  pairDevice: (deviceId) => electron.ipcRenderer.invoke("pairing:start", deviceId),
  respondPairing: (pairId, accept) => electron.ipcRenderer.invoke("pairing:respond", pairId, accept),
  removeTrustedDevice: (deviceId) => electron.ipcRenderer.invoke("trusted:remove", deviceId),
  setDeviceBlocked: (deviceId, blocked) => electron.ipcRenderer.invoke("trusted:block", deviceId, blocked),
  sendMessage: (peerId, text) => electron.ipcRenderer.invoke("message:send", peerId, text),
  retryMessage: (messageId) => electron.ipcRenderer.invoke("message:retry", messageId),
  chooseAndSendFiles: (peerId, category) => electron.ipcRenderer.invoke("transfer:choose", peerId, category),
  sendDroppedFiles: (peerId, files) => {
    const paths = files.map((file) => electron.webUtils.getPathForFile(file)).filter(Boolean);
    return electron.ipcRenderer.invoke("transfer:send-paths", peerId, paths);
  },
  acceptTransfer: (transferId) => electron.ipcRenderer.invoke("transfer:accept", transferId),
  rejectTransfer: (transferId) => electron.ipcRenderer.invoke("transfer:reject", transferId),
  pauseTransfer: (transferId) => electron.ipcRenderer.invoke("transfer:pause", transferId),
  resumeTransfer: (transferId) => electron.ipcRenderer.invoke("transfer:resume", transferId),
  cancelTransfer: (transferId) => electron.ipcRenderer.invoke("transfer:cancel", transferId),
  revealTransfer: (transferId) => electron.ipcRenderer.invoke("transfer:reveal", transferId),
  updateDeviceName: (name) => electron.ipcRenderer.invoke("identity:name", name),
  updateSettings: (settings) => electron.ipcRenderer.invoke("settings:update", settings),
  chooseDownloadFolder: () => electron.ipcRenderer.invoke("settings:choose-folder"),
  getLogs: () => electron.ipcRenderer.invoke("diagnostics:logs"),
  onEvent: (listener) => {
    const handler = (_event, value) => listener(value);
    electron.ipcRenderer.on("lanvia:event", handler);
    return () => electron.ipcRenderer.removeListener("lanvia:event", handler);
  }
};
electron.contextBridge.exposeInMainWorld("lanvia", api);
