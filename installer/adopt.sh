#!/bin/sh
#
# Takes over a gateway that is already installed on this server: reads its
# identity, gives it a fresh admin token, and prints both back.
#
# There is no way to read an existing admin token — the gateway stores only a
# SHA-256 hash of it — so a client that has lost the token, or never had it, can
# only get in by setting a new one. Run over SSH by the desktop app and by the
# terminal client, both of which already had root on this box to install it.
#
# Prints `LOCALTUNNEL_ADOPT {json}` on success, `ERROR: …` on failure, and puts
# the previous configuration back if the gateway does not come up again.
#
# The paths come from the environment with the real values as defaults, so the
# script can be exercised against a scratch config with no server involved.
set -u
CONF=${LT_CONF:-/etc/localtunnel/gateway.json}
SYSTEMCTL=${LT_SYSTEMCTL:-systemctl}
SERVICE=${LT_SERVICE:-localtunnel-gateway}
[ -f "$CONF" ] || { echo "ERROR: no gateway is installed on this server (\$CONF is missing)."; exit 1; }

field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$CONF" | head -1; }
number() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$CONF" | head -1; }

GATEWAY_ID=$(field gatewayId)
PUBLIC_IP=$(field publicIp)
DATA_DIR=$(field dataDir)
NAME=$(field name)
HTTPS_PORT=$(number httpsPort)
[ -n "$GATEWAY_ID" ] || { echo "ERROR: could not read gatewayId out of $CONF."; exit 1; }
[ -n "$DATA_DIR" ] || DATA_DIR=/var/lib/localtunnel
[ -n "$HTTPS_PORT" ] || HTTPS_PORT=443

CERT="$DATA_DIR/ca/identity.crt"
[ -f "$CERT" ] || { echo "ERROR: the gateway identity certificate is missing ($CERT)."; exit 1; }
FINGERPRINT=$(openssl x509 -in "$CERT" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'a-f' 'A-F')

TOKEN=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-43)
HASH=$(printf %s "$TOKEN" | sha256sum 2>/dev/null | cut -d' ' -f1)
[ -n "$HASH" ] || HASH=$(printf %s "$TOKEN" | openssl dgst -sha256 | awk '{print $NF}')

cp "$CONF" "$CONF.lt-bak"
# Rewritten through a temp file and poured back in, rather than with `sed -i`:
# that keeps the file's inode, owner and 0640 mode, and does not assume GNU sed.
sed "s|\"adminTokenHash\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"adminTokenHash\": \"$HASH\"|" "$CONF" > "$CONF.lt-new"
cat "$CONF.lt-new" > "$CONF"
rm -f "$CONF.lt-new"
if ! grep -q "$HASH" "$CONF"; then
  cp "$CONF.lt-bak" "$CONF"
  echo "ERROR: could not write the new admin token into $CONF."
  exit 1
fi

echo "restarting the gateway"
"$SYSTEMCTL" restart "$SERVICE"
sleep 2
if ! "$SYSTEMCTL" is-active --quiet "$SERVICE"; then
  cp "$CONF.lt-bak" "$CONF"
  "$SYSTEMCTL" restart "$SERVICE" || true
  echo "ERROR: the gateway did not come back up, so the previous token was restored."
  exit 1
fi
rm -f "$CONF.lt-bak"

printf 'LOCALTUNNEL_ADOPT {"gatewayId":"%s","publicIp":"%s","httpsPort":%s,"fingerprint":"%s","adminToken":"%s","name":"%s"}\n' \
  "$GATEWAY_ID" "$PUBLIC_IP" "$HTTPS_PORT" "$FINGERPRINT" "$TOKEN" "$NAME"
