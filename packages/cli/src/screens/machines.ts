import { agent } from '../agent.js';
import { gatewayApi, type MachineView } from '../gateway.js';
import { color } from '../tui/render.js';
import { CANCEL, ago, badge, confirm, input, keyValue, page, select } from '../tui/prompts.js';
import { Ctx, attempt } from './common.js';

/** Machines: every computer enrolled with the active gateway. */

const CRUMB = 'Machines';

export async function machinesScreen(ctx: Ctx): Promise<void> {
  for (;;) {
    const loaded = await attempt({ breadcrumb: CRUMB, title: 'Machines', label: 'Asking the gateway…' }, async () => {
      const { machines } = await gatewayApi.machines(ctx.connection());
      const mine = await agent
        .status()
        .then((s) => s.machineId)
        .catch(() => null);
      return { machines, mine };
    });
    if (!loaded) return;

    const choice = await select<string>({
      breadcrumb: CRUMB,
      title: 'Machines',
      subtitle: `${loaded.machines.filter((m) => m.connected).length} of ${loaded.machines.length} connected`,
      items: [
        ...loaded.machines.map((m) => ({
          value: `open:${m.id}`,
          label: `${m.name || m.hostname}${m.id === loaded.mine ? color.gray(' (this computer)') : ''}`,
          badge: machineBadge(m),
          hint: `${m.os}/${m.arch} · ${m.serviceCount} service(s) · last seen ${ago(m.lastSeenAt)}`,
        })),
        { value: 'back', label: '← Back' },
      ],
    });
    if (choice === CANCEL || choice === 'back') return;
    await machineActions(ctx, choice.slice(5), loaded.mine);
  }
}

async function machineActions(ctx: Ctx, id: string, mine: string | null): Promise<void> {
  for (;;) {
    const loaded = await attempt({ breadcrumb: CRUMB, title: 'Machine', label: 'Loading…' }, async () => {
      const { machines } = await gatewayApi.machines(ctx.connection());
      return machines.find((m) => m.id === id) ?? null;
    });
    if (!loaded) return;
    const machine = loaded;
    const isMine = machine.id === mine;

    const choice = await select<string>({
      breadcrumb: `${CRUMB} / ${machine.name || machine.hostname}`,
      title: machine.name || machine.hostname,
      subtitle: machine.revoked
        ? 'Revoked — its certificate is no longer accepted.'
        : machine.connected
          ? 'Connected right now.'
          : 'Not connected at the moment.',
      body: keyValue([
        ['Status', machineBadge(machine)],
        ['Hostname', machine.hostname],
        ['System', `${machine.os}/${machine.arch}`],
        ['Agent', machine.agentVersion ?? color.gray('unknown')],
        ['Latency', machine.latencyMs === null ? color.gray('—') : `${machine.latencyMs} ms`],
        ['Open streams', String(machine.activeStreams)],
        ['Services', String(machine.serviceCount)],
        ['Enrolled', new Date(machine.enrolledAt).toLocaleString()],
        ['Last seen', ago(machine.lastSeenAt)],
        ...(isMine ? ([['Note', color.yellow('This is the computer you are on.')]] as [string, string][]) : []),
      ]),
      filterable: false,
      items: [
        { value: 'rename', label: 'Rename' },
        ...(machine.revoked
          ? []
          : [{ value: 'revoke', label: color.red('Revoke this machine'), hint: 'Its certificate stops working immediately' }]),
        { value: 'remove', label: color.red('Remove it from the gateway'), hint: 'Also deletes its services' },
        { value: 'back', label: '← Back' },
      ],
    });

    if (choice === CANCEL || choice === 'back') return;

    if (choice === 'rename') {
      const name = await input({
        breadcrumb: CRUMB,
        title: 'Rename machine',
        label: 'Name',
        initial: machine.name || machine.hostname,
      });
      if (name !== CANCEL) {
        await attempt({ breadcrumb: CRUMB, title: 'Rename', label: 'Saving…' }, () =>
          gatewayApi.renameMachine(ctx.connection(), machine.id, name),
        );
      }
      continue;
    }

    if (choice === 'revoke') {
      const yes = await confirm({
        breadcrumb: CRUMB,
        title: `Revoke ${machine.name || machine.hostname}?`,
        subtitle: 'Use this if the computer was lost or you no longer trust it.',
        body: [
          color.gray('The gateway drops its tunnel and refuses the certificate from then on.'),
          ...(isMine ? [color.yellow('This is the computer you are using — you will lose your own tunnel.')] : []),
        ],
        dangerous: true,
        yes: 'Revoke it',
      });
      if (yes === true) {
        await attempt({ breadcrumb: CRUMB, title: 'Revoking', label: 'Revoking the certificate…' }, () =>
          gatewayApi.revokeMachine(ctx.connection(), machine.id),
        );
      }
      continue;
    }

    if (choice === 'remove') {
      const yes = await confirm({
        breadcrumb: CRUMB,
        title: `Remove ${machine.name || machine.hostname}?`,
        subtitle: `Its ${machine.serviceCount} service(s) go with it.`,
        dangerous: true,
        yes: 'Remove it',
      });
      if (yes === true) {
        const done = await attempt({ breadcrumb: CRUMB, title: 'Removing', label: 'Removing the machine…' }, () =>
          gatewayApi.removeMachine(ctx.connection(), machine.id),
        );
        if (done !== null) return;
      }
    }
  }
}

function machineBadge(machine: MachineView): string {
  if (machine.revoked) return badge('revoked', 'bad');
  return machine.connected ? badge('connected', 'ok') : badge('offline', 'idle');
}
