import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only route between the UI and the system.
 *
 * Every method here is an explicit, named operation. The renderer has no Node
 * access, cannot construct arbitrary IPC channels, and cannot reach the filesystem
 * or network except through these calls.
 */
const api = {
  app: {
    state: () => ipcRenderer.invoke('app:state'),
    setOnboarded: (value: boolean) => ipcRenderer.invoke('app:setOnboarded', value),
    setWizardProgress: (progress: { provider: string | null; stepIndex: number } | null) =>
      ipcRenderer.invoke('app:setWizardProgress', progress),
    updateSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('app:updateSettings', patch),
    reset: () => ipcRenderer.invoke('app:reset'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    pickPrivateKey: () => ipcRenderer.invoke('app:pickPrivateKey'),
    toggleMaximize: () => ipcRenderer.invoke('app:toggleMaximize'),
    platform: process.platform,
  },
  gateway: {
    list: () => ipcRenderer.invoke('gateway:list'),
    status: (gatewayId?: string) => ipcRenderer.invoke('gateway:status', gatewayId),
    credentials: (gatewayId?: string) => ipcRenderer.invoke('gateway:credentials', gatewayId),
    setActive: (id: string) => ipcRenderer.invoke('gateway:setActive', id),
    rename: (id: string, name: string) => ipcRenderer.invoke('gateway:rename', id, name),
    remove: (id: string) => ipcRenderer.invoke('gateway:remove', id),
    addExisting: (profile: Record<string, unknown>) => ipcRenderer.invoke('gateway:addExisting', profile),
    install: (target: Record<string, string>) => ipcRenderer.invoke('gateway:install', target),
    installSteps: () => ipcRenderer.invoke('gateway:installSteps'),
    sshCredentials: () => ipcRenderer.invoke('ssh:credentials'),
    uninstall: (target: Record<string, string>) => ipcRenderer.invoke('gateway:uninstall', target),
    onUninstallProgress: (handler: (event: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown) => handler(payload);
      ipcRenderer.on('gateway:uninstall-progress', listener);
      return () => {
        ipcRenderer.removeListener('gateway:uninstall-progress', listener);
      };
    },
    onInstallProgress: (handler: (event: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown) => handler(payload);
      ipcRenderer.on('gateway:install-progress', listener);
      return () => {
        ipcRenderer.removeListener('gateway:install-progress', listener);
      };
    },
  },
  machine: {
    list: (gatewayId?: string) => ipcRenderer.invoke('machine:list', gatewayId),
    revoke: (id: string, gatewayId?: string) => ipcRenderer.invoke('machine:revoke', id, gatewayId),
    remove: (id: string, gatewayId?: string) => ipcRenderer.invoke('machine:remove', id, gatewayId),
    rename: (id: string, name: string, gatewayId?: string) =>
      ipcRenderer.invoke('machine:rename', id, name, gatewayId),
  },
  agent: {
    status: () => ipcRenderer.invoke('agent:status'),
    connect: (gatewayId?: string) => ipcRenderer.invoke('agent:connect', gatewayId),
    start: () => ipcRenderer.invoke('agent:start'),
    stop: () => ipcRenderer.invoke('agent:stop'),
    disconnect: () => ipcRenderer.invoke('agent:disconnect'),
    discover: () => ipcRenderer.invoke('agent:discover'),
    onStatus: (handler: (status: unknown) => void) => {
      const listener = (_e: unknown, status: unknown) => handler(status);
      ipcRenderer.on('agent:status-changed', listener);
      return () => {
        ipcRenderer.removeListener('agent:status-changed', listener);
      };
    },
    onLog: (handler: (line: string) => void) => {
      const listener = (_e: unknown, line: string) => handler(line);
      ipcRenderer.on('agent:log', listener);
      return () => {
        ipcRenderer.removeListener('agent:log', listener);
      };
    },
  },
  service: {
    list: (gatewayId?: string) => ipcRenderer.invoke('service:list', gatewayId),
    create: (service: Record<string, unknown>, gatewayId?: string) =>
      ipcRenderer.invoke('service:create', service, gatewayId),
    update: (id: string, patch: Record<string, unknown>, gatewayId?: string) =>
      ipcRenderer.invoke('service:update', id, patch, gatewayId),
    remove: (id: string, gatewayId?: string) => ipcRenderer.invoke('service:remove', id, gatewayId),
  },
  cert: {
    list: (gatewayId?: string) => ipcRenderer.invoke('cert:list', gatewayId),
    reissue: (hostname: string, gatewayId?: string) => ipcRenderer.invoke('cert:reissue', hostname, gatewayId),
  },
  diagnostics: {
    run: (serviceId?: string, gatewayId?: string) => ipcRenderer.invoke('diagnostics:run', serviceId, gatewayId),
  },
  dns: {
    check: (hostname: string, expectedIp: string) => ipcRenderer.invoke('dns:check', hostname, expectedIp),
  },
  logs: {
    gateway: (gatewayId?: string) => ipcRenderer.invoke('logs:gateway', gatewayId),
  },
};

contextBridge.exposeInMainWorld('localtunnel', api);

/*
 * The stylesheet needs the platform before React mounts: the drag strip has to
 * clear macOS's traffic lights but sit under Windows' controls overlay, and
 * those are different insets. An attribute on <html> keeps that decision in CSS
 * rather than threading it through the component tree.
 */
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.platform = process.platform;
});

export type LocalTunnelApi = typeof api;
