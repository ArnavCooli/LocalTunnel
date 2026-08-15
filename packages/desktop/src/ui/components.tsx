import React, { useEffect, useState } from 'react';
import { Locked, Plug, Satellite, Wikis } from '@carbon/icons-react';
import { api } from './api.js';

/** Shared building blocks, kept in one file so the screens stay readable. */

export function Dot({ tone }: { tone: 'green' | 'amber' | 'red' | 'grey' }) {
  return <span className={`dot ${tone}`} />;
}

export function StatusRow({
  label,
  tone,
  value,
  detail,
}: {
  label: string;
  tone?: 'green' | 'amber' | 'red' | 'grey';
  value: string;
  detail?: string;
}) {
  return (
    <div className="status-row">
      <span className="label">{label}</span>
      {tone && <Dot tone={tone} />}
      <span className="value">{value}</span>
      {detail && <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-small)' }}>{detail}</span>}
    </div>
  );
}

export function Copyable({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copyable">
      <div className="code">{value}</div>
      <button
        className="btn small"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? 'Copied' : (label ?? 'Copy')}
      </button>
    </div>
  );
}

export function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void api.app.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success';
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`alert alert-${tone}`}>
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className={`field${error ? ' invalid' : ''}`}>
      <label>{label}</label>
      {children}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Choice({
  icon,
  title,
  description,
  selected,
  onClick,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`choice${selected ? ' selected' : ''}`} onClick={onClick}>
      {icon && <span className="choice-icon">{icon}</span>}
      <span>
        <span className="choice-title">{title}</span>
        {description && <span className="choice-desc" style={{ display: 'block' }}>{description}</span>}
      </span>
    </button>
  );
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div style={{ fontWeight: 560, color: 'var(--text)', marginBottom: 5 }}>{title}</div>
      <div style={{ marginBottom: action ? 18 : 0 }}>{description}</div>
      {action}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

export function Toast({ message, tone, onDone }: { message: string; tone: 'info' | 'error'; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, tone === 'error' ? 7000 : 3500);
    return () => clearTimeout(timer);
  }, [message, tone, onDone]);
  return <div className={`toast ${tone}`}>{message}</div>;
}

/** Poll a promise-returning function on an interval, with a manual refresh. */
export function usePolling<T>(
  loader: () => Promise<T>,
  intervalMs: number,
  deps: React.DependencyList = [],
): { data: T | null; error: string | null; refresh: () => void; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await loader();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, refresh: () => setNonce((n) => n + 1) };
}

/**
 * Line icons rather than emoji: emoji are full-colour images that ignore the
 * text colour around them, which reads as clip-art against the black chrome.
 * These are the same Carbon set the sidebar rail uses.
 */
export const SERVICE_ICONS: Record<string, React.ReactNode> = {
  http: <Wikis size={20} />,
  https: <Locked size={20} />,
  tcp: <Plug size={20} />,
  udp: <Satellite size={20} />,
};

export function serviceStatusTone(status: string): 'green' | 'amber' | 'red' | 'grey' {
  switch (status) {
    case 'online':
      return 'green';
    case 'local_unreachable':
      return 'amber';
    case 'machine_offline':
      return 'red';
    default:
      return 'grey';
  }
}

export function serviceStatusLabel(status: string): string {
  switch (status) {
    case 'online':
      return 'Online';
    case 'local_unreachable':
      return 'Local service not running';
    case 'machine_offline':
      return 'Computer offline';
    default:
      return 'Disabled';
  }
}
