import React, { useEffect, useState } from 'react';
import { api, type AppState } from '../api.js';
import { Alert, Copyable, ExternalLink, Modal } from '../components.js';

export function Settings({
  state,
  onChanged,
  notify,
  onReset,
  gatewayForCleanup,
  onRequestServerCleanup,
}: {
  state: AppState | null;
  onChanged: () => void;
  notify: (message: string, tone?: 'info' | 'error') => void;
  /** Sends the app back to the first-launch screen after a reset. */
  onReset: () => void;
  /** The active gateway, so a reset can offer to clean the server too. */
  gatewayForCleanup?: { id: string; name: string; host: string; sshUsername?: string | null; sshPort?: number } | null;
  onRequestServerCleanup: (gateway: { id: string; name: string; host: string; sshUsername?: string | null; sshPort?: number }) => void;
}) {
  const [logs, setLogs] = useState<string[]>([]);
  const [gatewayLogHint, setGatewayLogHint] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [done, setDone] = useState<string[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [alsoRemoveServer, setAlsoRemoveServer] = useState(false);

  useEffect(() => {
    const unsubscribe = api.agent.onLog((line) => setLogs((current) => [...current.slice(-300), line.trimEnd()]));
    void api.logs.gateway().then((result) => setGatewayLogHint((result as { hint: string | null }).hint));
    return unsubscribe;
  }, []);

  const toggle = async (key: string, value: boolean | string) => {
    await api.app.updateSettings({ [key]: value });
    notify('Setting saved.');
    onChanged();
  };

  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="subtitle">LocalTunnel {state?.version} on {state?.platform}</p>

      <div className="card">
        <div className="checkbox">
          <input
            type="checkbox"
            id="agentAutostart"
            checked={state?.settings.agentAutostart ?? true}
            onChange={(e) => void toggle('agentAutostart', e.target.checked)}
          />
          <label htmlFor="agentAutostart" style={{ margin: 0 }}>
            Keep services online when LocalTunnel is closed
            <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-caption)' }}>
              Runs the tunnel as a background service that starts with your computer. Turning this off
              means your sites go down when you quit the app.
            </div>
          </label>
        </div>

        <div className="checkbox">
          <input
            type="checkbox"
            id="launchAtLogin"
            checked={state?.settings.launchAtLogin ?? true}
            onChange={(e) => void toggle('launchAtLogin', e.target.checked)}
          />
          <label htmlFor="launchAtLogin" style={{ margin: 0 }}>
            Open LocalTunnel at login
          </label>
        </div>

        <div className="field" style={{ marginTop: 14, marginBottom: 0, maxWidth: 220 }}>
          <label>Appearance</label>
          <select
            value={state?.settings.theme ?? 'system'}
            onChange={(e) => void toggle('theme', e.target.value)}
          >
            <option value="system">Match system</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
      </div>

      <h2>Logs</h2>
      <p className="section-hint">Agent activity on this computer.</p>
      <div className="console">{logs.length ? logs.join('\n') : 'No agent output yet.'}</div>

      {gatewayLogHint && (
        <>
          <h3 style={{ marginTop: 20 }}>Gateway logs</h3>
          <p className="section-hint">
            The gateway keeps its own logs on your server. LocalTunnel does not hold an SSH session
            open after installing, so read them there:
          </p>
          <Copyable value={gatewayLogHint} />
        </>
      )}

      <h2>Uninstall</h2>
      <Alert tone="info" title="Two separate things">
        Removing the agent stops this computer from serving traffic. Your gateway keeps running on
        your VPS until you remove it there with <code>sudo /opt/localtunnel/uninstall.sh</code>.
      </Alert>
      <div className="btn-row">
        <button className="btn danger" onClick={() => setConfirmUnlink(true)} disabled={unlinking}>
          {unlinking ? 'Stopping…' : 'Stop and unlink the agent'}
        </button>
      </div>

      {done.length > 0 && (
        <Alert tone="success" title="This computer has been unlinked">
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {done.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </Alert>
      )}

      {confirmUnlink && (
        <Modal title="Stop and unlink this computer?" onClose={() => setConfirmUnlink(false)}>
          <p style={{ marginTop: 0 }}>This will:</p>
          <ul style={{ paddingLeft: 18, color: 'var(--text-secondary)' }}>
            <li>Take any services hosted on this computer offline immediately</li>
            <li>Stop the background agent and remove it from starting at login</li>
            <li>Delete this machine's certificate from this computer</li>
            <li>Revoke this machine on the gateway, so that certificate cannot be reused</li>
          </ul>
          <p style={{ color: 'var(--text-secondary)' }}>
            Your gateway and its other machines are unaffected. You can connect this computer again
            later — it will be issued a new identity.
          </p>
          <div className="btn-row">
            <button
              className="btn danger"
              disabled={unlinking}
              onClick={async () => {
                setUnlinking(true);
                setConfirmUnlink(false);
                try {
                  const result = (await api.agent.disconnect()) as { steps?: string[] };
                  setDone(result.steps ?? []);
                  notify('This computer has been unlinked.');
                  onChanged();
                } catch (err) {
                  notify(err instanceof Error ? err.message : String(err), 'error');
                } finally {
                  setUnlinking(false);
                }
              }}
            >
              Stop and unlink
            </button>
            <button className="btn ghost" onClick={() => setConfirmUnlink(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      <h2>Reset LocalTunnel</h2>
      <p className="section-hint">
        Return the app to how it was on first launch. Use this to start over, or to hand this
        computer to someone else.
      </p>
      <div className="btn-row">
        <button className="btn danger" onClick={() => setConfirmReset(true)} disabled={resetting}>
          {resetting ? 'Resetting…' : 'Reset LocalTunnel'}
        </button>
      </div>

      {confirmReset && (
        <Modal title="Reset LocalTunnel?" onClose={() => setConfirmReset(false)}>
          <p style={{ marginTop: 0 }}>This computer will be returned to first-launch state:</p>
          <ul style={{ paddingLeft: 18, color: 'var(--text-secondary)' }}>
            <li>Any services hosted here go offline immediately</li>
            <li>The agent stops, and its private key and certificate are deleted</li>
            <li>This machine is revoked on the gateway</li>
            <li>Saved gateways, admin tokens, settings and wizard progress are cleared</li>
            <li>The setup wizard starts again from the beginning</li>
          </ul>

          <div className="checkbox">
            <input
              type="checkbox"
              id="alsoServer"
              checked={alsoRemoveServer}
              onChange={(e) => setAlsoRemoveServer(e.target.checked)}
            />
            <label htmlFor="alsoServer" style={{ margin: 0 }}>
              Also remove LocalTunnel from my server
              <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-caption)' }}>
                Connects over SSH and deletes the gateway, its certificate authority and its system
                user. Your VPS keeps running — delete the instance at your provider to stop paying
                for it. Leave this off to reset only this computer.
              </div>
            </label>
          </div>

          {!alsoRemoveServer && (
            <Alert tone="warn" title="Your VPS is not touched">
              The gateway keeps running on your server, and so do services belonging to your other
              machines. To remove the gateway later, run{' '}
              <code>sudo /opt/localtunnel/uninstall.sh</code> on it.
            </Alert>
          )}

          <p style={{ color: 'var(--text-secondary)' }}>
            You will need the gateway's admin token and fingerprint to add it back, so reinstalling
            the gateway is usually simpler than reconnecting to it.
          </p>

          <div className="btn-row">
            <button
              className="btn danger"
              disabled={resetting}
              onClick={async () => {
                setResetting(true);
                setConfirmReset(false);
                try {
                  const result = (await api.app.reset()) as { steps?: string[] };
                  setDone(result.steps ?? []);
                  notify('LocalTunnel has been reset.');
                  // The server cleanup needs SSH, so it is handed to the same
                  // dialog the Gateways tab uses rather than done silently.
                  if (alsoRemoveServer && gatewayForCleanup) onRequestServerCleanup(gatewayForCleanup);
                  else onReset();
                } catch (err) {
                  notify(err instanceof Error ? err.message : String(err), 'error');
                } finally {
                  setResetting(false);
                }
              }}
            >
              Reset everything
            </button>
            <button className="btn ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      <h2>About</h2>
      <p className="section-hint">
        LocalTunnel routes your traffic through a server you own. No peer-to-peer, no mesh VPN, and
        no third-party tunnel service sits in the path.{' '}
        <ExternalLink href="https://github.com/localtunnel/localtunnel#readme">Documentation</ExternalLink>
      </p>
    </div>
  );
}
