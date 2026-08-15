const { contextBridge } = require('electron');

/**
 * A stand-in for the real preload bridge.
 *
 * The desktop UI normally talks to the main process, which talks to a gateway over
 * the network and to a background agent over a unix socket. None of that is
 * available in a test, and pointing the UI at a real gateway would make the tests
 * depend on someone's VPS. So this exposes the same API surface backed by
 * fixtures — the renderer, components and CSS under test are the real ones.
 *
 * Scenario is chosen with LT_UI_SCENARIO:
 *   fresh       nothing set up yet — first launch
 *   configured  a gateway, one machine, two services (one of them unhealthy)
 *   offline     a gateway that cannot be reached
 */

const scenario = process.env.LT_UI_SCENARIO || 'configured';
const noop = () => () => {};

const cert = {
  hostname: 'mysite.example.com',
  state: 'valid',
  expiresAt: '2027-04-18T00:00:00.000Z',
  autoRenew: true,
  error: null,
  issuer: "Let's Encrypt",
};

const machine = {
  id: 'm_1',
  name: 'MacBook',
  hostname: 'macbook',
  os: 'darwin',
  arch: 'arm64',
  certSerial: '0a',
  certExpiresAt: '2028-01-01T00:00:00.000Z',
  enrolledAt: '2026-08-01T00:00:00.000Z',
  lastSeenAt: new Date().toISOString(),
  revoked: false,
  revokedAt: null,
  connected: true,
  latencyMs: 24,
  activeStreams: 3,
  agentVersion: '1.0.0',
  serviceCount: 2,
};

const stats = {
  bytesIn: 1_200_000,
  bytesOut: 400_000,
  requests: 18_432,
  status2xx: 18_100,
  status4xx: 280,
  status5xx: 43,
  errors: 2,
  connections: 12,
};

const services = [
  {
    id: 'svc_1', machineId: 'm_1', name: 'My Website', type: 'http',
    localHost: '127.0.0.1', localPort: 3000, hostname: 'mysite.example.com', publicPort: null,
    enabled: true, allowLanTarget: false, expiresAt: null, createdAt: '2026-08-01T00:00:00.000Z',
    stats, machineConnected: true, localReachable: true, localError: null, certificate: cert,
    publicUrl: 'https://mysite.example.com', status: 'online',
  },
  {
    id: 'svc_2', machineId: 'm_1', name: 'Minecraft', type: 'tcp',
    localHost: '127.0.0.1', localPort: 25565, hostname: null, publicPort: 25565,
    enabled: true, allowLanTarget: false, expiresAt: null, createdAt: '2026-08-01T00:00:00.000Z',
    stats, machineConnected: true, localReachable: false,
    localError: 'Nothing is listening on 127.0.0.1:25565.', certificate: null,
    publicUrl: '129.153.0.1:25565', status: 'local_unreachable',
  },
];

const status = {
  ok: true,
  gateway: {
    id: 'gw_1', name: 'US East', version: '1.0.0', publicIp: '129.153.0.1',
    httpsPort: 443, httpPort: 80, tlsMode: 'acme', startedAt: '2026-08-01T00:00:00.000Z',
    uptimeSeconds: 96_000, totals: { bytesIn: 42e9, bytesOut: 8e9 },
  },
  machines: [machine],
  services,
  certificates: [cert],
  ports: [
    { port: 443, proto: 'tcp', label: 'HTTPS', open: true },
    { port: 80, proto: 'tcp', label: 'HTTP', open: true },
    { port: 25565, proto: 'tcp', label: 'Minecraft', open: true },
  ],
};

const agentStatus = {
  state: 'connected', machineId: 'm_1', gatewayId: 'gw_1', gatewayHost: '129.153.0.1',
  latencyMs: 24, connectedSince: new Date().toISOString(), services: [],
  probes: {
    svc_1: { reachable: true, latencyMs: 1 },
    svc_2: { reachable: false, error: 'Nothing is listening on 127.0.0.1:25565.' },
  },
  lastError: null, retryInSeconds: null, attempts: 0,
  bytesIn: 1e6, bytesOut: 2e6, activeStreams: 3,
};

const state = {
  onboarded: scenario !== 'fresh',
  activeGatewayId: scenario === 'fresh' ? null : 'gw_1',
  settings: { launchAtLogin: true, agentAutostart: true, theme: 'system' },
  wizard: null,
  platform: 'darwin',
  version: '1.0.0',
};

let hasGateway = scenario !== 'fresh';

const gatewayRow = {
  id: 'gw_1', name: 'US East', host: '129.153.0.1', port: 443,
  provider: 'oracle', region: 'us-east', addedAt: '2026-08-01T00:00:00.000Z',
  sshUsername: 'opc', sshPort: 22, active: true,
};

contextBridge.exposeInMainWorld('localtunnel', {
  app: {
    state: async () => state,
    setOnboarded: async (v) => ((state.onboarded = v), state),
    setWizardProgress: async (p) => ((state.wizard = p), state),
    updateSettings: async (patch) => Object.assign(state.settings, patch),
    openExternal: async () => {},
    pickPrivateKey: async () => '/tmp/test-key',
    reset: async () => {
      state.onboarded = false;
      state.activeGatewayId = null;
      hasGateway = false;
      return {
        ok: true,
        steps: [
          'Revoked this computer on the gateway',
          'Removed the login item',
          "Stopped the agent and deleted this computer's identity",
          'Cleared saved gateways, admin tokens, settings and setup progress',
        ],
      };
    },
  },
  gateway: {
    list: async () => (hasGateway ? [gatewayRow] : []),
    status: async () =>
      !hasGateway ? null : scenario === 'offline' ? { ok: false, error: 'Nothing answered on 129.153.0.1:443.' } : status,
    setActive: async () => state,
    rename: async () => state,
    remove: async () => ((hasGateway = false), state),
    addExisting: async () => gatewayRow,
    install: async () => ({ gateway: { id: 'gw_1', name: 'US East', host: '129.153.0.1' } }),
    installSteps: async () => [
      { key: 'connect', label: 'Connecting to your server' },
      { key: 'upload', label: 'Uploading the LocalTunnel Gateway' },
      { key: 'start', label: 'Starting the gateway' },
    ],
    onInstallProgress: noop,
    onUninstallProgress: noop,
    uninstall: async () => ({
      ok: true,
      steps: [
        'Stopped and removed the gateway service',
        'Deleted /opt/localtunnel, /etc/localtunnel and /var/lib/localtunnel',
        'Removed the localtunnel system user',
        'Verified nothing is left behind',
      ],
      output: ['running the installer\'s own uninstall script', 'LOCALTUNNEL_UNINSTALLED'],
    }),
    sshCredentials: async () => ({
      agent: { available: true, identities: ['you@example.com (ED25519)'], socket: '/tmp/agent.sock' },
      keys: [
        { path: '/Users/test/.ssh/id_ed25519', type: 'ssh-ed25519', encrypted: false, hasPublicHalf: true, comment: null },
        { path: '/Users/test/.ssh/oracle.key', type: 'openssh', encrypted: true, hasPublicHalf: false, comment: null },
      ],
      home: '/Users/test',
    }),
  },
  machine: {
    list: async () => (hasGateway ? [machine] : []),
    revoke: async () => ({}),
    remove: async () => ({}),
    rename: async () => ({}),
  },
  agent: {
    status: async () => (hasGateway ? agentStatus : null),
    connect: async () => ({ machineId: 'm_1', gatewayId: 'gw_1' }),
    start: async () => agentStatus,
    stop: async () => ({ ...agentStatus, state: 'idle' }),
    disconnect: async () => ({ ok: true, steps: ['Stopped the background agent'] }),
    discover: async () => ({ services: [{ port: 3000, guess: 'http' }] }),
    onStatus: noop,
    onLog: noop,
  },
  service: {
    list: async () => (hasGateway ? services : []),
    create: async () => services[0],
    update: async () => services[0],
    remove: async () => ({}),
  },
  cert: { list: async () => [cert], reissue: async () => cert },
  diagnostics: {
    run: async () => [
      { id: 'internet', label: 'Internet', state: 'pass', detail: 'This computer is online.' },
      {
        id: 'dns', label: 'DNS', state: 'fail',
        detail: 'mysite.example.com points somewhere else.',
        fix: 'Change the A record for mysite.example.com to 129.153.0.1.',
        facts: [
          { label: 'Currently resolves to', value: '203.0.113.9' },
          { label: 'Your gateway', value: '129.153.0.1' },
        ],
      },
    ],
  },
  dns: { check: async () => ({ resolved: true, addresses: ['129.153.0.1'], matches: true }) },
  logs: { gateway: async () => ({ hint: "ssh 129.153.0.1 'sudo journalctl -u localtunnel-gateway'" }) },
});
