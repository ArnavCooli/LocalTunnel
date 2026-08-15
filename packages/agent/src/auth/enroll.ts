import { createHash } from 'node:crypto';
import tls from 'node:tls';
import {
  ALPN,
  FrameParser,
  FrameType,
  encodeJsonFrame,
  type EnrollRequest,
  type EnrollResponse,
} from '@localtunnel/protocol';
import { Identity, type Credentials } from './identity.js';

const AGENT_VERSION = '1.0.0';
const ENROLL_TIMEOUT_MS = 20_000;

export interface EnrollOptions {
  host: string;
  port: number;
  token: string;
  /** Colon-separated SHA-256 fingerprint captured over SSH when the gateway was installed. */
  fingerprint: string;
}

/**
 * Exchange a single-use enrolment token for a client certificate.
 *
 * The gateway is authenticated by pinned fingerprint rather than by a public CA:
 * trust is rooted in the SSH session the user already used to install it, and it
 * means a gateway needs no domain name of its own.
 */
export async function enroll(options: EnrollOptions, identity = new Identity()): Promise<Credentials> {
  const csrPem = identity.createCsr();
  const details = identity.describe();

  const socket = await connectPinned(options);
  const request: EnrollRequest = {
    t: 'enroll',
    token: options.token,
    csrPem,
    hostname: details.hostname,
    os: details.os,
    arch: details.arch,
    agentVersion: AGENT_VERSION,
  };

  const response = await exchange(socket, request);
  if (response.t === 'enroll.err') {
    throw new Error(response.error);
  }

  const credentials: Credentials = {
    gatewayId: response.gatewayId,
    gatewayHost: options.host,
    gatewayPort: options.port,
    gatewayFingerprint: normalizeFingerprint(options.fingerprint),
    machineId: response.machineId,
    certPem: response.certPem,
    caPem: response.caPem,
    expiresAt: response.expiresAt,
  };
  identity.saveCredentials(credentials);
  return credentials;
}

export function normalizeFingerprint(value: string): string {
  return value.replace(/[^a-f0-9]/gi, '').toUpperCase();
}

/** Connect and verify the gateway certificate by fingerprint, not by CA chain. */
export function connectPinned(options: {
  host: string;
  port: number;
  fingerprint: string;
  alpn?: string;
  cert?: string;
  key?: string;
  ca?: string;
}): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const expected = normalizeFingerprint(options.fingerprint);
    const socket = tls.connect({
      host: options.host,
      port: options.port,
      ALPNProtocols: [options.alpn ?? ALPN.enroll],
      minVersion: 'TLSv1.2',
      // The gateway presents a self-signed identity certificate, so chain
      // verification is replaced by an exact fingerprint match below.
      rejectUnauthorized: false,
      cert: options.cert,
      key: options.key,
      ca: options.ca ? [options.ca] : undefined,
      servername: undefined,
    });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`The gateway at ${options.host}:${options.port} did not respond.`));
    }, ENROLL_TIMEOUT_MS);

    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const peer = socket.getPeerCertificate();
      if (!peer?.raw) {
        socket.destroy();
        reject(new Error('The gateway did not present a certificate.'));
        return;
      }
      const actual = createHash('sha256').update(peer.raw).digest('hex').toUpperCase();
      if (actual !== expected) {
        socket.destroy();
        reject(
          new Error(
            'The gateway\'s identity does not match the one LocalTunnel recorded. ' +
              'If you reinstalled the gateway, remove it and add it again.',
          ),
        );
        return;
      }
      resolve(socket);
    });

    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(friendlyConnectError(err, options.host, options.port)));
    });
  });
}

function exchange(socket: tls.TLSSocket, request: EnrollRequest): Promise<EnrollResponse> {
  return new Promise((resolve, reject) => {
    const parser = new FrameParser();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('The gateway did not answer the enrolment request in time.'));
    }, ENROLL_TIMEOUT_MS);

    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = parser.push(chunk);
      } catch (err) {
        clearTimeout(timer);
        socket.destroy();
        reject(err as Error);
        return;
      }
      for (const frame of frames) {
        if (frame.type !== FrameType.CONTROL) continue;
        clearTimeout(timer);
        socket.end();
        try {
          resolve(JSON.parse(frame.payload.toString('utf8')) as EnrollResponse);
        } catch {
          reject(new Error('The gateway sent a malformed response.'));
        }
        return;
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.write(encodeJsonFrame(FrameType.CONTROL, 0, request));
  });
}

export function friendlyConnectError(err: unknown, host: string, port: number): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return `Nothing is listening on ${host}:${port}. Is the gateway running?`;
    case 'ETIMEDOUT':
      return `${host}:${port} did not respond. Check that TCP ${port} is open in your VPS provider's firewall.`;
    case 'ENOTFOUND':
      return `${host} could not be resolved.`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${host} is unreachable from this network.`;
    default:
      return err instanceof Error ? err.message : String(err);
  }
}
