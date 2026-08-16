/**
 * The drawing layer: colours, the alternate screen, and one keypress reader.
 *
 * Everything here writes to the terminal directly rather than through a widget
 * library, so the CLI has no dependencies the agent does not already have and
 * ships as plain Node.
 */

const NO_COLOR =
  Boolean(process.env.NO_COLOR) || process.env.TERM === 'dumb' || !process.stdout.isTTY;

function paint(open: string, close = '\x1b[39m') {
  return (text: string): string => (NO_COLOR ? text : `${open}${text}${close}`);
}

export const color = {
  bold: paint('\x1b[1m', '\x1b[22m'),
  dim: paint('\x1b[2m', '\x1b[22m'),
  underline: paint('\x1b[4m', '\x1b[24m'),
  red: paint('\x1b[31m'),
  green: paint('\x1b[32m'),
  yellow: paint('\x1b[33m'),
  blue: paint('\x1b[34m'),
  magenta: paint('\x1b[35m'),
  cyan: paint('\x1b[36m'),
  gray: paint('\x1b[90m'),
  inverse: paint('\x1b[7m', '\x1b[27m'),
};

export const isTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);

export function columns(): number {
  return Math.max(40, Math.min(process.stdout.columns || 80, 120));
}

export function rows(): number {
  return Math.max(10, process.stdout.rows || 24);
}

/** Printable width, ignoring escape sequences. */
export function width(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function truncate(text: string, max: number): string {
  if (width(text) <= max) return text;
  if (max <= 1) return '…';
  // Slicing a coloured string would cut an escape sequence in half, so only
  // plain text is truncated; callers colour after truncating.
  return `${text.slice(0, max - 1)}…`;
}

export function pad(text: string, size: number): string {
  const missing = size - width(text);
  return missing > 0 ? text + ' '.repeat(missing) : text;
}

/* ------------------------------------------------------------------ screen */

let alternate = false;

export function enterAlternateScreen(): void {
  if (!isTty || alternate) return;
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  alternate = true;
}

export function leaveAlternateScreen(): void {
  if (!alternate) return;
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  alternate = false;
}

export function clear(): void {
  if (!isTty) return;
  process.stdout.write('\x1b[2J\x1b[H');
}

/** Draw a whole frame at once, so redrawing on every keypress does not flicker. */
export function draw(lines: string[]): void {
  if (!isTty) {
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }
  const visible = lines.slice(0, rows() - 1);
  process.stdout.write(`\x1b[H\x1b[2J${visible.join('\r\n')}`);
}

export function write(text: string): void {
  process.stdout.write(text);
}

/* --------------------------------------------------------------- keyboard */

export interface Key {
  name: string;
  ctrl: boolean;
  raw: string;
}

type KeyHandler = (key: Key) => void;

let listeners: KeyHandler[] = [];
let keyboardActive = false;
/** Re-armed on every startKeyboard, so suspending for ssh cannot disarm Ctrl-C. */
let exitGuard: KeyHandler | null = null;

function decode(raw: string): Key {
  const ctrl = raw.length === 1 && raw.charCodeAt(0) < 27 && raw !== '\r' && raw !== '\n' && raw !== '\t';
  const named: Record<string, string> = {
    '\x1b[A': 'up',
    '\x1bOA': 'up',
    '\x1b[B': 'down',
    '\x1bOB': 'down',
    '\x1b[C': 'right',
    '\x1bOC': 'right',
    '\x1b[D': 'left',
    '\x1bOD': 'left',
    '\x1b[H': 'home',
    '\x1b[F': 'end',
    '\x1b[5~': 'pageup',
    '\x1b[6~': 'pagedown',
    '\x1b[3~': 'delete',
    '\r': 'return',
    '\n': 'return',
    '\t': 'tab',
    '\x1b': 'escape',
    '\x7f': 'backspace',
    '\b': 'backspace',
    ' ': 'space',
    '\x03': 'ctrl-c',
    '\x04': 'ctrl-d',
    '\x15': 'ctrl-u',
    '\x17': 'ctrl-w',
  };
  const name = named[raw] ?? (raw.length === 1 ? raw : 'unknown');
  return { name, ctrl, raw };
}

export function startKeyboard(): void {
  if (keyboardActive || !isTty) return;
  keyboardActive = true;
  if (exitGuard) listeners.push(exitGuard);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    // A paste or a fast arrow key can arrive as several sequences in one chunk.
    const parts = chunk.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/g) ?? [];
    for (const part of parts) {
      const key = decode(part);
      for (const listener of [...listeners]) listener(key);
    }
  });
}

export function stopKeyboard(): void {
  if (!keyboardActive) return;
  keyboardActive = false;
  listeners = [];
  process.stdin.removeAllListeners('data');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}

/** Resolve on the next keypress; the caller decides whether to keep listening. */
export function onKey(handler: KeyHandler): () => void {
  startKeyboard();
  listeners.push(handler);
  return () => {
    listeners = listeners.filter((l) => l !== handler);
  };
}

export function nextKey(): Promise<Key> {
  return new Promise((resolve) => {
    const off = onKey((key) => {
      off();
      resolve(key);
    });
  });
}

/**
 * Hand the terminal back to a child process — ssh, and its password prompts —
 * then take it again. Raw mode and the alternate screen would both swallow a
 * passphrase prompt, so neither can be left in place while ssh runs.
 */
export async function suspend<T>(work: () => Promise<T>): Promise<T> {
  const wasAlternate = alternate;
  stopKeyboard();
  leaveAlternateScreen();
  try {
    return await work();
  } finally {
    if (wasAlternate) enterAlternateScreen();
    startKeyboard();
  }
}

/** Ctrl-C anywhere leaves the terminal the way we found it. */
export function installExitGuard(): void {
  const bail = () => {
    stopKeyboard();
    leaveAlternateScreen();
    process.exit(0);
  };
  exitGuard = (key: Key) => {
    if (key.name === 'ctrl-c') bail();
  };
  onKey(exitGuard);
  process.on('SIGINT', bail);
  process.on('SIGTERM', bail);
  process.on('exit', () => {
    stopKeyboard();
    leaveAlternateScreen();
  });
}
