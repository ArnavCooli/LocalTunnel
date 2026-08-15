#!/usr/bin/env bash
#
# Runs the real install.sh in a sandbox.
#
# The installer is the part of LocalTunnel that touches a machine we do not
# control, and the part that is hardest to test — so instead of mocking it, this
# runs the actual script against the actual bundle, with the system-changing
# commands (apt, useradd, systemctl, firewalls) replaced by stubs that record what
# was asked of them. Everything else — argument parsing, tar extraction,
# permissions, the Node steps that generate the CA, the config file, the result
# line — runs for real.
#
#   ./installer/test/run-installer.sh [path-to-bundle]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUNDLE="${1:-$ROOT/build/localtunnel-gateway.tar.gz}"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

pass() { printf '  ok   %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
FAILURES=0

[ -f "$BUNDLE" ] || { echo "bundle not found: $BUNDLE — run ./scripts/bundle-gateway.sh" >&2; exit 1; }

# --------------------------------------------------------------- fake system

BIN="$SANDBOX/bin"
mkdir -p "$BIN" "$SANDBOX/root"
CALLS="$SANDBOX/calls.log"
: > "$CALLS"

stub() {
  local name="$1"; shift
  cat > "$BIN/$name" <<EOF
#!/usr/bin/env bash
echo "$name \$*" >> "$CALLS"
$*
EOF
  chmod +x "$BIN/$name"
}

stub apt-get   'exit 0'
stub dnf       'exit 0'
stub useradd   'exit 0'
stub systemctl 'exit 0'
stub ufw       'exit 0'
stub firewall-cmd 'exit 0'
stub iptables  'exit 1'   # pretend the Oracle reject rule is absent
stub netfilter-persistent 'exit 0'
stub dpkg-reconfigure 'exit 0'
stub curl      'exit 0'
stub ss        'echo "LISTEN 0 4096 *:443 *:*"'

# `id -u` must still report a real uid for the root check, but report success for
# the service user so useradd is not required to have really created one.
cat > "$BIN/id" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-u" ] && [ -n "${2:-}" ]; then echo 999; exit 0; fi
exec /usr/bin/id "$@"
EOF
chmod +x "$BIN/id"

# There is no service user in the sandbox, so `sudo -u X cmd` just runs cmd.
cat > "$BIN/sudo" <<'EOF'
#!/usr/bin/env bash
echo "sudo $*" >> "$CALLS_LOG"
while [ $# -gt 0 ]; do
  case "$1" in
    -u) shift 2 ;;
    -n) shift ;;
    *)  break ;;
  esac
done
exec "$@"
EOF
chmod +x "$BIN/sudo"

# chown would need a real user and real privileges; record and succeed.
stub chown 'exit 0'

# The script sources /etc/os-release; give it an Ubuntu one.
mkdir -p "$SANDBOX/etc"
cat > "$SANDBOX/etc/os-release" <<'EOF'
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 22.04.4 LTS (sandbox)"
EOF

# install.sh reads /etc/os-release by absolute path, so run it through a wrapper
# that redirects just that read.
SCRIPT="$SANDBOX/install.sh"
sed 's|/etc/os-release|'"$SANDBOX"'/etc/os-release|g' "$ROOT/installer/install.sh" > "$SCRIPT"
cp "$ROOT/installer/localtunnel-gateway.service" "$SANDBOX/localtunnel-gateway.service"
chmod +x "$SCRIPT"

# ------------------------------------------------------------------ run it

echo "==> running the real installer in a sandbox"
OUTPUT="$SANDBOX/output.txt"
set +e
CALLS_LOG="$CALLS" \
LT_TEST_MODE=1 \
LT_PREFIX="$SANDBOX/opt/localtunnel" \
LT_CONFIG_DIR="$SANDBOX/etc/localtunnel" \
LT_STATE_DIR="$SANDBOX/var/lib/localtunnel" \
LT_LOG_DIR="$SANDBOX/var/log/localtunnel" \
LT_SYSTEMD_DIR="$SANDBOX/etc/systemd/system" \
LT_SERVICE_USER="$(/usr/bin/id -un)" \
PATH="$BIN:$PATH" \
  bash "$SCRIPT" --bundle "$BUNDLE" --public-ip 203.0.113.10 --name "Test Gateway" \
    --tls-mode selfsigned > "$OUTPUT" 2>&1
EXIT_CODE=$?
set -e

mkdir -p "$SANDBOX/etc/systemd/system" 2>/dev/null || true

echo
echo "==> assertions"

[ $EXIT_CODE -eq 0 ] && pass "installer exited 0" || fail "installer exited $EXIT_CODE"

RESULT_LINE="$(grep -o 'LOCALTUNNEL_RESULT .*' "$OUTPUT" || true)"
if [ -n "$RESULT_LINE" ]; then
  pass "printed the LOCALTUNNEL_RESULT line the desktop app parses"
  JSON="${RESULT_LINE#LOCALTUNNEL_RESULT }"
  for field in ok gatewayId publicIp adminToken fingerprint version; do
    if node -e "const r=JSON.parse(process.argv[1]); process.exit(r['$field']===undefined?1:0)" "$JSON"; then
      pass "result contains $field"
    else
      fail "result is missing $field"
    fi
  done
  node -e "
    const r = JSON.parse(process.argv[1]);
    if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}\$/.test(r.fingerprint)) { console.error('  bad fingerprint: '+r.fingerprint); process.exit(1); }
    if (r.adminToken.length < 40) { console.error('  short admin token'); process.exit(1); }
  " "$JSON" && pass "fingerprint and admin token are well formed" || fail "fingerprint or admin token malformed"
else
  fail "no LOCALTUNNEL_RESULT line — the desktop app would report a generic failure"
fi

CONFIG="$SANDBOX/etc/localtunnel/gateway.json"
if [ -f "$CONFIG" ]; then
  pass "wrote gateway.json"
  node -e "
    const c = require(process.argv[1]);
    const need = ['gatewayId','publicIp','adminTokenHash','dataDir','tls','limits'];
    const missing = need.filter((k) => c[k] === undefined);
    if (missing.length) { console.error('  missing keys: '+missing); process.exit(1); }
    if (c.publicIp !== '203.0.113.10') { console.error('  wrong publicIp: '+c.publicIp); process.exit(1); }
    if (!/^[a-f0-9]{64}\$/.test(c.adminTokenHash)) { console.error('  adminTokenHash is not a sha256'); process.exit(1); }
  " "$CONFIG" && pass "gateway.json is valid and complete" || fail "gateway.json is malformed"
else
  fail "gateway.json was not written"
fi

[ -f "$SANDBOX/var/lib/localtunnel/ca/ca.crt" ] && pass "generated the internal CA" || fail "no CA certificate"
[ -f "$SANDBOX/var/lib/localtunnel/ca/identity.crt" ] && pass "generated the identity certificate" || fail "no identity certificate"

# The reason the real install failed at step 8: an unreadable program directory.
GATEWAY_DIR="$SANDBOX/opt/localtunnel/gateway"
if [ -d "$GATEWAY_DIR" ]; then
  MODE="$(stat -f '%Lp' "$GATEWAY_DIR" 2>/dev/null || stat -c '%a' "$GATEWAY_DIR")"
  case "$MODE" in
    *5|*7) pass "gateway directory is traversable by other users (mode $MODE)" ;;
    *) fail "gateway directory mode $MODE would block the service user" ;;
  esac
  node -e "
    const { statSync } = require('fs');
    const p = process.argv[1];
    if (!(statSync(p).mode & 0o004)) { console.error('  not world-readable: '+p); process.exit(1); }
  " "$GATEWAY_DIR/dist/auth/ca.js" && pass "ca.js is readable by the service user" || fail "ca.js unreadable"
else
  fail "gateway directory missing"
fi

UNIT="$SANDBOX/etc/systemd/system/localtunnel-gateway.service"
if [ -f "$UNIT" ]; then
  pass "installed the systemd unit"

  # MemoryDenyWriteExecute stops V8 allocating JIT pages, so Node never starts.
  if grep -q '^MemoryDenyWriteExecute=true' "$UNIT"; then
    fail "unit sets MemoryDenyWriteExecute=true, which prevents Node from starting"
  else
    pass "unit does not set MemoryDenyWriteExecute (incompatible with Node)"
  fi

  EXEC_LINE="$(grep '^ExecStart=' "$UNIT" | head -1)"
  EXEC_CMD="${EXEC_LINE#ExecStart=}"
  # shellcheck disable=SC2086
  set -- $EXEC_CMD
  EXEC_NODE="$1"; EXEC_SCRIPT="$2"; EXEC_CONF="$3"

  [ -x "$EXEC_NODE" ] && pass "ExecStart points at a real node binary ($EXEC_NODE)" \
    || fail "ExecStart node path does not exist: $EXEC_NODE"
  [ -f "$EXEC_SCRIPT" ] && pass "ExecStart points at the installed gateway" \
    || fail "ExecStart script does not exist: $EXEC_SCRIPT"
  [ -f "$EXEC_CONF" ] && pass "ExecStart points at the written config" \
    || fail "ExecStart config does not exist: $EXEC_CONF"

  grep -q "^User=$(/usr/bin/id -un)\$" "$UNIT" && pass "unit runs as the service user" \
    || fail "unit User= was not rewritten"
else
  fail "systemd unit not installed"
fi

grep -q "systemctl enable" "$CALLS" && pass "enabled the service" || fail "never enabled the service"
grep -q "systemctl restart" "$CALLS" && pass "started the service" || fail "never started the service"
grep -qE "ufw allow 443|firewall-cmd .*443" "$CALLS" && pass "opened port 443" || fail "never opened port 443"
grep -qE "ufw allow 80|firewall-cmd .*80" "$CALLS" && pass "opened port 80" || fail "never opened port 80"

[ -f "$SANDBOX/opt/localtunnel/uninstall.sh" ] && pass "wrote uninstall.sh" || fail "no uninstall.sh"

# The assertion that matters most: does what the installer produced actually run?
# systemctl is stubbed, so start it the same way the unit file would, on ports an
# unprivileged test can bind.
if [ -f "$CONFIG" ] && [ -f "$GATEWAY_DIR/dist/main/index.js" ]; then
  node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    c.httpsPort = 18443; c.httpPort = 18080; c.firewall.manage = false; c.logFile = null;
    fs.writeFileSync(process.argv[1], JSON.stringify(c, null, 2));
  " "$CONFIG"

  node "$GATEWAY_DIR/dist/main/index.js" "$CONFIG" > "$SANDBOX/gateway.log" 2>&1 &
  GW_PID=$!
  for _ in $(seq 1 40); do
    grep -q "gateway ready" "$SANDBOX/gateway.log" 2>/dev/null && break
    sleep 0.25
  done

  if grep -q "gateway ready" "$SANDBOX/gateway.log"; then
    pass "the installed gateway starts"
  else
    fail "the installed gateway did not start"
    tail -5 "$SANDBOX/gateway.log" | sed 's/^/       /'
  fi

  if node -e "
    const net = require('net');
    const s = net.connect({ host: '127.0.0.1', port: 18443 });
    s.on('connect', () => { s.destroy(); process.exit(0); });
    s.on('error', () => process.exit(1));
    setTimeout(() => process.exit(1), 3000);
  "; then
    pass "the installed gateway is listening for public traffic"
  else
    fail "nothing listening on the gateway's TLS port"
  fi

  # And the fingerprint the installer reported must be the one it really serves,
  # or every agent would refuse to connect.
  if [ -n "${JSON:-}" ]; then
    node -e "
      const tls = require('tls');
      const { createHash } = require('crypto');
      const expected = JSON.parse(process.argv[1]).fingerprint.replace(/[^A-F0-9]/gi, '').toUpperCase();
      const s = tls.connect({ host: '127.0.0.1', port: 18443, rejectUnauthorized: false, ALPNProtocols: ['lt-admin/1'] }, () => {
        const actual = createHash('sha256').update(s.getPeerCertificate().raw).digest('hex').toUpperCase();
        s.destroy();
        process.exit(actual === expected ? 0 : 1);
      });
      s.on('error', () => process.exit(1));
      setTimeout(() => process.exit(1), 5000);
    " "$JSON" && pass "the reported fingerprint matches the certificate it serves" \
      || fail "fingerprint mismatch — agents would refuse to connect"
  fi

  kill $GW_PID 2>/dev/null || true
  wait $GW_PID 2>/dev/null || true
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "==> installer test passed"
else
  echo "==> $FAILURES assertion(s) failed"
  echo
  echo "--- installer output ---"
  tail -40 "$OUTPUT"
  exit 1
fi
