import { EventEmitter } from 'node:events';
import type { LogEntry } from '../shared/types/models';

type Scope = LogEntry['scope'];
type Level = LogEntry['level'];

export class Logger extends EventEmitter {
  private readonly entries: LogEntry[] = [];
  private readonly maxEntries = 1000;

  log(scope: Scope, level: Level, message: string): void {
    const sanitized = message.replace(/(trustToken|transferToken|Authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]');
    const entry: LogEntry = { timestamp: Date.now(), scope, level, message: sanitized };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    method(`[${scope}] ${sanitized}`);
    this.emit('entry', entry);
  }

  info(scope: Scope, message: string): void { this.log(scope, 'info', message); }
  warn(scope: Scope, message: string): void { this.log(scope, 'warn', message); }
  error(scope: Scope, message: string): void { this.log(scope, 'error', message); }
  debug(scope: Scope, message: string): void { this.log(scope, 'debug', message); }

  exportText(): string {
    return this.entries.map((entry) => `${new Date(entry.timestamp).toISOString()} [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}`).join('\n');
  }
}
