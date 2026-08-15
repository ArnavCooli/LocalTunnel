import React from 'react';
import { PROVIDERS } from '../../providers/catalog.js';
import { Choice, ExternalLink } from '../components.js';

/**
 * First launch. The one thing this screen has to land is *why* a VPS is needed —
 * everything else in the product depends on the user accepting that.
 */
/**
 * The traffic path, drawn with real elements rather than box-drawing characters:
 * ASCII art depends on the font joining its corners, which no font reliably does.
 */
function Flow() {
  return (
    <div className="flow">
      <div className="flow-cap">Visitors</div>
      <FlowLink label="https://mysite.example.com" />
      <div className="flow-node">
        Your VPS
        <span className="flow-sub">public IP address</span>
      </div>
      <FlowLink label="encrypted tunnel, dialled outward" />
      <div className="flow-node">
        This computer
        <span className="flow-sub">behind CGNAT — no public IP needed</span>
      </div>
      <FlowLink />
      <div className="flow-cap mono">localhost:3000</div>
    </div>
  );
}

function FlowLink({ label }: { label?: string }) {
  return (
    <div className="flow-link">
      <span className="flow-line" />
      {label && <span className="flow-label">{label}</span>}
      <span className="flow-line" />
      <span className="flow-arrow" />
    </div>
  );
}

export function Welcome({
  onChoose,
}: {
  onChoose: (choice: 'oracle' | 'existing' | 'other') => void;
}) {
  return (
    <div className="welcome">
      <h1>Welcome to LocalTunnel</h1>
      <p>
        Put a website or service running on this computer onto the public internet — even if your
        internet provider uses CGNAT and you cannot forward ports.
      </p>

      <Flow />

      <p style={{ maxWidth: 520 }}>
        LocalTunnel needs one small public server — a VPS — to act as your front door. Your home
        connection never needs a public IP address, because this computer dials out to that server
        rather than waiting to be contacted.
      </p>

      <div style={{ width: 420, marginTop: 26, textAlign: 'left' }}>
        <div className="eyebrow">
          Recommended
        </div>
        <Choice
          icon="☁️"
          title="Set up Oracle Cloud"
          description="Free forever. A guided walkthrough of every screen, from sign-up to a live HTTPS site."
          onClick={() => onChoose('oracle')}
        />

        <div className="eyebrow">
          Already have a server?
        </div>
        <Choice
          icon="🖥"
          title="I already have a VPS"
          description="Enter its address and SSH key — LocalTunnel installs the gateway for you."
          onClick={() => onChoose('existing')}
        />
        <Choice
          icon="🔎"
          title="Choose another provider"
          description={`DigitalOcean, Vultr, Hetzner, AWS and ${PROVIDERS.length - 3} more.`}
          onClick={() => onChoose('other')}
        />
      </div>

      <p style={{ marginTop: 26, fontSize: 'var(--text-small)', color: 'var(--text-tertiary)' }}>
        No peer-to-peer, no mesh VPN, no Cloudflare Tunnel — your traffic goes through your own
        server and nowhere else.{' '}
        <ExternalLink href="https://github.com/localtunnel/localtunnel#readme">Learn more</ExternalLink>
      </p>
    </div>
  );
}
