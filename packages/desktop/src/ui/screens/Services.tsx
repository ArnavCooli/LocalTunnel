import React, { useEffect, useState } from 'react';
import {
  api,
  formatBytes,
  formatNumber,
  type GatewayStatusResult,
  type MachineView,
  type ServiceView,
  type TunnelStatus,
} from '../api.js';
import {
  Alert,
  Copyable,
  Dot,
  Empty,
  Field,
  Modal,
  SERVICE_ICONS,
  serviceStatusLabel,
  serviceStatusTone,
} from '../components.js';
import { DnsInstructions } from './Domains.js';

type ServiceKind = 'website' | 'api' | 'minecraft' | 'ssh' | 'tcp' | 'udp';

const KINDS: { id: ServiceKind; icon: string; title: string; description: string; type: 'http' | 'tcp' | 'udp'; port?: number }[] = [
  { id: 'website', icon: '🌐', title: 'Website', description: 'A web app or site on a local port.', type: 'http', port: 3000 },
  { id: 'api', icon: '⚙️', title: 'API', description: 'An HTTP API or webhook receiver.', type: 'http', port: 8080 },
  { id: 'minecraft', icon: '🎮', title: 'Minecraft', description: 'A Java Edition server.', type: 'tcp', port: 25565 },
  { id: 'ssh', icon: '🔑', title: 'SSH', description: 'Remote shell access to this computer.', type: 'tcp', port: 22 },
  { id: 'tcp', icon: '🔌', title: 'Custom TCP', description: 'Any other TCP service.', type: 'tcp' },
  { id: 'udp', icon: '📡', title: 'Custom UDP', description: 'Bedrock Minecraft, game servers, and similar.', type: 'udp', port: 19132 },
];

export function Services({
  services,
  machines,
  gatewayStatus,
  agentStatus,
  onChanged,
  onDiagnose,
  notify,
  initialServiceId,
  onConsumedInitial,
}: {
  services: ServiceView[];
  machines: MachineView[];
  gatewayStatus: GatewayStatusResult;
  agentStatus: TunnelStatus | null;
  onChanged: () => void;
  onDiagnose: (serviceId: string) => void;
  notify: (message: string, tone?: 'info' | 'error') => void;
  /** Set when the user clicked a service elsewhere and expects it to open here. */
  initialServiceId?: string | null;
  onConsumedInitial?: () => void;
}) {
  const [exposing, setExposing] = useState(false);
  const [managing, setManaging] = useState<ServiceView | null>(null);
  const gatewayIp = gatewayStatus?.ok ? gatewayStatus.gateway.publicIp : null;

  useEffect(() => {
    if (!initialServiceId) return;
    const service = services.find((s) => s.id === initialServiceId);
    if (service) {
      setManaging(service);
      onConsumedInitial?.();
    }
  }, [initialServiceId, services, onConsumedInitial]);

  return (
    <div className="page page-wide">
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <div>
          <h1>Services</h1>
          <p className="subtitle">Everything you have published to the internet.</p>
        </div>
        <button
          className="btn primary"
          style={{ marginLeft: 'auto' }}
          onClick={() => setExposing(true)}
          disabled={machines.length === 0}
        >
          + Expose a Service
        </button>
      </div>

      {machines.length === 0 && (
        <Alert tone="info" title="Connect a computer first">
          Open the Machines tab and connect this computer to your gateway. Services belong to a
          machine, so there has to be one before you can publish anything.
        </Alert>
      )}

      {services.length === 0 ? (
        <Empty
          title="No services yet"
          description="Publish something running on this computer — a website on localhost:3000, a game server, an API."
          action={
            <button className="btn primary" onClick={() => setExposing(true)} disabled={machines.length === 0}>
              + Expose a Service
            </button>
          }
        />
      ) : (
        <div className="grid">
          {services.map((service) => (
            <ServiceCard
              key={service.id}
              service={service}
              machine={machines.find((m) => m.id === service.machineId)}
              onManage={() => setManaging(service)}
            />
          ))}
        </div>
      )}

      {exposing && (
        <ExposeService
          machines={machines}
          gatewayIp={gatewayIp}
          agentStatus={agentStatus}
          existing={services}
          onClose={() => setExposing(false)}
          onCreated={(service) => {
            setExposing(false);
            onChanged();
            notify(
              service?.publicUrl
                ? `Published at ${service.publicUrl}`
                : 'Service published.',
            );
          }}
          notify={notify}
        />
      )}

      {managing && (
        <ManageService
          service={managing}
          gatewayIp={gatewayIp}
          onClose={() => setManaging(null)}
          onChanged={() => {
            setManaging(null);
            onChanged();
          }}
          onDiagnose={() => {
            const id = managing.id;
            setManaging(null);
            onDiagnose(id);
          }}
          notify={notify}
        />
      )}
    </div>
  );
}

function ServiceCard({
  service,
  machine,
  onManage,
}: {
  service: ServiceView;
  machine?: MachineView;
  onManage: () => void;
}) {
  const target = `${service.localHost}:${service.localPort}`;
  return (
    <div className="card">
      <div className="card-head">
        <span>{SERVICE_ICONS[service.type]}</span>
        <span className="card-title">{service.name}</span>
        <span className="card-actions">
          <button className="btn small ghost" onClick={onManage}>
            Manage
          </button>
        </span>
      </div>

      <div style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-small)', color: 'var(--accent)', marginBottom: 10 }}>
        {service.publicUrl ?? '—'}
      </div>

      <div className="status-row" style={{ padding: '3px 0' }}>
        <Dot tone={serviceStatusTone(service.status)} />
        <span>{serviceStatusLabel(service.status)}</span>
      </div>
      <div style={{ fontSize: 'var(--text-small)', color: 'var(--text-secondary)' }}>
        {target} on {machine?.name ?? 'unknown machine'}
      </div>

      {service.expiresAt && (
        <div className="pill" style={{ marginTop: 9 }}>
          Temporary — expires {new Date(service.expiresAt).toLocaleString()}
        </div>
      )}

      <div className="stat-row" style={{ marginTop: 14 }}>
        <div className="stat">
          <div className="stat-value">{formatBytes(service.stats.bytesIn + service.stats.bytesOut)}</div>
          <div className="stat-label">Traffic</div>
        </div>
        <div className="stat">
          <div className="stat-value">
            {formatNumber(service.type === 'http' || service.type === 'https' ? service.stats.requests : service.stats.connections)}
          </div>
          <div className="stat-label">{service.type === 'http' || service.type === 'https' ? 'Requests' : 'Connections'}</div>
        </div>
        {service.certificate && (
          <div className="stat">
            <div className="stat-value" style={{ fontSize: 'var(--text-body)' }}>
              {service.certificate.state === 'valid' ? '✓ Valid' : service.certificate.state}
            </div>
            <div className="stat-label">TLS</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The "what are you exposing?" flow. */
function ExposeService({
  machines,
  gatewayIp,
  agentStatus,
  existing,
  onClose,
  onCreated,
  notify,
}: {
  machines: MachineView[];
  gatewayIp: string | null;
  agentStatus: TunnelStatus | null;
  existing: ServiceView[];
  onClose: () => void;
  onCreated: (service: ServiceView) => void;
  notify: (message: string, tone?: 'info' | 'error') => void;
}) {
  const [kind, setKind] = useState<ServiceKind | null>(null);
  const [discovered, setDiscovered] = useState<{ port: number; guess: string }[]>([]);
  const [form, setForm] = useState({
    name: '',
    localHost: '127.0.0.1',
    localPort: '3000',
    hostname: '',
    publicPort: '',
    machineId: machines[0]?.id ?? '',
    temporary: false,
    ttl: '24h',
    allowLanTarget: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.agent.discover().then((result) => {
      const found = (result as { services: { port: number; guess: string }[] }).services ?? [];
      setDiscovered(found);
    });
  }, []);

  const definition = KINDS.find((k) => k.id === kind);
  const isWeb = definition?.type === 'http';
  const isLan = !['127.0.0.1', 'localhost', '::1'].includes(form.localHost.trim());

  const choose = (id: ServiceKind) => {
    const def = KINDS.find((k) => k.id === id)!;
    setKind(id);
    setForm((f) => ({
      ...f,
      name: def.title,
      localPort: String(def.port ?? f.localPort),
      publicPort: def.type === 'tcp' || def.type === 'udp' ? String(def.port ?? '') : '',
    }));
  };

  const submit = async () => {
    setError(null);
    if (!definition) return;
    if (isWeb && !form.temporary && !form.hostname.trim()) {
      setError('Enter the public hostname visitors will use, e.g. mysite.example.com.');
      return;
    }
    if (existing.some((s) => s.hostname && s.hostname === form.hostname.trim().toLowerCase())) {
      setError('That hostname is already used by another service.');
      return;
    }

    setSaving(true);
    try {
      const expiresAt = form.temporary
        ? new Date(Date.now() + { '1h': 3600e3, '24h': 86400e3, '7d': 604800e3 }[form.ttl]!).toISOString()
        : null;
      const created = (await api.service.create({
        machineId: form.machineId,
        name: form.name || definition.title,
        type: definition.type,
        localHost: form.localHost.trim(),
        localPort: Number(form.localPort),
        hostname: isWeb ? form.hostname.trim().toLowerCase() : null,
        publicPort: isWeb ? null : Number(form.publicPort),
        allowLanTarget: isLan,
        expiresAt,
      })) as ServiceView;
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Expose a Service" onClose={onClose}>
      {!kind ? (
        <>
          <p className="section-hint">What are you exposing?</p>
          {KINDS.map((k) => (
            <button key={k.id} className="choice" onClick={() => choose(k.id)}>
              <span className="choice-icon">{k.icon}</span>
              <span>
                <span className="choice-title">{k.title}</span>
                <span className="choice-desc" style={{ display: 'block' }}>
                  {k.description}
                </span>
              </span>
            </button>
          ))}
        </>
      ) : (
        <>
          {discovered.length > 0 && (
            <Alert tone="info" title="Found running on this computer">
              {discovered.map((d) => (
                <button
                  key={d.port}
                  className="btn small"
                  style={{ marginRight: 8, marginTop: 6 }}
                  onClick={() => setForm((f) => ({ ...f, localPort: String(d.port) }))}
                >
                  localhost:{d.port}
                </button>
              ))}
            </Alert>
          )}

          <Field label="Name" hint="Shown in LocalTunnel only.">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>

          <div className="field-row">
            <Field label="Local address" hint="Where it is running on your network.">
              <input value={form.localHost} onChange={(e) => setForm({ ...form, localHost: e.target.value })} />
            </Field>
            <Field label="Local port">
              <input value={form.localPort} onChange={(e) => setForm({ ...form, localPort: e.target.value })} />
            </Field>
          </div>

          {isLan && (
            <Alert tone="warn" title="This is another device on your network">
              {form.localHost} is not this computer. Make sure you have permission to expose it —
              anything published here is reachable from the public internet.
            </Alert>
          )}

          {isWeb ? (
            <>
              <div className="checkbox">
                <input
                  type="checkbox"
                  id="temporary"
                  checked={form.temporary}
                  onChange={(e) => setForm({ ...form, temporary: e.target.checked })}
                />
                <label htmlFor="temporary" style={{ margin: 0 }}>
                  Expose temporarily
                  <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-caption)' }}>
                    Get a link straight away without setting up DNS. Useful for webhooks and sharing a
                    dev server.
                  </div>
                </label>
              </div>

              {form.temporary ? (
                <Field
                  label="Keep it public for"
                  hint="LocalTunnel generates the public address for you — no domain or DNS needed. You will see the link as soon as it is published."
                >
                  <select value={form.ttl} onChange={(e) => setForm({ ...form, ttl: e.target.value })}>
                    <option value="1h">1 hour</option>
                    <option value="24h">24 hours</option>
                    <option value="7d">7 days</option>
                  </select>
                </Field>
              ) : (
                <Field
                  label="Public hostname"
                  hint="The address visitors will type. You will point its DNS at your gateway next."
                >
                  <input
                    value={form.hostname}
                    onChange={(e) => setForm({ ...form, hostname: e.target.value })}
                    placeholder="mysite.example.com"
                  />
                </Field>
              )}
            </>
          ) : (
            <Field
              label="Public port"
              hint={`Visitors will connect to ${gatewayIp ?? 'your gateway'}:${form.publicPort || '…'}. LocalTunnel opens this port on the server for you.`}
            >
              <input value={form.publicPort} onChange={(e) => setForm({ ...form, publicPort: e.target.value })} />
            </Field>
          )}

          {machines.length > 1 && (
            <Field label="Machine" hint="Which computer hosts this service.">
              <select value={form.machineId} onChange={(e) => setForm({ ...form, machineId: e.target.value })}>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.connected ? '' : ' (offline)'}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {agentStatus?.state !== 'connected' && (
            <Alert tone="warn" title="This computer is not connected">
              You can still publish the service — it will start working as soon as the tunnel comes
              back up.
            </Alert>
          )}

          {error && <Alert tone="error">{error}</Alert>}

          <div className="btn-row">
            <button className="btn primary" onClick={() => void submit()} disabled={saving}>
              {saving ? 'Publishing…' : 'Publish'}
            </button>
            <button className="btn ghost" onClick={() => setKind(null)}>
              Back
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ManageService({
  service,
  gatewayIp,
  onClose,
  onChanged,
  onDiagnose,
  notify,
}: {
  service: ServiceView;
  gatewayIp: string | null;
  onClose: () => void;
  onChanged: () => void;
  onDiagnose: () => void;
  notify: (message: string, tone?: 'info' | 'error') => void;
}) {
  const [busy, setBusy] = useState(false);
  const web = service.type === 'http' || service.type === 'https';

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      notify(message);
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={service.name} onClose={onClose}>
      <div className="status-row">
        <Dot tone={serviceStatusTone(service.status)} />
        <span>{serviceStatusLabel(service.status)}</span>
      </div>
      {service.localError && <Alert tone="warn">{service.localError}</Alert>}

      <div className="card" style={{ marginTop: 14 }}>
        <table className="record-table">
          <tbody>
            <tr>
              <td>Public</td>
              <td>{service.publicUrl ?? '—'}</td>
            </tr>
            <tr>
              <td>Local</td>
              <td>
                {service.localHost}:{service.localPort}
              </td>
            </tr>
            <tr>
              <td>Traffic</td>
              <td>{formatBytes(service.stats.bytesIn + service.stats.bytesOut)}</td>
            </tr>
            {web && (
              <tr>
                <td>Responses</td>
                <td>
                  {formatNumber(service.stats.status2xx)} 2xx · {formatNumber(service.stats.status4xx)} 4xx ·{' '}
                  {formatNumber(service.stats.status5xx)} 5xx
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {service.certificate && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>
            TLS certificate
          </div>
          <div className="status-row" style={{ padding: '2px 0' }}>
            <Dot tone={service.certificate.state === 'valid' ? 'green' : service.certificate.state === 'error' ? 'red' : 'amber'} />
            <span>{service.certificate.state === 'valid' ? 'Valid' : service.certificate.state}</span>
          </div>
          {service.certificate.expiresAt && (
            <div style={{ fontSize: 'var(--text-small)', color: 'var(--text-secondary)' }}>
              Expires {new Date(service.certificate.expiresAt).toDateString()} · Auto-renew{' '}
              {service.certificate.autoRenew ? 'enabled' : 'off'} · {service.certificate.issuer}
            </div>
          )}
          {service.certificate.state === 'pending' && service.certificate.detail && (
            <Alert tone="info" title="Waiting for DNS">
              {service.certificate.detail}
            </Alert>
          )}
          {service.certificate.error && (
            <Alert tone="warn">
              {service.certificate.error}
              {service.certificate.detail && <div style={{ marginTop: 6 }}>{service.certificate.detail}</div>}
            </Alert>
          )}
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button
              className="btn small"
              disabled={busy}
              onClick={() => void act(() => api.cert.reissue(service.hostname!), 'Certificate requested.')}
            >
              Reissue certificate
            </button>
          </div>
        </div>
      )}

      {web && service.hostname && gatewayIp && (
        <details className="disclosure">
          <summary>DNS record for {service.hostname}</summary>
          <DnsInstructions hostname={service.hostname} gatewayIp={gatewayIp} />
        </details>
      )}

      {!web && service.publicPort && gatewayIp && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>
            Connect to this service
          </div>
          <Copyable value={`${gatewayIp}:${service.publicPort}`} />
        </div>
      )}

      <div className="btn-row">
        <button className="btn" onClick={onDiagnose}>
          Run diagnostics
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            void act(
              () => api.service.update(service.id, { enabled: !service.enabled }),
              service.enabled ? 'Service disabled.' : 'Service enabled.',
            )
          }
        >
          {service.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          className="btn danger"
          disabled={busy}
          onClick={() => void act(() => api.service.remove(service.id), 'Service removed.')}
        >
          Remove
        </button>
      </div>
    </Modal>
  );
}
