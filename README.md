# LocalTunnel

Put a website running on your home computer onto the public internet — even when your
ISP uses CGNAT and you cannot forward ports.

```
Visitor  ──https──▶  Your VPS  ──encrypted tunnel──▶  Your computer  ──▶  localhost:3000
                     (public IP)      dialled outward       (behind CGNAT)
```

You rent one small VPS. LocalTunnel installs a gateway on it over SSH, your computer
dials out to that gateway and keeps the connection open, and your domain points at the
VPS. No port forwarding, no reverse proxy to configure, no certificates to manage.

**Not used anywhere in this project:** P2P, hole punching, mesh VPN, WireGuard mesh,
Tailscale, Headscale, or Cloudflare Tunnel. Public traffic goes through a server you
own and nowhere else. Cloudflare is supported as an optional *DNS* provider only.

## What works today

- **Guided Oracle Cloud setup** — twelve steps, each with instructions, "why do I need
  this?", "what should I see?" and troubleshooting.
- **Any other VPS** — DigitalOcean, Vultr, Hetzner, Linode, AWS, GCP, Azure, or a box
  you already own.
- **One-click gateway install over SSH** — fourteen verified steps, live output, no
  terminal.
- **Automatic HTTPS** via Let's Encrypt, renewed automatically.
- **HTTP reverse proxy** with WebSocket support, and **raw TCP/UDP forwarding** for
  things like Minecraft or SSH.
- **Multiple machines and multiple gateways**, each machine with its own revocable
  certificate.
- **Temporary public links** for dev servers and webhooks.
- **A diagnostics engine** that names the broken link and the fix, rather than saying
  "something went wrong".

## Repository layout

```
packages/protocol/   wire format + stream multiplexer (shared)
packages/gateway/    runs on the VPS — ingress, tunnels, routing, TLS, auth, admin API
packages/agent/      runs on your computer — outbound tunnel, local service proxy
packages/desktop/    Electron + React app for macOS, Windows and Linux
installer/           install.sh + a sandboxed systemd unit
scripts/             build tooling
```

## Build and run from source

```bash
npm install
npm run build          # protocol, gateway, agent
npm run desktop        # build and launch the desktop app
```

Package the gateway payload the desktop app uploads to a VPS:

```bash
./scripts/bundle-gateway.sh
```

Build installers:

```bash
npm run dist:mac -w @localtunnel/desktop
npm run dist:win -w @localtunnel/desktop
npm run dist:linux -w @localtunnel/desktop
```

## Tests

```bash
npm test
```

This runs the protocol unit tests and the integration suite. The integration tests
start a **real gateway and a real agent** over real TLS, enrol the agent with a real
certificate, publish a local web server, and fetch it back over public HTTPS — plus
reconnection, revocation, TCP forwarding, oversized payloads, and the failure cases
(local service down, wrong hostname, spent enrolment token, wrong fingerprint).

## Documentation

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the pieces fit together and why the VPS is mandatory. |
| [PROTOCOL.md](PROTOCOL.md) | The wire format, control messages and enrolment exchange. |
| [SECURITY.md](SECURITY.md) | Identity, trust boundaries, hardening, limits. |
| [SETUP.md](SETUP.md) | The user-facing walkthrough, from zero to a public HTTPS site. |
| [packages/gateway/src/admin/README.md](packages/gateway/src/admin/README.md) | The gateway's management API. |

## Requirements

- **Desktop:** macOS 11+, Windows 10+, or a Linux desktop. Node 20+ to build.
- **VPS:** Ubuntu, Debian, Rocky, Alma or Fedora, a public IPv4, SSH access, and
  inbound TCP 443 and 80 allowed by your provider's firewall.
- **A domain name** if you want a permanent custom address. Temporary links do not
  need one.

## Licence

MIT.
