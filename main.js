"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_path_1 = require("node:path");
const agent_1 = require("@localtunnel/agent");
const store_js_1 = require("../services/store.js");
const agent_supervisor_js_1 = require("../services/agent-supervisor.js");
const gateway_client_js_1 = require("../services/gateway-client.js");
const installer_js_1 = require("../setup/installer.js");
const ssh_keys_js_1 = require("../setup/ssh-keys.js");
const engine_js_1 = require("../diagnostics/engine.js");
let window = null;
let store;
let supervisor;
/**
 * Paths to things shipped with the app: the agent it supervises, and the gateway
 * payload it uploads to a VPS. Packaged builds put all three under `resources/`
 * (see `extraResources` in package.json); in development they sit in the repo.
 */
function resources() {
    const packagedBase = process.resourcesPath;
    const repoBase = (0, node_path_1.join)(__dirname, '..', '..', '..', '..');
    return electron_1.app.isPackaged
        ? {
            agentScript: (0, node_path_1.join)(packagedBase, 'agent', 'dist', 'main', 'index.js'),
            gatewayBundle: (0, node_path_1.join)(packagedBase, 'gateway', 'localtunnel-gateway.tar.gz'),
            installerScript: (0, node_path_1.join)(packagedBase, 'installer', 'install.sh'),
            adoptScript: (0, node_path_1.join)(packagedBase, 'installer', 'adopt.sh'),
            serviceUnit: (0, node_path_1.join)(packagedBase, 'installer', 'localtunnel-gateway.service'),
        }
        : {
            agentScript: (0, node_path_1.join)(repoBase, 'packages', 'agent', 'dist', 'main', 'index.js'),
            gatewayBundle: (0, node_path_1.join)(repoBase, 'build', 'localtunnel-gateway.tar.gz'),
            installerScript: (0, node_path_1.join)(repoBase, 'installer', 'install.sh'),
            adoptScript: (0, node_path_1.join)(repoBase, 'installer', 'adopt.sh'),
            serviceUnit: (0, node_path_1.join)(repoBase, 'installer', 'localtunnel-gateway.service'),
        };
}
function createWindow() {
    window = new electron_1.BrowserWindow({
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
            preload: (0, node_path_1.join)(__dirname, 'preload.js'),
            // The renderer gets no Node access at all; everything crosses the narrow
            // bridge in preload.ts.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    const devServer = process.env.VITE_DEV_SERVER_URL;
    if (devServer)
        void window.loadURL(devServer);
    else
        void window.loadFile((0, node_path_1.join)(__dirname, '..', 'renderer', 'index.html'));
    // Links to Oracle Cloud and so on belong in the user's real browser.
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url))
            void electron_1.shell.openExternal(url);
        return { action: 'deny' };
    });
    window.on('closed', () => {
        window = null;
    });
}
/** The connection details for a stored gateway, with its token decrypted. */
function connectionFor(gatewayId) {
    const profile = gatewayId ? store.gateway(gatewayId) : store.activeGateway();
    if (!profile)
        return null;
    const adminToken = store.adminToken(profile.id);
    if (!adminToken)
        return null;
    return {
        host: profile.host,
        port: profile.port,
        adminToken,
        fingerprint: profile.fingerprint,
    };
}
function requireConnection(gatewayId) {
    const connection = connectionFor(gatewayId);
    if (!connection)
        throw new Error('No gateway has been set up yet.');
    return connection;
}
function registerIpc() {
    /* ------------------------------------------------------------ app state */
    electron_1.ipcMain.handle('app:state', () => ({
        ...store.snapshot(),
        platform: process.platform,
        version: electron_1.app.getVersion(),
    }));
    electron_1.ipcMain.handle('app:setOnboarded', (_e, value) => {
        store.setOnboarded(value);
        return store.snapshot();
    });
    electron_1.ipcMain.handle('app:setWizardProgress', (_e, progress) => {
        store.setWizardProgress(progress);
        return store.snapshot();
    });
    electron_1.ipcMain.handle('app:updateSettings', async (_e, patch) => {
        const settings = store.updateSettings(patch);
        if ('agentAutostart' in patch) {
            if (settings.agentAutostart) {
                await (0, agent_1.installAutostart)({ execPath: process.execPath, scriptPath: resources().agentScript }).catch(() => undefined);
            }
            else {
                await (0, agent_1.removeAutostart)().catch(() => undefined);
            }
        }
        if ('launchAtLogin' in patch) {
            electron_1.app.setLoginItemSettings({ openAtLogin: Boolean(settings.launchAtLogin) });
        }
        if ('theme' in patch) {
            electron_1.nativeTheme.themeSource = settings.theme;
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
    electron_1.ipcMain.handle('app:reset', async () => {
        const status = await supervisor.status();
        const machineId = status?.machineId ?? null;
        const steps = [];
        const connection = connectionFor();
        if (connection && machineId) {
            try {
                await gateway_client_js_1.gatewayApi.revokeMachine(connection, machineId);
                steps.push('Revoked this computer on the gateway');
            }
            catch {
                steps.push('Could not reach the gateway to revoke this computer — revoke it there yourself');
            }
        }
        await (0, agent_1.removeAutostart)()
            .then(() => steps.push('Removed the login item'))
            .catch(() => undefined);
        try {
            await supervisor.reset();
            steps.push("Stopped the agent and deleted this computer's identity");
        }
        catch {
            steps.push('Could not stop the agent cleanly');
        }
        store.reset();
        electron_1.nativeTheme.themeSource = 'system';
        steps.push('Cleared saved gateways, admin tokens, settings and setup progress');
        return { ok: true, steps };
    });
    /*
     * Double-clicking a title bar zooms the window. macOS does that for a drag
     * region on its own; Windows does not, so the renderer asks for it explicitly.
     */
    electron_1.ipcMain.handle('app:toggleMaximize', () => {
        if (!window)
            return false;
        if (window.isMaximized())
            window.unmaximize();
        else
            window.maximize();
        return window.isMaximized();
    });
    electron_1.ipcMain.handle('app:openExternal', (_e, url) => {
        if (!/^https?:\/\//.test(url))
            throw new Error('refusing to open a non-http link');
        return electron_1.shell.openExternal(url);
    });
    electron_1.ipcMain.handle('app:pickPrivateKey', async () => {
        const result = await electron_1.dialog.showOpenDialog(window, {
            title: 'Choose your SSH private key',
            properties: ['openFile', 'showHiddenFiles'],
            message: 'Select the private key file your VPS provider gave you.',
        });
        if (result.canceled)
            return null;
        const path = result.filePaths[0];
        // A key downloaded from a provider arrives world-readable; ssh refuses those.
        (0, ssh_keys_js_1.secureKeyFile)(path);
        return path;
    });
    /* ------------------------------------------------------------ gateways */
    electron_1.ipcMain.handle('gateway:list', () => store.gateways.map((g) => ({
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
    })));
    /**
     * The gateway's own credentials, decrypted, for the user to read.
     *
     * Kept out of `gateway:list` on purpose: the admin token only crosses into the
     * window when someone asks for it on screen, rather than sitting in renderer
     * state for the life of the app. It is the same secret the installer printed
     * once — this is where you get it back, since the server keeps only a hash.
     */
    electron_1.ipcMain.handle('gateway:credentials', (_e, gatewayId) => {
        const profile = gatewayId ? store.gateway(gatewayId) : store.activeGateway();
        if (!profile)
            return null;
        const adminToken = store.adminToken(profile.id);
        return {
            name: profile.name,
            host: profile.host,
            port: profile.port,
            fingerprint: profile.fingerprint,
            adminToken,
            /** False when the OS keychain will not give the token back. */
            readable: adminToken !== null,
        };
    });
    electron_1.ipcMain.handle('gateway:status', async (_e, gatewayId) => {
        const connection = connectionFor(gatewayId);
        if (!connection)
            return null;
        try {
            return { ok: true, ...(await gateway_client_js_1.gatewayApi.status(connection)) };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    electron_1.ipcMain.handle('gateway:setActive', (_e, id) => {
        store.setActiveGateway(id);
        return store.snapshot();
    });
    electron_1.ipcMain.handle('gateway:rename', (_e, id, name) => {
        store.renameGateway(id, name);
        return store.snapshot();
    });
    electron_1.ipcMain.handle('gateway:remove', (_e, id) => {
        store.removeGateway(id);
        return store.snapshot();
    });
    electron_1.ipcMain.handle('gateway:addExisting', (_e, profile) => {
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
    });
    electron_1.ipcMain.handle('gateway:install', async (event, target) => {
        const paths = resources();
        const installer = new installer_js_1.GatewayInstaller();
        installer.on('event', (payload) => {
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
    electron_1.ipcMain.handle('gateway:installSteps', () => installer_js_1.INSTALL_STEPS);
    /** What is on that server already, so the app can offer the right next step. */
    electron_1.ipcMain.handle('gateway:probe', async (_e, target) => {
        const installer = new installer_js_1.GatewayInstaller();
        return installer.probe({
            host: String(target.host),
            port: Number(target.port) || 22,
            username: String(target.username),
            privateKeyPath: target.privateKeyPath ? String(target.privateKeyPath) : null,
            useAgent: String(target.useAgent) === 'true',
            passphrase: target.passphrase || undefined,
        });
    });
    /** Take over a gateway that is already installed, and store its new token. */
    electron_1.ipcMain.handle('gateway:adopt', async (event, target) => {
        const installer = new installer_js_1.GatewayInstaller();
        installer.on('event', (payload) => {
            event.sender.send('gateway:install-progress', payload);
        });
        const result = await installer.adopt({
            host: String(target.host),
            port: Number(target.port) || 22,
            username: String(target.username),
            privateKeyPath: target.privateKeyPath ? String(target.privateKeyPath) : null,
            useAgent: String(target.useAgent) === 'true',
            passphrase: target.passphrase || undefined,
            adoptScriptPath: resources().adoptScript,
        });
        const profile = store.addGateway({
            id: result.gatewayId,
            name: String(target.name || 'LocalTunnel Gateway'),
            host: result.publicIp || String(target.host),
            port: 443,
            provider: String(target.provider || 'generic'),
            region: null,
            fingerprint: result.fingerprint,
            adminToken: result.adminToken,
            sshUsername: String(target.username),
            sshPort: Number(target.port) || 22,
        });
        return { gateway: { id: profile.id, name: profile.name, host: profile.host } };
    });
    /**
     * Best-effort removal of the gateway from the user's server. Requires SSH again:
     * the app never keeps the key after installing.
     */
    electron_1.ipcMain.handle('gateway:uninstall', async (event, target) => {
        const result = await (0, installer_js_1.uninstallGateway)({
            host: String(target.host),
            port: Number(target.port) || 22,
            username: String(target.username),
            privateKeyPath: target.privateKeyPath ? String(target.privateKeyPath) : null,
            useAgent: String(target.useAgent) === 'true',
            passphrase: target.passphrase || undefined,
        }, (line) => event.sender.send('gateway:uninstall-progress', { type: 'output', line }));
        if (result.ok && target.gatewayId)
            store.removeGateway(String(target.gatewayId));
        return result;
    });
    /** SSH credentials the user already has, so they need not hunt for a key file. */
    electron_1.ipcMain.handle('ssh:credentials', () => (0, ssh_keys_js_1.detectSshCredentials)());
    /* ------------------------------------------------------------- machines */
    electron_1.ipcMain.handle('machine:list', async (_e, gatewayId) => {
        const connection = requireConnection(gatewayId);
        return (await gateway_client_js_1.gatewayApi.machines(connection)).machines;
    });
    electron_1.ipcMain.handle('machine:revoke', (_e, id, gatewayId) => gateway_client_js_1.gatewayApi.revokeMachine(requireConnection(gatewayId), id));
    electron_1.ipcMain.handle('machine:remove', (_e, id, gatewayId) => gateway_client_js_1.gatewayApi.removeMachine(requireConnection(gatewayId), id));
    electron_1.ipcMain.handle('machine:rename', (_e, id, name, gatewayId) => gateway_client_js_1.gatewayApi.renameMachine(requireConnection(gatewayId), id, name));
    /* ---------------------------------------------------------------- agent */
    electron_1.ipcMain.handle('agent:status', () => supervisor.status());
    electron_1.ipcMain.handle('agent:connect', async (_e, gatewayId) => {
        const connection = requireConnection(gatewayId);
        await supervisor.ensureRunning();
        const { token } = await gateway_client_js_1.gatewayApi.enrollToken(connection);
        const result = await supervisor.connect({
            host: connection.host,
            port: connection.port,
            token,
            fingerprint: connection.fingerprint,
        });
        if (store.settings.agentAutostart) {
            await (0, agent_1.installAutostart)({ execPath: process.execPath, scriptPath: resources().agentScript }).catch(() => undefined);
        }
        return result;
    });
    electron_1.ipcMain.handle('agent:start', async () => {
        await supervisor.ensureRunning();
        return supervisor.start();
    });
    electron_1.ipcMain.handle('agent:stop', () => supervisor.stop());
    /**
     * Unlink this computer: stop serving, forget the credential, stop starting at
     * login, stop the process, and revoke the machine on the gateway so the
     * certificate cannot be used again. Anything less leaves the machine looking
     * connected and the user wondering whether the button did anything.
     */
    electron_1.ipcMain.handle('agent:disconnect', async () => {
        // Read the machine id before the credential is cleared.
        const status = await supervisor.status();
        const machineId = status?.machineId ?? null;
        const steps = [];
        await (0, agent_1.removeAutostart)()
            .then(() => steps.push('removed the login item'))
            .catch(() => undefined);
        try {
            await supervisor.disconnect();
            steps.push('stopped the tunnel and deleted this machine\'s credential');
        }
        catch {
            /* the agent may already be gone */
        }
        const connection = connectionFor();
        if (connection && machineId) {
            try {
                await gateway_client_js_1.gatewayApi.revokeMachine(connection, machineId);
                steps.push('revoked this machine on the gateway');
            }
            catch {
                steps.push('could not reach the gateway to revoke this machine');
            }
        }
        await supervisor.shutdown().catch(() => undefined);
        steps.push('stopped the background agent');
        return { ok: true, machineId, steps };
    });
    electron_1.ipcMain.handle('agent:discover', () => supervisor.discover());
    /* ------------------------------------------------------------- services */
    electron_1.ipcMain.handle('service:list', async (_e, gatewayId) => {
        const connection = requireConnection(gatewayId);
        return (await gateway_client_js_1.gatewayApi.services(connection)).services;
    });
    electron_1.ipcMain.handle('service:create', async (_e, service, gatewayId) => {
        const connection = requireConnection(gatewayId);
        const created = await gateway_client_js_1.gatewayApi.createService(connection, service);
        return created.service;
    });
    electron_1.ipcMain.handle('service:update', async (_e, id, patch, gatewayId) => {
        const connection = requireConnection(gatewayId);
        return (await gateway_client_js_1.gatewayApi.updateService(connection, id, patch)).service;
    });
    electron_1.ipcMain.handle('service:remove', (_e, id, gatewayId) => gateway_client_js_1.gatewayApi.removeService(requireConnection(gatewayId), id));
    /* --------------------------------------------------------- certificates */
    electron_1.ipcMain.handle('cert:list', async (_e, gatewayId) => {
        const connection = requireConnection(gatewayId);
        return (await gateway_client_js_1.gatewayApi.certificates(connection)).certificates;
    });
    electron_1.ipcMain.handle('cert:reissue', async (_e, hostname, gatewayId) => {
        const connection = requireConnection(gatewayId);
        return (await gateway_client_js_1.gatewayApi.reissueCertificate(connection, hostname)).certificate;
    });
    /* ---------------------------------------------------------- diagnostics */
    electron_1.ipcMain.handle('diagnostics:run', async (_e, serviceId, gatewayId) => {
        const connection = connectionFor(gatewayId);
        const agentStatus = await supervisor.status();
        let service = null;
        if (serviceId && connection) {
            const services = (await gateway_client_js_1.gatewayApi.services(connection)).services;
            service = services.find((s) => s.id === serviceId) ?? null;
        }
        return (0, engine_js_1.runDiagnostics)({
            connection,
            agentStatus: agentStatus
                ? {
                    state: agentStatus.state,
                    latencyMs: agentStatus.latencyMs,
                    lastError: agentStatus.lastError,
                    probes: agentStatus.probes,
                }
                : null,
            service,
        });
    });
    /* ------------------------------------------------------------------ dns */
    electron_1.ipcMain.handle('dns:check', async (_e, hostname, expectedIp) => {
        const dns = await Promise.resolve().then(() => __importStar(require('node:dns/promises')));
        try {
            const addresses = await dns.resolve4(hostname);
            return { resolved: true, addresses, matches: addresses.includes(expectedIp) };
        }
        catch (err) {
            return { resolved: false, addresses: [], matches: false, error: err.message };
        }
    });
    /* ----------------------------------------------------------------- logs */
    electron_1.ipcMain.handle('logs:gateway', async (_e, gatewayId) => {
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
electron_1.app.whenReady().then(async () => {
    store = new store_js_1.AppStore();
    supervisor = new agent_supervisor_js_1.AgentSupervisor({
        execPath: process.execPath,
        scriptPath: resources().agentScript,
        socketPath: (0, agent_supervisor_js_1.defaultSocketPath)((0, agent_1.agentDataDir)()),
    });
    supervisor.on('status', (status) => window?.webContents.send('agent:status-changed', status));
    supervisor.on('log', (line) => window?.webContents.send('agent:log', line));
    electron_1.nativeTheme.themeSource = store.settings.theme;
    registerIpc();
    createWindow();
    // If a gateway is already configured, get the tunnel up before the user asks.
    if (store.gateways.length > 0) {
        void supervisor.ensureRunning().catch(() => undefined);
    }
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
electron_1.app.on('window-all-closed', () => {
    // The agent keeps tunnelling; closing the window is not "stop serving my site".
    supervisor?.stopPolling();
    if (process.platform !== 'darwin')
        electron_1.app.quit();
});
//# sourceMappingURL=main.js.map