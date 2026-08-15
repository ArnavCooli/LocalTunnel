import React, { useEffect, useRef, useState } from 'react';
import { api, type InstallProgress } from '../api.js';
import { Alert, Choice, Field } from '../components.js';
import { providerById } from '../../providers/catalog.js';
import type { SshCredentials } from '../../setup/ssh-keys.js';

type StepState = 'pending' | 'running' | 'done' | 'failed';

/** How the user has chosen to authenticate to their server. */
type AuthChoice =
  | { kind: 'none' }
  | { kind: 'agent' }
  | { kind: 'file'; path: string; encrypted: boolean };

/** Shorten `/Users/someone/.ssh/id_ed25519` to `~/.ssh/id_ed25519` for display. */
function shorten(path: string, home: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * The SSH install. Fourteen named steps with live output, because a long silent
 * progress bar during a remote install is exactly where people give up.
 */
export function InstallGateway({
  providerId,
  defaultHost,
  onInstalled,
  onCancel,
}: {
  providerId: string;
  defaultHost?: string;
  onInstalled: (gateway: { id: string; name: string; host: string }) => void;
  onCancel?: () => void;
}) {
  const provider = providerById(providerId);
  const [form, setForm] = useState({
    host: defaultHost ?? '',
    port: '22',
    username: provider?.defaultUser === 'root' ? 'root' : 'ubuntu',
    privateKeyPath: '',
    passphrase: '',
    name: provider ? `${provider.name} Gateway` : 'LocalTunnel Gateway',
    email: '',
  });
  const [credentials, setCredentials] = useState<SshCredentials | null>(null);
  const [auth, setAuth] = useState<AuthChoice>({ kind: 'none' });
  const [steps, setSteps] = useState<{ key: string; label: string; state: StepState }[]>([]);
  const [output, setOutput] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.gateway
      .installSteps()
      .then((list: { key: string; label: string }[]) =>
        setSteps(list.map((s) => ({ ...s, state: 'pending' as StepState }))),
      );
  }, []);

  // Find the credentials the user already has, and preselect the best one: the
  // agent if it holds keys, otherwise the most conventional key file.
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
    const unsubscribe = api.gateway.onInstallProgress((raw) => {
      const event = raw as InstallProgress;
      if (event.type === 'step') {
        setSteps((current) =>
          current.map((s) => (s.key === event.key ? { ...s, state: event.state as StepState } : s)),
        );
      } else if (event.type === 'output' && event.line) {
        setOutput((lines) => [...lines.slice(-400), event.line!]);
      } else if (event.type === 'error') {
        setError({ message: event.message ?? 'Installation failed.', hint: event.hint });
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [output]);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value });

  const install = async () => {
    setRunning(true);
    setError(null);
    setOutput([]);
    setSteps((current) => current.map((s) => ({ ...s, state: 'pending' })));
    try {
      const result = await api.gateway.install({
        ...form,
        provider: providerId,
        privateKeyPath: auth.kind === 'file' ? auth.path : '',
        useAgent: String(auth.kind === 'agent'),
      });
      onInstalled((result as { gateway: { id: string; name: string; host: string } }).gateway);
    } catch (err) {
      if (!error) setError({ message: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(false);
    }
  };

  const ready = form.host.trim() && form.username.trim() && auth.kind !== 'none';

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Install the LocalTunnel Gateway</h2>
      <p className="section-hint">
        LocalTunnel connects to your server over SSH and sets everything up. If your key is already
        in your SSH agent, it is never read at all; a key file is read only for this install and is
        never stored or uploaded anywhere.
      </p>

      {provider && provider.id !== 'generic' && (
        <Alert tone="info" title={`${provider.name} firewall`}>
          {provider.firewallNote}
        </Alert>
      )}

      <div className="field-row">
        <Field label="Public IPv4 address" hint="From your provider's instance page.">
          <input value={form.host} onChange={set('host')} placeholder="129.153.0.1" disabled={running} />
        </Field>
        <Field label="SSH port" hint="22 unless you changed it.">
          <input value={form.port} onChange={set('port')} disabled={running} />
        </Field>
      </div>

      <Field
        label="SSH username"
        hint='Oracle/AWS Ubuntu images use "ubuntu"; Oracle Linux uses "opc"; most others use "root".'
      >
        <input value={form.username} onChange={set('username')} disabled={running} />
      </Field>

      <div className="field">
        <label>How should LocalTunnel sign in?</label>
        {credentials === null ? (
          <div className="hint">Looking for keys you already have…</div>
        ) : (
          <>
            {credentials.agent.available && (
              <Choice
                icon="🔐"
                title="Use my SSH agent"
                description={`${credentials.agent.identities.length} key${credentials.agent.identities.length === 1 ? '' : 's'} loaded — ${credentials.agent.identities[0]}. Your private key stays in the agent; LocalTunnel never reads it.`}
                selected={auth.kind === 'agent'}
                onClick={() => setAuth({ kind: 'agent' })}
              />
            )}
            {credentials.keys.map((key) => (
              <Choice
                key={key.path}
                icon="🗝"
                title={shorten(key.path, credentials.home)}
                description={[
                  key.type,
                  key.encrypted ? 'passphrase required' : 'no passphrase',
                  key.hasPublicHalf ? 'public half present' : 'no .pub file alongside',
                ].join(' · ')}
                selected={auth.kind === 'file' && auth.path === key.path}
                onClick={() => setAuth({ kind: 'file', path: key.path, encrypted: key.encrypted })}
              />
            ))}
            <Choice
              icon="📂"
              title="Choose a different key file…"
              description="For a key downloaded from your provider that is not in ~/.ssh yet."
              selected={auth.kind === 'file' && !credentials.keys.some((k) => k.path === auth.path)}
              onClick={async () => {
                const path = await api.app.pickPrivateKey();
                if (path) setAuth({ kind: 'file', path: path as string, encrypted: false });
              }}
            />
            {!credentials.agent.available && credentials.keys.length === 0 && (
              <div className="hint">
                {credentials.agent.reason ?? 'No SSH keys found.'} Choose the private key file your
                provider gave you.
              </div>
            )}
            {auth.kind === 'file' && (
              <div className="hint" style={{ marginTop: 8 }}>
                Using {shorten(auth.path, credentials.home)}
              </div>
            )}
          </>
        )}
      </div>

      {auth.kind === 'file' && auth.encrypted && (
        <Field label="Key passphrase" hint="This key is encrypted, so it needs its passphrase.">
          <input type="password" value={form.passphrase} onChange={set('passphrase')} disabled={running} />
        </Field>
      )}

      <details className="disclosure">
        <summary>Optional settings</summary>
        <Field label="Gateway name" hint="Shown in LocalTunnel only.">
          <input value={form.name} onChange={set('name')} disabled={running} />
        </Field>
        <Field
          label="Contact email"
          hint="Passed to Let's Encrypt so they can warn you if a certificate is about to expire unrenewed."
        >
          <input value={form.email} onChange={set('email')} placeholder="you@example.com" disabled={running} />
        </Field>
      </details>

      <div className="btn-row">
        <button className="btn primary" disabled={!ready || running} onClick={() => void install()}>
          {running ? 'Installing…' : 'Install LocalTunnel Gateway'}
        </button>
        {onCancel && (
          <button className="btn ghost" onClick={onCancel} disabled={running}>
            Back
          </button>
        )}
      </div>

      {error && (
        <Alert tone="error" title={error.message}>
          {error.hint ?? 'The output below shows exactly where it stopped.'}
        </Alert>
      )}

      {(running || output.length > 0) && (
        <>
          <h2>Progress</h2>
          <div className="steps">
            {steps.map((step) => (
              <div key={step.key} className={`step ${step.state}`}>
                <span className="step-icon">
                  {step.state === 'done' ? '✓' : step.state === 'failed' ? '✗' : step.state === 'running' ? '⟳' : '·'}
                </span>
                <span>{step.label}</span>
              </div>
            ))}
          </div>
          <details className="disclosure" style={{ marginTop: 14 }} open={Boolean(error)}>
            <summary>Server output</summary>
            <div className="console" ref={consoleRef}>
              {output.join('\n')}
            </div>
          </details>
        </>
      )}
    </div>
  );
}
