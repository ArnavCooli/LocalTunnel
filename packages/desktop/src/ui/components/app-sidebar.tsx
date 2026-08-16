import React from 'react';
import { Analytics, Chip, CloudServices, Dashboard, Earth, Wikis } from '@carbon/icons-react';

import { IconRail, type NavItemT } from '@/components/ui/sidebar-component';
import { LocalTunnelMark } from '@/components/logo';

/**
 * LocalTunnel's navigation: the icon rail from the sidebar component, without its
 * second-level pane. The screens themselves already list services, machines and
 * certificates, so a detail column only repeated them — the rail alone keeps the
 * chrome to one narrow strip and gives the content the rest of the window.
 */

export type Tab =
  | 'home'
  | 'services'
  | 'machines'
  | 'gateways'
  | 'domains'
  | 'diagnostics'
  | 'settings';

const NAV_ITEMS: NavItemT[] = [
  { id: 'home', icon: <Dashboard size={16} />, label: 'Overview' },
  { id: 'services', icon: <CloudServices size={16} />, label: 'Services' },
  { id: 'machines', icon: <Chip size={16} />, label: 'Machines' },
  { id: 'gateways', icon: <Earth size={16} />, label: 'Gateways' },
  { id: 'domains', icon: <Wikis size={16} />, label: 'Domains' },
  { id: 'diagnostics', icon: <Analytics size={16} />, label: 'Diagnostics' },
];

export interface AppSidebarProps {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  /** Full sentence — it is the rail's tooltip, since the dot alone cannot say it. */
  healthLabel: string;
  healthTone: 'green' | 'amber' | 'red';
}

export function AppSidebar({ tab, onTabChange, healthLabel, healthTone }: AppSidebarProps) {
  const fill =
    healthTone === 'green'
      ? 'bg-emerald-400'
      : healthTone === 'amber'
        ? 'bg-amber-400'
        : 'bg-red-400';

  return (
    <IconRail
      activeSection={tab}
      onSectionChange={(section) => onTabChange(section as Tab)}
      navItems={NAV_ITEMS}
      className="app-rail border-r border-neutral-800"
      logo={<LocalTunnelMark size={26} />}
      footer={
        <div className="size-8 flex items-center justify-center" title={healthLabel}>
          <span className={`inline-block size-2 rounded-full ${fill}`} />
          <span className="sr-only">{healthLabel}</span>
        </div>
      }
    />
  );
}
