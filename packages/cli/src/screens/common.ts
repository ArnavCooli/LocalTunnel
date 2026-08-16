import { Config, connectionOf, type GatewayProfile } from '../config.js';
import type { GatewayConnection, ServiceView } from '../gateway.js';
import { color } from '../tui/render.js';
import { badge, page, task, type Chrome } from '../tui/prompts.js';

/** Everything a screen needs: the config file and whichever gateway is active. */
export class Ctx {
  readonly config: Config;

  constructor(config = new Config()) {
    this.config = config;
  }

  get gateway(): GatewayProfile | null {
    return this.config.active();
  }

  /** The active gateway's connection details, or an error the user can act on. */
  connection(): GatewayConnection {
    const gateway = this.gateway;
    if (!gateway) throw new Error('No gateway is set up yet. Choose "Gateways" to add one.');
    return connectionOf(gateway);
  }
}

/** Run work behind a spinner and show any failure as a page rather than a stack trace. */
export async function attempt<T>(
  chrome: Chrome & { label: string },
  work: () => Promise<T>,
): Promise<T | null> {
  try {
    return await task(chrome, work);
  } catch (err) {
    await page({
      ...chrome,
      error: err instanceof Error ? err.message : String(err),
      body: [color.gray('Nothing was changed.')],
    });
    return null;
  }
}

export function serviceStatusBadge(service: ServiceView): string {
  switch (service.status) {
    case 'online':
      return badge('online', 'ok');
    case 'disabled':
      return badge('paused', 'idle');
    case 'machine_offline':
      return badge('machine offline', 'bad');
    case 'local_unreachable':
      return badge('local app down', 'warn');
    default:
      return badge(service.status, 'warn');
  }
}

export function serviceTarget(service: ServiceView): string {
  return `${service.localHost}:${service.localPort}`;
}

export function servicePublic(service: ServiceView, publicIp?: string): string {
  if (service.publicUrl) return service.publicUrl;
  if (service.hostname) return `https://${service.hostname}`;
  if (service.publicPort) return `${publicIp ?? 'your gateway'}:${service.publicPort}`;
  return '—';
}

export function certBadge(state: string | undefined): string {
  switch (state) {
    case 'valid':
      return badge('valid', 'ok');
    case 'pending':
      return badge('being issued', 'warn');
    case 'error':
      return badge('failed', 'bad');
    default:
      return badge('none', 'idle');
  }
}
