import { agent } from '../agent.js';
import { gatewayApi, type GatewayStatus, type MachineView, type ServiceView } from '../gateway.js';
import { color } from '../tui/render.js';
import { CANCEL, ago, bytes, confirm, input, keyValue, page, select } from '../tui/prompts.js';
import { Ctx, attempt, certBadge, servicePublic, serviceStatusBadge, serviceTarget } from './common.js';

/**
 * Services: the things this gateway puts on the public internet.
 */

const CRUMB = 'Services';

interface Kind {
  id: string;
  title: string;
  description: string;
  type: 'http' | 'tcp' | 'udp';
  port?: number;
}

const KINDS: Kind[] = [
  { id: 'website', title: 'Website', description: 'A web app or site on a local port', type: 'http', port: 3000 },
  { id: 'api', title: 'API or webhook receiver', description: 'An HTTP API visitors call by hostname', type: 'http', port: 8080 },
  { id: 'minecraft', title: 'Minecraft (Java)', description: 'A Java Edition server', type: 'tcp', port: 25565 },
  { id: 'ssh', title: 'SSH', description: 'Remote shell access to this computer', type: 'tcp', port: 22 },
  { id: 'tcp', title: 'Custom TCP', description: 'Any other TCP service', type: 'tcp' },
  { id: 'udp', title: 'Custom UDP', description: 'Bedrock Minecraft, game servers, and similar', type: 'udp', port: 19132 },
];

export async function servicesScreen(ctx: Ctx): Promise<void> {
  for (;;) {
    const status = await attempt(
      { breadcrumb: CRUMB, title: 'Services', label: 'Asking the gateway…' },
      () => gatewayApi.status(ctx.connection()),
    );
    if (!status) return;

    const choice = await select<string>({
      breadcrumb: CRUMB,
      title: 'Services',
      subtitle: status.services.length
        ? `${status.services.filter((s) => s.status === 'online').length} of ${status.services.length} online`
        : 'Nothing is published yet.',
      body: status.services.length
        ? []
        : [
            color.gray('A service points a public address at a port on one of your machines.'),
            color.gray('Add one and it is reachable from anywhere.'),
          ],
      items: [
        ...status.services.map((s) => ({
          value: `open:${s.id}`,
          label: s.name,
          badge: serviceStatusBadge(s),
          hint: `${servicePublic(s, status.gateway.publicIp)}  ${color.dim('→')}  ${serviceTarget(s)}`,
        })),
        { value: 'add', label: '＋ Expose something new' },
        { value: 'back', label: '← Back' },
      ],
    });

    if (choice === CANCEL || choice === 'back') return;
    if (choice === 'add') await addService(ctx, status);
    else if (choice.startsWith('open:')) await serviceActions(ctx, choice.slice(5));
  }
}

async function serviceActions(ctx: Ctx, id: string): Promise<void> {
  for (;;) {
    const loaded = await attempt(
      { breadcrumb: CRUMB, title: 'Service', label: 'Loading…' },
      async () => {
        const status = await gatewayApi.status(ctx.connection());
        return { status, service: status.services.find((s) => s.id === id) ?? null };
      },
    );
    if (!loaded) return;
    const { status, service } = loaded;
    if (!service) return;

    const web = service.type === 'http' || service.type === 'https';
    const choice = await select<string>({
      breadcrumb: `${CRUMB} / ${service.name}`,
      title: service.name,
      subtitle: explainStatus(service),
      body: serviceBody(service, status),
      filterable: false,
      items: [
        { value: 'toggle', label: service.enabled ? 'Pause this service' : 'Resume this service' },
        { value: 'rename', label: 'Rename' },
        { value: 'port', label: 'Change the local port', hint: `Currently ${serviceTarget(service)}` },
        ...(web && service.hostname
          ? [{ value: 'cert', label: 'Request the certificate again', hint: 'Use after fixing the DNS record' }]
          : []),
        ...(web && service.hostname
          ? [{ value: 'dns', label: 'Show the DNS record I need' }]
          : []),
        { value: 'delete', label: color.red('Delete this service') },
        { value: 'back', label: '← Back' },
      ],
    });

    if (choice === CANCEL || choice === 'back') return;

    if (choice === 'toggle') {
      await attempt(
        { breadcrumb: CRUMB, title: service.name, label: service.enabled ? 'Pausing…' : 'Resuming…' },
        () => gatewayApi.updateService(ctx.connection(), service.id, { enabled: !service.enabled }),
      );
      continue;
    }

    if (choice === 'rename') {
      const name = await input({
        breadcrumb: `${CRUMB} / ${service.name}`,
        title: 'Rename service',
        label: 'Name',
        initial: service.name,
      });
      if (name !== CANCEL) {
        await attempt({ breadcrumb: CRUMB, title: 'Rename', label: 'Saving…' }, () =>
          gatewayApi.updateService(ctx.connection(), service.id, { name }),
        );
      }
      continue;
    }

    if (choice === 'port') {
      const port = await input({
        breadcrumb: `${CRUMB} / ${service.name}`,
        title: 'Change the local port',
        subtitle: `The port on ${service.localHost} that visitors are sent to.`,
        label: 'Local port',
        initial: String(service.localPort),
        validate: portRule,
      });
      if (port !== CANCEL) {
        await attempt({ breadcrumb: CRUMB, title: 'Saving', label: 'Updating the service…' }, () =>
          gatewayApi.updateService(ctx.connection(), service.id, { localPort: Number(port) }),
        );
      }
      continue;
    }

    if (choice === 'cert' && service.hostname) {
      const done = await attempt(
        { breadcrumb: CRUMB, title: service.name, label: 'Asking Let\'s Encrypt…' },
        () => gatewayApi.reissueCertificate(ctx.connection(), service.hostname!),
      );
      if (done) {
        await page({
          breadcrumb: CRUMB,
          title: 'Certificate requested',
          notice: 'The gateway is working on it — this usually takes under a minute.',
          body: [color.gray('It only succeeds once the DNS record points at the gateway.')],
        });
      }
      continue;
    }

    if (choice === 'dns' && service.hostname) {
      await page({
        breadcrumb: `${CRUMB} / ${service.name}`,
        title: 'DNS record',
        subtitle: 'Add this at whoever manages your domain.',
        body: [
          ...keyValue([
            ['Type', 'A'],
            ['Name', service.hostname],
            ['Value', color.cyan(status.gateway.publicIp)],
            ['TTL', 'automatic, or 300'],
          ]),
          '',
          color.gray('Cloudflare users: set the record to "DNS only" (grey cloud) until the'),
          color.gray('certificate is issued.'),
        ],
      });
      continue;
    }

    if (choice === 'delete') {
      const yes = await confirm({
        breadcrumb: `${CRUMB} / ${service.name}`,
        title: `Delete "${service.name}"?`,
        subtitle: `${servicePublic(service, status.gateway.publicIp)} stops working immediately.`,
        dangerous: true,
        yes: 'Delete it',
      });
      if (yes === true) {
        const done = await attempt({ breadcrumb: CRUMB, title: 'Deleting', label: 'Removing the service…' }, () =>
          gatewayApi.removeService(ctx.connection(), service.id),
        );
        if (done !== null) return;
      }
    }
  }
}

/* -------------------------------------------------------------- add wizard */

async function addService(ctx: Ctx, status: GatewayStatus): Promise<void> {
  const crumb = `${CRUMB} / New`;

  const machine = await pickMachine(status, crumb);
  if (!machine) return;

  const kind = await select<Kind | 'back'>({
    breadcrumb: crumb,
    title: 'What are you putting online?',
    subtitle: `On ${machine.name || machine.hostname}`,
    filterable: false,
    items: [
      ...KINDS.map((k) => ({ value: k, label: k.title, hint: k.description })),
      { value: 'back' as const, label: '← Back' },
    ],
  });
  if (kind === CANCEL || kind === 'back') return;

  const isWeb = kind.type === 'http';
  const localPort = await pickLocalPort(kind, crumb, machine);
  if (localPort === null) return;

  let hostname: string | null = null;
  let publicPort: number | null = null;
  let temporary = false;

  if (isWeb) {
    const how = await select<'domain' | 'temporary' | 'back'>({
      breadcrumb: crumb,
      title: 'How should visitors reach it?',
      filterable: false,
      items: [
        { value: 'domain', label: 'On my own domain', hint: 'e.g. mysite.example.com — needs one DNS record' },
        { value: 'temporary', label: 'A temporary link', hint: 'The gateway invents a hostname; good for a quick demo' },
        { value: 'back', label: '← Back' },
      ],
    });
    if (how === CANCEL || how === 'back') return;

    if (how === 'temporary') {
      temporary = true;
    } else {
      const value = await input({
        breadcrumb: crumb,
        title: 'Public hostname',
        subtitle: 'The address visitors will type.',
        body: [
          color.gray(`You will need an A record pointing it at ${status.gateway.publicIp}.`),
          color.gray('LocalTunnel gets the HTTPS certificate once that record is live.'),
        ],
        label: 'Hostname',
        placeholder: 'mysite.example.com',
        validate: (v) =>
          /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(v)
            ? status.services.some((s) => s.hostname === v.toLowerCase())
              ? 'Another service already uses that hostname.'
              : null
            : 'Enter a hostname like mysite.example.com.',
      });
      if (value === CANCEL) return;
      hostname = value.toLowerCase();
    }
  } else {
    const value = await input({
      breadcrumb: crumb,
      title: 'Public port',
      subtitle: `Visitors will connect to ${status.gateway.publicIp}:PORT.`,
      body: [color.gray('LocalTunnel opens this port on the server for you.')],
      label: 'Public port',
      initial: String(kind.port ?? localPort),
      validate: (v) => {
        const rule = portRule(v);
        if (rule) return rule;
        const port = Number(v);
        if (port === 80 || port === 443) return 'Ports 80 and 443 are reserved for the gateway itself.';
        if (status.services.some((s) => s.publicPort === port)) return 'Another service already uses that port.';
        return null;
      },
    });
    if (value === CANCEL) return;
    publicPort = Number(value);
  }

  const name = await input({
    breadcrumb: crumb,
    title: 'Name this service',
    subtitle: 'Only you see this.',
    label: 'Name',
    initial: kind.title,
  });
  if (name === CANCEL) return;

  const created = await attempt({ breadcrumb: crumb, title: 'Publishing', label: 'Creating the service…' }, () =>
    gatewayApi.createService(ctx.connection(), {
      machineId: machine.id,
      name,
      type: kind.type,
      localHost: '127.0.0.1',
      localPort,
      hostname,
      publicPort,
      temporary,
      expiresAt: temporary ? new Date(Date.now() + 8 * 3600_000).toISOString() : null,
      // The CLI only ever exposes this machine's own loopback, never another box
      // on the LAN — that opt-in lives in the desktop app, with its warning.
      allowLanTarget: false,
    }),
  );
  if (!created) return;

  const service = created.service;
  await page({
    breadcrumb: CRUMB,
    title: `${service.name} is live`,
    notice: servicePublic(service, status.gateway.publicIp),
    body: [
      ...keyValue([
        ['Public address', color.cyan(servicePublic(service, status.gateway.publicIp))],
        ['Sends traffic to', `${serviceTarget(service)} on ${machine.name || machine.hostname}`],
        ['Certificate', service.hostname ? certBadge(service.certificate?.state) : color.gray('not needed')],
      ]),
      ...(service.hostname && !temporary
        ? [
            '',
            color.gray('Last step — point the domain at the gateway:'),
            `  ${color.bold('A')}  ${service.hostname}  ${color.dim('→')}  ${color.cyan(status.gateway.publicIp)}`,
          ]
        : []),
      ...(temporary ? ['', color.gray('This link expires in 8 hours.')] : []),
    ],
  });
}

/** Which machine serves this — defaulting to this computer when it is enrolled. */
async function pickMachine(status: GatewayStatus, crumb: string): Promise<MachineView | null> {
  const usable = status.machines.filter((m) => !m.revoked);
  if (usable.length === 0) {
    await page({
      breadcrumb: crumb,
      title: 'No machine is connected yet',
      error: 'A service has to live on a machine, and this gateway has none.',
      body: [color.gray('Go to "This computer" and connect it to the gateway first.')],
    });
    return null;
  }

  const mine = await agent
    .status()
    .then((s) => s.machineId)
    .catch(() => null);

  if (usable.length === 1) return usable[0] ?? null;

  const choice = await select<MachineView | 'back'>({
    breadcrumb: crumb,
    title: 'Which computer is it running on?',
    filterable: false,
    initialIndex: Math.max(0, usable.findIndex((m) => m.id === mine)),
    items: [
      ...usable.map((m) => ({
        value: m,
        label: `${m.name || m.hostname}${m.id === mine ? color.gray(' (this computer)') : ''}`,
        badge: m.connected ? color.green('online') : color.gray('offline'),
        hint: `${m.os}/${m.arch} · last seen ${ago(m.lastSeenAt)}`,
      })),
      { value: 'back' as const, label: '← Back' },
    ],
  });
  if (choice === CANCEL || choice === 'back') return null;
  return choice;
}

/** Offer whatever is actually listening locally, then fall back to typing a port. */
async function pickLocalPort(
  kind: Kind,
  crumb: string,
  machine: MachineView,
): Promise<number | null> {
  const mine = await agent
    .status()
    .then((s) => s.machineId)
    .catch(() => null);

  let discovered: { port: number; guess: string }[] = [];
  if (mine && mine === machine.id) {
    discovered = await agent
      .discover()
      .then((r) => r.services)
      .catch(() => []);
  }

  const suggestions = discovered.filter((d) => d.port !== kind.port);
  const choice = await select<number | 'custom' | 'back'>({
    breadcrumb: crumb,
    title: 'Which local port is it on?',
    subtitle: discovered.length
      ? 'These ports are answering on this computer right now.'
      : 'The port your app listens on.',
    filterable: false,
    items: [
      ...(kind.port ? [{ value: kind.port, label: `Port ${kind.port}`, hint: `The usual port for ${kind.title.toLowerCase()}` }] : []),
      ...suggestions.map((d) => ({
        value: d.port,
        label: `Port ${d.port}`,
        badge: color.green('listening'),
        hint: `Something is already serving ${d.guess} here`,
      })),
      { value: 'custom' as const, label: 'Enter a different port…' },
      { value: 'back' as const, label: '← Back' },
    ],
  });
  if (choice === CANCEL || choice === 'back') return null;
  if (choice !== 'custom') return choice;

  const typed = await input({
    breadcrumb: crumb,
    title: 'Local port',
    label: 'Port',
    initial: String(kind.port ?? 3000),
    validate: portRule,
  });
  if (typed === CANCEL) return null;
  return Number(typed);
}

/* ------------------------------------------------------------------ detail */

function serviceBody(service: ServiceView, status: GatewayStatus): string[] {
  const pairs: [string, string][] = [
    ['Public address', color.cyan(servicePublic(service, status.gateway.publicIp))],
    ['Sends traffic to', serviceTarget(service)],
    ['Protocol', service.type.toUpperCase()],
    ['Machine', service.machineConnected ? color.green('connected') : color.red('offline')],
  ];
  if (service.hostname) pairs.push(['Certificate', certBadge(service.certificate?.state)]);
  if (service.certificate?.error) pairs.push(['Certificate error', color.yellow(service.certificate.error)]);
  if (service.localError) pairs.push(['Local app', color.yellow(service.localError)]);
  if (service.expiresAt) pairs.push(['Expires', new Date(service.expiresAt).toLocaleString()]);
  pairs.push(['Traffic', `${bytes(service.stats.bytesIn)} in · ${bytes(service.stats.bytesOut)} out`]);
  if (service.type === 'http' || service.type === 'https') {
    pairs.push([
      'Requests',
      `${service.stats.requests} total · ${color.green(String(service.stats.status2xx))} ok · ${color.yellow(
        String(service.stats.status4xx),
      )} 4xx · ${color.red(String(service.stats.status5xx))} 5xx`,
    ]);
  } else {
    pairs.push(['Connections', String(service.stats.connections)]);
  }
  return keyValue(pairs);
}

function explainStatus(service: ServiceView): string {
  switch (service.status) {
    case 'online':
      return 'Working — visitors can reach it.';
    case 'disabled':
      return 'Paused. The gateway answers, but nothing is forwarded.';
    case 'machine_offline':
      return 'The computer serving this is not connected to the gateway.';
    case 'local_unreachable':
      return service.localError ?? 'The local app is not answering on that port.';
    default:
      return '';
  }
}

function portRule(value: string): string | null {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? null : 'Enter a port between 1 and 65535.';
}
