import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppEvent, Settings } from '../shared/types/models';
import { AppService } from './app-service';
import { SystemTray } from './system-tray/tray';
import { createMainWindow } from './window/create-window';

protocol.registerSchemesAsPrivileged([{ scheme: 'lanvia-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow: BrowserWindow | null = null;
let tray: SystemTray | null = null;
let service: AppService | null = null;
let quitting = false;

function requireService(): AppService {
  if (!service) throw new Error('LANVIA is not ready');
  return service;
}

function requireString(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`);
  return value;
}

function registerIpc(): void {
  ipcMain.handle('app:snapshot', () => requireService().snapshot());
  ipcMain.handle('discovery:refresh', () => requireService().refreshDiscovery());
  ipcMain.handle('device:connect-manual', (_event, host: unknown, port: unknown) => requireService().connectManual(requireString(host, 'host'), Number(port)));
  ipcMain.handle('device:connect', (_event, id: unknown) => requireService().connectDevice(requireString(id, 'device ID', 128)));
  ipcMain.handle('pairing:start', (_event, id: unknown) => requireService().pairDevice(requireString(id, 'device ID', 128)));
  ipcMain.handle('pairing:respond', (_event, id: unknown, accept: unknown) => requireService().respondPairing(requireString(id, 'pair ID', 128), accept === true));
  ipcMain.handle('trusted:remove', (_event, id: unknown) => requireService().removeTrustedDevice(requireString(id, 'device ID', 128)));
  ipcMain.handle('trusted:block', (_event, id: unknown, blocked: unknown) => requireService().setDeviceBlocked(requireString(id, 'device ID', 128), blocked === true));
  ipcMain.handle('message:send', (_event, peerId: unknown, text: unknown) => requireService().sendMessage(requireString(peerId, 'device ID', 128), requireString(text, 'message', 65_536)));
  ipcMain.handle('message:retry', (_event, id: unknown) => requireService().retryMessage(requireString(id, 'message ID', 128)));
  ipcMain.handle('transfer:choose', async (_event, peerId: unknown, category: unknown) => {
    const filters: Record<string, Electron.FileFilter[]> = {
      image: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }],
      video: [{ name: 'Videos', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi'] }],
      audio: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'] }],
      document: [{ name: 'Documents', extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'csv', 'zip'] }],
      file: [{ name: 'All files', extensions: ['*'] }],
    };
    const key = typeof category === 'string' && category in filters ? category : 'file';
    const options: Electron.OpenDialogOptions = { properties: ['openFile', 'multiSelections'], filters: filters[key] ?? filters.file! };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (!result.canceled && result.filePaths.length) await requireService().sendFiles(requireString(peerId, 'device ID', 128), result.filePaths);
  });
  ipcMain.handle('transfer:send-paths', (_event, peerId: unknown, paths: unknown) => {
    if (!Array.isArray(paths) || paths.some((item) => typeof item !== 'string') || paths.length > 20) throw new Error('Invalid dropped files');
    return requireService().sendFiles(requireString(peerId, 'device ID', 128), paths as string[]);
  });
  ipcMain.handle('transfer:accept', (_event, id: unknown) => requireService().acceptTransfer(requireString(id, 'transfer ID', 128)));
  ipcMain.handle('transfer:reject', (_event, id: unknown) => requireService().rejectTransfer(requireString(id, 'transfer ID', 128)));
  ipcMain.handle('transfer:pause', (_event, id: unknown) => requireService().pauseTransfer(requireString(id, 'transfer ID', 128)));
  ipcMain.handle('transfer:resume', (_event, id: unknown) => requireService().resumeTransfer(requireString(id, 'transfer ID', 128)));
  ipcMain.handle('transfer:cancel', (_event, id: unknown) => requireService().cancelTransfer(requireString(id, 'transfer ID', 128)));
  ipcMain.handle('transfer:reveal', (_event, id: unknown) => requireService().revealTransfer(requireString(id, 'transfer ID', 128)));
  ipcMain.handle('identity:name', (_event, name: unknown) => requireService().updateDeviceName(requireString(name, 'device name', 80)));
  ipcMain.handle('settings:update', (_event, patch: unknown) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings');
    const allowed = ['theme', 'notifications', 'launchAtStartup', 'minimizeToTray', 'controlPort', 'transferPort', 'discoveryPort'];
    if (Object.keys(patch).some((key) => !allowed.includes(key))) throw new Error('Unknown setting');
    const input = patch as Record<string, unknown>;
    if (input.theme !== undefined && !['dark', 'light', 'system'].includes(String(input.theme))) throw new Error('Invalid theme');
    for (const key of ['notifications', 'launchAtStartup', 'minimizeToTray']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`Invalid ${key}`);
    for (const key of ['controlPort', 'transferPort', 'discoveryPort']) if (input[key] !== undefined && typeof input[key] !== 'number') throw new Error(`Invalid ${key}`);
    requireService().updateSettings(patch as Partial<Settings>);
  });
  ipcMain.handle('settings:choose-folder', async () => {
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = path.resolve(result.filePaths[0]);
    requireService().updateSettings({ downloadFolder: selected });
    return selected;
  });
  ipcMain.handle('diagnostics:logs', () => requireService().logger.exportText());
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('ai.arena.lanvia');
  registerIpc();
  service = new AppService();
  protocol.handle('lanvia-media', (request) => {
    const url = new URL(request.url);
    const transferId = url.hostname === 'transfer' ? url.pathname.replace(/^\//, '') : '';
    const transfer = service?.store.findTransfer(transferId);
    if (!transfer?.localPath || transfer.state !== 'completed') return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(transfer.localPath).toString(), { headers: request.headers });
  });
  mainWindow = createMainWindow(() => !quitting && (service?.store.settings.minimizeToTray ?? true));
  tray = new SystemTray(mainWindow, () => { quitting = true; app.quit(); });
  service.on('event', (event: AppEvent) => {
    if (event.kind === 'snapshot') tray?.updateDeviceCount(event.snapshot.devices.filter((device) => device.status !== 'offline').length);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lanvia:event', event);
  });
  await service.start();
}

app.whenReady().then(() => void bootstrap().catch((error: unknown) => {
  dialog.showErrorBox('LANVIA failed to start', error instanceof Error ? error.message : String(error));
}));

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});

app.on('before-quit', () => { quitting = true; service?.stop(); tray?.destroy(); });
app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  if (quitting || !(service?.store.settings.minimizeToTray ?? true)) { quitting = true; app.quit(); }
});
