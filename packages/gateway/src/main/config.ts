import { readFileSync } from 'node:fs';

export interface Limits {
  /** New TLS connections accepted per source IP per minute. */
  connectionsPerIpPerMinute: number;
  /** Concurrent public connections from one source IP. */
  concurrentPerIp: number;
  /** Concurrent public connections across all sources. */
  concurrentTotal: number;
  /** Concurrent tunnel streams one machine may have open. */
  streamsPerMachine: number;
  /** Failed enrolment attempts per IP per 15 minutes. */
  enrollFailuresPerIp: number;
  /** Failed admin authentications per IP per 15 minutes. */
  adminFailuresPerIp: number;
  tlsHandshakeTimeoutMs: number;
  idleConnectionTimeoutMs: number;
}

export interface GatewayConfig {
  gatewayId: string;
  /** Display name shown in the desktop app. */
  name: string;
  /** The VPS's public IPv4, as entered by the user during install. */
  publicIp: string;
  httpsPort: number;
  httpPort: number;
  /** Where state, certificates and CA material live. */
  dataDir: string;
  logFile: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** SHA-256 of the admin bearer token. The token itself is never stored. */
  adminTokenHash: string;
  tls: {
    /**
     * `acme` issues real Let's Encrypt certificates. `selfsigned` is used by the
     * integration tests and by anyone running a gateway without a domain yet.
     */
    mode: 'acme' | 'selfsigned';
    acmeDirectoryUrl: string;
    contactEmail: string | null;
    /** Renew when this many days remain. */
    renewBeforeDays: number;
  };
  firewall: {
    /** Whether the gateway may open/close ports for raw TCP services itself. */
    manage: boolean;
  };
  limits: Limits;
}

export const DEFAULT_LIMITS: Limits = {
  connectionsPerIpPerMinute: 60,
  concurrentPerIp: 128,
  concurrentTotal: 8192,
  streamsPerMachine: 512,
  enrollFailuresPerIp: 5,
  adminFailuresPerIp: 5,
  tlsHandshakeTimeoutMs: 10_000,
  idleConnectionTimeoutMs: 120_000,
};

export const LETS_ENCRYPT_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';

export function defaultConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    gatewayId: 'gw_local',
    name: 'LocalTunnel Gateway',
    publicIp: '127.0.0.1',
    httpsPort: 443,
    httpPort: 80,
    dataDir: '/var/lib/localtunnel',
    logFile: '/var/log/localtunnel/gateway.log',
    logLevel: 'info',
    adminTokenHash: '',
    tls: {
      mode: 'acme',
      acmeDirectoryUrl: LETS_ENCRYPT_PRODUCTION,
      contactEmail: null,
      renewBeforeDays: 30,
    },
    firewall: { manage: true },
    limits: { ...DEFAULT_LIMITS },
    ...overrides,
  };
}

export function loadConfig(path: string): GatewayConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GatewayConfig>;
  const config = defaultConfig(raw);
  config.tls = { ...defaultConfig().tls, ...(raw.tls ?? {}) };
  config.limits = { ...DEFAULT_LIMITS, ...(raw.limits ?? {}) };
  config.firewall = { ...defaultConfig().firewall, ...(raw.firewall ?? {}) };

  if (!config.adminTokenHash) {
    throw new Error(`${path}: adminTokenHash is required — re-run the installer`);
  }
  return config;
}
