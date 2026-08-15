import React, { useState } from 'react';
import { ORACLE_REQUIRED_PORTS, ORACLE_STEPS } from '../../providers/oracle.js';
import { PROVIDERS, providerById } from '../../providers/catalog.js';
import { Alert, Choice, Copyable, ExternalLink } from '../components.js';
import { InstallGateway } from './InstallGateway.js';
import { api } from '../api.js';

/**
 * The Oracle Cloud wizard. Twelve steps, each with instructions, "why do I need
 * this?", "what should I see?", and troubleshooting — because dropping someone into
 * the Oracle console with a link is exactly the failure this product exists to avoid.
 */
export function OracleWizard({
  onInstalled,
  onExit,
  startIndex = 0,
  onStepChange,
}: {
  onInstalled: (gateway: { id: string; name: string; host: string }) => void;
  onExit: () => void;
  startIndex?: number;
  onStepChange?: (index: number) => void;
}) {
  const [index, setIndex] = useState(startIndex);
  /** Set once the gateway is installed, so the final step can confirm and finish. */
  const [installed, setInstalled] = useState<{ id: string; name: string; host: string } | null>(null);
  const step = ORACLE_STEPS[index];
  const isInstallStep = step.id === 'install';
  const isLastStep = index === ORACLE_STEPS.length - 1;

  const go = (next: number) => {
    const clamped = Math.max(0, Math.min(ORACLE_STEPS.length - 1, next));
    setIndex(clamped);
    onStepChange?.(clamped);
  };

  return (
    <div className="page">
      <div className="wizard-progress">
        <span>
          Step {index + 1} of {ORACLE_STEPS.length}
        </span>
        <div className="wizard-bar">
          <span style={{ width: `${((index + 1) / ORACLE_STEPS.length) * 100}%` }} />
        </div>
        <button className="btn ghost small" onClick={onExit}>
          Exit
        </button>
      </div>

      <h1>{step.title}</h1>
      <p className="subtitle">{step.summary}</p>

      {step.id === 'security-list' && (
        <Alert tone="warn" title="This is the step people miss">
          Oracle blocks all inbound traffic by default, in its own firewall — separate from the
          server. If you skip this, everything will install correctly and your site still will not
          load.
        </Alert>
      )}

      {isLastStep && installed && (
        <Alert tone="success" title="Your gateway is online">
          {installed.name} is running at {installed.host}. Finish to connect this computer and
          publish your first service.
        </Alert>
      )}

      {isInstallStep ? (
        <InstallGateway
          providerId="oracle"
          // Advance to the final step rather than leaving the wizard, so the
          // "Step 12 of 12" verification step is actually reachable.
          onInstalled={(gateway) => {
            setInstalled(gateway);
            go(index + 1);
          }}
          onCancel={() => go(index - 1)}
        />
      ) : (
        <>
          {step.link && (
            <div style={{ marginBottom: 16 }}>
              <button className="btn primary" onClick={() => void api.app.openExternal(step.link!.url)}>
                {step.link.label} ↗
              </button>
            </div>
          )}

          <ol className="step-list">
            {step.instructions.map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ol>

          {step.id === 'security-list' && (
            <div className="card" style={{ marginTop: 18 }}>
              <div className="card-title" style={{ marginBottom: 8 }}>
                The exact rules to add
              </div>
              <table className="record-table">
                <tbody>
                  {ORACLE_REQUIRED_PORTS.map((port) => (
                    <tr key={port.port}>
                      <td>{port.proto} {port.port}</td>
                      <td style={{ fontFamily: 'inherit', color: 'var(--text-secondary)' }}>{port.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="section-hint" style={{ margin: '12px 0 6px' }}>
                Source CIDR for both rules:
              </p>
              <Copyable value="0.0.0.0/0" />
            </div>
          )}

          {step.illustration && <Illustration name={step.illustration} />}

          <details className="disclosure" style={{ marginTop: 20 }}>
            <summary>Why do I need this?</summary>
            <p style={{ margin: 0 }}>{step.why}</p>
          </details>
          <details className="disclosure">
            <summary>What should I see?</summary>
            <p style={{ margin: 0 }}>{step.expect}</p>
          </details>
          <details className="disclosure">
            <summary>Something went wrong</summary>
            {step.troubleshooting.map((item) => (
              <div key={item.problem} style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 560, marginBottom: 3 }}>{item.problem}</div>
                <div style={{ color: 'var(--text-secondary)' }}>{item.fix}</div>
              </div>
            ))}
          </details>

          <div className="btn-row">
            {/* On the first step, Back leaves the wizard rather than being a dead
                control — otherwise the only way out is the small Exit link. */}
            <button className="btn" onClick={() => (index === 0 ? onExit() : go(index - 1))}>
              Back
            </button>
            <button
              className="btn primary"
              disabled={isLastStep && !installed}
              onClick={() => (isLastStep ? onInstalled(installed!) : go(index + 1))}
            >
              {index === 0 ? 'I have an account — continue' : isLastStep ? 'Finish' : 'Continue'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Bundled diagrams rather than screenshots: Oracle redesigns its console regularly,
 * and a diagram that describes the setting stays correct when the pixels move.
 */
function Illustration({ name }: { name: string }) {
  const art: Record<string, string> = {
    'oracle-public-ip': `  Networking
  ┌──────────────────────────────────────────┐
  │ Primary network interface                │
  │                                          │
  │  ( ) Do not assign a public IPv4 address │
  │  (•) Assign a public IPv4 address    ←── │  this one
  └──────────────────────────────────────────┘`,
    'oracle-ingress': `  Default Security List → Add Ingress Rules
  ┌────────────────┬──────────┬────────────────┐
  │ Source CIDR    │ Protocol │ Dest. port     │
  ├────────────────┼──────────┼────────────────┤
  │ 0.0.0.0/0      │ TCP      │ 443            │
  │ 0.0.0.0/0      │ TCP      │ 80             │
  │ 0.0.0.0/0      │ TCP      │ 22   (already) │
  └────────────────┴──────────┴────────────────┘`,
  };
  const content = art[name];
  if (!content) return null;
  return (
    <div className="code" style={{ marginTop: 18, color: 'var(--text-secondary)' }}>
      {content}
    </div>
  );
}

/** The simpler equivalent for every other provider. */
export function ProviderPicker({
  onPick,
  onExit,
}: {
  onPick: (providerId: string) => void;
  onExit: () => void;
}) {
  return (
    <div className="page">
      <h1>Choose a VPS provider</h1>
      <p className="subtitle">
        Any of these works. LocalTunnel installs the same gateway on all of them — the only
        difference is where the buttons are.
      </p>

      <div className="eyebrow">
        Recommended
      </div>
      {PROVIDERS.filter((p) => p.recommended).map((provider) => (
        <Choice
          key={provider.id}
          icon="☁️"
          title={provider.name}
          description={`${provider.tagline} — ${provider.cost}`}
          onClick={() => onPick(provider.id)}
        />
      ))}

      <div className="eyebrow">
        Other providers
      </div>
      {PROVIDERS.filter((p) => !p.recommended).map((provider) => (
        <Choice
          key={provider.id}
          title={provider.name}
          description={`${provider.tagline} — ${provider.cost}`}
          onClick={() => onPick(provider.id)}
        />
      ))}

      <div className="btn-row">
        <button className="btn ghost" onClick={onExit}>
          Back
        </button>
      </div>
    </div>
  );
}

/** The short guide + install form for a non-Oracle provider. */
export function ProviderSetup({
  providerId,
  onInstalled,
  onExit,
}: {
  providerId: string;
  onInstalled: (gateway: { id: string; name: string; host: string }) => void;
  onExit: () => void;
}) {
  const provider = providerById(providerId);
  const [phase, setPhase] = useState<'guide' | 'install'>(providerId === 'generic' ? 'install' : 'guide');
  if (!provider) return null;

  return (
    <div className="page">
      <h1>{provider.name}</h1>
      <p className="subtitle">{provider.tagline}</p>

      {phase === 'guide' ? (
        <>
          {provider.consoleUrl && (
            <div style={{ marginBottom: 16 }}>
              <button className="btn primary" onClick={() => void api.app.openExternal(provider.consoleUrl)}>
                Open {provider.name} ↗
              </button>
            </div>
          )}
          <ol className="step-list">
            {provider.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <Alert tone="warn" title="Firewall">
            {provider.firewallNote}
          </Alert>
          <div className="btn-row">
            <button className="btn ghost" onClick={onExit}>
              Back
            </button>
            <button className="btn primary" onClick={() => setPhase('install')}>
              My server is ready — install the gateway
            </button>
          </div>
        </>
      ) : (
        <>
          <Alert tone="info" title="Before you continue">
            The server needs a public IPv4 address, SSH access with a key, and inbound TCP 443 and 80
            allowed by whatever firewall your provider puts in front of it.{' '}
            {provider.id !== 'generic' && <ExternalLink href={provider.consoleUrl}>Open {provider.name}</ExternalLink>}
          </Alert>
          <InstallGateway
            providerId={providerId}
            onInstalled={onInstalled}
            onCancel={providerId === 'generic' ? onExit : () => setPhase('guide')}
          />
        </>
      )}
    </div>
  );
}
