import { agent } from '../agent.js';
import { gatewayApi, type GatewayStatus } from '../gateway.js';
import { color } from '../tui/render.js';
import { CANCEL, badge, bytes, duration, keyValue, page, select } from '../tui/prompts.js';
import { Ctx, servicePublic } from './common.js';
import { computerScreen, connectComputer } from './computer.js';
import { diagnosticsScreen } from './diagnostics.js';
import { domainsScreen } from './domains.js';
import { gatewaysScreen } from './gateways.js';
import { machinesScreen } from './machines.js';
import { servicesScreen } from './services.js';

/**
 * The home screen: what state everything is in, and where to go next.
 *
 * The menu changes with the situation — with no gateway it offers to add one, with
 * no enrolled machine it offers to connect this computer — so there is only ever
 * one obvious next step.
 */

export async function homeScreen(ctx: Ctx): Promise<void> {
  for (;;) {
    const gateway = ctx.gateway;

    let status: GatewayStatus | null = null;
    let gatewayError: string | null = null;
    if (gateway) {
      try {
        status = await gatewayApi.status(ctx.connection());
      } catch (err) {
        gatewayError = err instanceof Error ? err.message : String(err);
      }
    }

    const running = await agent.running();
    const local = running ? await agent.status().catch(() => null) : null;

    const items: { value: string; label: string; badge?: string; hint?: string }[] = [];

    if (!gateway) {
      items.push({ value: 'gateways', label: 'Add a gateway', hint: 'The server your traffic goes through' });
    } else if (!local?.machineId) {
      items.push({ value: 'connect', label: 'Connect this computer', hint: `Enrol with ${gateway.name || gateway.host}` });
    }

    if (gateway) {
      items.push({
        value: 'services',
        label: 'Services',
        badge: status ? summaryBadge(status) : '',
        hint: 'Everything you have put on the internet',
      });
      items.push({
        value: 'computer',
        label: 'This computer',
        badge: agentBadge(running, local?.state ?? null),
        hint: 'The agent, the tunnel, start at login',
      });
      items.push({ value: 'machines', label: 'Machines', hint: 'Every computer enrolled with this gateway' });
      items.push({ value: 'domains', label: 'Domains and certificates', hint: 'HTTPS and the DNS records behind it' });
      items.push({ value: 'diagnostics', label: 'Diagnose a problem', hint: 'Checks every link and names the broken one' });
    }

    items.push({ value: 'gateways', label: 'Gateways', hint: gateway ? `Active: ${gateway.name || gateway.host}` : 'None yet' });
    items.push({ value: 'refresh', label: 'Refresh' });
    items.push({ value: 'quit', label: 'Quit' });

    const choice = await select<string>({
      title: gateway ? gateway.name || gateway.host : 'Welcome to LocalTunnel',
      subtitle: headline(gateway !== null, status, gatewayError, running, local?.state ?? null),
      body: overview(status, gatewayError),
      filterable: false,
      cancelLabel: 'quit',
      hints: [`${color.bold('q')} quit`],
      items: dedupeGateways(items),
    });

    if (choice === CANCEL || choice === 'quit') return;

    switch (choice) {
      case 'connect':
        await connectComputer(ctx);
        break;
      case 'services':
        await servicesScreen(ctx);
        break;
      case 'computer':
        await computerScreen(ctx);
        break;
      case 'machines':
        await machinesScreen(ctx);
        break;
      case 'domains':
        await domainsScreen(ctx);
        break;
      case 'diagnostics':
        await diagnosticsScreen(ctx);
        break;
      case 'gateways':
        await gatewaysScreen(ctx);
        break;
      case 'refresh':
        break;
      default:
        await page({ title: 'Not implemented', error: `Unknown action ${choice}.` });
    }
  }
}

/** "Add a gateway" and the Gateways entry collapse into one when there is none. */
function dedupeGateways<T extends { value: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.value !== 'gateways') return true;
    if (seen.has('gateways')) return false;
    seen.add('gateways');
    return true;
  });
}

function headline(
  hasGateway: boolean,
  status: GatewayStatus | null,
  error: string | null,
  running: boolean,
  state: string | null,
): string {
  if (!hasGateway) return 'Put a site on your home computer onto the public internet.';
  if (error) return 'The gateway could not be reached.';
  if (!status) return '';
  const online = status.services.filter((s) => s.status === 'online').length;
  if (status.services.length === 0) return 'The gateway is up. Nothing is published yet.';
  if (!running || state !== 'connected') return `${online} of ${status.services.length} services online.`;
  return online === status.services.length
    ? `All ${online} service(s) online.`
    : `${online} of ${status.services.length} services online.`;
}

function overview(status: GatewayStatus | null, error: string | null): string[] {
  if (error) {
    return [
      color.red(`✗ ${error}`),
      '',
      color.gray('The server may be off, or TCP 443 may be closed in your provider\'s firewall.'),
    ];
  }
  if (!status) {
    return [
      color.gray('You rent one small VPS, LocalTunnel installs a gateway on it, and this'),
      color.gray('computer dials out to it and holds the connection open. No port'),
      color.gray('forwarding, and it works behind CGNAT.'),
    ];
  }

  const lines = keyValue([
    ['Gateway', `${badge('up', 'ok')} ${color.gray(`${status.gateway.publicIp} · ${status.gateway.version} · up ${duration(status.gateway.uptimeSeconds)}`)}`],
    ['Machines', `${status.machines.filter((m) => m.connected).length} connected of ${status.machines.length}`],
    ['Traffic', `${bytes(status.gateway.totals.bytesIn)} in · ${bytes(status.gateway.totals.bytesOut)} out`],
  ]);

  const live = status.services.filter((s) => s.status === 'online').slice(0, 4);
  if (live.length) {
    lines.push('');
    for (const service of live) {
      lines.push(
        `${color.green('●')} ${color.cyan(servicePublic(service, status.gateway.publicIp))} ${color.dim('→')} ${color.gray(
          `${service.localHost}:${service.localPort}`,
        )}`,
      );
    }
  }

  const broken = status.services.filter((s) => s.status === 'local_unreachable' || s.status === 'machine_offline');
  if (broken.length) {
    lines.push('');
    for (const service of broken.slice(0, 3)) {
      lines.push(`${color.red('●')} ${service.name} ${color.gray(`— ${service.localError ?? 'machine offline'}`)}`);
    }
  }

  return lines;
}

function summaryBadge(status: GatewayStatus): string {
  const online = status.services.filter((s) => s.status === 'online').length;
  if (status.services.length === 0) return color.gray('none yet');
  if (online === status.services.length) return badge(`${online} online`, 'ok');
  return badge(`${online}/${status.services.length} online`, 'warn');
}

function agentBadge(running: boolean, state: string | null): string {
  if (!running) return badge('stopped', 'bad');
  if (state === 'connected') return badge('connected', 'ok');
  if (state === 'idle' || state === null) return badge('idle', 'idle');
  if (state === 'revoked' || state === 'error') return badge(state, 'bad');
  return badge(state, 'warn');
}
