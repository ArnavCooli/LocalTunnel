#!/usr/bin/env bash
#
# LocalTunnel Gateway installer.
#
# Normally run for you by the LocalTunnel desktop app over SSH — you should not
# need to read this. It is kept legible on purpose: it runs on your server.
#
#   sudo ./install.sh --bundle /tmp/localtunnel-gateway.tar.gz --public-ip 129.0.0.1
#
# On success it prints a JSON line containing the admin token and the gateway's
# certificate fingerprint. Those two values are what the desktop app needs; the
# token is shown exactly once.

set -euo pipefail

# Paths are overridable so the installer can be exercised by the test harness in a
# sandbox. Defaults are what a real server gets; nothing here changes in production.
PREFIX="${LT_PREFIX:-/opt/localtunnel}"
CONFIG_DIR="${LT_CONFIG_DIR:-/etc/localtunnel}"
STATE_DIR="${LT_STATE_DIR:-/var/lib/localtunnel}"
LOG_DIR="${LT_LOG_DIR:-/var/log/localtunnel}"
SYSTEMD_DIR="${LT_SYSTEMD_DIR:-/etc/systemd/system}"
SERVICE_USER="${LT_SERVICE_USER:-localtunnel}"
NODE_MAJOR=20

BUNDLE=""
PUBLIC_IP=""
GATEWAY_NAME="LocalTunnel Gateway"
CONTACT_EMAIL=""
TLS_MODE="acme"
ACME_DIRECTORY="https://acme-v02.api.letsencrypt.org/directory"

log()  { printf '==> %s\n' "$*" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --bundle)      BUNDLE="$2"; shift 2 ;;
    --public-ip)   PUBLIC_IP="$2"; shift 2 ;;
    --name)        GATEWAY_NAME="$2"; shift 2 ;;
    --email)       CONTACT_EMAIL="$2"; shift 2 ;;
    --tls-mode)    TLS_MODE="$2"; shift 2 ;;
    --acme-directory) ACME_DIRECTORY="$2"; shift 2 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || [ -n "${LT_TEST_MODE:-}" ] || fail "run this with sudo"

# --------------------------------------------------------------- 1. verify OS
log "Step 1/13: checking the operating system"
[ -r /etc/os-release ] || fail "cannot identify this operating system"
. /etc/os-release
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) PKG=apt ;;
  *rhel*|*fedora*|*centos*) PKG=dnf ;;
  *) fail "unsupported distribution: ${PRETTY_NAME:-unknown}. Ubuntu, Debian, Rocky, Alma and Fedora are supported." ;;
esac
log "    ${PRETTY_NAME:-$ID} detected (package manager: $PKG)"

# ------------------------------------------------------- 2. verify architecture
log "Step 2/13: checking the CPU architecture"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|aarch64|arm64) log "    $ARCH is supported" ;;
  *) fail "unsupported architecture: $ARCH" ;;
esac

# --------------------------------------------------- 3. verify internet access
log "Step 3/13: checking that this server can reach the internet"
if command -v curl >/dev/null 2>&1; then
  curl -fsS --max-time 15 -o /dev/null https://deb.nodesource.com/ 2>/dev/null \
    || curl -fsS --max-time 15 -o /dev/null https://www.google.com/ \
    || fail "this server cannot reach the internet"
fi
log "    outbound connectivity is working"

# ------------------------------------------------------ 4. install dependencies
log "Step 4/13: installing dependencies"
if ! command -v node >/dev/null 2>&1 || \
   [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt "$NODE_MAJOR" ]; then
  log "    installing Node.js ${NODE_MAJOR}"
  if [ "$PKG" = apt ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg tar >/dev/null
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  else
    dnf install -y -q ca-certificates curl tar >/dev/null
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    dnf install -y -q nodejs >/dev/null
  fi
else
  log "    Node.js $(node -v) is already installed"
fi
command -v node >/dev/null 2>&1 || fail "Node.js installation failed"

# --------------------------------------------------------- 5. unpack the gateway
log "Step 5/13: installing the LocalTunnel Gateway"
[ -n "$BUNDLE" ] || fail "--bundle is required (the desktop app uploads it for you)"
[ -f "$BUNDLE" ] || fail "bundle not found: $BUNDLE"
systemctl stop localtunnel-gateway 2>/dev/null || true
rm -rf "$PREFIX/gateway"
mkdir -p "$PREFIX/gateway"
tar -xzf "$BUNDLE" -C "$PREFIX/gateway"
[ -f "$PREFIX/gateway/dist/main/index.js" ] || fail "the bundle does not look like a LocalTunnel gateway"
# The gateway runs as an unprivileged user, so it must be able to traverse and read
# its own program directory regardless of the modes recorded in the archive.
chmod 755 "$PREFIX" "$PREFIX/gateway"
chmod -R a+rX "$PREFIX/gateway"

# ------------------------------------------------------ 6. create a system user
log "Step 6/13: creating the localtunnel system user"
# The unit specifies Group=, so the group must exist even where useradd would not
# have created one — otherwise systemd fails the service with 216/GROUP.
getent group "$SERVICE_USER" >/dev/null 2>&1 || groupadd --system "$SERVICE_USER" 2>/dev/null || true
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_USER" --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd --system --gid "$SERVICE_USER" --home-dir "$STATE_DIR" --shell /sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd --system --home-dir "$STATE_DIR" "$SERVICE_USER"
fi
mkdir -p "$STATE_DIR" "$LOG_DIR" "$CONFIG_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR" "$LOG_DIR"
chmod 700 "$STATE_DIR"
chmod 750 "$LOG_DIR"

# --------------------------------------------------------- 7. write the config
log "Step 7/13: writing the configuration"
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || echo '')"
  [ -n "$PUBLIC_IP" ] || fail "could not determine the public IP; pass --public-ip"
fi

ADMIN_TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')"
ADMIN_HASH="$(printf '%s' "$ADMIN_TOKEN" | node -e '
  const chunks=[];process.stdin.on("data",c=>chunks.push(c)).on("end",()=>{
    process.stdout.write(require("crypto").createHash("sha256").update(Buffer.concat(chunks)).digest("hex"));
  });')"
GATEWAY_ID="gw_$(node -e 'process.stdout.write(require("crypto").randomBytes(8).toString("hex"))')"

cat > "$CONFIG_DIR/gateway.json" <<JSON
{
  "gatewayId": "$GATEWAY_ID",
  "name": "$GATEWAY_NAME",
  "publicIp": "$PUBLIC_IP",
  "httpsPort": 443,
  "httpPort": 80,
  "dataDir": "$STATE_DIR",
  "logFile": "$LOG_DIR/gateway.log",
  "logLevel": "info",
  "adminTokenHash": "$ADMIN_HASH",
  "tls": {
    "mode": "$TLS_MODE",
    "acmeDirectoryUrl": "$ACME_DIRECTORY",
    "contactEmail": $([ -n "$CONTACT_EMAIL" ] && printf '"%s"' "$CONTACT_EMAIL" || printf 'null'),
    "renewBeforeDays": 30
  },
  "firewall": { "manage": true },
  "limits": {
    "connectionsPerIpPerMinute": 60,
    "concurrentPerIp": 128,
    "concurrentTotal": 8192,
    "streamsPerMachine": 512,
    "enrollFailuresPerIp": 5,
    "adminFailuresPerIp": 5,
    "tlsHandshakeTimeoutMs": 10000,
    "idleConnectionTimeoutMs": 120000
  }
}
JSON
chmod 640 "$CONFIG_DIR/gateway.json"
chown root:"$SERVICE_USER" "$CONFIG_DIR/gateway.json"

# ------------------------------------------------- 8. generate server identity
log "Step 8/13: generating the gateway's identity"
# Fail with an explanation rather than a Node stack trace if the service user
# cannot read the program directory.
sudo -u "$SERVICE_USER" test -r "$PREFIX/gateway/dist/auth/ca.js" \
  || fail "the $SERVICE_USER user cannot read $PREFIX/gateway — check the permissions on $PREFIX"
# The gateway creates its CA and identity certificate on first start; run it once
# briefly so the fingerprint is available to print at the end of this script.
sudo -u "$SERVICE_USER" node -e '
  const { ensureCa, ensureIdentityCertificate } = require(process.argv[1] + "/dist/auth/ca.js");
  const { join } = require("path");
  const dir = join(process.argv[2], "ca");
  const ca = ensureCa(dir);
  ensureIdentityCertificate(dir, ca, process.argv[3]);
' "$PREFIX/gateway" "$STATE_DIR" "$PUBLIC_IP"

FINGERPRINT="$(node -e '
  const { certificateFingerprint } = require(process.argv[1] + "/dist/auth/ca.js");
  const fs = require("fs");
  process.stdout.write(certificateFingerprint(fs.readFileSync(process.argv[2], "utf8")));
' "$PREFIX/gateway" "$STATE_DIR/ca/identity.crt")"

# ------------------------------------------------------------ 9. install systemd
log "Step 9/13: installing the system service"
mkdir -p "$SYSTEMD_DIR"
install -m 644 "$(dirname "$0")/localtunnel-gateway.service" "$SYSTEMD_DIR"/localtunnel-gateway.service \
  2>/dev/null || cp "$PREFIX/gateway/installer/localtunnel-gateway.service" "$SYSTEMD_DIR"/localtunnel-gateway.service

# Point the unit at the node binary this machine actually has, and at the install
# paths in use. NodeSource puts node in /usr/bin, but a pre-existing install may
# be anywhere on PATH, and a wrong ExecStart fails with a bare 203/EXEC.
NODE_BIN="$(command -v node)"
[ -x "$NODE_BIN" ] || fail "could not locate the node binary after installing it"
sed -i.bak \
  -e "s|^ExecStart=.*|ExecStart=$NODE_BIN $PREFIX/gateway/dist/main/index.js $CONFIG_DIR/gateway.json|" \
  -e "s|^User=.*|User=$SERVICE_USER|" \
  -e "s|^Group=.*|Group=$SERVICE_USER|" \
  -e "s|^ReadWritePaths=.*|ReadWritePaths=$STATE_DIR $LOG_DIR|" \
  "$SYSTEMD_DIR"/localtunnel-gateway.service
rm -f "$SYSTEMD_DIR"/localtunnel-gateway.service.bak
log "    ExecStart=$NODE_BIN"

systemctl daemon-reload
systemctl enable localtunnel-gateway >/dev/null 2>&1

# --------------------------------------------------------- 10. open the firewall
log "Step 10/13: opening TCP 80 and 443 in the host firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=443/tcp >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-port=80/tcp  >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi
# Oracle Cloud images ship with iptables rules that reject everything but SSH.
if command -v iptables >/dev/null 2>&1 && iptables -C INPUT -j REJECT --reject-with icmp-host-prohibited >/dev/null 2>&1; then
  iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT || true
  iptables -I INPUT 6 -p tcp --dport 80  -j ACCEPT || true
  command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1 || true
fi

# --------------------------------------------- 11. automatic security updates
log "Step 11/13: enabling automatic security updates"
if [ "$PKG" = apt ]; then
  apt-get install -y -qq unattended-upgrades >/dev/null 2>&1 || true
  dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
else
  dnf install -y -q dnf-automatic >/dev/null 2>&1 || true
  systemctl enable --now dnf-automatic.timer >/dev/null 2>&1 || true
fi

# ------------------------------------------------------------ 12. start it up
log "Step 12/13: starting the gateway"
# Catch a bad config, missing module or permission problem before systemd hides it
# behind a generic unit failure. Run as the service user on unprivileged ports:
# binding 443 needs the capability that only the systemd unit grants, so testing
# the real ports here would fail for a reason that says nothing about the install.
SMOKE_LOG=/tmp/lt-smoke.log
SMOKE_CONF=/tmp/lt-smoke-gateway.json
node -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  c.httpsPort = 18443; c.httpPort = 18080;
  c.firewall = { manage: false };
  c.logFile = null;
  fs.writeFileSync(process.argv[2], JSON.stringify(c, null, 2));
' "$CONFIG_DIR/gateway.json" "$SMOKE_CONF"
chmod 644 "$SMOKE_CONF"

: > "$SMOKE_LOG"
chmod 666 "$SMOKE_LOG"
sudo -u "$SERVICE_USER" node "$PREFIX/gateway/dist/main/index.js" "$SMOKE_CONF" >> "$SMOKE_LOG" 2>&1 &
SMOKE_PID=$!
for _ in $(seq 1 30); do
  grep -q "gateway ready" "$SMOKE_LOG" 2>/dev/null && break
  kill -0 "$SMOKE_PID" 2>/dev/null || break
  sleep 0.5
done
kill "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" 2>/dev/null || true
rm -f "$SMOKE_CONF"

if ! grep -q "gateway ready" "$SMOKE_LOG"; then
  printf 'ERROR: the gateway could not start. It said:\n' >&2
  tail -20 "$SMOKE_LOG" | sed 's/^/    /' >&2
  exit 1
fi
log "    the gateway runs correctly as $SERVICE_USER"

systemctl restart localtunnel-gateway
sleep 2
if ! systemctl is-active --quiet localtunnel-gateway; then
  # Report what systemd and the journal actually say, rather than asking the user
  # to go and look for it themselves.
  printf 'ERROR: the gateway service failed to start. systemd reports:\n' >&2
  systemctl status localtunnel-gateway --no-pager -l 2>&1 | sed 's/^/    /' >&2 || true
  printf '  --- last 40 journal lines ---\n' >&2
  journalctl -u localtunnel-gateway -n 40 --no-pager 2>&1 | sed 's/^/    /' >&2 || true
  exit 1
fi

# --------------------------------------------------------- 13. verify the port
log "Step 13/13: verifying that port 443 is answering"
if command -v ss >/dev/null 2>&1; then
  ss -ltn | grep -q ':443 ' || fail "nothing is listening on port 443"
fi
log "    the gateway is listening"

cat > "$PREFIX/uninstall.sh" <<'UNINSTALL'
#!/usr/bin/env bash
set -euo pipefail
systemctl disable --now localtunnel-gateway 2>/dev/null || true
rm -f "$SYSTEMD_DIR"/localtunnel-gateway.service
systemctl daemon-reload
rm -rf /opt/localtunnel /etc/localtunnel /var/lib/localtunnel /var/log/localtunnel
userdel localtunnel 2>/dev/null || true
echo "LocalTunnel Gateway removed."
UNINSTALL
chmod 755 "$PREFIX/uninstall.sh"

log "Done."
log ""
log "Keep the admin token safe — it is shown only once."
printf 'LOCALTUNNEL_RESULT %s\n' \
  "$(node -e '
    process.stdout.write(JSON.stringify({
      ok: true,
      gatewayId: process.argv[1],
      publicIp: process.argv[2],
      adminToken: process.argv[3],
      fingerprint: process.argv[4],
      version: "1.0.0"
    }));
  ' "$GATEWAY_ID" "$PUBLIC_IP" "$ADMIN_TOKEN" "$FINGERPRINT")"
