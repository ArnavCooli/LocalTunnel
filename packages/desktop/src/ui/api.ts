import type { LocalTunnelApi } from '../main/preload.js';
import type { CheckResult } from '../diagnostics/engine.js';
import type { CertificateView, GatewayStatus, MachineView, ServiceView } from '../services/gateway-client.js';
import type { TunnelStatus } from '@localtunnel/agent';

declare global {
  interface Window {
    localtunnel: LocalTunnelApi;
  }
}

export const api = window.localtunnel;

export type {
  CertificateView,
  CheckResult,
  GatewayStatus,
  MachineView,
  ServiceView,
  TunnelStatus,
};

export interface GatewaySummary {
  id: string;
  name: string;
  host: string;
  port: number;
  provider: string;
  region: string | null;
  addedAt: string;
  /** Remembered from the install, so Update and Remove can prefill them. */
  sshUsername: string | null;
  sshPort: number;
  active: boolean;
}

export interface AppState {
  onboarded: boolean;
  activeGatewayId: string | null;
  settings: { launchAtLogin: boolean; agentAutostart: boolean; theme: 'system' | 'dark' | 'light' };
  wizard: { provider: string | null; stepIndex: number } | null;
  platform: string;
  version: string;
}

export type GatewayStatusResult =
  | ({ ok: true } & GatewayStatus)
  | { ok: false; error: string }
  | null;

export interface InstallProgress {
  type: 'step' | 'output' | 'done' | 'error';
  key?: string;
  label?: string;
  state?: 'running' | 'done' | 'failed';
  line?: string;
  message?: string;
  hint?: string;
  result?: { gatewayId: string; publicIp: string; fingerprint: string };
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString();
}

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const delta = Date.now() - Date.parse(iso);
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}
