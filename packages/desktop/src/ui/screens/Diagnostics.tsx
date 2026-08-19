import React, { useEffect, useState } from 'react';
import { CheckmarkFilled, CircleDash, ErrorFilled, WarningFilled } from '@carbon/icons-react';
import { api, type CheckResult, type ServiceView } from '../api.js';
import { Alert, Spinner } from '../components.js';

/**
 * Diagnostics. The rule this screen follows: never say "something went wrong".
 * Every failure names the broken link and the change that fixes it.
 */
export function Diagnostics({
  services,
  initialServiceId,
}: {
  services: ServiceView[];
  initialServiceId?: string | null;
}) {
  // A disabled service is not published, so there is no chain to check for it.
  const checkable = services.filter((s) => s.enabled);
  const [serviceId, setServiceId] = useState<string>(
    pickServiceId(checkable, initialServiceId),
  );
  const [results, setResults] = useState<CheckResult[] | null>(null);
  const [running, setRunning] = useState(false);

  // If the selected service is disabled while this screen is open, drop back to
  // the gateway-only check rather than checking something that is not published.
  useEffect(() => {
    if (serviceId && !checkable.some((s) => s.id === serviceId)) setServiceId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services]);

  const run = async (id: string) => {
    setRunning(true);
    setResults(null);
    try {
      const checks = (await api.diagnostics.run(id || undefined)) as CheckResult[];
      setResults(checks);
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    void run(serviceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const failures = results?.filter((r) => r.state === 'fail') ?? [];
  const warnings = results?.filter((r) => r.state === 'warn') ?? [];
  const allGood = results !== null && failures.length === 0 && warnings.length === 0;

  return (
    <div className="page">
      <h1>Diagnostics</h1>
      <p className="subtitle">
        LocalTunnel checks every link in the chain, from this computer to your public address.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 20 }}>
        {checkable.length > 0 && (
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label>Check a service</label>
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">Gateway and tunnel only</option>
              {checkable.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.publicUrl ?? `${s.localHost}:${s.localPort}`}
                </option>
              ))}
            </select>
          </div>
        )}
        <button className="btn primary" onClick={() => void run(serviceId)} disabled={running}>
          {running ? 'Checking…' : 'Run diagnostics'}
        </button>
      </div>

      {running && (
        <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Spinner /> Running checks…
        </div>
      )}

      {allGood && (
        <Alert tone="success" title="Everything is working">
          Every check passed. Your service is reachable from the internet.
        </Alert>
      )}

      {results && failures.length > 0 && (
        <Alert tone="error" title={summarize(failures)}>
          The failing check below tells you exactly what to change.
        </Alert>
      )}

      {results?.map((check) => (
        <div className="card" key={check.id}>
          <div className="card-head">
            <span className={`check-icon ${check.state}`}>{icon(check.state)}</span>
            <span className="card-title">{check.label}</span>
          </div>
          <div style={{ color: check.state === 'fail' ? 'var(--text)' : 'var(--text-secondary)' }}>{check.detail}</div>

          {check.facts && (
            <table className="record-table" style={{ marginTop: 10 }}>
              <tbody>
                {check.facts.map((fact) => (
                  <tr key={fact.label}>
                    <td>{fact.label}</td>
                    <td>{fact.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {check.fix && (
            <div
              style={{
                marginTop: 12,
                paddingTop: 12,
                borderTop: '1px solid var(--hairline)',
                fontSize: 'var(--text-body)',
              }}
            >
              <strong style={{ display: 'block', marginBottom: 3 }}>Fix</strong>
              <span style={{ color: 'var(--text-secondary)' }}>{check.fix}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Only enabled services can be checked; anything else falls back to gateway-only. */
function pickServiceId(checkable: ServiceView[], initialServiceId?: string | null): string {
  if (initialServiceId && checkable.some((s) => s.id === initialServiceId)) return initialServiceId;
  if (initialServiceId) return '';
  return checkable[0]?.id ?? '';
}

function icon(state: CheckResult['state']): React.ReactNode {
  switch (state) {
    case 'pass':
      return <CheckmarkFilled size={16} />;
    case 'fail':
      return <ErrorFilled size={16} />;
    case 'warn':
      return <WarningFilled size={16} />;
    default:
      return <CircleDash size={16} />;
  }
}

function summarize(failures: CheckResult[]): string {
  const first = failures[0];
  switch (first.id) {
    case 'internet':
      return 'This computer is offline.';
    case 'gateway-port':
    case 'gateway':
      return 'Your gateway cannot be reached.';
    case 'agent':
      return 'The tunnel from this computer is down.';
    case 'local-service':
      return 'Your local service is not running.';
    case 'dns':
      return 'Your domain does not point at your gateway.';
    case 'tls':
      return 'There is a problem with the HTTPS certificate.';
    default:
      return 'Your service cannot be reached.';
  }
}
