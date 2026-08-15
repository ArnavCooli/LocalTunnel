# LocalTunnel Tunnel Protocol v1

The tunnel protocol carries many independent byte streams over a single long-lived
connection between an agent (home computer) and a gateway (VPS).

**No cryptography is invented here.** Confidentiality, integrity and peer
authentication are entirely TLS 1.3's job. This document describes only what is sent
*inside* an already-authenticated TLS connection.

## 1. Transport

- TCP to the gateway's public IP, port **443**.
- TLS 1.3, minimum version enforced on both sides.
- ALPN selects the sub-protocol: `lt-enroll/1`, `lt-tunnel/1`, or `lt-admin/1`.
- `lt-tunnel/1` requires **mutual TLS**: the agent presents a client certificate
  issued by the gateway's internal CA at enrolment.
- Always dialled by the agent. The gateway never connects to the home machine.

## 2. Framing

Every frame:

```
 0        1                    5                    9
 +--------+--------------------+--------------------+-----------------+
 |  type  |     stream id      |    payload length  |     payload     |
 | 1 byte |  4 bytes, big-end  |  4 bytes, big-end  |   0..1 MiB      |
 +--------+--------------------+--------------------+-----------------+
```

`stream id` is `0` for connection-level control frames. A payload longer than
`MAX_FRAME_PAYLOAD` (1 MiB) is a protocol violation and closes the connection.

Frame types:

| Value | Name | Direction | Payload |
| --- | --- | --- | --- |
| `0x01` | `CONTROL` | both | UTF-8 JSON control message (see §4) |
| `0x02` | `OPEN` | gateway → agent | UTF-8 JSON `{ "serviceId", "remoteAddr", "proto" }` |
| `0x03` | `OPEN_OK` | agent → gateway | empty |
| `0x04` | `DATA` | both | opaque bytes |
| `0x05` | `WINDOW` | both | 4 bytes big-endian: additional credits |
| `0x06` | `CLOSE` | both | UTF-8 JSON `{ "reason"? }`, or empty for a clean EOF |

### Stream ids

Streams are opened by the gateway only (the gateway is where public connections
arrive). Ids start at 1 and increase monotonically per connection; they are never
reused. A reconnect starts a fresh id space.

### Flow control

Each stream starts with a **256 KiB** receive window in each direction. A sender
decrements its remaining window by the size of every `DATA` payload and must stop when
it reaches zero. A receiver sends a `WINDOW` frame granting more credit once it has
drained at least half a window. This keeps one slow visitor from stalling every other
stream on the connection, and bounds gateway memory per stream.

## 3. Lifecycle

```
agent                                              gateway
  │  TLS handshake, ALPN lt-tunnel/1, client cert     │
  │ ────────────────────────────────────────────────► │
  │  CONTROL hello                                    │
  │ ────────────────────────────────────────────────► │
  │                       CONTROL hello.ok            │
  │ ◄──────────────────────────────────────────────── │
  │                       CONTROL services.sync       │
  │ ◄──────────────────────────────────────────────── │
  │  CONTROL services.ack                             │
  │ ────────────────────────────────────────────────► │
  │                                                   │
  │                       OPEN   #1 (serviceId=web)   │   ← a visitor arrived
  │ ◄──────────────────────────────────────────────── │
  │  OPEN_OK #1                                       │   ← local dial succeeded
  │ ────────────────────────────────────────────────► │
  │  DATA / WINDOW #1  ◄────────────────────────────► │
  │  CLOSE #1                                         │
  │ ────────────────────────────────────────────────► │
  │                                                   │
  │  CONTROL ping / pong every 15 s                   │
```

If the local dial fails, the agent replies `CLOSE` with a reason instead of `OPEN_OK`,
and the gateway turns that into a 502 page (HTTP) or an immediate socket close (TCP).

## 4. Control messages

All control messages are JSON objects with a `t` discriminator, sent on stream 0.

### `hello` (agent → gateway)
```json
{ "t": "hello", "protocol": 1, "agentVersion": "1.0.0",
  "machineId": "m_7f3a…", "hostname": "macbook", "os": "darwin", "arch": "arm64" }
```
The `machineId` is advisory only — the authoritative identity is the CN of the client
certificate. A mismatch closes the connection.

### `hello.ok` (gateway → agent)
```json
{ "t": "hello.ok", "gatewayVersion": "1.0.0", "gatewayId": "gw_…",
  "publicIp": "129.0.0.1", "heartbeatMs": 15000 }
```

### `services.sync` (gateway → agent)
The authoritative list of services this machine must be prepared to serve. Sent after
`hello.ok` and again whenever the set changes.
```json
{ "t": "services.sync", "services": [
  { "id": "svc_1", "name": "My Website", "type": "http",
    "localHost": "127.0.0.1", "localPort": 3000,
    "hostname": "mysite.example.com", "publicPort": null }
] }
```
The agent refuses `OPEN` frames for service ids that are not in the current list.

### `services.ack` (agent → gateway)
```json
{ "t": "services.ack", "accepted": ["svc_1"], "probe": { "svc_1": { "reachable": true, "latencyMs": 1 } } }
```
The agent probes each local address and reports whether it is actually listening, so
the gateway (and therefore diagnostics) knows about a dead local service *before* a
visitor does.

### `ping` / `pong` (both)
```json
{ "t": "ping", "ts": 1723651200000 }
{ "t": "pong", "ts": 1723651200000 }
```
Sent every 15 s. Three missed pings (45 s) closes the connection. Round-trip time is
reported as tunnel latency in the UI.

### `metrics` (agent → gateway)
```json
{ "t": "metrics", "ts": 1723651200000, "streams": 4,
  "bytesIn": 91234, "bytesOut": 448210, "opens": 118, "openFailures": 2 }
```

### `revoked` (gateway → agent)
```json
{ "t": "revoked", "reason": "Machine revoked by administrator" }
```
The agent stops, deletes its credential, and does **not** retry.

## 5. Enrolment sub-protocol (`lt-enroll/1`)

A brand-new machine has no client certificate, so it cannot use `lt-tunnel/1`. It
connects with ALPN `lt-enroll/1` over ordinary (server-authenticated) TLS, pinning the
gateway's identity certificate fingerprint that the desktop app obtained over SSH
during install.

One request frame, one response frame, then the connection closes:

```json
→ { "t": "enroll", "token": "ent_…", "csrPem": "-----BEGIN CERTIFICATE REQUEST-----…",
    "hostname": "macbook", "os": "darwin", "arch": "arm64" }

← { "t": "enroll.ok", "machineId": "m_…", "certPem": "…", "caPem": "…",
    "gatewayId": "gw_…", "expiresAt": "2027-08-14T00:00:00.000Z" }
```
or
```json
← { "t": "enroll.err", "error": "token_expired" }
```

Enrolment tokens are single-use, expire in 15 minutes, and are minted only through the
admin API. The gateway never issues a certificate without one.

## 6. Admin sub-protocol (`lt-admin/1`)

Ordinary HTTP/1.1 spoken inside a TLS connection whose ALPN is `lt-admin/1`, so it can
share port 443 without ever being reachable by a browser that stumbles onto the IP.
Every request carries `Authorization: Bearer <admin token>`; the token is generated
during installation and shown once. Endpoints are documented in
`packages/gateway/src/admin/README.md`.

## 7. Versioning

`hello.protocol` is an integer. A gateway that receives an unknown version replies
with `hello.err` naming the versions it supports, and the desktop app turns that into
"Your gateway is out of date — update it from the Gateways tab." Frame *types* are
only ever added, never renumbered.
