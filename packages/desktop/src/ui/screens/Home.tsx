import React from 'react';
import {
  formatBytes,
  type GatewayStatusResult,
  type ServiceView,
  type TunnelStatus,
} from '../api.js';
import { Alert, Dot, Empty, SERVICE_ICONS, serviceStatusLabel, serviceStatusTone } from '../components.js';

/**
 * Overview.
 *
 * One hero object answers the only question that matters on opening the app —
 * "is my stuff online?" — and carries the action that follows from the answer.
 * Everything else is secondary and sits underneath it.
 */
export function Home({
  gatewayStatus,
  agentStatus,
  services,
  onExpose,
  onOpenService,
  onDiagnose,
  onConnect,
}: {
  gatewayStatus: GatewayStatusResult;
  agentStatus: TunnelStatus | null;
  services: ServiceView[];
  onExpose: () => void;
  onOpenService: (id: string) => void;
  onDiagnose: () => void;
  onConnect: () => void;
}) {
  const gatewayOnline = gatewayStatus?.ok === true;
  const tunnelUp = agentStatus?.state === 'connected';
  const broken = services.filter((s) => s.enabled && s.status !== 'online');
  const live = services.filter((s) => s.enabled && s.status === 'online');

  const health = !gatewayOnline ? 'down' : !tunnelUp || broken.length > 0 ? 'warning' : 'online';

  const headline = !gatewayOnline
    ? 'Your gateway is unreachable'
    : !tunnelUp
      ? 'This computer is not connected'
      : broken.length > 0
        ? `${live.length} of ${live.length + broken.length} services are serving traffic`
        : services.length === 0
          ? 'Ready to publish'
          : `${live.length} service${live.length === 1 ? '' : 's'} live on the internet`;

  const subline = !gatewayOnline
    ? gatewayStatus?.ok === false
      ? gatewayStatus.error
      : 'No gateway has been set up yet.'
    : !tunnelUp
      ? 'Your gateway is running, but this computer is not sending traffic through it.'
      : `via ${gatewayStatus.gateway.name} · ${gatewayStatus.gateway.publicIp}`;

  return (
    <div className="page">
      <h1>Overview</h1>
      <p className="subtitle">Everything you have made reachable from the internet.</p>

      <div className={`hero is-${health}`}>
        <div className="hero-head">
          <span className="hero-badge">
            {health === 'online' ? '🔒' : health === 'warning' ? '⚠️' : '⛔️'}
          </span>
          <span>
            <span className="hero-title">{headline}</span>
            <span className="hero-sub">{subline}</span>
          </span>
          <span className={`hero-state ${health}`}>
            <Dot tone={health === 'online' ? 'green' : health === 'warning' ? 'amber' : 'red'} />
            {health === 'online' ? 'Protected' : health === 'warning' ? 'Needs attention' : 'Offline'}
          </span>
        </div>

        {gatewayOnline && tunnelUp && (
          <div className="hero-facts">
            <div>
              <div className="hero-fact-label">Latency</div>
              <div className="hero-fact-value">
                {agentStatus?.latencyMs == null ? '—' : `${agentStatus.latencyMs} ms`}
              </div>
            </div>
            <div>
              <div className="hero-fact-label">Tunnel</div>
              <div className="hero-fact-value">Encrypted</div>
            </div>
            <div>
              <div className="hero-fact-label">Traffic served</div>
              <div className="hero-fact-value">
                {formatBytes(gatewayStatus.gateway.totals.bytesIn + gatewayStatus.gateway.totals.bytesOut)}
              </div>
            </div>
            <div>
              <div className="hero-fact-label">Gateway</div>
              <div className="hero-fact-value">{gatewayStatus.gateway.name}</div>
            </div>
          </div>
        )}

        {gatewayOnline && !tunnelUp && (
          <button className="btn primary block" onClick={onConnect}>
            {agentStatus?.state === 'reconnecting'
              ? `Reconnecting${agentStatus.retryInSeconds !== null ? ` in ${agentStatus.retryInSeconds}s` : '…'}`
              : 'Connect this computer'}
          </button>
        )}
        {!gatewayOnline && (
          <button className="btn primary block" onClick={onDiagnose}>
            Find out why
          </button>
        )}
      </div>

      {broken.length > 0 && gatewayOnline && tunnelUp && (
        <Alert
          tone="warn"
          title={`${broken.length} service${broken.length === 1 ? '' : 's'} not serving traffic`}
        >
          {broken.map((s) => `${s.name}: ${serviceStatusLabel(s.status).toLowerCase()}`).join(' · ')}{' '}
          <button className="btn small" style={{ marginLeft: 8 }} onClick={onDiagnose}>
            Diagnose
          </button>
        </Alert>
      )}

      <div className="section-title">Your services</div>
      {services.length === 0 ? (
        <Empty
          title="Nothing published yet"
          description="Take something running on this computer — a website, an API, a game server — and give it an address on the internet."
          action={
            <button className="btn primary" onClick={onExpose}>
              Expose a service
            </button>
          }
        />
      ) : (
        <>
          <div className="row-list">
            {services.map((service) => (
              <button key={service.id} className="row" onClick={() => onOpenService(service.id)}>
                <span className="row-icon">{SERVICE_ICONS[service.type]}</span>
                <span className="row-body">
                  <span className="row-title">{service.publicUrl ?? service.name}</span>
                  <span className="row-sub">
                    {service.name} → {service.localHost}:{service.localPort}
                  </span>
                </span>
                <span className="row-end">
                  <span style={{ fontSize: 'var(--text-small)', color: 'var(--text-tertiary)' }}>
                    {serviceStatusLabel(service.status)}
                  </span>
                  <Dot tone={serviceStatusTone(service.status)} />
                </span>
              </button>
            ))}
          </div>
          <div className="btn-row">
            <button className="btn primary" onClick={onExpose}>
              Expose a service
            </button>
          </div>
        </>
      )}
    </div>
  );
}
