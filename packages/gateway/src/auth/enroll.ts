import type { Duplex } from 'node:stream';
import {
  FrameParser,
  FrameType,
  encodeJsonFrame,
  newId,
  type EnrollRequest,
  type EnrollResponse,
} from '@localtunnel/protocol';
import type { Logger } from '../main/log.js';
import type { Store } from '../main/state.js';
import { issueClientCertificate, type CaMaterial } from './ca.js';
import type { RateLimiter } from './limits.js';

const ENROLL_TIMEOUT_MS = 15_000;

/**
 * Handles the `lt-enroll/1` sub-protocol: one request, one response, then close.
 *
 * A machine can only get a certificate by presenting a single-use token that was
 * minted through the authenticated admin API. There is no other path to an identity.
 */
export class EnrollmentHandler {
  constructor(
    private readonly store: Store,
    private readonly ca: CaMaterial,
    private readonly log: Logger,
    private readonly limiter: RateLimiter,
    private readonly gatewayId: string,
  ) {}

  handle(socket: Duplex, remoteIp: string): void {
    if (!this.limiter.remaining(remoteIp)) {
      this.log.warn('enrolment blocked by rate limit', { ip: remoteIp });
      socket.destroy();
      return;
    }

    const parser = new FrameParser();
    const timeout = setTimeout(() => socket.destroy(), ENROLL_TIMEOUT_MS);
    timeout.unref();

    socket.on('error', () => clearTimeout(timeout));
    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = parser.push(chunk);
      } catch {
        clearTimeout(timeout);
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.type !== FrameType.CONTROL) continue;
        clearTimeout(timeout);
        let request: EnrollRequest;
        try {
          request = JSON.parse(frame.payload.toString('utf8')) as EnrollRequest;
        } catch {
          socket.destroy();
          return;
        }
        this.respond(socket, request, remoteIp);
        return;
      }
    });
  }

  private respond(socket: Duplex, request: EnrollRequest, remoteIp: string): void {
    const reply = (response: EnrollResponse) => {
      socket.write(encodeJsonFrame(FrameType.CONTROL, 0, response));
      setTimeout(() => socket.end(), 50).unref();
    };

    if (request.t !== 'enroll' || typeof request.token !== 'string' || typeof request.csrPem !== 'string') {
      this.limiter.fail(remoteIp);
      reply({ t: 'enroll.err', error: 'malformed enrolment request' });
      return;
    }

    const machineId = newId('m');
    const consumed = this.store.consumeEnrollToken(request.token, machineId);
    if (!consumed) {
      this.limiter.fail(remoteIp);
      this.log.warn('enrolment rejected', {
        ip: remoteIp,
        tokenPrefix: request.token.slice(0, 6),
        reason: 'unknown, spent or expired token',
      });
      reply({
        t: 'enroll.err',
        error: 'This enrolment code is not valid any more. Generate a new one in LocalTunnel.',
      });
      return;
    }

    let issued;
    try {
      issued = issueClientCertificate(this.ca, request.csrPem, machineId);
    } catch (err) {
      this.log.error('certificate issuance failed', {
        machineId,
        error: err instanceof Error ? err.message : String(err),
      });
      reply({ t: 'enroll.err', error: 'The gateway could not issue a certificate for this machine.' });
      return;
    }

    const name = sanitizeName(request.hostname) || 'New machine';
    this.store.addMachine({
      id: machineId,
      name,
      hostname: name,
      os: sanitizeName(request.os) || 'unknown',
      arch: sanitizeName(request.arch) || 'unknown',
      certSerial: issued.serial,
      certExpiresAt: issued.expiresAt,
      enrolledAt: new Date().toISOString(),
      lastSeenAt: null,
      revoked: false,
      revokedAt: null,
    });

    this.log.info('machine enrolled', { machineId, hostname: name, ip: remoteIp });
    this.limiter.reset(remoteIp);

    reply({
      t: 'enroll.ok',
      machineId,
      certPem: issued.certPem,
      caPem: this.ca.certPem,
      gatewayId: this.gatewayId,
      expiresAt: issued.expiresAt,
    });
  }
}

function sanitizeName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[^\w .\-]/g, '').slice(0, 64).trim();
}
