import { agent } from '../agent.js';
import { gatewayApi } from '../gateway.js';
import { color } from '../tui/render.js';
import { page } from '../tui/prompts.js';
import { Ctx, attempt } from './common.js';

/**
 * Diagnostics: check every link in the chain and name the one that is broken.
 *
 * Visitor → gateway → tunnel → agent → local app, plus the certificate. Each check
 * ends in a sentence the user can act on rather than a status code.
 */

const CRUMB = 'Diagnostics';

interface Check {
  ok: boolean | null;
  label: string;
  detail: string;
}

export async function diagnosticsScreen(ctx: Ctx): Promise<void> {
  const result = await attempt(
    { breadcrumb: CRUMB, title: 'Diagnostics', label: 'Checking every link in the chain…' },
    async () => {
      const status = await gatewayApi.status(ctx.connection());
      const diagnostics = await gatewayApi.diagnostics(ctx.connection()).catch(() => null);
      const running = await agent.running();
      const local = running ? await agent.status().catch(() => null) : null;
      return { status, diagnostics, running, local };
    },
  );
  if (!result) return;

  const { status, running, local } = result;
  const checks: Check[] = [];

  checks.push({
    ok: true,
    label: 'Gateway reachable',
    detail: `${status.gateway.publicIp} answered — version ${status.gateway.version}, up ${Math.round(
      status.gateway.uptimeSeconds / 3600,
    )}h.`,
  });

  checks.push({
    ok: running,
    label: 'Agent running on this computer',
    detail: running
      ? 'The background agent is answering.'
      : 'Nothing is holding the tunnel open. Start it from "This computer".',
  });

  if (running) {
    const connected = local?.state === 'connected';
    checks.push({
      ok: local?.machineId ? connected : false,
      label: 'Tunnel up',
      detail: !local?.machineId
        ? 'This computer has not been connected to the gateway yet.'
        : connected
          ? `Connected to ${local.gatewayHost}${local.latencyMs !== null ? ` at ${local.latencyMs} ms` : ''}.`
          : local?.lastError ?? `The tunnel is ${local?.state}.`,
    });
  }

  const offlineMachines = status.machines.filter((m) => !m.connected && !m.revoked);
  checks.push({
    ok: offlineMachines.length === 0,
    label: 'Machines connected',
    detail: offlineMachines.length
      ? `Offline: ${offlineMachines.map((m) => m.name || m.hostname).join(', ')}.`
      : `All ${status.machines.length} machine(s) are connected.`,
  });

  const unreachable = status.services.filter((s) => s.enabled && s.localReachable === false);
  checks.push({
    ok: unreachable.length === 0,
    label: 'Local apps answering',
    detail: unreachable.length
      ? unreachable.map((s) => `${s.name}: ${s.localError ?? `nothing on port ${s.localPort}`}`).join('  ·  ')
      : 'Every published service answers on its local port.',
  });

  const badCerts = status.certificates.filter((c) => c.state !== 'valid');
  checks.push({
    ok: status.certificates.length === 0 ? null : badCerts.length === 0,
    label: 'HTTPS certificates',
    detail:
      status.certificates.length === 0
        ? 'No hostname needs one yet.'
        : badCerts.length === 0
          ? `All ${status.certificates.length} certificate(s) are valid.`
          : badCerts
              .map((c) => `${c.hostname}: ${c.error ?? c.detail ?? c.state}`)
              .join('  ·  '),
  });

  const closedPorts = status.ports.filter((p) => !p.open);
  checks.push({
    ok: closedPorts.length === 0,
    label: 'Ports open on the server',
    detail: closedPorts.length
      ? `Blocked: ${closedPorts
          .map((p) => `${p.proto} ${p.port} (${p.label})`)
          .join(', ')}. Open these in your VPS provider's firewall — on Oracle Cloud that is the VCN security list.`
      : 'Every port the gateway needs is reachable.',
  });

  const broken = checks.filter((c) => c.ok === false);
  const body: string[] = [];
  for (const check of checks) {
    const mark = check.ok === null ? color.gray('–') : check.ok ? color.green('✓') : color.red('✗');
    body.push(`${mark} ${color.bold(check.label)}`);
    body.push(`  ${color.gray(check.detail)}`);
    body.push('');
  }

  await page({
    breadcrumb: CRUMB,
    title: broken.length === 0 ? 'Everything checks out' : `${broken.length} thing(s) need attention`,
    subtitle:
      broken.length === 0
        ? 'Visitor → gateway → tunnel → your computer → your app.'
        : `Start with: ${broken[0]?.label.toLowerCase()}.`,
    body,
  });
}
