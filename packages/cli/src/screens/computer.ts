import { hostname } from 'node:os';
import {
  agent,
  agentLogPath,
  disableAutostart,
  enableAutostart,
  ensureAgentRunning,
  type TunnelStatus,
} from '../agent.js';
import { gatewayApi } from '../gateway.js';
import { color } from '../tui/render.js';
import { CANCEL, ago, badge, bytes, confirm, keyValue, page, select } from '../tui/prompts.js';
import { Ctx, attempt } from './common.js';

/**
 * This computer: the agent that dials out to the gateway and keeps the tunnel up.
 */

const CRUMB = 'This computer';

export async function computerScreen(ctx: Ctx): Promise<void> {
  for (;;) {
    const running = await agent.running();
    const status = running ? await agent.status().catch(() => null) : null;

    const items: { value: string; label: string; hint?: string }[] = [];
    if (!running) {
      items.push({ value: 'start-agent', label: 'Start the agent', hint: 'Runs in the background, survives closing this terminal' });
    }
    if (running && !status?.machineId) {
      items.push({ value: 'connect', label: 'Connect this computer to the gateway', hint: 'Enrols this machine and gives it its own certificate' });
    }
    if (status?.machineId) {
      if (status.state === 'idle' || status.state === 'error') {
        items.push({ value: 'resume', label: 'Connect the tunnel' });
      } else {
        items.push({ value: 'pause', label: 'Pause the tunnel', hint: 'Your services go offline until you resume' });
      }
    }
    items.push({
      value: 'autostart',
      label: agent.autostartInstalled() ? 'Turn off start at login' : 'Start the agent at login',
      hint: agent.autostartInstalled() ? agent.autostartPath() : 'Installs a systemd user service',
    });
    items.push({ value: 'log', label: 'Where are the logs?' });
    if (running) {
      items.push({ value: 'stop-agent', label: 'Stop the agent', hint: 'Everything you expose goes offline' });
    }
    if (status?.machineId) {
      items.push({ value: 'disconnect', label: color.red('Disconnect from the gateway'), hint: 'Forgets the certificate; the keypair stays' });
      items.push({ value: 'reset', label: color.red('Reset this machine completely'), hint: 'Forgets the private key too' });
    }
    items.push({ value: 'back', label: '← Back' });

    const choice = await select<string>({
      breadcrumb: CRUMB,
      title: hostname(),
      subtitle: describeState(running, status),
      body: statusBody(running, status),
      filterable: false,
      items,
    });

    if (choice === CANCEL || choice === 'back') return;

    switch (choice) {
      case 'start-agent':
        await attempt({ breadcrumb: CRUMB, title: 'Starting the agent', label: 'Waiting for the agent to answer…' }, () =>
          ensureAgentRunning(),
        );
        break;
      case 'connect':
        await connectComputer(ctx);
        break;
      case 'resume':
        await attempt({ breadcrumb: CRUMB, title: hostname(), label: 'Connecting…' }, () => agent.start());
        break;
      case 'pause':
        await attempt({ breadcrumb: CRUMB, title: hostname(), label: 'Pausing…' }, () => agent.pause());
        break;
      case 'autostart':
        await toggleAutostart();
        break;
      case 'log':
        await page({
          breadcrumb: CRUMB,
          title: 'Agent logs',
          body: [
            color.gray('The background agent appends everything it does to:'),
            '',
            ` ${color.cyan(agentLogPath())}`,
            '',
            color.gray('If it was started at login by systemd, use this instead:'),
            ` ${color.cyan('journalctl --user -u localtunnel-agent -f')}`,
          ],
        });
        break;
      case 'stop-agent': {
        const yes = await confirm({
          breadcrumb: CRUMB,
          title: 'Stop the agent?',
          subtitle: 'Everything this computer exposes goes offline until it starts again.',
          dangerous: true,
          yes: 'Stop it',
        });
        if (yes === true) {
          await attempt({ breadcrumb: CRUMB, title: 'Stopping', label: 'Stopping the agent…' }, () => agent.shutdown());
        }
        break;
      }
      case 'disconnect': {
        const yes = await confirm({
          breadcrumb: CRUMB,
          title: 'Disconnect from the gateway?',
          subtitle: 'This machine\'s certificate is deleted from this computer.',
          body: [
            color.gray('Services pointing at this machine stop working until you connect again.'),
            color.gray('The gateway still lists the machine — remove it there to clean up.'),
          ],
          dangerous: true,
          yes: 'Disconnect',
        });
        if (yes === true) {
          await attempt({ breadcrumb: CRUMB, title: 'Disconnecting', label: 'Removing credentials…' }, () =>
            agent.disconnect(),
          );
        }
        break;
      }
      case 'reset': {
        const yes = await confirm({
          breadcrumb: CRUMB,
          title: 'Reset this machine?',
          subtitle: 'The private key is deleted as well as the certificate.',
          body: [
            color.gray('Connecting again afterwards creates a brand-new machine on the gateway,'),
            color.gray('so the old one has to be removed there by hand.'),
          ],
          dangerous: true,
          yes: 'Reset everything',
        });
        if (yes === true) {
          await attempt({ breadcrumb: CRUMB, title: 'Resetting', label: 'Clearing this machine\'s identity…' }, () =>
            agent.reset(),
          );
        }
        break;
      }
    }
  }
}

/** Mint an enrolment token on the gateway and hand it to the local agent. */
export async function connectComputer(ctx: Ctx): Promise<boolean> {
  const gateway = ctx.gateway;
  if (!gateway) {
    await page({
      breadcrumb: CRUMB,
      title: 'No gateway yet',
      error: 'Add a gateway first, then come back and connect this computer.',
    });
    return false;
  }

  const chrome = { breadcrumb: CRUMB, title: `Connect to ${gateway.name || gateway.host}` };
  const result = await attempt({ ...chrome, label: 'Enrolling this computer…' }, async () => {
    await ensureAgentRunning();
    const { token } = await gatewayApi.enrollToken(ctx.connection());
    return agent.enroll({
      host: gateway.host,
      port: gateway.port,
      token,
      fingerprint: gateway.fingerprint,
    });
  });
  if (!result) return false;

  await page({
    ...chrome,
    title: 'This computer is connected',
    notice: `Enrolled as machine ${result.machineId.slice(0, 12)}…`,
    body: [
      color.gray('The agent dialled out to the gateway and holds the tunnel open. Nothing'),
      color.gray('connects inbound to this computer, which is why this works behind CGNAT.'),
      '',
      color.gray('Next: choose "Services" to put something on the internet.'),
    ],
  });
  return true;
}

async function toggleAutostart(): Promise<void> {
  const on = agent.autostartInstalled();
  const chrome = { breadcrumb: CRUMB, title: on ? 'Turning off start at login' : 'Starting at login' };
  if (on) {
    const ok = await attempt({ ...chrome, label: 'Removing the service…' }, () => disableAutostart());
    if (ok !== null) {
      await page({ ...chrome, title: 'Start at login is off', notice: 'The agent will not start by itself any more.' });
    }
    return;
  }
  const path = await attempt({ ...chrome, label: 'Installing the service…' }, () => enableAutostart());
  if (path) {
    await page({
      ...chrome,
      title: 'Start at login is on',
      notice: `Installed ${path}`,
      body: [
        color.gray('It is a user service — no root, and it can only reach what you can reach.'),
        '',
        color.gray('If your box has no graphical login, keep it running between sessions with:'),
        ` ${color.cyan('sudo loginctl enable-linger $USER')}`,
      ],
    });
  }
}

function describeState(running: boolean, status: TunnelStatus | null): string {
  if (!running) return 'The agent is not running.';
  if (!status?.machineId) return 'Running, but not connected to a gateway yet.';
  switch (status.state) {
    case 'connected':
      return `Connected to ${status.gatewayHost}.`;
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return `Reconnecting${status.retryInSeconds ? ` in ${status.retryInSeconds}s` : ''}…`;
    case 'revoked':
      return 'This machine was revoked by the gateway.';
    case 'error':
      return status.lastError ?? 'Something went wrong.';
    default:
      return 'Idle — the tunnel is paused.';
  }
}

function statusBody(running: boolean, status: TunnelStatus | null): string[] {
  if (!running) {
    return [
      color.gray('Nothing is holding the tunnel open. Start the agent to bring your'),
      color.gray('services back online.'),
    ];
  }
  if (!status) return [];
  const state =
    status.state === 'connected'
      ? badge('connected', 'ok')
      : status.state === 'revoked' || status.state === 'error'
        ? badge(status.state, 'bad')
        : status.state === 'idle'
          ? badge('paused', 'idle')
          : badge(status.state, 'warn');

  const pairs: [string, string][] = [['Tunnel', state]];
  if (status.machineId) pairs.push(['Machine', status.machineId]);
  if (status.gatewayHost) pairs.push(['Gateway', status.gatewayHost]);
  if (status.latencyMs !== null) pairs.push(['Latency', `${status.latencyMs} ms`]);
  if (status.connectedSince) pairs.push(['Up since', ago(status.connectedSince)]);
  pairs.push(['Services on this machine', String(status.services.length)]);
  pairs.push(['Traffic', `${bytes(status.bytesIn)} in · ${bytes(status.bytesOut)} out`]);
  if (status.lastError) pairs.push(['Last error', color.yellow(status.lastError)]);
  return keyValue(pairs);
}
