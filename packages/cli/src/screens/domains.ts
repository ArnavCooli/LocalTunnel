import { gatewayApi, type CertificateView } from '../gateway.js';
import { color } from '../tui/render.js';
import { CANCEL, keyValue, page, select } from '../tui/prompts.js';
import { Ctx, attempt, certBadge } from './common.js';

/** Domains: one HTTPS certificate per hostname, and the DNS record behind it. */

const CRUMB = 'Domains';

export async function domainsScreen(ctx: Ctx): Promise<void> {
  for (;;) {
    const loaded = await attempt({ breadcrumb: CRUMB, title: 'Domains', label: 'Asking the gateway…' }, async () => {
      const status = await gatewayApi.status(ctx.connection());
      return status;
    });
    if (!loaded) return;

    const certs = loaded.certificates;
    const choice = await select<string>({
      breadcrumb: CRUMB,
      title: 'Domains and certificates',
      subtitle: certs.length
        ? `${certs.filter((c) => c.state === 'valid').length} of ${certs.length} valid`
        : 'No web service uses a domain yet.',
      body: certs.length
        ? [color.gray(`Every hostname here must have an A record pointing at ${loaded.gateway.publicIp}.`)]
        : [color.gray('Add a website under "Services" and its certificate will appear here.')],
      items: [
        ...certs.map((c) => ({
          value: `open:${c.hostname}`,
          label: c.hostname,
          badge: certBadge(c.state),
          hint: certHint(c),
        })),
        { value: 'back', label: '← Back' },
      ],
    });

    if (choice === CANCEL || choice === 'back') return;
    await certActions(ctx, choice.slice(5), loaded.gateway.publicIp);
  }
}

async function certActions(ctx: Ctx, hostname: string, publicIp: string): Promise<void> {
  for (;;) {
    const loaded = await attempt({ breadcrumb: CRUMB, title: hostname, label: 'Loading…' }, async () => {
      const { certificates } = await gatewayApi.certificates(ctx.connection());
      return certificates.find((c) => c.hostname === hostname) ?? null;
    });
    if (!loaded) return;
    const cert = loaded;

    const choice = await select<string>({
      breadcrumb: `${CRUMB} / ${hostname}`,
      title: hostname,
      subtitle: explain(cert),
      body: keyValue([
        ['Certificate', certBadge(cert.state)],
        ['Issuer', cert.issuer || color.gray('—')],
        ['Expires', cert.expiresAt ? new Date(cert.expiresAt).toLocaleDateString() : color.gray('—')],
        ['Auto-renew', cert.autoRenew ? color.green('on') : color.gray('off')],
        ...(cert.detail ? ([['Waiting on', cert.detail]] as [string, string][]) : []),
        ...(cert.error ? ([['Error', color.yellow(cert.error)]] as [string, string][]) : []),
        ...(cert.nextAttemptAt
          ? ([['Next attempt', new Date(cert.nextAttemptAt).toLocaleTimeString()]] as [string, string][])
          : []),
      ]),
      filterable: false,
      items: [
        { value: 'dns', label: 'Show the DNS record I need' },
        { value: 'reissue', label: 'Request the certificate again' },
        { value: 'back', label: '← Back' },
      ],
    });

    if (choice === CANCEL || choice === 'back') return;

    if (choice === 'dns') {
      await page({
        breadcrumb: `${CRUMB} / ${hostname}`,
        title: 'DNS record',
        subtitle: 'Add this wherever your domain is managed.',
        body: [
          ...keyValue([
            ['Type', 'A'],
            ['Name', hostname],
            ['Value', color.cyan(publicIp)],
            ['TTL', 'automatic, or 300'],
          ]),
          '',
          color.gray('Check it took effect with:'),
          ` ${color.cyan(`dig +short ${hostname}`)}`,
          '',
          color.gray('Cloudflare: keep the record "DNS only" (grey cloud) until the certificate'),
          color.gray('is issued, or the challenge cannot reach your gateway.'),
        ],
      });
      continue;
    }

    if (choice === 'reissue') {
      const done = await attempt(
        { breadcrumb: CRUMB, title: hostname, label: 'Asking Let\'s Encrypt…' },
        () => gatewayApi.reissueCertificate(ctx.connection(), hostname),
      );
      if (done) {
        await page({
          breadcrumb: CRUMB,
          title: 'Certificate requested',
          notice: 'The gateway is working on it — usually under a minute.',
          body: [color.gray('It can only succeed once the DNS record above is live.')],
        });
      }
    }
  }
}

function certHint(cert: CertificateView): string {
  if (cert.state === 'valid' && cert.expiresAt) {
    return `Valid until ${new Date(cert.expiresAt).toLocaleDateString()}${cert.autoRenew ? ', renews itself' : ''}`;
  }
  if (cert.state === 'pending') return cert.detail ?? 'Waiting for Let\'s Encrypt';
  if (cert.state === 'error') return cert.error ?? 'The last attempt failed';
  return 'No certificate yet';
}

function explain(cert: CertificateView): string {
  switch (cert.state) {
    case 'valid':
      return 'HTTPS is working for this hostname.';
    case 'pending':
      return 'Being issued — this needs the DNS record to be live.';
    case 'error':
      return 'The last attempt failed.';
    default:
      return 'No certificate has been issued yet.';
  }
}
