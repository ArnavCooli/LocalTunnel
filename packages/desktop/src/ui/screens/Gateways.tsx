import React, { useState } from 'react';
import { api, formatBytes, type GatewayStatusResult, type GatewaySummary } from '../api.js';
import { Alert, Dot, Empty, Field, Modal } from '../components.js';
import { providerById } from '../../providers/catalog.js';

export function Gateways({
  gateways,
  status,
  onChanged,
  onAddGateway,
  notify,
}: {
  gateways: GatewaySummary[];
  status: GatewayStatusResult;
  onChanged: () => void;
  onAddGateway: () => void;
  notify: (message: string, tone?: 'info' | 'error') => void;
}) {
  const [addingExisting, setAddingExisting] = useState(false);
  const [removing, setRemoving] = useState<GatewaySummary | null>(null);

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <div>
          <h1>Gateways</h1>
          <p className="subtitle">The public servers your traffic arrives at.</p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => setAddingExisting(true)}>
            Add existing
          </button>
          <button className="btn primary" onClick={onAddGateway}>
            + New gateway
          </button>
        </div>
      </div>

      {gateways.length === 0 ? (
        <Empty
          title="No gateways yet"
          description="A gateway is a small VPS with a public IP. It is what makes your home services reachable."
          action={
            <button className="btn primary" onClick={onAddGateway}>
              Set up a gateway
            </button>
          }
        />
      ) : (
        gateways.map((gateway) => {
          const live = gateway.active ? status : null;
          const online = live?.ok === true;
          const provider = providerById(gateway.provider);
          return (
            <div className="card" key={gateway.id}>
              <div className="card-head">
                <Dot tone={gateway.active ? (online ? 'green' : 'red') : 'grey'} />
                <span className="card-title">{gateway.name}</span>
                {gateway.active && <span className="pill">Active</span>}
                <span className="card-actions">
                  {!gateway.active && (
                    <button
                      className="btn small"
                      onClick={async () => {
                        await api.gateway.setActive(gateway.id);
                        onChanged();
                      }}
                    >
                      Use this one
                    </button>
                  )}
                  <button className="btn small danger" onClick={() => setRemoving(gateway)}>
                    Remove
                  </button>
                </span>
              </div>

              <table className="record-table" style={{ marginTop: 6 }}>
                <tbody>
                  <tr>
                    <td>Provider</td>
                    <td style={{ fontFamily: 'inherit' }}>{provider?.name ?? gateway.provider}</td>
                  </tr>
                  <tr>
                    <td>Address</td>
                    <td>
                      {gateway.host}:{gateway.port}
                    </td>
                  </tr>
                  {live?.ok && (
                    <>
                      <tr>
                        <td>Version</td>
                        <td>{live.gateway.version}</td>
                      </tr>
                      <tr>
                        <td>Services</td>
                        <td>{live.services.length}</td>
                      </tr>
                      <tr>
                        <td>Machines</td>
                        <td>
                          {live.machines.filter((m) => m.connected).length} connected of {live.machines.length}
                        </td>
                      </tr>
                      <tr>
                        <td>Traffic</td>
                        <td>{formatBytes(live.gateway.totals.bytesIn + live.gateway.totals.bytesOut)}</td>
                      </tr>
                    </>
                  )}
                </tbody>
              </table>

              {gateway.active && live?.ok === false && (
                <Alert tone="error" title="This gateway is not responding">
                  {live.error}
                </Alert>
              )}

              {live?.ok && (
                <>
                  <h3 style={{ marginTop: 16 }}>Public ports</h3>
                  <table className="record-table">
                    <tbody>
                      {live.ports.map((port) => (
                        <tr key={`${port.proto}-${port.port}`}>
                          <td>
                            {port.proto.toUpperCase()} {port.port}
                          </td>
                          <td style={{ fontFamily: 'inherit', color: 'var(--text-dim)' }}>
                            {port.label} · <Dot tone="green" /> open
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="section-hint" style={{ marginTop: 10 }}>
                    LocalTunnel opens these on the server itself. If a port is unreachable from
                    outside, it is your provider's own firewall — check its security rules.
                  </p>
                </>
              )}
            </div>
          );
        })
      )}

      {addingExisting && (
        <AddExistingGateway
          onClose={() => setAddingExisting(false)}
          onAdded={() => {
            setAddingExisting(false);
            onChanged();
            notify('Gateway added.');
          }}
        />
      )}

      {removing && (
        <Modal title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}>
          <p>
            This removes the gateway from LocalTunnel on this computer. The server itself keeps
            running and keeps serving your sites — to shut it down, run{' '}
            <code>sudo /opt/localtunnel/uninstall.sh</code> on it.
          </p>
          <div className="btn-row">
            <button
              className="btn danger"
              onClick={async () => {
                await api.gateway.remove(removing.id);
                setRemoving(null);
                onChanged();
              }}
            >
              Remove from LocalTunnel
            </button>
            <button className="btn ghost" onClick={() => setRemoving(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** For a gateway installed by hand, or on another computer. */
function AddExistingGateway({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({ name: 'My Gateway', host: '', port: '443', adminToken: '', fingerprint: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.gateway.addExisting({ ...form, port: Number(form.port) || 443, provider: 'generic' });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Add an existing gateway" onClose={onClose}>
      <p className="section-hint">
        The installer prints an admin token and a certificate fingerprint when it finishes. Paste
        both here.
      </p>
      <Field label="Name">
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <div className="field-row">
        <Field label="Public IP">
          <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="129.153.0.1" />
        </Field>
        <Field label="Port">
          <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
        </Field>
      </div>
      <Field label="Admin token">
        <input value={form.adminToken} onChange={(e) => setForm({ ...form, adminToken: e.target.value })} />
      </Field>
      <Field label="Certificate fingerprint" hint="The SHA-256 fingerprint printed by the installer.">
        <input
          value={form.fingerprint}
          onChange={(e) => setForm({ ...form, fingerprint: e.target.value })}
          placeholder="A1:B2:C3:…"
        />
      </Field>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="btn-row">
        <button
          className="btn primary"
          onClick={() => void submit()}
          disabled={saving || !form.host || !form.adminToken || !form.fingerprint}
        >
          Add gateway
        </button>
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
