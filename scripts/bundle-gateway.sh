#!/usr/bin/env bash
#
# Packs the gateway into the tarball the desktop app uploads to a VPS over SSH.
#
# The bundle is self-contained: compiled gateway, its production dependencies, and
# the systemd unit. The target server needs only Node.js, which install.sh handles.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "==> Building gateway"
npm run build -w @localtunnel/protocol --prefix "$ROOT" >/dev/null
npm run build -w @localtunnel/gateway --prefix "$ROOT" >/dev/null

echo "==> Staging"
mkdir -p "$STAGE/dist" "$STAGE/node_modules/@localtunnel/protocol" "$STAGE/installer"
cp -R "$ROOT/packages/gateway/dist/." "$STAGE/dist/"
cp "$ROOT/packages/gateway/package.json" "$STAGE/package.json"
cp "$ROOT/installer/localtunnel-gateway.service" "$STAGE/installer/"

# The protocol package is a workspace sibling, so it is vendored rather than fetched.
cp -R "$ROOT/packages/protocol/dist" "$STAGE/node_modules/@localtunnel/protocol/dist"
cp "$ROOT/packages/protocol/package.json" "$STAGE/node_modules/@localtunnel/protocol/package.json"

# Third-party runtime dependencies.
for dep in node-forge acme-client; do
  if [ -d "$ROOT/node_modules/$dep" ]; then
    mkdir -p "$STAGE/node_modules/$dep"
    cp -R "$ROOT/node_modules/$dep/." "$STAGE/node_modules/$dep/"
  else
    echo "ERROR: $dep is not installed — run npm install first" >&2
    exit 1
  fi
done
# acme-client's own dependencies.
for dep in axios debug node-forge; do
  if [ -d "$ROOT/node_modules/$dep" ] && [ ! -d "$STAGE/node_modules/$dep" ]; then
    mkdir -p "$STAGE/node_modules/$dep"
    cp -R "$ROOT/node_modules/$dep/." "$STAGE/node_modules/$dep/"
  fi
done
# Everything else acme-client and axios pull in, flattened by npm already.
node "$ROOT/scripts/collect-deps.js" "$ROOT" "$STAGE" acme-client axios

mkdir -p "$OUT"
echo "==> Packing"
# mktemp -d creates the staging directory as 0700, and tar records that mode for
# "./". Extracted as root on the server, it would make /opt/localtunnel/gateway
# unreadable to the unprivileged `localtunnel` user the gateway runs as.
chmod 755 "$STAGE"
chmod -R a+rX "$STAGE"
tar -czf "$OUT/localtunnel-gateway.tar.gz" -C "$STAGE" .

SIZE="$(du -h "$OUT/localtunnel-gateway.tar.gz" | cut -f1)"
echo "==> build/localtunnel-gateway.tar.gz ($SIZE)"
