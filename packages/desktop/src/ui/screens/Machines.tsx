import React, { useState } from 'react';
import { api, relativeTime, type MachineView, type TunnelStatus } from '../api.js';
import { Alert, Dot, Empty, Modal } from '../components.js';

export function Machines({
  machines,
  agentStatus,
  hasGateway,
  onChanged,
  notify,
}: {
  machines: MachineView[];
  agentStatus: TunnelStatus | null;
  hasGateway: boolean;
  onChanged: () => void;
  notify: (message: string, tone?: 'info' | 'error') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<MachineView | null>(null);

  const thisMachineId = agentStatus?.machineId ?? null;
  const connected = agentStatus?.state === 'connected';

  const connectThisComputer = async () => {
    setBusy(true);
    try {
      await api.agent.connect();
      notify('This computer is connected.');
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1>Machines</h1>
      <p className="subtitle">
        Computers that can serve traffic through your gateway. Each one has its own certificate and
        can be revoked on its own.
      </p>

      <div className="card">
        <div className="card-head">
          <span className="card-title">This computer</span>
          <span className="card-actions">
            {thisMachineId ? (
              <>
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await (connected ? api.agent.stop() : api.agent.start());
                      onChanged();
                    } catch (err) {
                      notify(err instanceof Error ? err.message : String(err), 'error');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {connected ? 'Disconnect' : 'Connect'}
                </button>
                <button
                  className="btn small danger"
                  disabled={busy}
                  onClick={async () => {
                    await api.agent.disconnect();
                    notify('This computer has been unlinked from the gateway.');
                    onChanged();
                  }}
                >
                  Unlink
                </button>
              </>
            ) : (
              <button className="btn small primary" disabled={busy || !hasGateway} onClick={() => void connectThisComputer()}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            )}
          </span>
        </div>

        {!hasGateway && (
          <Alert tone="info">Set up a gateway first — a machine connects to a gateway, not to LocalTunnel.</Alert>
        )}

        {agentStatus ? (
          <>
            <div className="status-row">
              <span className="label">Connection</span>
              <Dot
                tone={
                  agentStatus.state === 'connected'
                    ? 'green'
                    : agentStatus.state === 'reconnecting' || agentStatus.state === 'connecting'
                      ? 'amber'
                      : agentStatus.state === 'revoked'
                        ? 'red'
                        : 'grey'
                }
              />
              <span className="value">{stateLabel(agentStatus)}</span>
            </div>
            {agentStatus.state === 'connected' && (
              <>
                <div className="status-row">
                  <span className="label">Latency</span>
                  <span className="value">
                    {agentStatus.latencyMs === null ? 'measuring…' : `${agentStatus.latencyMs} ms`}
                  </span>
                </div>
                <div className="status-row">
                  <span className="label">Tunnel</span>
                  <span className="value">Encrypted (TLS 1.3)</span>
                </div>
                <div className="status-row">
                  <span className="label">Reconnect</span>
                  <span className="value">Automatic</span>
                </div>
              </>
            )}
            {agentStatus.lastError && agentStatus.state !== 'connected' && (
              <Alert tone={agentStatus.state === 'revoked' ? 'error' : 'warn'}>{agentStatus.lastError}</Alert>
            )}
          </>
        ) : (
          <div style={{ color: 'var(--text-secondary)' }}>The LocalTunnel agent is not running.</div>
        )}
      </div>

      <h2>All machines</h2>
      {machines.length === 0 ? (
        <Empty title="No machines yet" description="Connect this computer to start serving traffic." />
      ) : (
        machines.map((machine) => (
          <div className="card" key={machine.id}>
            <div className="card-head">
              <Dot tone={machine.revoked ? 'grey' : machine.connected ? 'green' : 'red'} />
              <span className="card-title">{machine.name}</span>
              {machine.id === thisMachineId && <span className="pill">This computer</span>}
              <span className="card-actions">
                {!machine.revoked && (
                  <button className="btn small danger" onClick={() => setConfirming(machine)}>
                    Revoke
                  </button>
                )}
                {machine.revoked && (
                  <button
                    className="btn small ghost"
                    onClick={async () => {
                      await api.machine.remove(machine.id);
                      onChanged();
                    }}
                  >
                    Remove
                  </button>
                )}
              </span>
            </div>
            <div style={{ fontSize: 'var(--text-small)', color: 'var(--text-secondary)' }}>
              {machine.revoked
                ? 'Revoked'
                : machine.connected
                  ? `Connected · ${machine.latencyMs ?? '—'} ms · ${machine.activeStreams} open connections`
                  : `Last seen ${relativeTime(machine.lastSeenAt)}`}
              {' · '}
              {machine.os}/{machine.arch}
              {' · '}
              {machine.serviceCount} service{machine.serviceCount === 1 ? '' : 's'}
            </div>
          </div>
        ))
      )}

      {confirming && (
        <Modal title={`Revoke ${confirming.name}?`} onClose={() => setConfirming(null)}>
          <p>
            Its tunnel is closed immediately and its certificate stops working, so any services on it
            go offline at once. The machine can be connected again later — it will get a new identity.
          </p>
          <div className="btn-row">
            <button
              className="btn danger"
              onClick={async () => {
                try {
                  await api.machine.revoke(confirming.id);
                  notify(`${confirming.name} revoked.`);
                  onChanged();
                } catch (err) {
                  notify(err instanceof Error ? err.message : String(err), 'error');
                }
                setConfirming(null);
              }}
            >
              Revoke machine
            </button>
            <button className="btn ghost" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function stateLabel(status: TunnelStatus): string {
  switch (status.state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return status.retryInSeconds !== null
        ? `Reconnecting — retrying in ${status.retryInSeconds}s (attempt ${status.attempts})`
        : 'Reconnecting…';
    case 'revoked':
      return 'Revoked by the gateway';
    case 'error':
      return 'Error';
    default:
      return 'Not connected';
  }
}
