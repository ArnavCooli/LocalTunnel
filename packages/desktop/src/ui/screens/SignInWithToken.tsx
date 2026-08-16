import React, { useState } from 'react';
import { api } from '../api.js';
import { Alert, Field } from '../components.js';

/**
 * Signing in to a gateway that already exists, with its admin token.
 *
 * Four details identify a gateway: where it is, and the two secrets the
 * installer printed — the admin token, which is what authorises management, and
 * the certificate fingerprint, which is how this app knows the server answering
 * is the one you installed rather than anything else on that address.
 *
 * Used both on first launch and later from Gateways, so someone who already has
 * a gateway never has to install a second one to get started.
 */

export interface AddedGateway {
  id: string;
  name: string;
  host: string;
}

export function SignInWithToken({
  onAdded,
  onCancel,
  submitLabel = 'Add gateway',
}: {
  onAdded: (gateway: AddedGateway) => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const [form, setForm] = useState({
    name: 'My Gateway',
    host: '',
    port: '443',
    adminToken: '',
    fingerprint: '',
  });
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const ready = form.host.trim() && form.adminToken.trim() && form.fingerprint.trim();

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const port = Number(form.port) || 443;

      // Prove the details work before they are stored: a wrong token or a
      // mistyped fingerprint would otherwise be saved happily and only fail
      // later, somewhere that gives no clue which of the two was wrong.
      const check = (await api.gateway.test({
        host: form.host.trim(),
        port: String(port),
        adminToken: form.adminToken.trim(),
        fingerprint: form.fingerprint.trim(),
      })) as { ok: boolean; error?: string; hint?: string };

      if (!check.ok) {
        setError({ message: check.error ?? 'That gateway could not be reached.', hint: check.hint });
        return;
      }

      const gateway = (await api.gateway.addExisting({
        ...form,
        host: form.host.trim(),
        port,
        adminToken: form.adminToken.trim(),
        fingerprint: form.fingerprint.trim(),
        provider: 'generic',
      })) as AddedGateway;
      onAdded(gateway);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value });

  return (
    <>
      <p className="section-hint">
        The installer prints an admin token and a certificate fingerprint when it finishes — the
        desktop app shows them under Gateways → Connection details on whichever computer set the
        gateway up. Paste both here.
      </p>

      <Field label="Name" hint="Shown in LocalTunnel only.">
        <input value={form.name} onChange={set('name')} disabled={saving} />
      </Field>

      <div className="field-row">
        <Field label="Public IP or hostname">
          <input value={form.host} onChange={set('host')} placeholder="129.153.0.1" disabled={saving} />
        </Field>
        <Field label="Port">
          <input value={form.port} onChange={set('port')} disabled={saving} />
        </Field>
      </div>

      <Field label="Admin token">
        <input
          value={form.adminToken}
          onChange={set('adminToken')}
          placeholder="Paste the token"
          disabled={saving}
        />
      </Field>

      <Field
        label="Certificate fingerprint"
        hint="The SHA-256 fingerprint printed by the installer. Not a secret — it is what proves the server is yours."
      >
        <input value={form.fingerprint} onChange={set('fingerprint')} placeholder="A1:B2:C3:…" disabled={saving} />
      </Field>

      {error && (
        <Alert tone="error" title={error.message}>
          {error.hint ?? 'Check the address, token and fingerprint, then try again.'}
        </Alert>
      )}

      <div className="btn-row">
        <button className="btn primary" onClick={() => void submit()} disabled={saving || !ready}>
          {saving ? 'Checking…' : submitLabel}
        </button>
        {onCancel && (
          <button className="btn ghost" onClick={onCancel} disabled={saving}>
            Back
          </button>
        )}
      </div>
    </>
  );
}
