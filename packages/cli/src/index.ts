#!/usr/bin/env node
import { runAgent } from '@localtunnel/agent';
import { agent, agentLogPath, ensureAgentRunning } from './agent.js';
import { Config, connectionOf } from './config.js';
import { gatewayApi } from './gateway.js';
import { color, enterAlternateScreen, installExitGuard, isTty, leaveAlternateScreen, stopKeyboard } from './tui/render.js';
import { Ctx, servicePublic } from './screens/common.js';
import { homeScreen } from './screens/home.js';

/**
 * `localtunnel` — the terminal client.
 *
 * With no arguments it opens the full-screen menu; the few subcommands exist for
 * scripts, systemd units and SSH sessions where a menu would be in the way.
 */

const VERSION = '1.0.0';

const HELP = `${color.bold('localtunnel')} — put your local services on the public internet

${color.bold('USAGE')}
  localtunnel                 open the interactive menu (arrow keys)
  localtunnel status          print what is up right now
  localtunnel services        list published services
  localtunnel up              start the background agent and connect the tunnel
  localtunnel down            pause the tunnel (the agent keeps running)
  localtunnel stop            stop the background agent entirely
  localtunnel logs            print the path to the agent log
  localtunnel agent           run the agent in the foreground (for systemd)

${color.bold('OPTIONS')}
  -h, --help                  show this
  -v, --version               show the version
  --json                      machine-readable output for status and services

Everything else — adding a gateway, publishing a service, certificates,
diagnostics — lives in the interactive menu.
`;

async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith('-')));
  const [command] = argv.filter((a) => !a.startsWith('-'));
  const json = flags.has('--json');

  if (flags.has('-h') || flags.has('--help') || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (flags.has('-v') || flags.has('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  switch (command) {
    case undefined:
      return interactive();
    case 'status':
      return printStatus(json);
    case 'services':
      return printServices(json);
    case 'up':
      return up();
    case 'down':
      return down();
    case 'stop':
      return stop();
    case 'logs':
      process.stdout.write(`${agentLogPath()}\n`);
      return 0;
    case 'agent':
      // Run the agent in this process, so `localtunnel agent` can be the ExecStart
      // of a service unit without pointing inside node_modules by hand. It runs
      // until stopped, hence -1 rather than an exit code.
      await runAgent();
      return -1;
    default:
      process.stderr.write(`Unknown command "${command}". Try localtunnel --help\n`);
      return 2;
  }
}

async function interactive(): Promise<number> {
  if (!isTty) {
    process.stderr.write(
      'The menu needs an interactive terminal. Try `localtunnel status`, or see `localtunnel --help`.\n',
    );
    return 1;
  }
  installExitGuard();
  enterAlternateScreen();
  try {
    await homeScreen(new Ctx());
  } finally {
    stopKeyboard();
    leaveAlternateScreen();
  }
  return 0;
}

/* --------------------------------------------------------- plain commands */

async function printStatus(json: boolean): Promise<number> {
  const config = new Config();
  const profile = config.active();
  const running = await agent.running();
  const local = running ? await agent.status().catch(() => null) : null;
  const status = profile ? await gatewayApi.status(connectionOf(profile)).catch((err) => err as Error) : null;

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          gateway: profile ? { name: profile.name, host: profile.host, port: profile.port } : null,
          gatewayStatus: status instanceof Error ? { error: status.message } : status,
          agentRunning: running,
          tunnel: local,
        },
        null,
        2,
      )}\n`,
    );
    return status instanceof Error ? 1 : 0;
  }

  if (!profile) {
    process.stdout.write('No gateway is set up yet. Run `localtunnel` and choose "Add a gateway".\n');
    return 1;
  }

  const lines: string[] = [];
  lines.push(`${color.bold(profile.name || profile.host)}  ${color.gray(`${profile.host}:${profile.port}`)}`);
  if (status instanceof Error) {
    lines.push(`${color.red('✗')} gateway unreachable — ${status.message}`);
  } else if (status) {
    lines.push(
      `${color.green('✓')} gateway up — ${status.gateway.version}, ${status.machines.filter((m) => m.connected).length}/${
        status.machines.length
      } machines connected`,
    );
  }
  lines.push(
    running
      ? `${local?.state === 'connected' ? color.green('✓') : color.yellow('•')} agent ${local?.state ?? 'running'}${
          local?.latencyMs != null ? ` (${local.latencyMs} ms)` : ''
        }`
      : `${color.red('✗')} agent not running`,
  );
  if (status && !(status instanceof Error)) {
    for (const service of status.services) {
      const mark = service.status === 'online' ? color.green('✓') : color.red('✗');
      lines.push(
        `  ${mark} ${service.name} ${color.gray(`${servicePublic(service, status.gateway.publicIp)} → ${service.localHost}:${service.localPort}`)}`,
      );
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return status instanceof Error ? 1 : 0;
}

async function printServices(json: boolean): Promise<number> {
  const config = new Config();
  const profile = config.active();
  if (!profile) {
    process.stderr.write('No gateway is set up yet. Run `localtunnel` to add one.\n');
    return 1;
  }
  try {
    const { services } = await gatewayApi.services(connectionOf(profile));
    if (json) {
      process.stdout.write(`${JSON.stringify(services, null, 2)}\n`);
      return 0;
    }
    if (services.length === 0) {
      process.stdout.write('Nothing is published yet.\n');
      return 0;
    }
    for (const service of services) {
      process.stdout.write(
        `${service.status === 'online' ? color.green('✓') : color.red('✗')} ${service.name}\t${servicePublic(
          service,
        )}\t→ ${service.localHost}:${service.localPort}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function up(): Promise<number> {
  try {
    const how = await ensureAgentRunning();
    const status = await agent.start();
    process.stdout.write(
      `agent ${how === 'started' ? 'started' : 'already running'} — tunnel ${status.state}${
        status.gatewayHost ? ` to ${status.gatewayHost}` : ''
      }\n`,
    );
    if (!status.machineId) {
      process.stdout.write('This computer is not connected to a gateway yet. Run `localtunnel` to connect it.\n');
      return 1;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function down(): Promise<number> {
  try {
    const status = await agent.pause();
    process.stdout.write(`tunnel ${status.state}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function stop(): Promise<number> {
  try {
    await agent.shutdown();
    process.stdout.write('agent stopped\n');
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      // -1 means another entrypoint took over the process (the agent).
      if (code >= 0) process.exit(code);
    })
    .catch((err) => {
      stopKeyboard();
      leaveAlternateScreen();
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
