import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Envelope, Settings, TransferRecord } from '../src/shared/types/models';
import type { LocalStore } from '../src/main/storage/store';
import { Logger } from '../src/main/logger';
import { TransferManager } from '../src/main/transfers/manager';

const dirs: string[] = [];
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ephemeral port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function get(port: number, transferId: string, token: string, range?: string): Promise<{ status: number; body: Buffer; contentRange?: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'X-LANVIA-Receiver': 'peer-device-0001' };
    if (range) headers.Range = range;
    http.get({ hostname: '127.0.0.1', port, path: `/v1/transfers/${transferId}`, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const value = { status: response.statusCode ?? 0, body: Buffer.concat(chunks) } as { status: number; body: Buffer; contentRange?: string };
        if (response.headers['content-range']) value.contentRange = response.headers['content-range'];
        resolve(value);
      });
    }).on('error', reject);
  });
}

describe('HTTP transfer phase gate', () => {
  it('advertises an explicit fallback when the configured transfer port is occupied', async () => {
    const occupiedPort = await freePort();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(occupiedPort, '0.0.0.0', resolve));
    const root = await mkdtemp(path.join(os.tmpdir(), 'lanvia-transfer-fallback-')); dirs.push(root);
    const file = path.join(root, 'fallback.txt');
    await writeFile(file, 'fallback');
    const settings: Settings = { theme: 'dark', downloadFolder: root, notifications: false, launchAtStartup: false, minimizeToTray: false, controlPort: 54511, transferPort: occupiedPort, discoveryPort: 54513 };
    const records = new Map<string, TransferRecord>();
    const fakeStore = {
      identity: { deviceId: 'local-device-0001' },
      saveTransfer: (record: TransferRecord) => records.set(record.transferId, record),
      findTransfer: (id: string) => records.get(id),
    } as unknown as LocalStore;
    let advertisedPort = 0;
    const manager = new TransferManager(() => settings, fakeStore, (_peer, type, payload) => {
      if (type === 'transfer_request') advertisedPort = Number(payload.transferPort);
    }, () => '127.0.0.1', new Logger());
    try {
      await manager.start();
      expect(manager.status.state).toBe('running');
      expect(manager.status.port).not.toBe(occupiedPort);
      await manager.createOutgoing('peer-device-0001', file);
      expect(advertisedPort).toBe(manager.status.port);
    } finally {
      manager.stop();
      await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('serves only an accepted capability and supports Range resume', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lanvia-transfer-')); dirs.push(root);
    const file = path.join(root, 'payload.bin');
    const content = Buffer.from('0123456789-LANVIA-abcdefghijklmnopqrstuvwxyz');
    await writeFile(file, content);
    const transferPort = await freePort();
    const settings: Settings = { theme: 'dark', downloadFolder: root, notifications: false, launchAtStartup: false, minimizeToTray: false, controlPort: 54511, transferPort, discoveryPort: 54513 };
    const records = new Map<string, TransferRecord>();
    const fakeStore = {
      identity: { deviceId: 'local-device-0001' },
      saveTransfer: (record: TransferRecord) => records.set(record.transferId, record),
      findTransfer: (id: string) => records.get(id),
    } as unknown as LocalStore;
    let requestPayload: Record<string, unknown> | null = null;
    const manager = new TransferManager(() => settings, fakeStore, (_peer, type, payload) => { if (type === 'transfer_request') requestPayload = payload; }, () => '127.0.0.1', new Logger());
    try {
      await manager.start();
      const record = await manager.createOutgoing('peer-device-0001', file);
      const payload = requestPayload as unknown as Record<string, unknown>;
      const token = String(payload.transferToken);
      const denied = await get(settings.transferPort, record.transferId, token);
      expect(denied.status).toBe(403);
      const accept: Envelope = { version: 1, type: 'transfer_accept', requestId: 'request-00000001', senderId: 'peer-device-0001', receiverId: 'local-device-0001', timestamp: Date.now(), payload: { transferId: record.transferId, offset: 0 } };
      manager.handleControl('peer-device-0001', accept);
      const full = await get(settings.transferPort, record.transferId, token);
      expect(full.status).toBe(200);
      expect(full.body).toEqual(content);
      const resumed = await get(settings.transferPort, record.transferId, token, 'bytes=11-');
      expect(resumed.status).toBe(206);
      expect(resumed.contentRange).toBe(`bytes 11-${content.length - 1}/${content.length}`);
      expect(resumed.body).toEqual(content.subarray(11));
      expect((await get(settings.transferPort, record.transferId, 'wrong-token')).status).toBe(401);
    } finally { manager.stop(); }
  });
});
