import React, { useEffect, useState } from 'react';
import { api, type UpdateStatus } from '../api.js';
import { Alert, ExternalLink, Spinner } from '../components.js';

/**
 * "There is a newer LocalTunnel."
 *
 * The app does not update itself. It tells you a new version exists, shows what
 * changed, and sends you to the release page — where the download is signed and
 * checked by the same OS package tooling that installed the current one. An
 * updater that fetched and ran code would be a second permanent path onto this
 * machine, sitting behind the same window as the gateway's admin token and an
 * SSH installer, and it is not worth adding for the sake of one fewer click.
 *
 * Everything shown here arrives from a public API, so it is rendered as text.
 * React escapes it; nothing is passed to dangerouslySetInnerHTML, and the link
 * is a constant from the main process rather than a URL from the response.
 */

function useUpdateStatus(): [UpdateStatus | null, boolean, (force?: boolean) => void] {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const check = (force = false) => {
    setChecking(true);
    void (force ? api.updates.check(true) : api.updates.state())
      .then((result) => setStatus(result as UpdateStatus))
      .finally(() => setChecking(false));
  };

  useEffect(() => check(false), []);
  return [status, checking, check];
}

/**
 * The banner shown above the main content when an update is waiting.
 *
 * Renders nothing at all unless there is genuinely a newer version, so the
 * normal state of the app is not a dismissible nag.
 */
export function UpdateBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [status] = useUpdateStatus();
  const [dismissed, setDismissed] = useState(false);

  if (!status?.updateAvailable || dismissed) return null;

  return (
    <div className="update-banner">
      <span>
        <strong>LocalTunnel {status.latest} is available.</strong> You are running {status.current}.
      </span>
      <span className="update-banner-actions">
        <button className="btn small" onClick={onOpenSettings}>
          What&apos;s new
        </button>
        <button className="btn small" onClick={() => setDismissed(true)}>
          Not now
        </button>
      </span>
    </div>
  );
}

/** The full section, shown in Settings. */
export function UpdateSection() {
  const [status, checking, check] = useUpdateStatus();

  return (
    <>
      <h2>Updates</h2>
      <div className="card">
        <div className="card-head">
          <span className="card-title">
            {status?.updateAvailable
              ? `LocalTunnel ${status.latest} is available`
              : 'LocalTunnel is up to date'}
          </span>
          <span className="card-actions">
            <button className="btn small" disabled={checking} onClick={() => check(true)}>
              {checking ? 'Checking…' : 'Check now'}
            </button>
          </span>
        </div>

        <table className="record-table" style={{ marginTop: 6 }}>
          <tbody>
            <tr>
              <td>Installed</td>
              <td>{status?.current ?? '—'}</td>
            </tr>
            <tr>
              <td>Latest</td>
              <td>{status?.latest ?? 'unknown'}</td>
            </tr>
            <tr>
              <td>Last checked</td>
              <td>{status?.checkedAt ? new Date(status.checkedAt).toLocaleString() : 'never'}</td>
            </tr>
          </tbody>
        </table>

        {checking && !status && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
            <Spinner /> Checking for updates…
          </div>
        )}

        {status?.error && (
          <Alert tone="warn" title="The update check did not finish">
            {status.error}
          </Alert>
        )}

        {status?.updateAvailable && (
          <>
            {status.notes && (
              <>
                <h3 style={{ marginTop: 16, marginBottom: 4 }}>What&apos;s new</h3>
                {/*
                  Release notes are remote text. `white-space: pre-wrap` keeps
                  their line breaks without letting them be markup.
                */}
                <pre className="release-notes">{status.notes}</pre>
              </>
            )}
            <p className="section-hint" style={{ marginTop: 12 }}>
              LocalTunnel does not install updates by itself. Download the new version from the
              release page and install it the way you installed this one — your gateways, machines
              and services are unaffected.
            </p>
            <div className="btn-row">
              <ExternalLink href={status.url}>
                <span className="btn primary">Open the release page</span>
              </ExternalLink>
            </div>
          </>
        )}
      </div>
    </>
  );
}
