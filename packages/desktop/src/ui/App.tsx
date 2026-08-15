import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type AppState,
  type CertificateView,
  type GatewayStatusResult,
  type GatewaySummary,
  type MachineView,
  type ServiceView,
  type TunnelStatus,
} from './api.js';
import { Toast } from './components.js';
import { AppSidebar, type Tab } from './components/app-sidebar.js';
import { Welcome } from './screens/Welcome.js';
import { OracleWizard, ProviderPicker, ProviderSetup } from './screens/OracleWizard.js';
import { Home } from './screens/Home.js';
import { Services } from './screens/Services.js';
import { Machines } from './screens/Machines.js';
import { Gateways } from './screens/Gateways.js';
import { Domains } from './screens/Domains.js';
import { Diagnostics } from './screens/Diagnostics.js';
import { Settings } from './screens/Settings.js';
import { UninstallGateway } from './screens/UninstallGateway.js';

type SetupRoute =
  | { kind: 'none' }
  | { kind: 'welcome' }
  | { kind: 'oracle' }
  | { kind: 'picker' }
  /** `from` is where Back should return to — the screen the user actually came from. */
  | { kind: 'provider'; providerId: string; from: 'welcome' | 'picker' };

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [setup, setSetup] = useState<SetupRoute>({ kind: 'none' });
  const [tab, setTab] = useState<Tab>('home');
  const [gateways, setGateways] = useState<GatewaySummary[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatusResult>(null);
  const [services, setServices] = useState<ServiceView[]>([]);
  const [machines, setMachines] = useState<MachineView[]>([]);
  const [certificates, setCertificates] = useState<CertificateView[]>([]);
  const [agentStatus, setAgentStatus] = useState<TunnelStatus | null>(null);
  const [diagnoseServiceId, setDiagnoseServiceId] = useState<string | null>(null);
  const [openServiceId, setOpenServiceId] = useState<string | null>(null);
  const [cleanupTarget, setCleanupTarget] = useState<{
    id: string;
    name: string;
    host: string;
    sshUsername?: string | null;
    sshPort?: number;
  } | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: 'info' | 'error' } | null>(null);
  /** True until the first load decides which screen to show, to avoid a flash of Home. */
  const [initializing, setInitializing] = useState(true);
  const routed = useRef(false);

  const notify = useCallback((message: string, tone: 'info' | 'error' = 'info') => {
    setToast({ message, tone });
  }, []);

  /** Put the app back to first launch after a reset. */
  const resetToWelcome = useCallback(() => {
    routed.current = false;
    setGateways([]);
    setServices([]);
    setMachines([]);
    setCertificates([]);
    setGatewayStatus(null);
    setAgentStatus(null);
    setTab('home');
    setSetup({ kind: 'welcome' });
  }, []);

  /** One refresh path for everything that comes from the gateway. */
  const refresh = useCallback(async () => {
    const appState = (await api.app.state()) as AppState;
    setState(appState);
    const list = (await api.gateway.list()) as GatewaySummary[];
    setGateways(list);

    if (list.length === 0) {
      setGatewayStatus(null);
      setServices([]);
      setMachines([]);
      setCertificates([]);
      // Only *route* on the first load. This runs on a timer, so deciding the
      // screen here again would throw the user back to Welcome every few seconds
      // — including in the middle of the wizard or the SSH form.
      if (!routed.current) {
        routed.current = true;
        if (!appState.onboarded) setSetup({ kind: 'welcome' });
      }
      setInitializing(false);
      return;
    }
    routed.current = true;
    setInitializing(false);

    const status = (await api.gateway.status()) as GatewayStatusResult;
    setGatewayStatus(status);
    if (status?.ok) {
      setServices(status.services);
      setMachines(status.machines);
      setCertificates(status.certificates);
    }
  }, []);

  useEffect(() => {
    // A failure here must never leave the window stuck on the loading spinner.
    const tick = () => void refresh().catch(() => setInitializing(false));
    tick();
    const timer = setInterval(tick, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    void api.agent.status().then((status) => setAgentStatus(status as TunnelStatus | null));
    return api.agent.onStatus((status) => setAgentStatus(status as TunnelStatus));
  }, []);

  const finishSetup = async (gateway: { id: string; name: string; host: string }) => {
    await api.app.setOnboarded(true);
    await api.app.setWizardProgress(null);
    setSetup({ kind: 'none' });
    setTab('machines');
    notify(`${gateway.name} is online at ${gateway.host}. Connect this computer next.`);
    await refresh();
  };

  if (initializing) {
    return (
      <div className="welcome">
        <span className="spinner" />
      </div>
    );
  }

  if (setup.kind === 'welcome') {
    return (
      <Welcome
        onChoose={(choice) => {
          if (choice === 'oracle') setSetup({ kind: 'oracle' });
          else if (choice === 'existing')
            setSetup({ kind: 'provider', providerId: 'generic', from: 'welcome' });
          else setSetup({ kind: 'picker' });
        }}
      />
    );
  }

  if (setup.kind === 'oracle') {
    return (
      <div className="shell">
        <div className="main">
          <OracleWizard
            startIndex={state?.wizard?.provider === 'oracle' ? (state.wizard.stepIndex ?? 0) : 0}
            onStepChange={(index) => void api.app.setWizardProgress({ provider: 'oracle', stepIndex: index })}
            onInstalled={(gateway) => void finishSetup(gateway)}
            onExit={() => setSetup(state?.onboarded ? { kind: 'none' } : { kind: 'welcome' })}
          />
        </div>
      </div>
    );
  }

  if (setup.kind === 'picker') {
    return (
      <div className="shell">
        <div className="main">
          <ProviderPicker
            onPick={(providerId) =>
              setSetup(
                providerId === 'oracle'
                  ? { kind: 'oracle' }
                  : { kind: 'provider', providerId, from: 'picker' },
              )
            }
            onExit={() => setSetup(state?.onboarded ? { kind: 'none' } : { kind: 'welcome' })}
          />
        </div>
      </div>
    );
  }

  if (setup.kind === 'provider') {
    return (
      <div className="shell">
        <div className="main">
          <ProviderSetup
            providerId={setup.providerId}
            onInstalled={(gateway) => void finishSetup(gateway)}
            onExit={() =>
              setSetup(state?.onboarded ? { kind: 'none' } : { kind: setup.from })
            }
          />
        </div>
      </div>
    );
  }

  // A service that is published but not actually serving is not "all systems online".
  const degraded = services.filter((s) => s.enabled && s.status !== 'online');
  const online = gatewayStatus?.ok === true && agentStatus?.state === 'connected' && degraded.length === 0;
  const healthLabel =
    gatewayStatus?.ok !== true
      ? 'Gateway unreachable'
      : agentStatus?.state !== 'connected'
        ? 'Tunnel down'
        : degraded.length === 1
          ? '1 service needs attention'
          : degraded.length > 1
            ? `${degraded.length} services need attention`
            : 'All systems online';

  const healthTone = online ? 'green' : gatewayStatus?.ok ? 'amber' : 'red';

  return (
    <div className="shell with-rail">
      <AppSidebar
        tab={tab}
        onTabChange={setTab}
        healthLabel={healthLabel}
        healthTone={healthTone}
      />

      <main className="main">
        {tab === 'home' && (
          <Home
            gatewayStatus={gatewayStatus}
            agentStatus={agentStatus}
            services={services}
            onExpose={() => setTab('services')}
            onOpenService={(id) => {
              setOpenServiceId(id);
              setTab('services');
            }}
            onDiagnose={() => setTab('diagnostics')}
            onConnect={() => setTab('machines')}
          />
        )}
        {tab === 'services' && (
          <Services
            services={services}
            machines={machines}
            gatewayStatus={gatewayStatus}
            agentStatus={agentStatus}
            onChanged={() => void refresh()}
            onDiagnose={(serviceId) => {
              setDiagnoseServiceId(serviceId);
              setTab('diagnostics');
            }}
            notify={notify}
            initialServiceId={openServiceId}
            onConsumedInitial={() => setOpenServiceId(null)}
          />
        )}
        {tab === 'machines' && (
          <Machines
            machines={machines}
            agentStatus={agentStatus}
            hasGateway={gateways.length > 0}
            onChanged={() => void refresh()}
            notify={notify}
          />
        )}
        {tab === 'gateways' && (
          <Gateways
            gateways={gateways}
            status={gatewayStatus}
            onChanged={() => void refresh()}
            onAddGateway={() => setSetup({ kind: 'picker' })}
            notify={notify}
          />
        )}
        {tab === 'domains' && (
          <Domains
            services={services}
            certificates={certificates}
            gatewayIp={gatewayStatus?.ok ? gatewayStatus.gateway.publicIp : null}
            notify={notify}
          />
        )}
        {tab === 'diagnostics' && <Diagnostics services={services} initialServiceId={diagnoseServiceId} />}
        {tab === 'settings' && (
          <Settings
            state={state}
            onChanged={() => void refresh()}
            notify={notify}
            gatewayForCleanup={
              gateways[0]
                ? {
                    id: gateways[0].id,
                    name: gateways[0].name,
                    host: gateways[0].host,
                    sshUsername: gateways[0].sshUsername,
                    sshPort: gateways[0].sshPort,
                  }
                : null
            }
            onRequestServerCleanup={(gateway) => setCleanupTarget(gateway)}
            onReset={() => {
              resetToWelcome();
              void refresh();
            }}
          />
        )}
      </main>

      {cleanupTarget && (
        <UninstallGateway
          gateway={cleanupTarget}
          onClose={() => {
            setCleanupTarget(null);
            resetToWelcome();
          }}
          onDone={() => {
            setCleanupTarget(null);
            resetToWelcome();
          }}
        />
      )}

      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
