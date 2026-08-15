import React, { useEffect, useRef, useState } from 'react';
import { CheckmarkFilled, CircleDash, DotMark as DotIcon, ErrorFilled, FolderOpen, Key, Password } from '@carbon/icons-react';
import { api } from '../api.js';
import { Alert, Choice, Field, Modal } from '../components.js';
import type { SshCredentials } from '../../setup/ssh-keys.js';

type AuthChoice = { kind: 'none' } | { kind: 'agent' } | { kind: 'file'; path: string; encrypted: boolean };

function shorten(path: string, home: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * Removing the gateway from the user's own server.
 *
 * This is destructive and irreversible on a machine LocalTunnel does not own, so it
 * is always explicit, always confirmed, and always reports what actually happened —
 * including when it could not finish, so the user knows to clean up themselves.
 */
export function UninstallGateway({
  gateway,
  onClose,
  onDone,
}: {
  gateway: { id: string; name: string; host: string; sshUsername?: string | null; sshPort?: number };
  onClose: () => void;
  onDone: (removed: boolean) => void;
}) {
  const [credentials, setCredentials] = useState<SshCredentials | null>(null);
  const [auth, setAuth] = useState<AuthChoice>({ kind: 'none' });
  const [username, setUsername] = useState(gateway.sshUsername || 'ubuntu');
  const [passphrase, setPassphrase] = useState('');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [result, setResult] = useState<{ ok: boolean; steps: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.gateway.sshCredentials().then((raw) => {
      const found = raw as SshCredentials;
      setCredentials(found);
      setAuth((current) => {
        if (current.kind !== 'none') return current;
        if (found.agent.available) return { kind: 'agent' };
        const first = found.keys.find((k) => !k.encrypted) ?? found.keys[0];
        return first ? { kind: 'file', path: first.path, encrypted: first.encrypted } : current;
      });
    });
  }, []);

  useEffect(() => {
    return api.gateway.onUninstallProgress((raw) => {
      const event = raw as { line?: string };
      if (event.line) setOutput((lines) => [...lines.slice(-300), event.line!]);
    });
  }, []);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [output]);

  const run = async () => {
    setRunning(true);
    setError(null);
    setOutput([]);
    try {
      const res = (await api.gateway.uninstall({
        gatewayId: gateway.id,
        host: gateway.host,
        port: String(gateway.sshPort ?? 22),
        username,
        privateKeyPath: auth.kind === 'file' ? auth.path : '',
        useAgent: String(auth.kind === 'agent'),
        passphrase,
      })) as { ok: boolean; steps: string[] };
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  if (result) {
    return (
      <Modal title={result.ok ? 'Gateway removed from your server' : 'Could not finish removing it'} onClose={() => onDone(result.ok)}>
        <Alert tone={result.ok ? 'success' : 'warn'}>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {result.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </Alert>
        {!result.ok && (
          <p className="section-hint">
            You can finish by hand: <code>sudo /opt/localtunnel/uninstall.sh</code> on {gateway.host}.
            Remember your VPS itself is still running and still costs money — delete the instance at
            your provider if you no longer want it.
          </p>
        )}
        <details className="disclosure" open={!result.ok}>
          <summary>Server output</summary>
          <div className="console" ref={consoleRef}>
            {output.join('\n')}
          </div>
        </details>
        <div className="btn-row">
          <button className="btn primary" onClick={() => onDone(result.ok)}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Remove LocalTunnel from ${gateway.host}?`} onClose={onClose}>
      <p style={{ marginTop: 0 }}>This connects over SSH and removes, on your server:</p>
      <ul style={{ paddingLeft: 18, color: 'var(--text-secondary)' }}>
        <li>The gateway service, and its systemd unit</li>
        <li>
          <code>/opt/localtunnel</code>, <code>/etc/localtunnel</code> and{' '}
          <code>/var/lib/localtunnel</code> — including its certificate authority
        </li>
        <li>The <code>localtunnel</code> system user, and the firewall rules it added</li>
      </ul>

      <Alert tone="warn" title="This cannot be undone">
        Every machine enrolled with this gateway loses its identity, and every service it serves goes
        offline permanently. The VPS itself keeps running — delete the instance at your provider if
        you want to stop paying for it.
      </Alert>

      <Field label="SSH username" hint='"ubuntu" on Oracle/AWS Ubuntu, "opc" on Oracle Linux, "root" on most others.'>
        <input value={username} onChange={(e) => setUsername(e.target.value)} disabled={running} />
      </Field>

      <div className="field">
        <label>How should LocalTunnel sign in?</label>
        {credentials === null ? (
          <div className="hint">Looking for keys you already have…</div>
        ) : (
          <>
            {credentials.agent.available && (
              <Choice
                icon={<Password size={24} />}
                title="Use my SSH agent"
                description={`${credentials.agent.identities.length} key(s) loaded`}
                selected={auth.kind === 'agent'}
                onClick={() => setAuth({ kind: 'agent' })}
              />
            )}
            {credentials.keys.map((key) => (
              <Choice
                key={key.path}
                icon={<Key size={24} />}
                title={shorten(key.path, credentials.home)}
                description={`${key.type} · ${key.encrypted ? 'passphrase required' : 'no passphrase'}`}
                selected={auth.kind === 'file' && auth.path === key.path}
                onClick={() => setAuth({ kind: 'file', path: key.path, encrypted: key.encrypted })}
              />
            ))}
            <Choice
              icon={<FolderOpen size={24} />}
              title="Choose a different key file…"
              description="If the key is not in ~/.ssh"
              selected={auth.kind === 'file' && !credentials.keys.some((k) => k.path === auth.path)}
              onClick={async () => {
                const path = await api.app.pickPrivateKey();
                if (path) setAuth({ kind: 'file', path: path as string, encrypted: false });
              }}
            />
          </>
        )}
      </div>

      {auth.kind === 'file' && auth.encrypted && (
        <Field label="Key passphrase">
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} disabled={running} />
        </Field>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      {running && (
        <div className="console" ref={consoleRef} style={{ marginTop: 12 }}>
          {output.join('\n') || 'Connecting…'}
        </div>
      )}

      <div className="btn-row">
        <button className="btn danger" disabled={running || auth.kind === 'none' || !username.trim()} onClick={() => void run()}>
          {running ? 'Removing…' : 'Remove from my server'}
        </button>
        <button className="btn ghost" onClick={onClose} disabled={running}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
