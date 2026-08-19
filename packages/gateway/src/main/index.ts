#!/usr/bin/env node
import { join } from 'node:path';
import { defaultConfig, loadConfig, type GatewayConfig } from './config.js';
import { createRootLogger, type Logger } from './log.js';
import { Store } from './state.js';
import { ensureCa, ensureIdentityCertificate, certificateFingerprint } from '../auth/ca.js';
import { ConnectionCounter, RateLimiter } from '../auth/limits.js';
import { EnrollmentHandler } from '../auth/enroll.js';
import { TunnelRegistry } from '../tunnels/registry.js';
import { CertificateManager } from '../tls/certificates.js';
import { HttpProxy } from '../ingress/http-proxy.js';
import { TcpForwarder } from '../ingress/tcp-forwarder.js';
import { IngressServer } from '../ingress/server.js';
import { AdminApi } from '../admin/api.js';
import { Firewall } from '../system/firewall.js';

const DEFAULT_CONFIG_PATH = '/etc/localtunnel/gateway.json';
const FIFTEEN_MINUTES = 15 * 60 * 1000;

export interface RunningGateway {
  config: GatewayConfig;
  store: Store;
  registry: TunnelRegistry;
  certificates: CertificateManager;
  identityFingerprint: string;
  stop: () => Promise<void>;
}

/**
 * Boot a gateway. Exported so the integration tests can run a real gateway
 * in-process rather than testing a mock.
 */
export async function startGateway(config: GatewayConfig, logger?: Logger): Promise<RunningGateway> {
  const log = logger ?? createRootLogger(config.logFile, config.logLevel);
  const startedAt = new Date();

  const store = new Store(config.dataDir);
  const ca = ensureCa(join(config.dataDir, 'ca'));
  const identity = ensureIdentityCertificate(join(config.dataDir, 'ca'), ca, config.publicIp);
  const identityFingerprint = certificateFingerprint(identity.certPem);

  const certificates = new CertificateManager(config, log.child('tls'));
  const registry = new TunnelRegistry(
    store,
    log.child('tunnels'),
    { streamsPerMachine: config.limits.streamsPerMachine },
    config.publicIp,
    config.gatewayId,
  );
  const connections = new ConnectionCounter(config.limits.concurrentPerIp, config.limits.concurrentTotal);
  const firewall = new Firewall(log.child('firewall'), config.firewall.manage);
  const forwarder = new TcpForwarder(store, registry, log.child('tcp'), connections, firewall);
  const proxy = new HttpProxy({ store, registry, log: log.child('http'), hsts: config.tls.mode === 'acme' });

  const enrollment = new EnrollmentHandler(
    store,
    ca,
    log.child('enrol'),
    new RateLimiter(config.limits.enrollFailuresPerIp, FIFTEEN_MINUTES),
    config.gatewayId,
  );

  const admin = new AdminApi({
    config,
    store,
    registry,
    certificates,
    forwarder,
    log: log.child('admin'),
    limiter: new RateLimiter(config.limits.adminFailuresPerIp, FIFTEEN_MINUTES),
    onChange: async () => {
      registry.syncAll();
      await forwarder.reconcile();
    },
    startedAt,
  });

  await certificates.init(store.certificateHostnames());
  await forwarder.reconcile();
  // Make sure the ports the gateway itself needs are open, whatever the installer did.
  await firewall.openPort(config.httpsPort, 'tcp');
  await firewall.openPort(config.httpPort, 'tcp');

  const ingress = new IngressServer({
    config,
    log: log.child('ingress'),
    store,
    identity,
    ca,
    certificates,
    registry,
    proxy,
    admin,
    enrollment,
    connections,
  });
  await ingress.listen();

  // Temporary links expire on their own.
  const expiryTimer = setInterval(() => {
    const expired = store.expireServices();
    if (expired.length > 0) {
      log.info('temporary services expired', { count: expired.length });
      registry.syncAll();
      void forwarder.reconcile();
    }
  }, 30_000);
  expiryTimer.unref();

  log.info('gateway ready', {
    gatewayId: config.gatewayId,
    publicIp: config.publicIp,
    httpsPort: config.httpsPort,
    tlsMode: config.tls.mode,
    machines: store.machines.length,
    services: store.services.length,
    fingerprint: identityFingerprint,
  });

  return {
    config,
    store,
    registry,
    certificates,
    identityFingerprint,
    stop: async () => {
      clearInterval(expiryTimer);
      registry.shutdown();
      forwarder.close();
      ingress.close();
      store.save();
      log.info('gateway stopped');
    },
  };
}

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? process.env.LOCALTUNNEL_CONFIG ?? DEFAULT_CONFIG_PATH;
  let config: GatewayConfig;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    process.stderr.write(
      `LocalTunnel gateway could not start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
    return;
  }

  const gateway = await startGateway(config);

  const shutdown = (signal: string) => {
    void gateway.stop().then(() => {
      process.stderr.write(`localtunnel-gateway stopped (${signal})\n`);
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  /*
   * A public-facing daemon must not be killable by one bad request.
   *
   * Node ends the process on an unhandled rejection, and every request handler
   * here is async — so without this, any throw on a request path is a remote
   * denial of service. Handlers contain their own failures; these two are the
   * backstop, and they log loudly because a hit means something got past them.
   */
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`unhandled rejection: ${detail}\n`);
  });
  process.on('uncaughtException', (err) => {
    process.stderr.write(`uncaught exception: ${err.stack ?? err.message}\n`);
  });
}

export { defaultConfig, loadConfig };

if (require.main === module) {
  void main();
}
