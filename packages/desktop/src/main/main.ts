import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from 'electron';
import { join } from 'node:path';
import { agentDataDir, installAutostart, removeAutostart } from '@localtunnel/agent';
import { AppStore } from '../services/store.js';
import { AgentSupervisor, defaultSocketPath } from '../services/agent-supervisor.js';
import { gatewayApi, type GatewayConnection } from '../services/gateway-client.js';
import { GatewayInstaller, INSTALL_STEPS, uninstallGateway, type InstallEvent } from '../setup/installer.js';
import { detectSshCredentials, secureKeyFile } from '../setup/ssh-keys.js';
import { runDiagnostics } from '../diagnostics/engine.js';

let window: BrowserWindow | null = null;
let store: AppStore;
let supervisor: AgentSupervisor;

/**
 * Paths to things shipped with the app: the agent it supervises, and the gateway
 * payload it uploads to a VPS. Packaged builds put all three under `resources/`
 * (see `extraResources` in package.json); in development they sit in the repo.
 */
function resources() {
  const packagedBase = process.resourcesPath;
  const repoBase = join(__dirname, '..', '..', '..', '..');
  return app.isPackaged
    ? {
        agentScript: join(packagedBase, 'agent', 'dist', 'main', 'index.js'),
        gatewayBundle: join(packagedBase, 'gateway', 'localtunnel-gateway.tar.gz'),
        installerScript: join(packagedBase, 'installer', 'install.sh'),
        serviceUnit: join(packagedBase, 'installer', 'localtunnel-gateway.service'),
      }
    : {
        agentScript: join(repoBase, 'packages', 'agent', 'dist', 'main', 'index.js'),
        gatewayBundle: join(repoBase, 'build', 'localtunnel-gateway.tar.gz'),
        installerScript: join(repoBase, 'installer', 'install.sh'),
        serviceUnit: join(repoBase, 'installer', 'localtunnel-gateway.service'),
      };
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 640,
    title: 'LocalTunnel',
    // The UI is a single dark scheme, so the window must not flash light on open.
    backgroundColor: '#000000',
    /*
     * No OS title bar on macOS or Windows: the app draws its own, and the strip
     * across the top of the page is the drag region (see `.titlebar`).
     *
     * macOS keeps its traffic lights and insets them; Windows draws its minimise
     * / maximise / close buttons *over* the page as a Window Controls Overlay,
     * which also publishes the `titlebar-area-*` CSS env vars the layout uses to
     * keep content clear of them. Linux window managers vary too much to hide the
     * frame safely, so there it stays native.
     */
    titleBarStyle: process.platform === 'linux' ? 'default' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 18, y: 14 } }
      : process.platform === 'win32'
        ? {
            titleBarOverlay: { color: '#000000', symbolColor: '#a3a3a3', height: 40 },
          }
        : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      // The renderer gets no Node access at all; everything crosses the narrow
      // bridge in preload.ts.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(join(__dirname, '..', 'renderer', 'index.html'));

  // Links to Oracle Cloud and so on belong in the user's real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.on('closed', () => {
    window = null;
  });
}

/** The connection details for a stored gateway, with its token decrypted. */
function connectionFor(gatewayId?: string): GatewayConnection | null {
  const profile = gatewayId ? store.gateway(gatewayId) : store.activeGateway();
  if (!profile) return null;
  const adminToken = store.adminToken(profile.id);
  if (!adminToken) return null;
  return {
    host: profile.host,
    port: profile.port,
    adminToken,
    fingerprint: profile.fingerprint,
  };
}

function requireConnection(gatewayId?: string): GatewayConnection {
  const connection = connectionFor(gatewayId);
  if (!connection) throw new Error('No gateway has been set up yet.');
  return connection;
}

function registerIpc(): void {
  /* ------------------------------------------------------------ app state */

  ipcMain.handle('app:state', () => ({
    ...store.snapshot(),
    platform: process.platform,
    version: app.getVersion(),
  }));

  ipcMain.handle('app:setOnboarded', (_e, value: boolean) => {
    store.setOnboarded(value);
    return store.snapshot();
  });

  ipcMain.handle('app:setWizardProgress', (_e, progress: { provider: string | null; stepIndex: number } | null) => {
    store.setWizardProgress(progress);
    return store.snapshot();
  });

  ipcMain.handle('app:updateSettings', async (_e, patch: Record<string, unknown>) => {
    const settings = store.updateSettings(patch);
    if ('agentAutostart' in patch) {
      if (settings.agentAutostart) {
        await installAutostart({ execPath: process.execPath, scriptPath: resources().agentScript }).catch(
          () => undefined,
        );
      } else {
        await removeAutostart().catch(() => undefined);
      }
    }
    if ('launchAtLogin' in patch) {
      app.setLoginItemSettings({ openAtLogin: Boolean(settings.launchAtLogin) });
    }
    if ('theme' in patch) {
      nativeTheme.themeSource = settings.theme;
    }
    return settings;
  });

  /**
   * Reset LocalTunnel to first-launch.
   *
   * Everything unlinking does, plus this computer's private key and the app's own
   * record of gateways, tokens and settings. It deliberately does NOT touch the
   * gateway running on the user's VPS — that is their server, it costs money, and
   * silently destroying it from a "reset the app" button would be wrong. The UI
   * says so, and offers the uninstall command for when they do want it gone.
   */
  ipcMain.handle('app:reset', async () => {
    const status = await supervisor.status();
    const machineId = status?.machineId ?? null;
    const steps: string[] = [];

    const connection = connectionFor();
    if (connection && machineId) {
      try {
        await gatewayApi.revokeMachine(connection, machineId);
        steps.push('Revoked this computer on the gateway');
      } catch {
        steps.push('Could not reach the gateway to revoke this computer — revoke it there yourself');
      }
    }

    await removeAutostart()
      .then(() => steps.push('Removed the login item'))
      .catch(() => undefined);

    try {
      await supervisor.reset();
      steps.push("Stopped the agent and deleted this computer's identity");
    } catch {
      steps.push('Could not stop the agent cleanly');
    }

    store.reset();
    nativeTheme.themeSource = 'system';
    steps.push('Cleared saved gateways, admin tokens, settings and setup progress');

    return { ok: true, steps };
  });

  /*
   * Double-clicking a title bar zooms the window. macOS does that for a drag
   * region on its own; Windows does not, so the renderer asks for it explicitly.
   */
  ipcMain.handle('app:toggleMaximize', () => {
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });

  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (!/^https?:\/\//.test(url)) throw new Error('refusing to open a non-http link');
    return shell.openExternal(url);
  });

  ipcMain.handle('app:pickPrivateKey', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Choose your SSH private key',
      properties: ['openFile', 'showHiddenFiles'],
      message: 'Select the private key file your VPS provider gave you.',
    });
    if (result.canceled) return null;
    const path = result.filePaths[0];
    // A key downloaded from a provider arrives world-readable; ssh refuses those.
    secureKeyFile(path);
    return path;
  });

  /* ------------------------------------------------------------ gateways */

  ipcMain.handle('gateway:list', () =>
    store.gateways.map((g) => ({
      id: g.id,
      name: g.name,
      host: g.host,
      port: g.port,
      provider: g.provider,
      region: g.region,
      addedAt: g.addedAt,
      sshUsername: g.sshUsername ?? null,
      sshPort: g.sshPort ?? 22,
      active: store.activeGateway()?.id === g.id,
    })),
  );

  ipcMain.handle('gateway:status', async (_e, gatewayId?: string) => {
    const connection = connectionFor(gatewayId);
    if (!connection) return null;
    try {
      return { ok: true, ...(await gatewayApi.status(connection)) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('gateway:setActive', (_e, id: string) => {
    store.setActiveGateway(id);
    return store.snapshot();
  });

  ipcMain.handle('gateway:rename', (_e, id: string, name: string) => {
    store.renameGateway(id, name);
    return store.snapshot();
  });

  ipcMain.handle('gateway:remove', (_e, id: string) => {
    store.removeGateway(id);
    return store.snapshot();
  });

  ipcMain.handle(
    'gateway:addExisting',
    (_e, profile: { name: string; host: string; port: number; adminToken: string; fingerprint: string; provider: string }) => {
      return store.addGateway({
        id: `gw_${Date.now().toString(36)}`,
        name: profile.name,
        host: profile.host,
        port: profile.port || 443,
        provider: profile.provider || 'generic',
        region: null,
        fingerprint: profile.fingerprint,
        adminToken: profile.adminToken,
      });
    },
  );

  ipcMain.handle('gateway:install', async (event, target: Record<string, string>) => {
    const paths = resources();
    const installer = new GatewayInstaller();
    installer.on('event', (payload: InstallEvent) => {
      event.sender.send('gateway:install-progress', payload);
    });

    const result = await installer.run({
      host: String(target.host),
      port: Number(target.port) || 22,
      username: String(target.username),
      privateKeyPath: target.privateKeyPath ? String(target.privateKeyPath) : null,
      useAgent: String(target.useAgent) === 'true',
      passphrase: target.passphrase || undefined,
      gatewayName: String(target.name || 'LocalTunnel Gateway'),
      contactEmail: target.email || undefined,
      gatewayBundlePath: paths.gatewayBundle,
      installerScriptPath: paths.installerScript,
      serviceUnitPath: paths.serviceUnit,
    });

    const profile = store.addGateway({
      id: result.gatewayId,
      name: String(target.name || 'LocalTunnel Gateway'),
      host: result.publicIp,
      port: 443,
      provider: String(target.provider || 'generic'),
      region: target.region || null,
      fingerprint: result.fingerprint,
      adminToken: result.adminToken,
      sshUsername: String(target.username),
      sshPort: Number(target.port) || 22,
    });
    return { gateway: { id: profile.id, name: profile.name, host: profile.host } };
  });

  ipcMain.handle('gateway:installSteps', () => INSTALL_STEPS);

  /**
   * Best-effort removal of the gateway from the user's server. Requires SSH again:
   * the app never keeps the key after installing.
   */
  ipcMain.handle('gateway:uninstall', async (event, target: Record<string, string>) => {
    const result = await uninstallGateway(
      {
        host: String(target.host),
        port: Number(target.port) || 22,
        username: String(target.username),
        privateKeyPath: target.privateKeyPath ? String(target.privateKeyPath) : null,
        useAgent: String(target.useAgent) === 'true',
        passphrase: target.passphrase || undefined,
      },
      (line) => event.sender.send('gateway:uninstall-progress', { type: 'output', line }),
    );
    if (result.ok && target.gatewayId) store.removeGateway(String(target.gatewayId));
    return result;
  });

  /** SSH credentials the user already has, so they need not hunt for a key file. */
  ipcMain.handle('ssh:credentials', () => detectSshCredentials());

  /* ------------------------------------------------------------- machines */

  ipcMain.handle('machine:list', async (_e, gatewayId?: string) => {
    const connection = requireConnection(gatewayId);
    return (await gatewayApi.machines(connection)).machines;
  });

  ipcMain.handle('machine:revoke', (_e, id: string, gatewayId?: string) =>
    gatewayApi.revokeMachine(requireConnection(gatewayId), id),
  );

  ipcMain.handle('machine:remove', (_e, id: string, gatewayId?: string) =>
    gatewayApi.removeMachine(requireConnection(gatewayId), id),
  );

  ipcMain.handle('machine:rename', (_e, id: string, name: string, gatewayId?: string) =>
    gatewayApi.renameMachine(requireConnection(gatewayId), id, name),
  );

  /* ---------------------------------------------------------------- agent */

  ipcMain.handle('agent:status', () => supervisor.status());

  ipcMain.handle('agent:connect', async (_e, gatewayId?: string) => {
    const connection = requireConnection(gatewayId);
    await supervisor.ensureRunning();
    const { token } = await gatewayApi.enrollToken(connection);
    const result = await supervisor.connect({
      host: connection.host,
      port: connection.port,
      token,
      fingerprint: connection.fingerprint,
    });
    if (store.settings.agentAutostart) {
      await installAutostart({ execPath: process.execPath, scriptPath: resources().agentScript }).catch(
        () => undefined,
      );
    }
    return result;
  });

  ipcMain.handle('agent:start', async () => {
    await supervisor.ensureRunning();
    return supervisor.start();
  });
  ipcMain.handle('agent:stop', () => supervisor.stop());
  /**
   * Unlink this computer: stop serving, forget the credential, stop starting at
   * login, stop the process, and revoke the machine on the gateway so the
   * certificate cannot be used again. Anything less leaves the machine looking
   * connected and the user wondering whether the button did anything.
   */
  ipcMain.handle('agent:disconnect', async () => {
    // Read the machine id before the credential is cleared.
    const status = await supervisor.status();
    const machineId = status?.machineId ?? null;
    const steps: string[] = [];

    await removeAutostart()
      .then(() => steps.push('removed the login item'))
      .catch(() => undefined);

    try {
      await supervisor.disconnect();
      steps.push('stopped the tunnel and deleted this machine\'s credential');
    } catch {
      /* the agent may already be gone */
    }

    const connection = connectionFor();
    if (connection && machineId) {
      try {
        await gatewayApi.revokeMachine(connection, machineId);
        steps.push('revoked this machine on the gateway');
      } catch {
        steps.push('could not reach the gateway to revoke this machine');
      }
    }

    await supervisor.shutdown().catch(() => undefined);
    steps.push('stopped the background agent');

    return { ok: true, machineId, steps };
  });
  ipcMain.handle('agent:discover', () => supervisor.discover());

  /* ------------------------------------------------------------- services */

  ipcMain.handle('service:list', async (_e, gatewayId?: string) => {
    const connection = requireConnection(gatewayId);
    return (await gatewayApi.services(connection)).services;
  });

  ipcMain.handle('service:create', async (_e, service: Record<string, unknown>, gatewayId?: string) => {
    const connection = requireConnection(gatewayId);
    const created = await gatewayApi.createService(connection, service);
    return created.service;
  });

  ipcMain.handle('service:update', async (_e, id: string, patch: Record<string, unknown>, gatewayId?: string) => {
    const connection = requireConnection(gatewayId);
    return (await gatewayApi.updateService(connection, id, patch)).service;
  });

  ipcMain.handle('service:remove', (_e, id: string, gatewayId?: string) =>
    gatewayApi.removeService(requireConnection(gatewayId), id),
  );

  /* --------------------------------------------------------- certificates */

  ipcMain.handle('cert:list', async (_e, gatewayId?: string) => {
    const connection = requireConnection(gatewayId);
    return (await gatewayApi.certificates(connection)).certificates;
  });

  ipcMain.handle('cert:reissue', async (_e, hostname: string, gatewayId?: string) => {
    const connection = requireConnection(gatewayId);
    return (await gatewayApi.reissueCertificate(connection, hostname)).certificate;
  });

  /* ---------------------------------------------------------- diagnostics */

  ipcMain.handle('diagnostics:run', async (_e, serviceId?: string, gatewayId?: string) => {
    const connection = connectionFor(gatewayId);
    const agentStatus = await supervisor.status();
    let service = null;
    if (serviceId && connection) {
      const services = (await gatewayApi.services(connection)).services;
      service = services.find((s) => s.id === serviceId) ?? null;
    }
    return runDiagnostics({
      connection,
      agentStatus: agentStatus
        ? {
            state: agentStatus.state,
            latencyMs: agentStatus.latencyMs,
            lastError: agentStatus.lastError,
            probes: agentStatus.probes as Record<string, { reachable: boolean; error?: string }>,
          }
        : null,
      service,
    });
  });

  /* ------------------------------------------------------------------ dns */

  ipcMain.handle('dns:check', async (_e, hostname: string, expectedIp: string) => {
    const dns = await import('node:dns/promises');
    try {
      const addresses = await dns.resolve4(hostname);
      return { resolved: true, addresses, matches: addresses.includes(expectedIp) };
    } catch (err) {
      return { resolved: false, addresses: [], matches: false, error: (err as Error).message };
    }
  });

  /* ----------------------------------------------------------------- logs */

  ipcMain.handle('logs:gateway', async (_e, gatewayId?: string) => {
    // Reading the gateway's journal needs SSH, which the app only holds during
    // installation. Point the user at the command instead of pretending.
    const profile = gatewayId ? store.gateway(gatewayId) : store.activeGateway();
    return {
      hint: profile
        ? `ssh ${profile.host} 'sudo journalctl -u localtunnel-gateway -n 200 --no-pager'`
        : null,
    };
  });
}

app.whenReady().then(async () => {
  store = new AppStore();
  supervisor = new AgentSupervisor({
    execPath: process.execPath,
    scriptPath: resources().agentScript,
    socketPath: defaultSocketPath(agentDataDir()),
  });
  supervisor.on('status', (status) => window?.webContents.send('agent:status-changed', status));
  supervisor.on('log', (line: string) => window?.webContents.send('agent:log', line));

  nativeTheme.themeSource = store.settings.theme;
  registerIpc();
  createWindow();

  // If a gateway is already configured, get the tunnel up before the user asks.
  if (store.gateways.length > 0) {
    void supervisor.ensureRunning().catch(() => undefined);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // The agent keeps tunnelling; closing the window is not "stop serving my site".
  supervisor?.stopPolling();
  if (process.platform !== 'darwin') app.quit();
});
