import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs';
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

  /**
   * Append without touching the event loop.
   *
   * This used to mkdir + stat + appendFileSync on every single line, which is
   * three blocking syscalls per log write on a process whose whole job is
   * forwarding bytes. The stream is opened once, the size is tracked in memory,
   * and rotation only stats when the counter says it might be due.
   */
  private appendRotating(line: string): void {
    try {
      const sink = this.sink();
      if (!sink) return;
      sink.stream.write(`${line}\n`);
      sink.size += line.length + 1;
      if (sink.size > MAX_BYTES) this.rotate();
    } catch {
      /* never let logging take the gateway down */
    }
  }

  private sink(): FileSink | null {
    const file = this.file;
    if (!file) return null;
    let sink = SINKS.get(file);
    if (sink) return sink;
    mkdirSync(dirname(file), { recursive: true });
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      /* file does not exist yet */
    }
    const stream = createWriteStream(file, { flags: 'a', mode: 0o600 });
    stream.on('error', () => SINKS.delete(file));
    sink = { stream, size };
    SINKS.set(file, sink);
    return sink;
  }

  private rotate(): void {
    const file = this.file!;
    const sink = SINKS.get(file);
    SINKS.delete(file);
    sink?.stream.end();
    const dir = dirname(file);
    const base = file.slice(dir.length + 1);
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      try {
        renameSync(join(dir, `${base}.${i}`), join(dir, `${base}.${i + 1}`));
      } catch {
        /* nothing to rotate at this index */
      }
    }
    try {
      renameSync(file, join(dir, `${base}.1`));
    } catch {
      /* ignore */
    }
  }
}

interface FileSink {
  stream: WriteStream;
  size: number;
}

/** One append stream per file, shared by every child logger writing to it. */
const SINKS = new Map<string, FileSink>();

export function createRootLogger(file: string | null, level: LogLevel = 'info'): Logger {
  return new Logger('gateway', { file, level });
}
