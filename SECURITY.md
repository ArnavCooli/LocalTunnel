# LocalTunnel Security Model

The gateway is public-facing infrastructure on a machine the user owns. This document
states what LocalTunnel protects, how, and what it explicitly does not protect.

## 1. Trust boundaries

```
   untrusted                 semi-trusted              trusted
┌──────────────┐   TLS   ┌──────────────────┐  mTLS  ┌────────────────┐
│   internet   │ ──────► │  gateway (VPS)   │ ◄───── │  agent (home)  │
│   visitors   │         │  attacker-facing │        │  user's box    │
└──────────────┘         └──────────────────┘        └────────────────┘
```

The gateway is assumed to be *attackable*. A compromised gateway can read plaintext
for the services published through it — that is inherent to terminating TLS there, and
it is the user's own server. A compromised gateway still cannot reach anything on the
home network other than the exact `host:port` values the user configured as services.

## 2. Machine identity

Static shared secrets embedded in agents are not used anywhere.

- On first run the agent generates an **RSA-2048 keypair in memory** and writes the
  private key to its own config directory with mode `0600`. The private key never
  leaves the machine and is never sent to the gateway.
- The gateway runs a small **internal CA**, created at install time
  (`/var/lib/localtunnel/ca/`, mode `0600`, owned by the `localtunnel` system user).
- Enrolment: the desktop app mints a **single-use token** (32 bytes of
  `crypto.randomBytes`, base64url, 15-minute expiry) through the admin API. The agent
  sends a CSR plus the token; the gateway issues a client certificate with the machine
  id as its CN, valid two years.
- Every tunnel connection is **mutual TLS**. The gateway verifies the client chain
  against its own CA, then additionally checks that the certificate's CN maps to a
  known, non-revoked machine. `requestCert` alone is not treated as sufficient — the
  authorisation check is explicit and separate from the chain check.
- The agent verifies the gateway by **certificate fingerprint pinning**. The
  fingerprint is captured over the SSH session that installed the gateway, so trust is
  rooted in the user's existing SSH access to their own VPS rather than in a public CA.

### Revocation
Revoking a machine in the UI adds its certificate serial to a revocation list, closes
any live tunnel for that machine immediately with a `revoked` control frame, and
rejects future handshakes. It takes effect in under a second — there is no CRL
distribution delay because the enforcement point and the issuer are the same process.

## 3. What the agent will and will not connect to

The agent only ever dials `host:port` pairs present in the current `services.sync`
list, which comes from the gateway's authenticated admin API. An `OPEN` frame naming
an unknown service id is refused and logged.

Because a malicious gateway could in principle push a service pointing at, say,
`192.168.1.1:80`, the agent enforces a local policy:

- `localhost`/`127.0.0.1` is always allowed.
- Private LAN addresses are allowed **only** if the user ticked "allow LAN targets"
  for that service in the desktop app, which shows an explicit warning that the device
  belongs to someone else on their network.
- Link-local (`169.254.0.0/16`), multicast, and cloud metadata (`169.254.169.254`) are
  refused unconditionally.

## 4. Gateway hardening

- **Runs as a dedicated unprivileged user** `localtunnel`, never root. Binding 80/443
  is granted with `AmbientCapabilities=CAP_NET_BIND_SERVICE`, not by running as root.
- **systemd sandboxing** (see `installer/localtunnel-gateway.service`):
  `NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, `ProtectSystem=strict`,
  `ProtectHome`, `ProtectKernelTunables`, `ProtectKernelModules`,
  `ProtectControlGroups`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`,
  `RestrictNamespaces`, `LockPersonality`, `MemoryDenyWriteExecute`,
  `SystemCallFilter=@system-service`, and a single writable path
  (`StateDirectory=localtunnel`).
- **No shell access, ever.** The admin API has no command execution endpoint, no file
  read/write endpoint, and no template that interpolates user input into a shell.
  Firewall changes are made by `execFile` with an argument array — never a shell string
  — against a strict allowlist of port numbers and protocols.
- **Automatic security updates** are enabled by the installer via `unattended-upgrades`
  restricted to the security pocket.
- **Rate limiting and connection limits**, all configurable in
  `/etc/localtunnel/gateway.json`:

  | Limit | Default |
  | --- | --- |
  | New TLS connections per source IP | 60 / minute (burst 30) |
  | Concurrent public connections per source IP | 128 |
  | Concurrent public connections total | 8192 |
  | Concurrent tunnel streams per machine | 512 |
  | Failed enrolment attempts per IP | 5 / 15 min, then blocked for an hour |
  | Failed admin auth per IP | 5 / 15 min |
  | TLS handshake timeout | 10 s |
  | Idle public connection timeout | 120 s |

  Requests over the limit get `429` (HTTP) or an immediate close (TCP), and the event
  is logged with the source IP.
- **Admin token** is 32 random bytes, compared with `crypto.timingSafeEqual`, stored
  hashed (SHA-256) on the gateway so a stolen state file does not yield a usable token.
- **ACME account keys and certificates** live under `/var/lib/localtunnel/acme/`, mode
  `0600`. Renewal runs at 30 days remaining.
- **Requests for unknown hostnames** are answered with a static 404 that does not
  disclose which hostnames exist, and unknown-SNI handshakes are failed rather than
  served a default certificate that would leak a customer domain.

## 5. Transport security

- TLS 1.3 minimum on both the public listener and the tunnel.
- The tunnel is not "encrypted with our own scheme"; it is a TLS 1.3 socket carrying
  framed streams. There is no custom KDF, cipher, MAC, or handshake anywhere in this
  codebase.
- HTTP services are served to visitors over HTTPS with HSTS
  (`max-age=31536000`) once a certificate is valid. Port 80 serves only the ACME
  challenge and a 301.

## 6. Desktop application

- SSH private keys chosen in the installer are read for the duration of the install
  and never copied into LocalTunnel's own storage.
- The gateway admin token and certificate fingerprint are stored in the OS keychain
  where available (`safeStorage`), falling back to a `0600` file.
- The renderer runs with `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, and a narrow preload bridge. External links open in the system
  browser, never in an app window.
- The renderer's CSP forbids remote script; the wizard's Oracle Cloud illustrations are
  bundled locally rather than hotlinked.

## 7. Logging

Logged: connection open/close with source IP, machine id, service id, byte counts,
auth failures, enrolment attempts, certificate issuance and renewal, firewall changes,
admin API calls.

Never logged: private keys, the admin token, enrolment tokens (only a prefix), request
bodies, or visitor request paths beyond the first 256 characters. Logs rotate at 50 MB
with 5 files kept.

## 8. Non-goals

- LocalTunnel is not a WAF. IP allowlists and access authentication are on the roadmap
  and are not present in the MVP.
- LocalTunnel does not protect a service that is itself insecure. Publishing a
  database admin panel to the internet is still a bad idea; the app warns but obeys.
- LocalTunnel does not hide the visitor's traffic from the VPS provider.

## 9. Reporting

Security issues: open a private advisory rather than a public issue.
