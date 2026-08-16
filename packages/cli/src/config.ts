import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentDataDir } from '@localtunnel/agent';
import type { GatewayConnection } from './gateway.js';

/**
 * Where the CLI keeps how to reach each gateway.
 *
 * The gateway is the source of truth for machines and services, so this file only
 * holds addresses, pinned fingerprints and admin tokens. It sits next to the
 * agent's own credentials at 0600; there is no OS keychain to use from a shell on
 * a headless box, which is the same fallback the desktop app takes when a Linux
 * desktop has no keyring.
 */

export interface GatewayProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  fingerprint: string;
  adminToken: string;
  addedAt: string;
}

export interface CliState {
  version: number;
  gateways: GatewayProfile[];
  activeGatewayId: string | null;
}

const EMPTY: CliState = { version: 1, gateways: [], activeGatewayId: null };

export class Config {
  private state: CliState;
  readonly path: string;

  constructor(dir = agentDataDir()) {
    this.path = join(dir, 'cli.json');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.state = this.read();
  }

  private read(): CliState {
    if (!existsSync(this.path)) return structuredClone(EMPTY);
    try {
      return { ...structuredClone(EMPTY), ...(JSON.parse(readFileSync(this.path, 'utf8')) as CliState) };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private write(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get gateways(): GatewayProfile[] {
    return this.state.gateways;
  }

  active(): GatewayProfile | null {
    const id = this.state.activeGatewayId;
    return (id ? this.state.gateways.find((g) => g.id === id) : this.state.gateways[0]) ?? null;
  }

  setActive(id: string): void {
    this.state.activeGatewayId = id;
    this.write();
  }

  add(profile: Omit<GatewayProfile, 'id' | 'addedAt'> & { id?: string }): GatewayProfile {
    const record: GatewayProfile = {
      ...profile,
      id: profile.id ?? randomUUID(),
      fingerprint: normalizeFingerprint(profile.fingerprint),
      addedAt: new Date().toISOString(),
    };
    // Re-adding the same address replaces the old entry rather than duplicating it.
    const existing = this.state.gateways.findIndex((g) => g.host === record.host);
    if (existing >= 0) this.state.gateways[existing] = record;
    else this.state.gateways.push(record);
    this.state.activeGatewayId = record.id;
    this.write();
    return record;
  }

  remove(id: string): void {
    this.state.gateways = this.state.gateways.filter((g) => g.id !== id);
    if (this.state.activeGatewayId === id) {
      this.state.activeGatewayId = this.state.gateways[0]?.id ?? null;
    }
    this.write();
  }

  rename(id: string, name: string): void {
    const gateway = this.state.gateways.find((g) => g.id === id);
    if (!gateway) return;
    gateway.name = name.slice(0, 64);
    this.write();
  }
}

export function connectionOf(profile: GatewayProfile): GatewayConnection {
  return {
    host: profile.host,
    port: profile.port,
    adminToken: profile.adminToken,
    fingerprint: profile.fingerprint,
  };
}

export function normalizeFingerprint(value: string): string {
  return value.replace(/[^a-f0-9]/gi, '').toUpperCase();
}

/**
 * Gateways already set up in the desktop app on this machine.
 *
 * Only readable when the desktop app had no OS keyring and stored the token in the
 * clear; a sealed token can only be unsealed by Electron itself, so for those the
 * app's own Gateways → Connection details screen is where to get it.
 */
export interface ImportCandidate {
  profile: Omit<GatewayProfile, 'id' | 'addedAt'> | null;
  name: string;
  host: string;
  /** Set when the entry exists but its token is sealed in the OS keychain. */
  locked: boolean;
}

export function desktopGateways(): ImportCandidate[] {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const candidates = [
    join(base, 'LocalTunnel', 'localtunnel.json'),
    join(base, 'localtunnel-desktop', 'localtunnel.json'),
    join(base, '@localtunnel', 'desktop', 'localtunnel.json'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        gateways?: {
          name: string;
          host: string;
          port: number;
          fingerprint: string;
          adminTokenPlain?: string;
        }[];
      };
      return (parsed.gateways ?? []).map((g) => ({
        name: g.name,
        host: g.host,
        locked: !g.adminTokenPlain,
        profile: g.adminTokenPlain
          ? {
              name: g.name,
              host: g.host,
              port: g.port || 443,
              fingerprint: g.fingerprint,
              adminToken: g.adminTokenPlain,
            }
          : null,
      }));
    } catch {
      /* unreadable or a different format — treat as nothing to import */
    }
  }
  return [];
}
