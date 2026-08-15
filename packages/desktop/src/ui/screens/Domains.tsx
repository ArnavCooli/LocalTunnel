import React, { useState } from 'react';
import { api, type CertificateView, type ServiceView } from '../api.js';
import { Alert, Copyable, Dot, Empty, ExternalLink } from '../components.js';
import { DNS_GUIDES, dnsRecordFor } from '../../providers/dns.js';

export function Domains({
  services,
  certificates,
  gatewayIp,
  notify,
}: {
  services: ServiceView[];
  certificates: CertificateView[];
  gatewayIp: string | null;
  notify: (message: string, tone?: 'info' | 'error') => void;
}) {
  const web = services.filter((s) => s.hostname);

  return (
    <div className="page">
      <h1>Domains</h1>
      <p className="subtitle">Your hostnames, their DNS records and their TLS certificates.</p>

      {web.length === 0 ? (
        <Empty
          title="No domains yet"
          description="Publish a website with a public hostname and it will appear here."
        />
      ) : (
        web.map((service) => {
          const cert = certificates.find((c) => c.hostname === service.hostname);
          return (
            <div className="card" key={service.id}>
              <div className="card-head">
                <span className="card-title">{service.hostname}</span>
                <span className="card-actions">
                  <button
                    className="btn small"
                    onClick={async () => {
                      try {
                        await api.cert.reissue(service.hostname!);
                        notify('Certificate requested.');
                      } catch (err) {
                        notify(err instanceof Error ? err.message : String(err), 'error');
                      }
                    }}
                  >
                    Reissue
                  </button>
                </span>
              </div>
              <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 10 }}>
                {service.name} → {service.localHost}:{service.localPort}
              </div>

              <div className="status-row" style={{ padding: '3px 0' }}>
                <span className="label">TLS certificate</span>
                <Dot tone={cert?.state === 'valid' ? 'green' : cert?.state === 'error' ? 'red' : 'amber'} />
                <span>{cert ? certLabel(cert) : 'Not issued yet'}</span>
              </div>
              {cert?.error && <Alert tone="error">{cert.error}</Alert>}

              {gatewayIp && (
                <details className="disclosure" style={{ marginTop: 10 }}>
                  <summary>DNS record</summary>
                  <DnsInstructions hostname={service.hostname!} gatewayIp={gatewayIp} />
                </details>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function certLabel(cert: CertificateView): string {
  switch (cert.state) {
    case 'valid':
      return `Valid until ${cert.expiresAt ? new Date(cert.expiresAt).toDateString() : 'unknown'}${cert.autoRenew ? ' · auto-renews' : ''}`;
    case 'pending':
      return 'Being issued…';
    case 'error':
      return 'Could not be issued';
    default:
      return 'Not issued yet';
  }
}

/**
 * The DNS instructions. Shown wherever a hostname needs pointing — the guides differ
 * only in where the buttons are, so the record itself is always front and centre.
 */
export function DnsInstructions({ hostname, gatewayIp }: { hostname: string; gatewayIp: string }) {
  const record = dnsRecordFor(hostname, gatewayIp);
  const [guideId, setGuideId] = useState<string>('cloudflare');
  const [check, setCheck] = useState<{ resolved: boolean; addresses: string[]; matches: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  const guide = DNS_GUIDES.find((g) => g.id === guideId)!;

  return (
    <div>
      <p className="section-hint">Your domain needs to point at your gateway. Create this record:</p>
      <table className="record-table">
        <tbody>
          <tr>
            <td>Type</td>
            <td>{record.type}</td>
          </tr>
          <tr>
            <td>Name</td>
            <td>{record.name}</td>
          </tr>
          <tr>
            <td>Value</td>
            <td>{record.value}</td>
          </tr>
          <tr>
            <td>TTL</td>
            <td>{record.ttl}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ marginTop: 10 }}>
        <Copyable value={record.value} label="Copy IP" />
      </div>

      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 13, color: 'var(--text-dim)', display: 'block', marginBottom: 6 }}>
          Where is your domain registered?
        </label>
        <select
          value={guideId}
          onChange={(e) => setGuideId(e.target.value)}
          style={{
            width: '100%',
            padding: '8px 11px',
            background: 'var(--bg-inset)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 7,
          }}
        >
          {DNS_GUIDES.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>

      {guide.warning && (
        <Alert tone="warn" title="Important for Cloudflare">
          {guide.warning}
        </Alert>
      )}

      <ol className="step-list" style={{ marginTop: 12 }}>
        {guide.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      {guide.url && (
        <p style={{ fontSize: 13 }}>
          <ExternalLink href={guide.url}>Open {guide.name} ↗</ExternalLink>
        </p>
      )}

      <div className="btn-row">
        <button
          className="btn"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            try {
              const result = (await api.dns.check(hostname, gatewayIp)) as {
                resolved: boolean;
                addresses: string[];
                matches: boolean;
              };
              setCheck(result);
            } finally {
              setChecking(false);
            }
          }}
        >
          {checking ? 'Checking…' : 'Check DNS'}
        </button>
      </div>

      {check &&
        (check.matches ? (
          <Alert tone="success" title="DNS is correct">
            {hostname} points at {gatewayIp}. Your certificate can be issued.
          </Alert>
        ) : check.resolved ? (
          <Alert tone="error" title="DNS points somewhere else">
            {hostname} currently resolves to {check.addresses.join(', ')}. It needs to be {gatewayIp}.
            If you use Cloudflare, make sure the record is set to DNS only (grey cloud).
          </Alert>
        ) : (
          <Alert tone="warn" title="No DNS record yet">
            {hostname} does not resolve. New records usually take a few minutes; some registrars take
            up to an hour.
          </Alert>
        ))}
    </div>
  );
}
