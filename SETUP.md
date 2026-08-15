# LocalTunnel Setup

Getting from "a website on my laptop" to "a website on the internet", when your ISP
gives you a CGNAT address and you cannot forward ports.

You need three things: **a small VPS**, **a domain name**, and **LocalTunnel**.
The VPS is not optional — it is the public address your visitors connect to. Your home
connection never needs a public IP.

---

## Part 1 — Install the desktop app

| Platform | File |
| --- | --- |
| macOS | `LocalTunnel-1.0.0.dmg` (universal) |
| Windows | `LocalTunnel-Setup-1.0.0.exe` |
| Linux | `LocalTunnel-1.0.0.AppImage` or `.deb` |

Build from source instead:

```bash
npm install
npm run build
npm run build:desktop
```

Run it in development with `npm run desktop`.

---

## Part 2 — Create your gateway VPS

The app walks you through this; this is the same thing in text.

### Oracle Cloud (recommended — its "Always Free" tier fits a gateway)

1. **Create an account** at `https://signup.cloud.oracle.com`. A card is required for
   identity verification; Always Free resources are not charged.
2. **Sign in** to the console and note your **home region** — you cannot change it
   later, so pick one near your visitors.
3. **Compute → Instances → Create instance.**
4. **Image:** Canonical **Ubuntu 22.04** (or 24.04).
5. **Shape:** `VM.Standard.A1.Flex` with 1 OCPU / 6 GB is ideal and Always Free
   eligible. `VM.Standard.E2.1.Micro` also works.
6. **Networking:** leave "Assign a public IPv4 address" **enabled**. This is the one
   setting people miss.
7. **SSH keys:** choose "Generate a key pair for me" and download the **private** key,
   or paste a public key you already have. Keep the private key file safe —
   LocalTunnel needs to read it once to install the gateway.
8. **Create**, then wait for the instance state to become **Running**.
9. **Open the ports.** Oracle has its own firewall in front of the VM:
   Networking → Virtual Cloud Networks → your VCN → Security Lists → Default →
   **Add Ingress Rules**:

   | Source CIDR | Protocol | Destination port |
   | --- | --- | --- |
   | `0.0.0.0/0` | TCP | `443` |
   | `0.0.0.0/0` | TCP | `80` |

   That is all LocalTunnel needs. Raw TCP services (e.g. Minecraft on 25565) get their
   port added here later — the app tells you exactly which one, when it needs it.
10. **Copy the public IPv4 address** from the instance page.

### Any other provider

DigitalOcean, Vultr, Hetzner, Linode, AWS Lightsail/EC2, Google Cloud, Azure, or a
box you already own all work. You need: Ubuntu/Debian/Rocky/Alma, a public IPv4, SSH
access, and inbound TCP 80 and 443 allowed. Pick **"I already have a VPS"** in the app.

---

## Part 3 — Install the gateway

In the app: **Gateways → Install gateway**, then enter

```
Public IPv4:      129.x.x.x
SSH username:     ubuntu        (opc on Oracle Linux, root on most others)
SSH private key:  ~/.ssh/oracle_key
```

and press **Install LocalTunnel Gateway**. The app connects over SSH and runs, with
live output:

1. Verify OS and CPU architecture
2. Verify outbound internet from the VPS
3. Install dependencies (Node.js runtime, `ca-certificates`)
4. Download and verify the gateway release
5. Create the `localtunnel` system user
6. Write `/etc/localtunnel/gateway.json`
7. Generate the gateway identity certificate and internal CA
8. Install and enable the sandboxed systemd unit
9. Open TCP 80 and 443 in the host firewall (ufw/firewalld/nftables)
10. Start the gateway
11. Verify port 443 answers from the outside
12. Register the gateway in the app (admin token + certificate fingerprint)

Doing it by hand instead:

```bash
curl -fsSL https://raw.githubusercontent.com/localtunnel/localtunnel/main/installer/install.sh | sudo bash
```

The script prints the admin token and certificate fingerprint once — paste both into
**Gateways → Add existing gateway**.

> If step 11 fails, the Oracle ingress rules from Part 2 step 9 are almost always the
> reason. The app says so explicitly rather than just failing.

---

## Part 4 — Connect this computer

**Machines → Connect this computer.** The app mints an enrolment token, the agent
generates a keypair, gets a certificate, and opens its tunnel. You should see:

```
Connection   ● Connected
Latency      24 ms
Tunnel       Encrypted (TLS 1.3)
Reconnect    Automatic
```

The agent installs itself as a background service (launchd / Windows Service /
systemd user unit) and starts with the computer.

---

## Part 5 — Publish your website

1. Start your site locally, e.g. `npm run dev` on `http://localhost:3000`.
2. **+ Expose a Service → Website.**
3. Local address `http://localhost:3000`, public hostname `mysite.example.com`.
4. The app shows the DNS record to create:

   ```
   Type   A
   Name   mysite
   Value  129.x.x.x
   TTL    300
   ```

   Add it at your registrar — there are step-by-step guides in the app for Cloudflare,
   GoDaddy, Namecheap, Porkbun, Squarespace/Google Domains and Route 53.

   **Using Cloudflare?** Set the record to **DNS only** (grey cloud). Cloudflare is
   supported as a DNS provider; the tunnel itself must not be proxied by Cloudflare.
5. Press **Publish**. LocalTunnel waits for DNS to resolve to your VPS, requests a
   Let's Encrypt certificate, and turns the service on.

Visit `https://mysite.example.com`. Traffic goes visitor → your VPS → encrypted tunnel
→ your computer → `localhost:3000`.

### Just testing? Skip the domain

**Expose temporarily** gives you a hostname on the gateway's own domain immediately,
valid for 1 hour, 24 hours, 7 days, or until you turn it off. Useful for webhooks and
sharing a dev server.

---

## Part 6 — When something is wrong

Open **Diagnostics**. It checks internet, gateway reachability, tunnel health, the
local service, DNS, ports and TLS, and tells you which one failed and what to change:

```
✓ Local service is running
✓ Tunnel is connected
✓ VPS is reachable
✗ DNS record does not point to the VPS

   mysite.example.com  →  203.0.113.9
   your gateway        →  129.0.0.1

Fix: change the A record for mysite.example.com to 129.0.0.1
```

Common ones:

| Symptom | Cause |
| --- | --- |
| Public endpoint unreachable, gateway "online" locally | Oracle ingress rules missing for 80/443 |
| Certificate stuck at "pending" | DNS not propagated yet, or Cloudflare proxy is on (orange cloud) |
| 502 from your domain | Local service not running, or laptop asleep |
| Tunnel reconnecting in a loop | Machine was revoked, or the gateway was reinstalled — re-enrol the machine |

---

## Uninstall

Desktop: **Settings → Uninstall agent** removes the background service and credentials.
Gateway: `sudo /opt/localtunnel/uninstall.sh` removes the service, user, and state.
