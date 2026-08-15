import React from 'react';
import {
  formatBytes,
  type GatewayStatusResult,
  type ServiceView,
  type TunnelStatus,
} from '../api.js';
import { Alert, Dot, Empty, SERVICE_ICONS, serviceStatusLabel, serviceStatusTone } from '../components.js';

export function Home({
  gatewayStatus,
  agentStatus,
  services,
  onExpose,
  onOpenService,
  onDiagnose,
}: {
  gatewayStatus: GatewayStatusResult;
  agentStatus: TunnelStatus | null;
  services: ServiceView[];
  onExpose: () => void;
  onOpenService: (id: string) => void;
  onDiagnose: () => void;
}) {
  const gatewayOnline = gatewayStatus?.ok === true;
  const tunnelUp = agentStatus?.state === 'connected';
  const broken = services.filter((s) => s.enabled && s.status !== 'online');

  return (
    <div className="page">
      <h1>Overview</h1>
      <p className="subtitle">
        {gatewayOnline && tunnelUp
          ? 'Your gateway is online and this computer is connected.'
          : 'Set-up status for your public services.'}
      </p>

      <div className="card">
        <div className="status-row">
          <span className="label">Gateway</span>
          <Dot tone={gatewayOnline ? 'green' : gatewayStatus === null ? 'grey' : 'red'} />
          <span className="value">
            {gatewayStatus === null
              ? 'Not set up'
              : gatewayOnline
                ? `${gatewayStatus.gateway.name} · ${gatewayStatus.gateway.publicIp}`
                : 'Unreachable'}
          </span>
        </div>
        <div className="status-row">
          <span className="label">Tunnel</span>
          <Dot tone={tunnelUp ? 'green' : agentStatus?.state === 'reconnecting' ? 'amber' : 'red'} />
          <span className="value">
            {tunnelUp
              ? `Connected${agentStatus?.latencyMs !== null && agentStatus ? ` · ${agentStatus.latencyMs} ms` : ''}`
              : agentStatus?.state === 'reconnecting'
                ? `Reconnecting${agentStatus.retryInSeconds !== null ? ` in ${agentStatus.retryInSeconds}s` : '…'}`
                : 'Not connected'}
          </span>
        </div>
        {gatewayOnline && (
          <div className="status-row">
            <span className="label">Traffic served</span>
            <span className="value">
              {formatBytes(gatewayStatus.gateway.totals.bytesIn + gatewayStatus.gateway.totals.bytesOut)}
            </span>
          </div>
        )}
      </div>

      {gatewayStatus?.ok === false && (
        <Alert tone="error" title="Your gateway is not responding">
          {gatewayStatus.error}{' '}
          <button className="btn small" style={{ marginLeft: 8 }} onClick={onDiagnose}>
            Run diagnostics
          </button>
        </Alert>
      )}

      {broken.length > 0 && gatewayOnline && (
        <Alert tone="warn" title={`${broken.length} service${broken.length === 1 ? '' : 's'} not serving traffic`}>
          {broken.map((s) => `${s.name}: ${serviceStatusLabel(s.status).toLowerCase()}`).join(' · ')}{' '}
          <button className="btn small" style={{ marginLeft: 8 }} onClick={onDiagnose}>
            Diagnose
          </button>
        </Alert>
      )}

      <h2>Public services</h2>
      {services.length === 0 ? (
        <Empty
          title="No services yet"
          description="Take something running on this computer and make it public."
          action={
            <button className="btn primary" onClick={onExpose}>
              + Expose a Service
            </button>
          }
        />
      ) : (
        <>
          {services.map((service) => (
            <button
              key={service.id}
              className="card"
              style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', color: 'var(--text)' }}
              onClick={() => onOpenService(service.id)}
            >
              <span>{SERVICE_ICONS[service.type]}</span>
              <span style={{ flex: 1 }}>
                <span style={{ fontWeight: 560 }}>{service.publicUrl ?? service.name}</span>
                <span style={{ display: 'block', fontSize: 'var(--text-small)', color: 'var(--text-secondary)' }}>
                  {service.name} → {service.localHost}:{service.localPort}
                </span>
              </span>
              <Dot tone={serviceStatusTone(service.status)} />
            </button>
          ))}
          <div className="btn-row">
            <button className="btn primary" onClick={onExpose}>
              + Expose a Service
            </button>
          </div>
        </>
      )}
    </div>
  );
}
