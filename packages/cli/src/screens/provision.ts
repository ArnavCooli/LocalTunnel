import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatewayApi } from '../gateway.js';
import {
  discoverPrivateKeys,
  explainFailure,
  markerPayload,
  remoteExec,
  remoteScript,
  sshDir,
  upload,
  destination,
  SshError,
  type PrivateKey,
  type SshTarget,
} from '../ssh.js';
import { color, suspend, write } from '../tui/render.js';
import { CANCEL, confirm, input, keyValue, page, select, type Cancelled } from '../tui/prompts.js';
import { Ctx } from './common.js';
import { prettyFingerprint } from './gateways.js';

/**
 * Setting a gateway up over SSH — the desktop app's flow, in a terminal.
 *
 * You sign in to the server the same way you would by hand, and everything else
 * (admin token, certificate fingerprint, gateway id) is read or generated on the
 * server and stored here. Nothing is copied by hand.
 */

const CRUMB = 'Gateways / SSH';

interface Probe {
  installed: boolean;
  os: string;
  arch: string;
}

interface GatewayFacts {
  gatewayId: string;
  publicIp: string;
  httpsPort: number;
  fingerprint: string;
  adminToken: string;
  name?: string;
}

/** Repo layout, mirroring how the desktop app finds the same three files. */
function assets() {
  const repo = join(__dirname, '..', '..', '..', '..');
  return {
    bundle: join(repo, 'build', 'localtunnel-gateway.tar.gz'),
    installer: join(repo, 'installer', 'install.sh'),
    unit: join(repo, 'installer', 'localtunnel-gateway.service'),
    // Shared with the desktop app, which ships the same directory as a resource.
    adopt: join(repo, 'installer', 'adopt.sh'),
  };
}

export async function sshSetupScreen(ctx: Ctx): Promise<void> {
  const target = await askForTarget();
  if (!target) return;

  const probe = await runStep(
    { title: `Connecting to ${destination(target)}`, note: 'A key passphrase or sudo prompt appears below.' },
    async (say) => {
      const result = await remoteExec(
        target,
        [
          // Same default-with-override as the adopt script, so both can be pointed
          // at a scratch config when this flow is tested without a server.
          'CONF=${LT_CONF:-/etc/localtunnel/gateway.json}',
          'test -f "$CONF" && echo LT_INSTALLED || echo LT_ABSENT',
          'uname -m',
          '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo unknown',
        ].join('; '),
        say,
      );
      if (result.code !== 0) throw new SshError(explainFailure(result.code, result.output));
      const lines = result.output.split(/\r?\n/).map((l) => l.trim());
      return {
        installed: lines.includes('LT_INSTALLED'),
        arch: lines.find((l) => /^(x86_64|aarch64|arm64|i686|armv7l)$/.test(l)) ?? 'unknown',
        os: lines[lines.length - 2] ?? 'unknown',
      } satisfies Probe;
    },
  );
  if (!probe) return;

  const facts = probe.installed ? await adopt(target) : await install(target, probe);
  if (!facts) return;

  await finish(ctx, target, facts, probe.installed);
}

/* ------------------------------------------------------------------ sign in */

async function askForTarget(): Promise<SshTarget | null> {
  const body = [
    color.gray('The same details you would use to `ssh` into the server yourself. Your'),
    color.gray('agent, ~/.ssh/config and known_hosts all apply, and nothing is stored here.'),
  ];

  const host = await input({
    breadcrumb: CRUMB,
    title: 'Sign in to your server',
    subtitle: 'Step 1 of 4',
    body,
    label: 'Server address (public IPv4 or hostname)',
    placeholder: '203.0.113.10',
  });
  if (host === CANCEL) return null;

  const username = await input({
    breadcrumb: CRUMB,
    title: 'Sign in to your server',
    subtitle: 'Step 2 of 4',
    body: [color.gray('`ubuntu` on Ubuntu images, `opc` on Oracle Linux, often `root` elsewhere.')],
    label: 'SSH username',
    initial: 'ubuntu',
  });
  if (username === CANCEL) return null;

  const port = await input({
    breadcrumb: CRUMB,
    title: 'Sign in to your server',
    subtitle: 'Step 3 of 4',
    label: 'SSH port',
    initial: '22',
    validate: (v) => (Number(v) > 0 && Number(v) < 65536 ? null : 'Enter a port between 1 and 65535.'),
  });
  if (port === CANCEL) return null;

  const identityFile = await pickKey();
  if (identityFile === CANCEL) return null;

  return { host, username, port: Number(port), identityFile };
}

/**
 * Which key to sign in with.
 *
 * The keys in ~/.ssh are offered by name, because that is how people think of
 * them — but the default stays "let ssh decide", since an agent or a Host entry
 * in ~/.ssh/config usually has this covered already.
 */
async function pickKey(): Promise<string | null | Cancelled> {
  const keys = discoverPrivateKeys();

  const choice = await select<string | null | 'browse'>({
    breadcrumb: CRUMB,
    title: 'Which SSH key?',
    subtitle: 'Step 4 of 4',
    body: keys.length
      ? [color.gray(`Found ${keys.length} in ${sshDir()}.`)]
      : [color.gray(`No private keys in ${sshDir()} — your agent may still have one.`)],
    filterable: keys.length > 6,
    items: [
      {
        value: null,
        label: 'Let ssh decide (recommended)',
        hint: 'Uses your agent and ~/.ssh/config, exactly as `ssh` would by itself',
      },
      ...keys.map((key) => ({
        value: key.path,
        label: key.name,
        badge: key.encrypted ? color.yellow('passphrase') : '',
        hint: describeKey(key),
      })),
      { value: 'browse' as const, label: 'Use a key from somewhere else…', hint: 'Type the path to a key outside ~/.ssh' },
    ],
  });
  if (choice === CANCEL) return CANCEL;
  if (choice !== 'browse') return choice;

  const typed = await input({
    breadcrumb: CRUMB,
    title: 'Private key file',
    subtitle: 'Step 4 of 4',
    body: [color.gray('An absolute path, or one starting with ~/.')],
    label: 'Path to the private key',
    placeholder: '/media/usb/oracle_key',
    validate: (v) => {
      const path = expandHome(v);
      if (!existsSync(path)) return `${v} does not exist.`;
      if (v.endsWith('.pub')) return 'That is the public half — point at the private key, without .pub.';
      return null;
    },
  });
  if (typed === CANCEL) return CANCEL;
  return expandHome(typed);
}

function describeKey(key: PrivateKey): string {
  const bits = [key.type ?? 'private key', key.comment].filter(Boolean);
  return bits.join(' · ');
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(process.env.HOME ?? '', path.slice(2)) : path;
}

/* ------------------------------------------------------ existing gateway */

/**
 * Take over a gateway that is already installed.
 *
 * The server keeps only a hash of the admin token, so there is nothing to read
 * back — the only way to end up with a working token is to set a new one.
 */
async function adopt(target: SshTarget): Promise<GatewayFacts | null> {
  const go = await confirm({
    breadcrumb: CRUMB,
    title: 'That server already has a gateway',
    subtitle: 'Its admin token has to be replaced to continue.',
    body: [
      color.gray('The gateway stores only a hash of its admin token, so an existing one cannot'),
      color.gray('be read back off the server — not by this client, and not by anyone else who'),
      color.gray('gets in. A new token is generated on the server and kept here.'),
      '',
      color.yellow('The desktop app, if you also use it with this gateway, will need the new'),
      color.yellow('token — it is shown at the end. The gateway restarts, so tunnels drop for a'),
      color.yellow('few seconds and reconnect by themselves.'),
    ],
    yes: 'Replace the token and continue',
  });
  if (go !== true) return null;

  return runStep({ title: 'Setting a new admin token', note: 'Running as root on the server.' }, async (say) => {
    const result = await remoteScript(target, readFileSync(assets().adopt, 'utf8'), say);
    const facts = markerPayload<GatewayFacts>(result.output, 'LOCALTUNNEL_ADOPT');
    if (!facts) throw new SshError(explainFailure(result.code, result.output));
    return facts;
  });
}

/* ----------------------------------------------------------- fresh install */

async function install(target: SshTarget, probe: Probe): Promise<GatewayFacts | null> {
  const paths = assets();
  if (!existsSync(paths.bundle)) {
    await page({
      breadcrumb: CRUMB,
      title: 'The gateway bundle is missing',
      error: `${paths.bundle} does not exist.`,
      body: [
        color.gray('That tarball is what gets uploaded and installed on the server. Build it'),
        color.gray('from the LocalTunnel checkout with:'),
        '',
        ` ${color.cyan('./scripts/bundle-gateway.sh')}`,
      ],
    });
    return null;
  }

  if (!/x86_64|aarch64|arm64/.test(probe.arch)) {
    await page({
      breadcrumb: CRUMB,
      title: 'That server is not supported',
      error: `Its CPU architecture (${probe.arch}) is not one the gateway runs on.`,
      body: [color.gray('LocalTunnel gateways run on x86-64 and arm64.')],
    });
    return null;
  }

  const name = await input({
    breadcrumb: CRUMB,
    title: 'Name this gateway',
    subtitle: probe.os,
    label: 'Name',
    initial: 'My Gateway',
  });
  if (name === CANCEL) return null;

  const email = await input({
    breadcrumb: CRUMB,
    title: 'Let\'s Encrypt contact address',
    subtitle: 'Optional.',
    body: [
      color.gray('Let\'s Encrypt uses it to warn you if a certificate is about to expire without'),
      color.gray('renewing. Leave it blank to go without.'),
    ],
    label: 'Email',
    placeholder: 'you@example.com',
    allowEmpty: true,
  });
  if (email === CANCEL) return null;

  const go = await confirm({
    breadcrumb: CRUMB,
    title: `Install a gateway on ${target.host}?`,
    subtitle: probe.os,
    body: [
      color.gray('This uploads the gateway to the server and installs it as a systemd service:'),
      color.gray('a dedicated system user, its own certificate authority, and TCP 80 and 443'),
      color.gray('opened in the host firewall. It needs sudo, and takes a couple of minutes.'),
    ],
    yes: 'Install it',
  });
  if (go !== true) return null;

  return runStep({ title: `Installing on ${target.host}`, note: 'This takes a couple of minutes.' }, async (say) => {
    for (const [local, remote] of [
      [paths.bundle, '/tmp/localtunnel-gateway.tar.gz'],
      [paths.installer, '/tmp/localtunnel-install.sh'],
      [paths.unit, '/tmp/localtunnel-gateway.service'],
    ] as const) {
      say(`uploading ${remote}\n`);
      const sent = await upload(target, local, remote, say);
      if (sent.code !== 0) throw new SshError(explainFailure(sent.code, sent.output));
    }

    const result = await remoteScript(target, installScript(target.host, name, email), say);
    const facts = markerPayload<GatewayFacts>(result.output, 'LOCALTUNNEL_RESULT');
    if (!facts) throw new SshError(explainFailure(result.code, result.output));
    return { ...facts, name };
  });
}

/**
 * The script the server runs to install a gateway.
 *
 * install.sh reads its systemd unit from its own directory, so both files are
 * staged together under the names it expects — the same staging the desktop app
 * does, so the two front ends install identically.
 */
export function installScript(host: string, name: string, email: string): string {
  const flags = [
    '--bundle /tmp/localtunnel-gateway.tar.gz',
    `--public-ip ${shellQuote(host)}`,
    `--name ${shellQuote(name)}`,
    ...(email ? [`--email ${shellQuote(email)}`] : []),
  ];
  return [
    'set -e',
    'mkdir -p /tmp/lt-installer',
    'cp /tmp/localtunnel-install.sh /tmp/lt-installer/install.sh',
    'cp /tmp/localtunnel-gateway.service /tmp/lt-installer/localtunnel-gateway.service',
    'chmod +x /tmp/lt-installer/install.sh',
    `bash /tmp/lt-installer/install.sh ${flags.join(' ')}`,
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/* ---------------------------------------------------------------- finish */

async function finish(
  ctx: Ctx,
  target: SshTarget,
  facts: GatewayFacts,
  adopted: boolean,
): Promise<void> {
  const profile = {
    name: facts.name || target.host,
    host: facts.publicIp || target.host,
    port: facts.httpsPort || 443,
    fingerprint: facts.fingerprint,
    adminToken: facts.adminToken,
  };

  // Prove the token and fingerprint actually work before storing them.
  try {
    await gatewayApi.status({
      host: profile.host,
      port: profile.port,
      adminToken: profile.adminToken,
      fingerprint: profile.fingerprint,
    });
  } catch (err) {
    await page({
      breadcrumb: CRUMB,
      title: 'The gateway is set up, but not reachable from here',
      error: err instanceof Error ? err.message : String(err),
      body: [
        color.gray('The work on the server finished. What is left is almost always the'),
        color.gray(`provider firewall: TCP ${profile.port} has to be open to the internet — on`),
        color.gray('Oracle Cloud that is the VCN security list, not the box\'s own firewall.'),
        '',
        color.gray('The details have been saved anyway, so once the port is open this client'),
        color.gray('will connect without setting anything up again.'),
      ],
    });
    ctx.config.add(profile);
    return;
  }

  ctx.config.add(profile);
  await page({
    breadcrumb: CRUMB,
    title: adopted ? 'Gateway connected' : 'Gateway installed',
    notice: `${profile.name} is now the active gateway.`,
    body: [
      ...keyValue([
        ['Address', `${profile.host}:${profile.port}`],
        ['Fingerprint', color.gray(prettyFingerprint(profile.fingerprint))],
      ]),
      '',
      color.bold('Admin token'),
      ` ${color.cyan(profile.adminToken)}`,
      color.gray(' Stored here already. Copy it only if you also use the desktop app with'),
      color.gray(' this gateway — it is not shown again, and the server keeps only a hash.'),
      '',
      color.gray('Next: "This computer" to connect this machine, then "Services".'),
    ],
  });
}

/* --------------------------------------------------------------- plumbing */

/**
 * Give the terminal to ssh for one step.
 *
 * The menu cannot stay on screen: a passphrase or sudo prompt has to be visible
 * and typeable, so the alternate screen is dropped and the server's own output
 * scrolls past exactly as it would if you had run the command yourself.
 */
async function runStep<T>(
  chrome: { title: string; note?: string },
  work: (say: (text: string) => void) => Promise<T>,
): Promise<T | null> {
  const outcome = await suspend(async () => {
    write(`\n${color.bold(chrome.title)}\n`);
    if (chrome.note) write(`${color.gray(chrome.note)}\n`);
    write(`${color.dim('─'.repeat(60))}\n`);
    try {
      const value = await work((text) => write(text));
      return { ok: true as const, value };
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) };
    } finally {
      write(`${color.dim('─'.repeat(60))}\n`);
    }
  });

  if (outcome.ok) return outcome.value;
  await page({ breadcrumb: CRUMB, title: chrome.title, error: outcome.message });
  return null;
}

/** Offered from the Gateways menu; kept here so the flow reads top to bottom. */
export async function chooseSetupMethod(): Promise<'ssh' | 'manual' | null> {
  const choice = await select<'ssh' | 'manual' | 'back'>({
    breadcrumb: 'Gateways',
    title: 'Add a gateway',
    subtitle: 'How would you like to set it up?',
    filterable: false,
    items: [
      {
        value: 'ssh',
        label: 'Sign in over SSH (recommended)',
        hint: 'Installs or adopts the gateway and fetches its details for you',
      },
      {
        value: 'manual',
        label: 'Enter the details by hand',
        hint: 'If you already have the admin token and fingerprint',
      },
      { value: 'back', label: '← Back' },
    ],
  });
  if (choice === CANCEL || choice === 'back') return null;
  return choice;
}
