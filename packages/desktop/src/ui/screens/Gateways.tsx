import React, { useEffect, useState } from 'react';
import { api, formatBytes, type GatewayStatusResult, type GatewaySummary } from '../api.js';
import { Alert, Copyable, Dot, Empty, Field, Modal } from '../components.js';
import { providerById } from '../../providers/catalog.js';
import { InstallGateway } from './InstallGateway.js';
import { SignInWithToken } from './SignInWithToken.js';
import { UninstallGateway } from './UninstallGateway.js';

interface GatewayCredentials {
  name: string;
  host: string;
  port: number;
  fingerprint: string;
  adminToken: string | null;
  /** False when the OS keychain will not give the token back. */
  readable: boolean;
}

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
  const [updating, setUpdating] = useState<GatewaySummary | null>(null);
  const [uninstalling, setUninstalling] = useState<GatewaySummary | null>(null);
  const [showingDetails, setShowingDetails] = useState<GatewaySummary | null>(null);

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
                  <button className="btn small" onClick={() => setShowingDetails(gateway)}>
                    Connection details
                  </button>
                  <button className="btn small" onClick={() => setUpdating(gateway)}>
                    Update
                  </button>
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
                          <td style={{ fontFamily: 'inherit', color: 'var(--text-secondary)' }}>
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

      {showingDetails && (
        <ConnectionDetails gateway={showingDetails} onClose={() => setShowingDetails(null)} />
      )}

      {updating && (
        <Modal title={`Update ${updating.name}`} onClose={() => setUpdating(null)}>
          <Alert tone="info" title="What an update changes">
            The gateway program on your server is replaced with the version bundled in this app.
            Your machines, services, certificates and the gateway's identity are all kept, so
            enrolled computers keep working and you will not need to re-enrol anything. Services are
            offline for the few seconds it takes to restart.
          </Alert>
          <p className="section-hint">
            LocalTunnel needs SSH access again — it does not keep your key after installing.
          </p>
          <InstallGateway
            providerId={updating.provider}
            defaultHost={updating.host}
            defaultUsername={updating.sshUsername}
            defaultPort={updating.sshPort}
            onInstalled={() => {
              setUpdating(null);
              onChanged();
              notify('Gateway updated.');
            }}
            onCancel={() => setUpdating(null)}
          />
        </Modal>
      )}

      {uninstalling && (
        <UninstallGateway
          gateway={uninstalling}
          onClose={() => setUninstalling(null)}
          onDone={(removed) => {
            setUninstalling(null);
            onChanged();
            notify(removed ? 'Gateway removed from your server.' : 'The server was not fully cleaned up.',
              removed ? 'info' : 'error');
          }}
        />
      )}

      {addingExisting && (
        <Modal title="Sign in to an existing gateway" onClose={() => setAddingExisting(false)}>
          <SignInWithToken
            onAdded={() => {
              setAddingExisting(false);
              onChanged();
              notify('Gateway added.');
            }}
            onCancel={() => setAddingExisting(false)}
          />
        </Modal>
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
            <button
              className="btn danger"
              onClick={() => {
                const target = removing;
                setRemoving(null);
                setUninstalling(target);
              }}
            >
              Also remove it from the server…
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
/**
 * The four details that identify a gateway, for putting into the terminal client,
 * another computer's copy of this app, or a password manager.
 *
 * The admin token is fetched only when this opens, and stays masked until asked
 * for: the server keeps nothing but a hash of it, so this app is the only place
 * it still exists once the installer's output has scrolled away.
 */
function ConnectionDetails({ gateway, onClose }: { gateway: GatewaySummary; onClose: () => void }) {
  const [details, setDetails] = useState<GatewayCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    void api.gateway
      .credentials(gateway.id)
      .then((result) => setDetails(result as GatewayCredentials | null))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [gateway.id]);

  return (
    <Modal title={`${gateway.name} — connection details`} onClose={onClose}>
      <p className="section-hint">
        Anything that needs to manage this gateway needs these four. The terminal client can
        fetch them over SSH by itself; this is here for when you would rather copy them, or want
        the admin token somewhere safe.
      </p>

      {error && <Alert tone="error">{error}</Alert>}

      {details && (
        <>
          <Field label="Server address">
            <Copyable value={details.host} />
          </Field>
          <Field label="Admin port">
            <Copyable value={String(details.port)} />
          </Field>
          <Field label="Certificate fingerprint" hint="Not a secret. It is what proves the server you reach is this one.">
            <Copyable value={details.fingerprint} />
          </Field>
          <Field
            label="Admin token"
            hint="Full control of this gateway. Treat it like a password."
          >
            {!details.readable ? (
              <Alert tone="error" title="This token cannot be read back">
                The system keychain would not release it — most often because this app was
                reinstalled or the login keychain changed. Reinstalling or re-adding the gateway
                issues a new token.
              </Alert>
            ) : revealed ? (
              <Copyable value={details.adminToken ?? ''} />
            ) : (
              <div className="btn-row">
                <button className="btn" onClick={() => setRevealed(true)}>
                  Reveal admin token
                </button>
              </div>
            )}
          </Field>
        </>
      )}

      <Alert tone="info" title="Using the terminal client on another computer">
        Run <code>localtunnel</code> there, choose Gateways → Add a gateway → Enter the details by
        hand, and paste these in. Signing in over SSH instead needs nothing from this screen.
      </Alert>

      <div className="btn-row">
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
