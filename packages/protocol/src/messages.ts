/** Control messages carried on stream 0 (see PROTOCOL.md §4). */

export type ServiceType = 'http' | 'https' | 'tcp' | 'udp';

export interface ServiceDescriptor {
  id: string;
  name: string;
  type: ServiceType;
  localHost: string;
  localPort: number;
  /** Public hostname for http/https services. */
  hostname?: string | null;
  /** Public port for raw tcp/udp services. */
  publicPort?: number | null;
  /** Set when the user knowingly exposed a device other than this computer. */
  allowLanTarget?: boolean;
}

export interface HelloMessage {
  t: 'hello';
  protocol: number;
  agentVersion: string;
  machineId: string;
  hostname: string;
  os: string;
  arch: string;
}

export interface HelloOkMessage {
  t: 'hello.ok';
  gatewayVersion: string;
  gatewayId: string;
  publicIp: string;
  heartbeatMs: number;
}

export interface HelloErrMessage {
  t: 'hello.err';
  error: string;
  supportedProtocols: number[];
}

export interface ServicesSyncMessage {
  t: 'services.sync';
  services: ServiceDescriptor[];
}

export interface ServiceProbe {
  reachable: boolean;
  latencyMs?: number;
  error?: string;
}

export interface ServicesAckMessage {
  t: 'services.ack';
  accepted: string[];
  rejected?: { id: string; reason: string }[];
  probe: Record<string, ServiceProbe>;
}

export interface PingMessage {
  t: 'ping';
  ts: number;
}

export interface PongMessage {
  t: 'pong';
  ts: number;
}

export interface MetricsMessage {
  t: 'metrics';
  ts: number;
  streams: number;
  bytesIn: number;
  bytesOut: number;
  opens: number;
  openFailures: number;
}

export interface RevokedMessage {
  t: 'revoked';
  reason: string;
}

export type ControlMessage =
  | HelloMessage
  | HelloOkMessage
  | HelloErrMessage
  | ServicesSyncMessage
  | ServicesAckMessage
  | PingMessage
  | PongMessage
  | MetricsMessage
  | RevokedMessage;

/** Payload of an OPEN frame. */
export interface OpenRequest {
  serviceId: string;
  remoteAddr: string;
  proto: 'tcp';
}

/** Payload of a CLOSE frame carrying a reason. */
export interface CloseReason {
  reason: string;
  code?: 'no_such_service' | 'dial_failed' | 'policy_denied' | 'limit' | 'shutdown';
}

/* ---------------------------------------------------------------- enrolment */

export interface EnrollRequest {
  t: 'enroll';
  token: string;
  csrPem: string;
  hostname: string;
  os: string;
  arch: string;
  agentVersion: string;
}

export interface EnrollOk {
  t: 'enroll.ok';
  machineId: string;
  certPem: string;
  caPem: string;
  gatewayId: string;
  expiresAt: string;
}

export interface EnrollErr {
  t: 'enroll.err';
  error: string;
}

export type EnrollResponse = EnrollOk | EnrollErr;
