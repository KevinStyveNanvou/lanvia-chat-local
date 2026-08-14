import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import mime from 'mime-types';
import { INTERVALS_MS, LIMITS, TIMEOUTS_MS } from '../../shared/constants/protocol.generated';
import type { Envelope, ServiceStatus, Settings, TransferRecord } from '../../shared/types/models';
import type { Logger } from '../logger';
import { finalizePart, safeDestination, sha256File, validateSourceFile } from '../security/files';
import type { LocalStore } from '../storage/store';

interface OutgoingSource {
  transferId: string;
  peerId: string;
  filePath: string;
  token: string;
  size: number;
  accepted: boolean;
  expiresAt: number;
}

interface IncomingContext {
  transferId: string;
  peerId: string;
  address: string;
  transferPort: number;
  token: string;
  finalPath: string;
  partPath: string;
  request: http.ClientRequest | null;
  intentionalStop: 'pause' | 'cancel' | null;
}

interface TransferRequestPayload {
  transferId: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  transferPort: number;
  transferToken: string;
  expiresAt: number;
}

export class TransferManager extends EventEmitter {
  private server: http.Server | null = null;
  private statusValue: ServiceStatus = { state: 'stopped' };
  private readonly outgoing = new Map<string, OutgoingSource>();
  private readonly incoming = new Map<string, IncomingContext>();
  private activeDownloads = 0;
  private readonly requestRates = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly settings: () => Settings,
    private readonly store: LocalStore,
    private readonly send: (peerId: string, type: Envelope['type'], payload: Record<string, unknown>) => void,
    private readonly peerAddress: (peerId: string) => string | undefined,
    private readonly logger: Logger,
  ) { super(); }

  get status(): ServiceStatus { return this.statusValue; }

  async start(): Promise<void> {
    if (this.server) return;
    const configuredPort = this.settings().transferPort;
    this.statusValue = { state: 'starting', port: configuredPort };
    const server = http.createServer((request, response) => void this.handleHttp(request, response));
    server.requestTimeout = 0;
    server.headersTimeout = TIMEOUTS_MS.httpIdle;
    server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));

    let actualPort: number | null = null;
    let lastError: Error | null = null;
    const candidates = Array.from(
      { length: LIMITS.transferPortFallbackAttempts + 1 },
      (_, index) => configuredPort + index,
    ).filter((candidate) =>
      candidate <= 65535 &&
      candidate !== this.settings().controlPort &&
      candidate !== this.settings().discoveryPort,
    );

    for (const candidate of candidates) {
      try {
        await this.listen(server, candidate);
        actualPort = candidate;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE') break;
      }
    }

    if (actualPort === null && (lastError as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE') {
      try {
        await this.listen(server, 0);
        const address = server.address();
        if (address && typeof address !== 'string') actualPort = address.port;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (actualPort === null) {
      const message = lastError?.message ?? 'Unable to bind transfer server';
      this.statusValue = { state: 'error', port: configuredPort, error: message };
      try { server.close(); } catch { /* no-op */ }
      throw new Error(`Transfer port ${configuredPort} unavailable: ${message}`);
    }

    this.server = server;
    server.on('error', (error) => {
      this.statusValue = { state: 'error', port: actualPort ?? configuredPort, error: error.message };
      this.logger.error('TRANSFER', `Transfer server error on ${actualPort ?? configuredPort}: ${error.message}`);
      this.emit('changed');
    });
    const fallbackMessage = actualPort !== configuredPort
      ? `Configured transfer port ${configuredPort} was occupied; using ${actualPort}`
      : undefined;
    this.statusValue = fallbackMessage
      ? { state: 'running', port: actualPort, error: fallbackMessage }
      : { state: 'running', port: actualPort };
    if (fallbackMessage) this.logger.warn('TRANSFER', fallbackMessage);
    this.logger.info('TRANSFER', `HTTP transfer server listening on 0.0.0.0:${actualPort}`);
    this.emit('changed');
  }

  stop(): void {
    for (const context of this.incoming.values()) context.request?.destroy(new Error('LANVIA stopping'));
    this.incoming.clear();
    this.outgoing.clear();
    try { this.server?.close(); } catch { /* no-op */ }
    this.server = null;
    this.statusValue = { state: 'stopped' };
    this.emit('changed');
  }

  async createOutgoing(peerId: string, filePath: string): Promise<TransferRecord> {
    const { size, fileName } = await validateSourceFile(filePath);
    const transferId = randomUUID();
    const now = Date.now();
    let record: TransferRecord = {
      transferId,
      peerId,
      direction: 'outgoing',
      fileName,
      mimeType: mime.lookup(fileName) || 'application/octet-stream',
      size,
      sha256: '',
      localPath: filePath,
      state: 'hashing',
      bytesTransferred: 0,
      speed: 0,
      remainingTime: null,
      createdAt: now,
      updatedAt: now,
    };
    this.save(record);
    try {
      const hash = await sha256File(filePath);
      record = { ...record, sha256: hash, state: 'pending', updatedAt: Date.now() };
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + TIMEOUTS_MS.transferDecision;
      this.outgoing.set(transferId, { transferId, peerId, filePath, token, size, accepted: false, expiresAt });
      this.save(record);
      this.send(peerId, 'transfer_request', {
        transferId,
        fileName,
        mimeType: record.mimeType,
        size,
        sha256: hash,
        transferPort: this.statusValue.port ?? this.settings().transferPort,
        transferToken: token,
        expiresAt,
      });
      this.logger.info('TRANSFER', `Transfer request sent: ${fileName} (${size} bytes)`);
      return record;
    } catch (error) {
      record = { ...record, state: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() };
      this.save(record);
      throw error;
    }
  }

  registerIncoming(peerId: string, payload: Record<string, unknown>): TransferRecord {
    const parsed = this.parseRequest(payload);
    if (parsed.expiresAt < Date.now()) throw new Error('Transfer request expired');
    const existing = this.store.findTransfer(parsed.transferId);
    if (existing) return existing;
    const now = Date.now();
    const record: TransferRecord = {
      transferId: parsed.transferId,
      peerId,
      direction: 'incoming',
      fileName: parsed.fileName,
      mimeType: parsed.mimeType,
      size: parsed.size,
      sha256: parsed.sha256,
      state: 'pending',
      bytesTransferred: 0,
      speed: 0,
      remainingTime: null,
      createdAt: now,
      updatedAt: now,
    };
    const address = this.peerAddress(peerId);
    if (!address) throw new Error('Peer address unavailable');
    this.incoming.set(parsed.transferId, {
      transferId: parsed.transferId,
      peerId,
      address,
      transferPort: parsed.transferPort,
      token: parsed.transferToken,
      finalPath: '',
      partPath: '',
      request: null,
      intentionalStop: null,
    });
    this.save(record);
    this.logger.info('TRANSFER', `Incoming request: ${record.fileName} (${record.size} bytes)`);
    this.emit('incoming', record);
    return record;
  }

  async accept(transferId: string): Promise<void> {
    const record = this.requireIncomingRecord(transferId);
    const context = this.requireIncomingContext(transferId);
    if (this.activeDownloads >= LIMITS.concurrentTransfers) throw new Error('Concurrent transfer limit reached');
    if (!context.finalPath) {
      const destination = await safeDestination(this.settings().downloadFolder, record.fileName);
      context.finalPath = destination.finalPath;
      context.partPath = destination.partPath;
    }
    this.send(record.peerId, 'transfer_accept', { transferId, offset: 0 });
    this.save({ ...record, localPath: context.finalPath, state: 'accepted', updatedAt: Date.now() });
    await this.download(transferId);
  }

  reject(transferId: string): void {
    const record = this.requireIncomingRecord(transferId);
    this.send(record.peerId, 'transfer_reject', { transferId, reason: 'user_rejected' });
    this.save({ ...record, state: 'rejected', updatedAt: Date.now() });
    this.incoming.delete(transferId);
  }

  pause(transferId: string): void {
    const context = this.requireIncomingContext(transferId);
    const record = this.requireIncomingRecord(transferId);
    context.intentionalStop = 'pause';
    context.request?.destroy();
    this.send(record.peerId, 'transfer_pause', { transferId });
    this.save({ ...record, state: 'paused', updatedAt: Date.now() });
  }

  async resume(transferId: string): Promise<void> {
    const record = this.requireIncomingRecord(transferId);
    if (record.state !== 'paused' && record.state !== 'failed') throw new Error('Transfer is not paused');
    const context = this.requireIncomingContext(transferId);
    context.intentionalStop = null;
    context.address = this.peerAddress(record.peerId) ?? context.address;
    const offset = context.partPath && existsSync(context.partPath) ? (await stat(context.partPath)).size : 0;
    this.send(record.peerId, 'transfer_resume', { transferId, offset });
    await this.download(transferId);
  }

  async cancel(transferId: string): Promise<void> {
    const record = this.store.findTransfer(transferId);
    if (!record) throw new Error('Transfer not found');
    const context = this.incoming.get(transferId);
    if (context) {
      context.intentionalStop = 'cancel';
      context.request?.destroy();
      if (context.partPath) await unlink(context.partPath).catch(() => undefined);
      this.incoming.delete(transferId);
    }
    this.outgoing.delete(transferId);
    this.send(record.peerId, 'transfer_cancel', { transferId });
    this.save({ ...record, state: 'cancelled', updatedAt: Date.now() });
  }

  handleControl(peerId: string, envelope: Envelope): void {
    const transferId = typeof envelope.payload.transferId === 'string' ? envelope.payload.transferId : '';
    if (!transferId) return;
    const record = this.store.findTransfer(transferId);
    switch (envelope.type) {
      case 'transfer_accept': {
        const source = this.outgoing.get(transferId);
        if (!source || source.peerId !== peerId || !record) return;
        source.accepted = true;
        this.save({ ...record, state: 'accepted', updatedAt: Date.now() });
        break;
      }
      case 'transfer_reject':
        if (record) this.save({ ...record, state: 'rejected', updatedAt: Date.now() });
        this.outgoing.delete(transferId);
        break;
      case 'transfer_progress':
        if (record && record.peerId === peerId) {
          const bytes = this.number(payloadValue(envelope, 'bytesTransferred'), 0, record.size);
          const speed = this.number(payloadValue(envelope, 'speed'), 0, Number.MAX_SAFE_INTEGER);
          const remainingRaw = payloadValue(envelope, 'remainingTime');
          const remainingTime = typeof remainingRaw === 'number' && Number.isFinite(remainingRaw) ? Math.max(0, Math.floor(remainingRaw)) : null;
          this.save({ ...record, state: 'transferring', bytesTransferred: bytes, speed, remainingTime, updatedAt: Date.now() });
        }
        break;
      case 'transfer_pause':
        if (record) this.save({ ...record, state: 'paused', updatedAt: Date.now() });
        break;
      case 'transfer_resume':
        if (record) this.save({ ...record, state: 'transferring', updatedAt: Date.now() });
        break;
      case 'transfer_cancel': {
        if (record) this.save({ ...record, state: 'cancelled', updatedAt: Date.now() });
        const context = this.incoming.get(transferId);
        if (context) {
          context.intentionalStop = 'cancel';
          context.request?.destroy();
          if (context.partPath) void unlink(context.partPath).catch(() => undefined);
          this.incoming.delete(transferId);
        }
        this.outgoing.delete(transferId);
        break;
      }
      case 'transfer_complete':
        if (record && envelope.payload.sha256 === record.sha256 && Number(envelope.payload.size) === record.size) {
          this.save({ ...record, state: 'completed', bytesTransferred: record.size, speed: 0, remainingTime: 0, updatedAt: Date.now() });
          this.outgoing.delete(transferId);
        }
        break;
      case 'transfer_error':
        if (record) this.save({ ...record, state: 'failed', error: String(envelope.payload.message ?? 'Transfer failed'), updatedAt: Date.now() });
        break;
      default:
        break;
    }
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const remote = request.socket.remoteAddress ?? 'unknown';
      if (!this.allowRequest(remote)) { response.writeHead(429, { 'Retry-After': '60' }).end(); return; }
      if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end(); return; }
      const pathname = new URL(request.url ?? '/', 'http://lanvia.local').pathname;
      const match = /^\/v1\/transfers\/([0-9a-f-]{36})$/i.exec(pathname);
      if (!match?.[1]) { response.writeHead(404).end(); return; }
      const transferId = match[1];
      const source = this.outgoing.get(transferId);
      if (!source) { response.writeHead(404).end(); return; }
      if (!source.accepted && source.expiresAt < Date.now()) { response.writeHead(410).end(); this.outgoing.delete(transferId); return; }
      if (!source.accepted) { response.writeHead(403).end(); return; }
      if (request.headers['x-lanvia-receiver'] !== source.peerId) { response.writeHead(403).end(); return; }
      const supplied = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!this.safeTokenEqual(supplied, source.token)) { response.writeHead(401).end(); return; }
      const fileInfo = await stat(source.filePath);
      if (!fileInfo.isFile() || fileInfo.size !== source.size) { response.writeHead(410).end(); return; }
      let start = 0;
      const range = request.headers.range;
      if (range) {
        const rangeMatch = /^bytes=(\d+)-$/.exec(range);
        if (!rangeMatch?.[1]) { response.writeHead(416, { 'Content-Range': `bytes */${source.size}` }).end(); return; }
        start = Number(rangeMatch[1]);
        if (!Number.isSafeInteger(start) || start < 0 || start >= source.size) { response.writeHead(416, { 'Content-Range': `bytes */${source.size}` }).end(); return; }
      }
      const headers: Record<string, string | number> = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': source.size - start,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      if (start > 0) headers['Content-Range'] = `bytes ${start}-${source.size - 1}/${source.size}`;
      response.writeHead(start > 0 ? 206 : 200, headers);
      const stream = createReadStream(source.filePath, { start });
      stream.on('error', (error) => { this.logger.warn('TRANSFER', `Source read failed: ${error.message}`); response.destroy(error); });
      request.on('aborted', () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      this.logger.warn('TRANSFER', `HTTP transfer request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  }

  private async download(transferId: string): Promise<void> {
    const context = this.requireIncomingContext(transferId);
    let record = this.requireIncomingRecord(transferId);
    const existing = context.partPath && existsSync(context.partPath) ? (await stat(context.partPath)).size : 0;
    if (existing > record.size) throw new Error('Partial file exceeds expected size');
    if (existing === record.size) {
      if (!existsSync(context.partPath)) await writeFile(context.partPath, Buffer.alloc(0));
      await this.verifyAndFinalize(context, record); return;
    }
    this.activeDownloads += 1;
    context.intentionalStop = null;
    record = { ...record, state: 'transferring', bytesTransferred: existing, updatedAt: Date.now() };
    this.save(record);
    const startedAt = Date.now();
    let bytes = existing;
    let lastReportAt = startedAt;
    let lastReportBytes = existing;

    try {
      await new Promise<void>((resolve, reject) => {
        const host = context.address.includes(':') && !context.address.startsWith('[') ? `[${context.address}]` : context.address;
        const headers: Record<string, string> = {
          Authorization: `Bearer ${context.token}`,
          'X-LANVIA-Receiver': this.store.identity.deviceId,
        };
        if (existing > 0) headers.Range = `bytes=${existing}-`;
        const request = http.get({ hostname: host.replace(/^\[|\]$/g, ''), port: context.transferPort, path: `/v1/transfers/${transferId}`, headers, timeout: TIMEOUTS_MS.httpIdle }, (response) => {
          const expectedStatus = existing > 0 ? 206 : 200;
          if (response.statusCode !== expectedStatus) { response.resume(); reject(new Error(`Transfer HTTP status ${response.statusCode ?? 'unknown'}`)); return; }
          const output = createWriteStream(context.partPath, { flags: existing > 0 ? 'a' : 'w' });
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            const now = Date.now();
            if (now - lastReportAt >= INTERVALS_MS.progressNotification) {
              const speed = Math.round(((bytes - lastReportBytes) * 1000) / Math.max(1, now - lastReportAt));
              const remainingTime = speed > 0 ? Math.ceil((record.size - bytes) / speed) : null;
              record = { ...record, bytesTransferred: bytes, speed, remainingTime, updatedAt: now };
              this.save(record);
              this.send(record.peerId, 'transfer_progress', { transferId, bytesTransferred: bytes, totalBytes: record.size, speed, remainingTime });
              lastReportAt = now;
              lastReportBytes = bytes;
            }
          });
          response.once('error', reject);
          output.once('error', reject);
          output.once('finish', resolve);
          response.pipe(output);
        });
        context.request = request;
        request.once('timeout', () => request.destroy(new Error('Transfer idle timeout')));
        request.once('error', reject);
      });
      if (bytes !== record.size) throw new Error(`Received ${bytes} of ${record.size} bytes`);
      record = { ...record, state: 'verifying', bytesTransferred: bytes, speed: 0, remainingTime: 0, updatedAt: Date.now() };
      this.save(record);
      await this.verifyAndFinalize(context, record);
      const elapsed = Math.max(1, Date.now() - startedAt);
      this.logger.info('TRANSFER', `Received ${record.fileName} in ${(elapsed / 1000).toFixed(1)}s`);
    } catch (error) {
      const stopped = context.intentionalStop;
      if (!stopped) {
        const message = error instanceof Error ? error.message : String(error);
        this.save({ ...record, state: 'failed', error: message, bytesTransferred: bytes, updatedAt: Date.now() });
        this.send(record.peerId, 'transfer_error', { transferId, code: 'internal_error', message, retryable: true });
        this.logger.error('TRANSFER', `${record.fileName} failed: ${message}`);
        throw error;
      }
    } finally {
      context.request = null;
      this.activeDownloads = Math.max(0, this.activeDownloads - 1);
    }
  }

  private async verifyAndFinalize(context: IncomingContext, record: TransferRecord): Promise<void> {
    const actual = await sha256File(context.partPath);
    if (actual !== record.sha256) {
      const failed = { ...record, state: 'failed' as const, error: 'SHA-256 integrity verification failed', updatedAt: Date.now() };
      this.save(failed);
      this.send(record.peerId, 'transfer_error', { transferId: record.transferId, code: 'hash_mismatch', message: failed.error, retryable: true });
      throw new Error(failed.error);
    }
    await finalizePart(context.partPath, context.finalPath);
    this.save({ ...record, localPath: context.finalPath, state: 'completed', bytesTransferred: record.size, speed: 0, remainingTime: 0, updatedAt: Date.now() });
    this.send(record.peerId, 'transfer_complete', { transferId: record.transferId, sha256: actual, size: record.size });
    this.incoming.delete(record.transferId);
  }

  private parseRequest(payload: Record<string, unknown>): TransferRequestPayload {
    const result: TransferRequestPayload = {
      transferId: String(payload.transferId ?? ''),
      fileName: String(payload.fileName ?? ''),
      mimeType: String(payload.mimeType ?? 'application/octet-stream'),
      size: Number(payload.size),
      sha256: String(payload.sha256 ?? ''),
      transferPort: Number(payload.transferPort),
      transferToken: String(payload.transferToken ?? ''),
      expiresAt: Number(payload.expiresAt),
    };
    if (!/^[0-9a-f-]{36}$/i.test(result.transferId) || !result.fileName || result.fileName.length > 255 || result.mimeType.length > 200 || !Number.isSafeInteger(result.size) || result.size < 0 || result.size > LIMITS.fileBytes || !/^[0-9a-f]{64}$/.test(result.sha256) || !Number.isInteger(result.transferPort) || result.transferPort < 1 || result.transferPort > 65535 || result.transferToken.length < 20 || result.transferToken.length > 200 || !Number.isSafeInteger(result.expiresAt)) {
      throw new Error('Invalid transfer request');
    }
    return result;
  }

  private save(record: TransferRecord): void { this.store.saveTransfer(record); this.emit('changed'); }
  private requireIncomingRecord(id: string): TransferRecord {
    const record = this.store.findTransfer(id);
    if (!record || record.direction !== 'incoming') throw new Error('Incoming transfer not found');
    return record;
  }
  private requireIncomingContext(id: string): IncomingContext {
    const context = this.incoming.get(id);
    if (!context) throw new Error('Transfer session expired; ask the sender to retry');
    return context;
  }
  private listen(server: http.Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    });
  }

  private allowRequest(address: string): boolean {
    const now = Date.now();
    const current = this.requestRates.get(address);
    if (!current || now - current.startedAt >= 60_000) { this.requestRates.set(address, { startedAt: now, count: 1 }); return true; }
    current.count += 1;
    return current.count <= LIMITS.requestsPerMinute;
  }
  private safeTokenEqual(a: string, b: string): boolean {
    const left = Buffer.from(a); const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  private number(value: unknown, min: number, max: number): number {
    const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : min;
  }
}

function payloadValue(envelope: Envelope, key: string): unknown { return envelope.payload[key]; }
