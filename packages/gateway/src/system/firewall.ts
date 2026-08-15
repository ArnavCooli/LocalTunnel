import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '../main/log.js';

const run = promisify(execFile);

export type FirewallBackend = 'ufw' | 'firewalld' | 'nftables' | 'none';

/**
 * Opens and closes public ports so the user never has to touch a firewall after
 * install.
 *
 * Every call goes through execFile with an argument array — no shell, ever — and
 * the port is validated as an integer in range first. This is the only place in the
 * gateway that runs an external command, and it is deliberately the narrowest
 * possible surface.
 */
export class Firewall {
  private backend: FirewallBackend | null = null;

  constructor(
    private readonly log: Logger,
    private readonly enabled: boolean,
  ) {}

  async detect(): Promise<FirewallBackend> {
    if (this.backend) return this.backend;
    if (!this.enabled) return (this.backend = 'none');
    for (const [command, backend] of [
      ['ufw', 'ufw'],
      ['firewall-cmd', 'firewalld'],
      ['nft', 'nftables'],
    ] as const) {
      try {
        await run('which', [command]);
        this.backend = backend;
        this.log.info('firewall backend detected', { backend });
        return backend;
      } catch {
        /* try the next one */
      }
    }
    this.log.info('no supported firewall found; skipping firewall management');
    return (this.backend = 'none');
  }

  async openPort(port: number, proto: 'tcp' | 'udp'): Promise<boolean> {
    return this.change('open', port, proto);
  }

  async closePort(port: number, proto: 'tcp' | 'udp'): Promise<boolean> {
    return this.change('close', port, proto);
  }

  private async change(action: 'open' | 'close', port: number, proto: 'tcp' | 'udp'): Promise<boolean> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RangeError(`refusing to change firewall for invalid port ${port}`);
    }
    if (proto !== 'tcp' && proto !== 'udp') {
      throw new RangeError(`refusing to change firewall for invalid protocol ${proto}`);
    }

    const backend = await this.detect();
    if (backend === 'none') return false;

    const rule = `${port}/${proto}`;
    try {
      if (backend === 'ufw') {
        await run('ufw', [action === 'open' ? 'allow' : 'delete', ...(action === 'open' ? [rule] : ['allow', rule])]);
      } else if (backend === 'firewalld') {
        await run('firewall-cmd', [
          action === 'open' ? `--add-port=${rule}` : `--remove-port=${rule}`,
          '--permanent',
        ]);
        await run('firewall-cmd', ['--reload']);
      } else {
        await run('nft', [
          action === 'open' ? 'add' : 'delete',
          'rule',
          'inet',
          'filter',
          'input',
          proto,
          'dport',
          String(port),
          'accept',
        ]);
      }
      this.log.info('firewall rule changed', { action, port, proto, backend });
      return true;
    } catch (err) {
      this.log.warn('firewall change failed', {
        action,
        port,
        proto,
        backend,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
