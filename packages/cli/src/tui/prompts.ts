import {
  color,
  columns,
  draw,
  isTty,
  nextKey,
  onKey,
  pad,
  rows,
  truncate,
  width,
} from './render.js';

/**
 * The pieces every screen is built from: an arrow-key list, a text field, a
 * yes/no question and a spinner. Each one paints the full screen, so a screen is
 * just a title, a body and one of these.
 */

export interface Chrome {
  /** Small line above the title, e.g. "Services / Add". */
  breadcrumb?: string;
  title: string;
  subtitle?: string;
  /** Lines shown between the title and the control. */
  body?: string[];
  /** Extra key hints, appended to the standard ones. */
  hints?: string[];
  /** Shown in red above the control. */
  error?: string | null;
  /** Shown in green above the control. */
  notice?: string | null;
}

export const CANCEL = Symbol('cancel');
export type Cancelled = typeof CANCEL;

function header(chrome: Chrome): string[] {
  const w = columns();
  const lines: string[] = [];
  lines.push(color.dim('─'.repeat(w)));
  const brand = color.bold(color.cyan(' LocalTunnel'));
  const crumb = chrome.breadcrumb ? color.gray(` ${chrome.breadcrumb}`) : '';
  lines.push(`${brand}${crumb}`);
  lines.push(color.dim('─'.repeat(w)));
  lines.push('');
  lines.push(` ${color.bold(chrome.title)}`);
  if (chrome.subtitle) lines.push(` ${color.gray(truncate(chrome.subtitle, w - 2))}`);
  lines.push('');
  for (const line of chrome.body ?? []) lines.push(line ? ` ${line}` : '');
  if ((chrome.body ?? []).length) lines.push('');
  if (chrome.error) lines.push(` ${color.red(`✗ ${chrome.error}`)}`, '');
  if (chrome.notice) lines.push(` ${color.green(`✓ ${chrome.notice}`)}`, '');
  return lines;
}

function footer(hints: string[]): string[] {
  const w = columns();
  return ['', color.dim('─'.repeat(w)), ` ${color.gray(hints.join(color.dim('  ·  ')))}`];
}

/* ----------------------------------------------------------------- select */

export interface Item<T> {
  value: T;
  label: string;
  /** Right-aligned status, e.g. "online". */
  badge?: string;
  /** Second line under the label. */
  hint?: string;
  disabled?: boolean;
  /** Draws a divider with this caption above the item. */
  section?: string;
}

export interface SelectOptions<T> extends Chrome {
  items: Item<T>[];
  /** Index selected when the list opens. */
  initialIndex?: number;
  /** Esc returns CANCEL instead of being ignored. Default true. */
  cancellable?: boolean;
  /** Type-to-filter. Default true when the list is longer than 8 items. */
  filterable?: boolean;
  /** What esc does here, for the footer. Default "back". */
  cancelLabel?: string;
}

export async function select<T>(options: SelectOptions<T>): Promise<T | Cancelled> {
  requireTty();
  const cancellable = options.cancellable !== false;
  const filterable = options.filterable ?? options.items.length > 8;
  let filter = '';
  let index = options.initialIndex ?? 0;
  let offset = 0;

  const visibleItems = () => {
    if (!filter) return options.items;
    const needle = filter.toLowerCase();
    return options.items.filter(
      (item) =>
        item.label.toLowerCase().includes(needle) || (item.hint ?? '').toLowerCase().includes(needle),
    );
  };

  const paint = () => {
    const items = visibleItems();
    if (index >= items.length) index = Math.max(0, items.length - 1);
    const head = header(options);
    const hints = [
      `${color.bold('↑↓')} move`,
      `${color.bold('enter')} select`,
      ...(filterable ? [`${color.bold('type')} to filter`] : []),
      ...(options.hints ?? []),
      ...(cancellable ? [`${color.bold('esc')} ${options.cancelLabel ?? 'back'}`] : []),
    ];
    const foot = footer(hints);
    const room = Math.max(3, rows() - head.length - foot.length - 3);
    // Items are one or two rows depending on whether they carry a hint, so how
    // many fit depends on which ones are on screen.
    const height = (item: Item<T>) => (item.hint ? 2 : 1) + (item.section ? 1 : 0);
    const fits = (from: number): number => {
      let used = 0;
      let count = 0;
      for (let i = from; i < items.length; i += 1) {
        used += height(items[i]!);
        if (used > room) break;
        count += 1;
      }
      return Math.max(1, count);
    };
    if (index < offset) offset = index;
    while (index >= offset + fits(offset)) offset += 1;

    const lines = [...head];
    if (filterable) {
      lines.push(` ${color.gray('filter:')} ${filter || color.dim('(type to narrow the list)')}`, '');
    }
    if (items.length === 0) {
      lines.push(` ${color.gray('Nothing matches that filter.')}`);
    }

    const w = columns();
    const capacity = fits(offset);
    items.slice(offset, offset + capacity).forEach((item, i) => {
      const active = offset + i === index;
      if (item.section) lines.push(` ${color.dim(item.section)}`);
      const marker = active ? color.cyan('❯ ') : '  ';
      const badge = item.badge ? ` ${item.badge}` : '';
      const labelRoom = w - 4 - width(badge);
      let label = pad(truncate(item.label, labelRoom), labelRoom);
      if (item.disabled) label = color.dim(label);
      else if (active) label = color.bold(color.cyan(label));
      lines.push(`${marker}${label}${badge}`);
      if (item.hint) lines.push(`  ${color.gray(truncate(item.hint, w - 4))}`);
    });
    if (offset + capacity < items.length) {
      lines.push(color.dim(`  … ${items.length - offset - capacity} more`));
    }
    draw([...lines, ...foot]);
  };

  paint();

  return new Promise<T | Cancelled>((resolve) => {
    const off = onKey((key) => {
      const items = visibleItems();
      const step = (delta: number) => {
        if (items.length === 0) return;
        let next = index;
        for (let i = 0; i < items.length; i += 1) {
          next = (next + delta + items.length) % items.length;
          if (!items[next]?.disabled) break;
        }
        index = next;
      };

      switch (key.name) {
        case 'up':
          step(-1);
          break;
        case 'down':
          step(1);
          break;
        case 'pageup':
          step(-5);
          break;
        case 'pagedown':
          step(5);
          break;
        case 'home':
          index = 0;
          break;
        case 'end':
          index = items.length - 1;
          break;
        case 'return': {
          const chosen = items[index];
          if (!chosen || chosen.disabled) break;
          off();
          resolve(chosen.value);
          return;
        }
        case 'escape':
          if (cancellable) {
            off();
            resolve(CANCEL);
            return;
          }
          break;
        case 'backspace':
          if (filterable) filter = filter.slice(0, -1);
          break;
        default:
          if (filterable && key.raw.length === 1 && key.raw >= ' ') {
            filter += key.raw;
            index = 0;
            offset = 0;
          } else if (!filterable && key.name === 'q' && cancellable) {
            off();
            resolve(CANCEL);
            return;
          }
      }
      paint();
    });
  });
}

/* ------------------------------------------------------------------ input */

export interface InputOptions extends Chrome {
  label: string;
  initial?: string;
  placeholder?: string;
  /** Hide the value, for tokens. */
  secret?: boolean;
  /** Return a message to reject the value, or null to accept it. */
  validate?: (value: string) => string | null;
  /** Enter on an empty field returns this instead of failing validation. */
  allowEmpty?: boolean;
}

export async function input(options: InputOptions): Promise<string | Cancelled> {
  requireTty();
  let value = options.initial ?? '';
  let error = options.error ?? null;

  const paint = () => {
    const shown = options.secret ? '•'.repeat(value.length) : value;
    const field = shown || color.dim(options.placeholder ?? '');
    const lines = [
      ...header({ ...options, error }),
      ` ${color.gray(options.label)}`,
      ` ${color.cyan('❯')} ${field}${color.inverse(' ')}`,
      ...footer([
        `${color.bold('enter')} confirm`,
        `${color.bold('esc')} back`,
        ...(options.hints ?? []),
      ]),
    ];
    draw(lines);
  };

  paint();

  return new Promise<string | Cancelled>((resolve) => {
    const off = onKey((key) => {
      switch (key.name) {
        case 'return': {
          const trimmed = value.trim();
          if (!trimmed && !options.allowEmpty) {
            error = 'This cannot be empty.';
            break;
          }
          const problem = options.validate?.(trimmed) ?? null;
          if (problem) {
            error = problem;
            break;
          }
          off();
          resolve(trimmed);
          return;
        }
        case 'escape':
          off();
          resolve(CANCEL);
          return;
        case 'backspace':
          value = value.slice(0, -1);
          error = null;
          break;
        case 'ctrl-u':
          value = '';
          break;
        case 'ctrl-w':
          value = value.replace(/\s*\S+\s*$/, '');
          break;
        default:
          if (key.raw.length >= 1 && key.raw >= ' ' && !key.ctrl) {
            // Pasted text arrives a character at a time through the decoder.
            value += key.raw;
            error = null;
          }
      }
      paint();
    });
  });
}

/* ---------------------------------------------------------------- confirm */

export async function confirm(
  options: Chrome & { yes?: string; no?: string; dangerous?: boolean },
): Promise<boolean | Cancelled> {
  const yes = options.yes ?? 'Yes';
  const no = options.no ?? 'No, go back';
  const choice = await select<boolean>({
    ...options,
    filterable: false,
    initialIndex: options.dangerous ? 1 : 0,
    items: [
      { value: true, label: options.dangerous ? color.red(yes) : yes },
      { value: false, label: no },
    ],
  });
  return choice;
}

/* ------------------------------------------------------------- show / wait */

/**
 * A read-only page. Scrolls when the body is taller than the terminal, so a long
 * diagnostics report is not silently cut off on an 80x24 SSH session.
 */
export async function page(options: Chrome): Promise<void> {
  requireTty();
  let offset = 0;

  const layout = () => {
    // The body is the only part that scrolls; the title block stays put.
    const chromeLines = header({ ...options, body: [] });
    const body = options.body ?? [];
    const foot = footer([]);
    const room = Math.max(3, rows() - chromeLines.length - foot.length - 1);
    return { chromeLines, body, room };
  };

  const paint = () => {
    const { chromeLines, body, room } = layout();
    const scrollable = body.length > room;
    const max = Math.max(0, body.length - room);
    if (offset > max) offset = max;
    const shown = body.slice(offset, offset + room).map((line) => (line ? ` ${line}` : ''));
    const hints = scrollable
      ? [`${color.bold('↑↓')} scroll`, `${color.bold('esc')} back`, `${color.gray(`${offset + 1}-${Math.min(body.length, offset + room)} of ${body.length}`)}`]
      : [`${color.bold('any key')} back`];
    draw([...chromeLines, ...shown, ...footer(hints)]);
    return scrollable;
  };

  const scrollable = paint();

  return new Promise<void>((resolve) => {
    const off = onKey((key) => {
      if (!scrollable) {
        off();
        resolve();
        return;
      }
      switch (key.name) {
        case 'up':
          offset = Math.max(0, offset - 1);
          break;
        case 'down':
          offset += 1;
          break;
        case 'pageup':
          offset = Math.max(0, offset - 10);
          break;
        case 'pagedown':
          offset += 10;
          break;
        case 'home':
          offset = 0;
          break;
        case 'end':
          offset = Number.MAX_SAFE_INTEGER;
          break;
        default:
          off();
          resolve();
          return;
      }
      paint();
    });
  });
}

/* --------------------------------------------------------------- spinner */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Run work behind a spinner, keeping the current screen's chrome. */
export async function task<T>(chrome: Chrome & { label: string }, work: () => Promise<T>): Promise<T> {
  if (!isTty) return work();
  let frame = 0;
  const paint = () => {
    draw([
      ...header(chrome),
      ` ${color.cyan(FRAMES[frame % FRAMES.length])} ${chrome.label}`,
      ...footer([color.gray('working…')]),
    ]);
    frame += 1;
  };
  paint();
  const timer = setInterval(paint, 90);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

function requireTty(): void {
  if (!isTty) {
    throw new Error(
      'This needs an interactive terminal. Run `localtunnel --help` for the non-interactive commands.',
    );
  }
}

/* ------------------------------------------------------------ formatting */

export function badge(text: string, kind: 'ok' | 'warn' | 'bad' | 'idle'): string {
  const dot = { ok: color.green('●'), warn: color.yellow('●'), bad: color.red('●'), idle: color.gray('○') }[kind];
  const label = { ok: color.green, warn: color.yellow, bad: color.red, idle: color.gray }[kind];
  return `${dot} ${label(text)}`;
}

export function keyValue(pairs: [string, string][]): string[] {
  const size = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${color.gray(pad(`${k}`, size))}  ${v}`);
}

export function bytes(count: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = count;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const delta = (Date.now() - Date.parse(iso)) / 1000;
  if (Number.isNaN(delta)) return 'unknown';
  if (delta < 45) return 'just now';
  return `${duration(delta)} ago`;
}
