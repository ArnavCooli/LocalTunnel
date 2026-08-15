import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 5;

/** Fields we refuse to write to disk even if a caller passes them. */
const REDACTED = new Set(['token', 'adminToken', 'privateKey', 'keyPem', 'password', 'secret']);

export interface LogRecord {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  [key: string]: unknown;
}

export class Logger {
  private file: string | null;
  private minLevel: number;

  constructor(
    private scope: string,
    options: { file?: string | null; level?: LogLevel } = {},
  ) {
    this.file = options.file ?? null;
    this.minLevel = LEVELS[options.level ?? 'info'];
  }

  child(scope: string): Logger {
    const logger = new Logger(`${this.scope}.${scope}`);
    logger.file = this.file;
    logger.minLevel = this.minLevel;
    return logger;
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.write('error', msg, fields);
  }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < this.minLevel) return;
    const record: LogRecord = { ts: new Date().toISOString(), level, scope: this.scope, msg };
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        record[key] = REDACTED.has(key) ? '[redacted]' : value;
      }
    }
    const line = JSON.stringify(record);
    // journald captures stdout; the file is for the desktop app's log viewer.
    process.stdout.write(`${line}\n`);
    if (this.file) this.appendRotating(line);
  }

  private appendRotating(line: string): void {
    try {
      mkdirSync(dirname(this.file!), { recursive: true });
      try {
        if (statSync(this.file!).size > MAX_BYTES) this.rotate();
      } catch {
        /* file does not exist yet */
      }
      appendFileSync(this.file!, `${line}\n`);
    } catch {
      /* never let logging take the gateway down */
    }
  }

  private rotate(): void {
    const dir = dirname(this.file!);
    const base = this.file!.slice(dir.length + 1);
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      try {
        renameSync(join(dir, `${base}.${i}`), join(dir, `${base}.${i + 1}`));
      } catch {
        /* nothing to rotate at this index */
      }
    }
    try {
      renameSync(this.file!, join(dir, `${base}.1`));
    } catch {
      /* ignore */
    }
  }
}

export function createRootLogger(file: string | null, level: LogLevel = 'info'): Logger {
  return new Logger('gateway', { file, level });
}
