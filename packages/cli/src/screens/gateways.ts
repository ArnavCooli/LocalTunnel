import { desktopGateways, normalizeFingerprint, type GatewayProfile } from '../config.js';
import { gatewayApi } from '../gateway.js';
import { color } from '../tui/render.js';
import { CANCEL, badge, confirm, input, keyValue, page, select } from '../tui/prompts.js';
import { Ctx, attempt } from './common.js';
import { chooseSetupMethod, sshSetupScreen } from './provision.js';

/**
 * Gateways: the servers this computer tunnels through.
 *
 * Normally added by signing in over SSH, which installs or takes over the gateway
 * and brings its address, admin token and certificate fingerprint back by itself.
 * The pinned fingerprint is what makes all of this safe without the server needing
 * a domain name of its own.
 */

const CRUMB = 'Gateways';

export async function gatewaysScreen(ctx: Ctx): Promise<void> {
  for (;;) {
    const active = ctx.gateway;
    const items = ctx.config.gateways.map((g) => ({
      value: `open:${g.id}`,
      label: g.name || g.host,
      badge: g.id === active?.id ? badge('active', 'ok') : '',
      hint: `${g.host}:${g.port}`,
    }));

    const choice = await select<string>({
      breadcrumb: CRUMB,
      title: 'Gateways',
      subtitle: 'The servers your traffic goes through. You own these.',
      body: items.length ? [] : [color.gray('No gateway yet — add the one you installed from the app.')],
      filterable: false,
      items: [
        ...items,
        { value: 'add', label: '＋ Add a gateway', hint: 'Sign in over SSH, or enter the details by hand' },
        ...(desktopGateways().length
          ? [{ value: 'import', label: '⇥ Import from the desktop app', hint: 'Gateways already set up on this computer' }]
          : []),
        { value: 'where', label: '? Where do I find the admin token?', hint: 'And what to do if you have lost it' },
        { value: 'back', label: '← Back' },
      ],
    });

    if (choice === CANCEL || choice === 'back') return;
    if (choice === 'add') {
      const method = await chooseSetupMethod();
      if (method === 'ssh') await sshSetupScreen(ctx);
      else if (method === 'manual') await addGateway(ctx);
    }
    else if (choice === 'import') await importGateways(ctx);
    else if (choice === 'where') await whereIsTheToken();
    else if (choice.startsWith('open:')) await gatewayActions(ctx, choice.slice(5));
  }
}

async function gatewayActions(ctx: Ctx, id: string): Promise<void> {
  for (;;) {
    const gateway = ctx.config.gateways.find((g) => g.id === id);
    if (!gateway) return;
    const isActive = ctx.gateway?.id === gateway.id;

    const choice = await select<string>({
      breadcrumb: `${CRUMB} / ${gateway.name || gateway.host}`,
      title: gateway.name || gateway.host,
      body: keyValue([
        ['Address', `${gateway.host}:${gateway.port}`],
        ['Fingerprint', color.gray(prettyFingerprint(gateway.fingerprint))],
        ['Added', new Date(gateway.addedAt).toLocaleString()],
        ['Active', isActive ? color.green('yes') : color.gray('no')],
      ]),
      filterable: false,
      items: [
        ...(isActive ? [] : [{ value: 'use', label: 'Use this gateway' }]),
        { value: 'test', label: 'Test the connection' },
        { value: 'rename', label: 'Rename' },
        { value: 'remove', label: color.red('Forget this gateway') },
        { value: 'back', label: '← Back' },
      ],
    });

    if (choice === CANCEL || choice === 'back') return;

    if (choice === 'use') {
      ctx.config.setActive(gateway.id);
      return;
    }

    if (choice === 'test') {
      const status = await attempt(
        { breadcrumb: CRUMB, title: gateway.name, label: `Contacting ${gateway.host}…` },
        () => gatewayApi.status({ ...gateway, adminToken: gateway.adminToken }),
      );
      if (status) {
        await page({
          breadcrumb: CRUMB,
          title: 'The gateway answered',
          notice: 'Address, token and fingerprint all check out.',
          body: keyValue([
            ['Version', status.gateway.version],
            ['Public IP', status.gateway.publicIp],
            ['Machines', String(status.machines.length)],
            ['Services', String(status.services.length)],
          ]),
        });
      }
      continue;
    }

    if (choice === 'rename') {
      const name = await input({
        breadcrumb: CRUMB,
        title: 'Rename gateway',
        label: 'Name',
        initial: gateway.name,
      });
      if (name !== CANCEL) ctx.config.rename(gateway.id, name);
      continue;
    }

    if (choice === 'remove') {
      const yes = await confirm({
        breadcrumb: CRUMB,
        title: `Forget ${gateway.name || gateway.host}?`,
        subtitle: 'This only removes it from this computer.',
        body: [
          color.gray('The server keeps running and your services stay up. You can add it back'),
          color.gray('with the same address, token and fingerprint.'),
        ],
        dangerous: true,
        yes: 'Forget it',
      });
      if (yes === true) {
        ctx.config.remove(gateway.id);
        return;
      }
    }
  }
}

async function addGateway(ctx: Ctx): Promise<void> {
  const body = [
    color.gray('Only needed if you already have these to hand — "Sign in over SSH" fetches'),
    color.gray('them from the server for you. The installer prints them once when it'),
    color.gray('finishes; the desktop app shows that as a LOCALTUNNEL_RESULT line.'),
  ];

  const host = await input({
    breadcrumb: `${CRUMB} / Add`,
    title: 'Add a gateway',
    subtitle: 'Step 1 of 4',
    body,
    label: 'Server address (IP or hostname)',
    placeholder: '203.0.113.10',
  });
  if (host === CANCEL) return;

  const portText = await input({
    breadcrumb: `${CRUMB} / Add`,
    title: 'Add a gateway',
    subtitle: 'Step 2 of 4',
    label: 'Admin port',
    initial: '443',
    validate: (v) => (Number(v) > 0 && Number(v) < 65536 ? null : 'Enter a port between 1 and 65535.'),
  });
  if (portText === CANCEL) return;

  const token = await input({
    breadcrumb: `${CRUMB} / Add`,
    title: 'Add a gateway',
    subtitle: 'Step 3 of 4',
    body: [color.gray('Hidden as you type. It is stored at 0600 in your own config directory.')],
    label: 'Admin token',
    secret: true,
  });
  if (token === CANCEL) return;

  const fingerprint = await input({
    breadcrumb: `${CRUMB} / Add`,
    title: 'Add a gateway',
    subtitle: 'Step 4 of 4',
    body: [
      color.gray('The SHA-256 fingerprint of the gateway certificate. This is what proves the'),
      color.gray('server you reach is the one you installed, so it is not optional.'),
    ],
    label: 'Certificate fingerprint',
    placeholder: 'AB:CD:EF:…',
    validate: (v) =>
      normalizeFingerprint(v).length === 64 ? null : 'A SHA-256 fingerprint is 64 hex characters.',
  });
  if (fingerprint === CANCEL) return;

  const candidate: Omit<GatewayProfile, 'id' | 'addedAt'> = {
    name: host,
    host,
    port: Number(portText),
    fingerprint: normalizeFingerprint(fingerprint),
    adminToken: token,
  };

  const status = await attempt(
    { breadcrumb: `${CRUMB} / Add`, title: 'Add a gateway', label: `Checking ${host}…` },
    () =>
      gatewayApi.status({
        host: candidate.host,
        port: candidate.port,
        adminToken: candidate.adminToken,
        fingerprint: candidate.fingerprint,
      }),
  );
  if (!status) return;

  const name = await input({
    breadcrumb: `${CRUMB} / Add`,
    title: 'What should this gateway be called?',
    notice: `Reached ${host} — gateway ${status.gateway.version}, ${status.machines.length} machine(s).`,
    label: 'Name',
    initial: status.gateway.name || host,
  });
  if (name === CANCEL) return;

  ctx.config.add({ ...candidate, name });
  await page({
    breadcrumb: CRUMB,
    title: 'Gateway added',
    notice: `${name} is now the active gateway.`,
    body: [color.gray('Next: connect this computer to it from "This computer".')],
  });
}

async function importGateways(ctx: Ctx): Promise<void> {
  const found = desktopGateways();
  const importable = found.filter((c) => c.profile);
  const locked = found.filter((c) => !c.profile);

  if (importable.length === 0) {
    await page({
      breadcrumb: CRUMB,
      title: 'Nothing to import',
      body: [
        color.gray(`Found ${locked.length} gateway(s) in the desktop app, but their admin tokens are`),
        color.gray('sealed in the OS keyring and only the desktop app can open them.'),
        '',
        color.gray('Open the app and use Gateways → Connection details → Reveal admin token,'),
      color.gray('then "Add a gateway → Enter the details by hand" here. Or skip all of that'),
      color.gray('with "Sign in over SSH".'),
      ],
    });
    return;
  }

  const choice = await select<number | 'back'>({
    breadcrumb: `${CRUMB} / Import`,
    title: 'Import from the desktop app',
    subtitle: `${importable.length} gateway(s) can be imported.`,
    filterable: false,
    items: [
      ...importable.map((c, i) => ({ value: i, label: c.name || c.host, hint: c.host })),
      { value: 'back' as const, label: '← Back' },
    ],
  });
  if (choice === CANCEL || choice === 'back') return;

  const picked = importable[choice as number];
  if (!picked?.profile) return;
  ctx.config.add(picked.profile);
  await page({
    breadcrumb: CRUMB,
    title: 'Imported',
    notice: `${picked.name || picked.host} is now the active gateway.`,
  });
}

/**
 * Where the admin token comes from, and how to set a new one.
 *
 * The gateway only ever stores sha256(token), so a lost token cannot be read back
 * off the server — it can only be replaced.
 */
async function whereIsTheToken(): Promise<void> {
  await page({
    breadcrumb: `${CRUMB} / Help`,
    title: 'Where do I find the admin token?',
    subtitle: 'The installer generates it on the server and prints it once.',
    body: [
      color.bold('When you install a gateway'),
      color.gray('The last line the installer prints is a LOCALTUNNEL_RESULT line holding the'),
      color.gray('gateway id, public IP, admin token and fingerprint. The desktop app reads it'),
      color.gray('from there; installing over SSH by hand, it is in your terminal scrollback.'),
      '',
      color.bold('If the desktop app already has this gateway'),
      color.gray('Open it there: Gateways → Connection details → Reveal admin token. That works'),
      color.gray('on macOS and Windows too, where the token is sealed in the OS keychain and'),
      color.gray('only that app can unseal it.'),
      color.gray('On this computer, "Import from the desktop app" can also pick it up directly'),
      color.gray('when the desktop had no keyring to seal it with.'),
      '',
      color.bold('If it is lost — or you would rather not copy it at all'),
      color.gray('Use "Add a gateway → Sign in over SSH". You sign in to the server the way'),
      color.gray('you normally would, and this client sets a new admin token there and keeps'),
      color.gray('it, so there is nothing to paste. The old token stops working, so the'),
      color.gray('desktop app would need the new one — it is shown once at the end.'),
      '',
      color.gray('By hand, that is the same as:'),
      color.cyan('  TOKEN=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-43)'),
      color.cyan('  HASH=$(printf %s "$TOKEN" | sha256sum | cut -d" " -f1)'),
      color.cyan('  sudo sed -i "s/\\"adminTokenHash\\": \\"[^\\"]*\\"/\\"adminTokenHash\\": \\"$HASH\\"/" \\'),
      color.cyan('       /etc/localtunnel/gateway.json'),
      color.cyan('  sudo systemctl restart localtunnel-gateway'),
      color.cyan('  echo "$TOKEN"'),
      '',
      color.gray('The certificate fingerprint is not a secret and is always recoverable:'),
      color.cyan('  openssl s_client -connect YOUR_IP:443 -alpn localtunnel-admin </dev/null 2>/dev/null \\'),
      color.cyan('    | openssl x509 -noout -fingerprint -sha256'),
    ],
  });
}

export function prettyFingerprint(value: string): string {
  return (value.match(/.{1,2}/g) ?? []).join(':');
}
