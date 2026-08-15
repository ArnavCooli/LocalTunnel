import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';

/**
 * The desktop app's own configuration.
 *
 * Deliberately thin: the gateway is the source of truth for machines and services,
 * so all this holds is how to reach each gateway. Losing this file costs the user a
 * re-add, not their public website.
 */

export interface GatewayProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  provider: string;
  region: string | null;
  fingerprint: string;
  /** Encrypted with the OS keychain when available; plaintext only as a fallback. */
  adminTokenCipher: string;
  adminTokenPlain?: string;
  addedAt: string;
}

export interface AppState {
  version: number;
  /** False until the user finishes the first-run flow. */
  onboarded: boolean;
  gateways: GatewayProfile[];
  activeGatewayId: string | null;
  settings: {
    launchAtLogin: boolean;
    agentAutostart: boolean;
    theme: 'system' | 'dark' | 'light';
  };
  /** Progress through the Oracle wizard, so closing the app does not lose it. */
  wizard: { provider: string | null; stepIndex: number } | null;
}

const EMPTY: AppState = {
  version: 1,
  onboarded: false,
  gateways: [],
  activeGatewayId: null,
  settings: { launchAtLogin: true, agentAutostart: true, theme: 'system' },
  wizard: null,
};

export class AppStore {
  private state: AppState;
  private readonly path: string;

  constructor(dir?: string) {
    const base = dir ?? app.getPath('userData');
    this.path = join(base, 'localtunnel.json');
    mkdirSync(dirname(this.path), { recursive: true });
    this.state = this.read();
  }

  private read(): AppState {
    if (!existsSync(this.path)) return structuredClone(EMPTY);
    try {
      return { ...structuredClone(EMPTY), ...(JSON.parse(readFileSync(this.path, 'utf8')) as AppState) };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private write(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  snapshot(): AppState {
    return structuredClone(this.state);
  }

  /** Back to first-launch: no gateways, no tokens, no settings, not onboarded. */
  reset(): AppState {
    this.state = structuredClone(EMPTY);
    this.write();
    return this.snapshot();
  }

  get onboarded(): boolean {
    return this.state.onboarded;
  }

  setOnboarded(value: boolean): void {
    this.state.onboarded = value;
    this.write();
  }

  get settings(): AppState['settings'] {
    return this.state.settings;
  }

  updateSettings(patch: Partial<AppState['settings']>): AppState['settings'] {
    this.state.settings = { ...this.state.settings, ...patch };
    this.write();
    return this.state.settings;
  }

  setWizardProgress(progress: AppState['wizard']): void {
    this.state.wizard = progress;
    this.write();
  }

  /* ------------------------------------------------------------ gateways */

  get gateways(): GatewayProfile[] {
    return this.state.gateways;
  }

  gateway(id: string): GatewayProfile | undefined {
    return this.state.gateways.find((g) => g.id === id);
  }

  activeGateway(): GatewayProfile | null {
    const id = this.state.activeGatewayId;
    return (id ? this.gateway(id) : this.state.gateways[0]) ?? null;
  }

  setActiveGateway(id: string): void {
    this.state.activeGatewayId = id;
    this.write();
  }

  addGateway(profile: Omit<GatewayProfile, 'adminTokenCipher' | 'addedAt'> & { adminToken: string }): GatewayProfile {
    const { adminToken, ...rest } = profile;
    const record: GatewayProfile = {
      ...rest,
      ...encryptToken(adminToken),
      addedAt: new Date().toISOString(),
    };
    // Re-installing onto the same IP replaces the old entry rather than duplicating.
    const existing = this.state.gateways.findIndex((g) => g.host === record.host);
    if (existing >= 0) this.state.gateways[existing] = record;
    else this.state.gateways.push(record);
    this.state.activeGatewayId = record.id;
    this.write();
    return record;
  }

  removeGateway(id: string): void {
    this.state.gateways = this.state.gateways.filter((g) => g.id !== id);
    if (this.state.activeGatewayId === id) {
      this.state.activeGatewayId = this.state.gateways[0]?.id ?? null;
    }
    this.write();
  }

  renameGateway(id: string, name: string): void {
    const gateway = this.gateway(id);
    if (!gateway) return;
    gateway.name = name.slice(0, 64);
    this.write();
  }

  /** The admin token in the clear, for use by the gateway client only. */
  adminToken(id: string): string | null {
    const gateway = this.gateway(id);
    if (!gateway) return null;
    return decryptToken(gateway);
  }
}

function encryptToken(token: string): { adminTokenCipher: string; adminTokenPlain?: string } {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { adminTokenCipher: safeStorage.encryptString(token).toString('base64') };
    }
  } catch {
    /* fall through to the plaintext fallback below */
  }
  // No OS keychain (some Linux desktops). The file is 0600 in the user's own
  // profile; the alternative would be refusing to work at all.
  return { adminTokenCipher: '', adminTokenPlain: token };
}

function decryptToken(gateway: GatewayProfile): string | null {
  if (gateway.adminTokenPlain) return gateway.adminTokenPlain;
  if (!gateway.adminTokenCipher) return null;
  try {
    return safeStorage.decryptString(Buffer.from(gateway.adminTokenCipher, 'base64'));
  } catch {
    return null;
  }
}
