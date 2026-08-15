import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ServiceType } from '@localtunnel/protocol';
import { newId, newToken } from '@localtunnel/protocol';

export interface MachineRecord {
  id: string;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  certSerial: string;
  certExpiresAt: string;
  enrolledAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
}

export interface ServiceStats {
  bytesIn: number;
  bytesOut: number;
  requests: number;
  status2xx: number;
  status4xx: number;
  status5xx: number;
  errors: number;
  connections: number;
}

export interface ServiceRecord {
  id: string;
  machineId: string;
  name: string;
  type: ServiceType;
  localHost: string;
  localPort: number;
  hostname: string | null;
  publicPort: number | null;
  enabled: boolean;
  allowLanTarget: boolean;
  /** Set for temporary links; the service is removed automatically after this. */
  expiresAt: string | null;
  createdAt: string;
  stats: ServiceStats;
}

export interface EnrollTokenRecord {
  /** SHA-256 of the token. The token itself exists only in the desktop app. */
  hash: string;
  prefix: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByMachineId: string | null;
}

interface StateShape {
  version: number;
  machines: MachineRecord[];
  services: ServiceRecord[];
  enrollTokens: EnrollTokenRecord[];
  revokedSerials: string[];
  totals: { bytesIn: number; bytesOut: number };
}

const EMPTY: StateShape = {
  version: 1,
  machines: [],
  services: [],
  enrollTokens: [],
  revokedSerials: [],
  totals: { bytesIn: 0, bytesOut: 0 },
};

export function emptyStats(): ServiceStats {
  return {
    bytesIn: 0,
    bytesOut: 0,
    requests: 0,
    status2xx: 0,
    status4xx: 0,
    status5xx: 0,
    errors: 0,
    connections: 0,
  };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const ENROLL_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * The gateway's own source of truth. Deliberately a plain JSON file: the gateway
 * must keep working with no contact to any cloud account, and an operator must be
 * able to read and repair its state with a text editor.
 */
export class Store {
  private state: StateShape;
  private readonly path: string;
  private saveScheduled = false;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'state.json');
    mkdirSync(dirname(this.path), { recursive: true });
    this.state = this.read();
  }

  private read(): StateShape {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StateShape;
      return { ...structuredClone(EMPTY), ...parsed };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  /** Atomic write: temp file then rename, so a crash never leaves half a state file. */
  save(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.saveScheduled = false;
  }

  /** Coalesce the frequent small writes (counters, lastSeen) into one per second. */
  saveSoon(): void {
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    setTimeout(() => {
      try {
        this.save();
      } catch {
        this.saveScheduled = false;
      }
    }, 1000).unref();
  }

  /* -------------------------------------------------------------- machines */

  get machines(): MachineRecord[] {
    return this.state.machines;
  }

  machine(id: string): MachineRecord | undefined {
    return this.state.machines.find((m) => m.id === id);
  }

  addMachine(machine: MachineRecord): void {
    this.state.machines.push(machine);
    this.save();
  }

  revokeMachine(id: string): MachineRecord | undefined {
    const machine = this.machine(id);
    if (!machine || machine.revoked) return machine;
    machine.revoked = true;
    machine.revokedAt = new Date().toISOString();
    if (!this.state.revokedSerials.includes(machine.certSerial)) {
      this.state.revokedSerials.push(machine.certSerial);
    }
    // A revoked machine's services stop being routable immediately.
    for (const service of this.servicesForMachine(id)) service.enabled = false;
    this.save();
    return machine;
  }

  removeMachine(id: string): void {
    this.revokeMachine(id);
    this.state.services = this.state.services.filter((s) => s.machineId !== id);
    this.state.machines = this.state.machines.filter((m) => m.id !== id);
    this.save();
  }

  isSerialRevoked(serial: string): boolean {
    return this.state.revokedSerials.includes(serial);
  }

  touchMachine(id: string): void {
    const machine = this.machine(id);
    if (!machine) return;
    machine.lastSeenAt = new Date().toISOString();
    this.saveSoon();
  }

  /* -------------------------------------------------------------- services */

  get services(): ServiceRecord[] {
    return this.state.services;
  }

  service(id: string): ServiceRecord | undefined {
    return this.state.services.find((s) => s.id === id);
  }

  servicesForMachine(machineId: string): ServiceRecord[] {
    return this.state.services.filter((s) => s.machineId === machineId);
  }

  serviceByHostname(hostname: string): ServiceRecord | undefined {
    const needle = hostname.toLowerCase();
    return this.state.services.find((s) => s.enabled && s.hostname?.toLowerCase() === needle);
  }

  serviceByPublicPort(port: number): ServiceRecord | undefined {
    return this.state.services.find((s) => s.enabled && s.publicPort === port);
  }

  addService(record: Omit<ServiceRecord, 'id' | 'createdAt' | 'stats'>): ServiceRecord {
    const service: ServiceRecord = {
      ...record,
      id: newId('svc'),
      createdAt: new Date().toISOString(),
      stats: emptyStats(),
    };
    this.state.services.push(service);
    this.save();
    return service;
  }

  updateService(id: string, patch: Partial<ServiceRecord>): ServiceRecord | undefined {
    const service = this.service(id);
    if (!service) return undefined;
    Object.assign(service, patch);
    this.save();
    return service;
  }

  removeService(id: string): boolean {
    const before = this.state.services.length;
    this.state.services = this.state.services.filter((s) => s.id !== id);
    const removed = this.state.services.length !== before;
    if (removed) this.save();
    return removed;
  }

  /** Drop temporary services whose window has passed. Returns the ids removed. */
  expireServices(now = Date.now()): string[] {
    const expired = this.state.services.filter(
      (s) => s.expiresAt !== null && Date.parse(s.expiresAt) <= now,
    );
    if (expired.length === 0) return [];
    const ids = expired.map((s) => s.id);
    this.state.services = this.state.services.filter((s) => !ids.includes(s.id));
    this.save();
    return ids;
  }

  recordTraffic(serviceId: string, bytesIn: number, bytesOut: number): void {
    const service = this.service(serviceId);
    if (service) {
      service.stats.bytesIn += bytesIn;
      service.stats.bytesOut += bytesOut;
    }
    this.state.totals.bytesIn += bytesIn;
    this.state.totals.bytesOut += bytesOut;
    this.saveSoon();
  }

  recordResponse(serviceId: string, status: number): void {
    const service = this.service(serviceId);
    if (!service) return;
    service.stats.requests += 1;
    if (status >= 500) service.stats.status5xx += 1;
    else if (status >= 400) service.stats.status4xx += 1;
    else if (status >= 200) service.stats.status2xx += 1;
    this.saveSoon();
  }

  recordServiceError(serviceId: string): void {
    const service = this.service(serviceId);
    if (!service) return;
    service.stats.errors += 1;
    this.saveSoon();
  }

  get totals(): { bytesIn: number; bytesOut: number } {
    return this.state.totals;
  }

  /* --------------------------------------------------------- enrol tokens */

  /** Mint a single-use enrolment token. The plaintext is returned exactly once. */
  createEnrollToken(): { token: string; record: EnrollTokenRecord } {
    const token = newToken(32);
    const record: EnrollTokenRecord = {
      hash: sha256(token),
      prefix: token.slice(0, 6),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ENROLL_TOKEN_TTL_MS).toISOString(),
      usedAt: null,
      usedByMachineId: null,
    };
    this.state.enrollTokens.push(record);
    this.pruneEnrollTokens();
    this.save();
    return { token, record };
  }

  /** Consume a token. Returns null when it is unknown, spent, or expired. */
  consumeEnrollToken(token: string, machineId: string): EnrollTokenRecord | null {
    const hash = sha256(token);
    const record = this.state.enrollTokens.find((t) => t.hash === hash);
    if (!record) return null;
    if (record.usedAt !== null) return null;
    if (Date.parse(record.expiresAt) <= Date.now()) return null;
    record.usedAt = new Date().toISOString();
    record.usedByMachineId = machineId;
    this.save();
    return record;
  }

  get enrollTokens(): EnrollTokenRecord[] {
    return this.state.enrollTokens;
  }

  private pruneEnrollTokens(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.state.enrollTokens = this.state.enrollTokens.filter(
      (t) => Date.parse(t.expiresAt) > cutoff,
    );
  }

  /** Every hostname the gateway should hold a certificate for. */
  certificateHostnames(): string[] {
    return this.state.services
      .filter((s) => s.enabled && (s.type === 'http' || s.type === 'https') && s.hostname)
      .map((s) => s.hostname!.toLowerCase());
  }

  /** Public TCP/UDP ports that must be open in the firewall. */
  publicServicePorts(): { port: number; proto: 'tcp' | 'udp' }[] {
    return this.state.services
      .filter((s) => s.enabled && s.publicPort !== null)
      .map((s) => ({ port: s.publicPort!, proto: s.type === 'udp' ? 'udp' : 'tcp' as const }));
  }
}
