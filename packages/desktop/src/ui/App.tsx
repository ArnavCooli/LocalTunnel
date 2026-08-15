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
import { Dot, Toast } from './components.js';
import { Welcome } from './screens/Welcome.js';
import { OracleWizard, ProviderPicker, ProviderSetup } from './screens/OracleWizard.js';
import { Home } from './screens/Home.js';
import { Services } from './screens/Services.js';
import { Machines } from './screens/Machines.js';
import { Gateways } from './screens/Gateways.js';
import { Domains } from './screens/Domains.js';
import { Diagnostics } from './screens/Diagnostics.js';
import { Settings } from './screens/Settings.js';

type Tab = 'home' | 'services' | 'machines' | 'gateways' | 'domains' | 'diagnostics' | 'settings';
type SetupRoute =
  | { kind: 'none' }
  | { kind: 'welcome' }
  | { kind: 'oracle' }
  | { kind: 'picker' }
  /** `from` is where Back should return to — the screen the user actually came from. */
  | { kind: 'provider'; providerId: string; from: 'welcome' | 'picker' };

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: '◉' },
  { id: 'services', label: 'Services', icon: '⬡' },
  { id: 'machines', label: 'Machines', icon: '▣' },
  { id: 'gateways', label: 'Gateways', icon: '☁' },
  { id: 'domains', label: 'Domains', icon: '⌂' },
  { id: 'diagnostics', label: 'Diagnostics', icon: '✓' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

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
  const [toast, setToast] = useState<{ message: string; tone: 'info' | 'error' } | null>(null);
  /** True until the first load decides which screen to show, to avoid a flash of Home. */
  const [initializing, setInitializing] = useState(true);
  const routed = useRef(false);

  const notify = useCallback((message: string, tone: 'info' | 'error' = 'info') => {
    setToast({ message, tone });
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

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark" />
          LocalTunnel
        </div>
        <div className="nav">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={`nav-item${tab === item.id ? ' active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              <span style={{ width: 15, textAlign: 'center', opacity: 0.75 }}>{item.icon}</span>
              {item.label}
              {item.id === 'services' && services.length > 0 && <span className="badge">{services.length}</span>}
              {item.id === 'machines' && machines.length > 0 && <span className="badge">{machines.length}</span>}
            </button>
          ))}
        </div>
        <div className="sidebar-foot">
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Dot tone={online ? 'green' : gatewayStatus?.ok ? 'amber' : 'red'} />
            {healthLabel}
          </div>
        </div>
      </nav>

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
            onReset={() => {
              // Let the next refresh route to Welcome again, as on a fresh install.
              routed.current = false;
              setGateways([]);
              setServices([]);
              setMachines([]);
              setCertificates([]);
              setGatewayStatus(null);
              setAgentStatus(null);
              setTab('home');
              setSetup({ kind: 'welcome' });
              void refresh();
            }}
          />
        )}
      </main>

      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
