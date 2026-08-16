#!/usr/bin/env node
/**
 * Serves the built installers to another machine on your network.
 *
 * Getting a 100 MB package onto a Linux box is where installing it usually goes
 * wrong: a copy through a USB stick or a chat app arrives truncated or renamed,
 * and then the failure looks like a broken package. This hands the file over
 * HTTP, checksummed, and prints the one command to run at the other end.
 *
 * It serves exactly the files in packages/desktop/release and nothing else, on
 * your local network only — there is no upload, no directory traversal, and it
 * stops when you press ctrl-c.
 *
 * Usage: npm run serve            # or: node scripts/serve-release.mjs [port]
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(root, 'packages', 'desktop', 'release');
const port = Number(process.argv[2]) || 8080;

const KINDS = /\.(deb|AppImage|dmg|exe|txt)$/;

if (!existsSync(releaseDir)) {
  process.stderr.write(
    'Nothing has been built yet. Run:\n  npm run dist:linux -w @localtunnel/desktop\n',
  );
  process.exit(1);
}

/** Only these files are reachable — the name is matched, never a path. */
const catalogue = new Map();
for (const name of readdirSync(releaseDir).sort()) {
  if (!KINDS.test(name)) continue;
  const path = join(releaseDir, name);
  if (!statSync(path).isFile()) continue;
  catalogue.set(name, { path, size: statSync(path).size, sha256: null });
}

if (catalogue.size === 0) {
  process.stderr.write(`No installers in ${releaseDir}. Run: npm run dist:linux -w @localtunnel/desktop\n`);
  process.exit(1);
}

function sha256(name) {
  const entry = catalogue.get(name);
  if (!entry.sha256) {
    entry.sha256 = createHash('sha256').update(readFileSync(entry.path)).digest('hex');
  }
  return entry.sha256;
}

function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

const host = lanAddress();
const base = `http://${host}:${port}`;

const debFor = (arch) => [...catalogue.keys()].find((n) => n.endsWith(`_${arch}.deb`));
const appImageFor = (arch) => [...catalogue.keys()].find((n) => n.endsWith(`${arch}.AppImage`));

/* ------------------------------------------------------------ bootstrap */

/**
 * The script the Linux machine runs. It downloads the right package for its own
 * CPU, checks it arrived whole, and installs it — so nothing depends on how the
 * file got copied, because it did not get copied.
 */
function bootstrap() {
  const amd64 = debFor('amd64');
  const arm64 = debFor('arm64');
  const amdImage = appImageFor('x86_64');
  const armImage = appImageFor('arm64');

  return `#!/bin/sh
# Installs LocalTunnel from ${base}
set -e

BASE="${base}"
MACHINE=$(uname -m)
case "$MACHINE" in
  x86_64|amd64)  DEB="${amd64 ?? ''}"; DEB_SHA="${amd64 ? sha256(amd64) : ''}"; APPIMAGE="${amdImage ?? ''}" ;;
  aarch64|arm64) DEB="${arm64 ?? ''}"; DEB_SHA="${arm64 ? sha256(arm64) : ''}"; APPIMAGE="${armImage ?? ''}" ;;
  *) echo "ERROR: no LocalTunnel build for $MACHINE (x86_64 and arm64 only)" >&2; exit 1 ;;
esac

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fL --progress-bar -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q --show-progress -O "$2" "$1"
  else echo "ERROR: neither curl nor wget is installed" >&2; exit 1
  fi
}

if [ -n "$DEB" ] && command -v dpkg >/dev/null 2>&1; then
  echo "==> downloading $DEB for $MACHINE"
  fetch "$BASE/$DEB" "/tmp/$DEB"

  if command -v sha256sum >/dev/null 2>&1; then
    GOT=$(sha256sum "/tmp/$DEB" | cut -d' ' -f1)
    if [ "$GOT" != "$DEB_SHA" ]; then
      echo "ERROR: the download is damaged (checksum mismatch). Try again." >&2
      exit 1
    fi
    echo "==> checksum ok"
  fi

  echo "==> installing (this needs your password)"
  sudo dpkg -i "/tmp/$DEB" || sudo apt-get -f install -y
  rm -f "/tmp/$DEB"
  echo ""
  echo "Done. Find LocalTunnel in your menu, or run: localtunnel-desktop"
  exit 0
fi

# No dpkg — not a Debian-family system. The AppImage needs nothing installed.
if [ -n "$APPIMAGE" ]; then
  echo "==> no dpkg here, downloading the AppImage instead"
  fetch "$BASE/$APPIMAGE" "$HOME/$APPIMAGE"
  chmod +x "$HOME/$APPIMAGE"
  echo ""
  echo "Done. Start it with:"
  echo "  $HOME/$APPIMAGE --appimage-extract-and-run"
  exit 0
fi

echo "ERROR: nothing on the server suits this machine" >&2
exit 1
`;
}

/* ---------------------------------------------------------------- index */

function index() {
  const lines = [
    'LocalTunnel installers',
    '='.repeat(50),
    '',
    'On the Linux machine, one command does everything:',
    '',
    `  curl -fsSL ${base}/install.sh | sh`,
    '',
    'Or take a file directly:',
    '',
  ];
  for (const [name, entry] of catalogue) {
    lines.push(`  ${(entry.size / 1024 / 1024).toFixed(0).padStart(4)} MB  ${base}/${name}`);
  }
  lines.push('', 'Checksums: ' + `${base}/SHA256SUMS.txt`, '');
  return lines.join('\n');
}

/* --------------------------------------------------------------- server */

const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const from = req.socket.remoteAddress ?? '?';

  if (path === '/' || path === '/index.html') {
    process.stdout.write(`  ${from} → index\n`);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(index());
    return;
  }

  if (path === '/install.sh') {
    process.stdout.write(`  ${from} → install.sh\n`);
    const body = bootstrap();
    res.writeHead(200, {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  // Names only, matched against the catalogue: nothing else on this machine is
  // reachable, whatever the request path says.
  const name = path.replace(/^\/+/, '');
  const entry = catalogue.get(name);
  if (!entry) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`No such file. See ${base}/ for what is here.\n`);
    return;
  }

  // Range support, so a dropped download can be resumed rather than restarted.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0;
  let end = entry.size - 1;
  let status = 200;
  const headers = {
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    'content-disposition': `attachment; filename="${name}"`,
  };
  if (range) {
    start = range[1] ? Number(range[1]) : 0;
    end = range[2] ? Number(range[2]) : entry.size - 1;
    if (start >= entry.size || end >= entry.size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${entry.size}` });
      res.end();
      return;
    }
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${entry.size}`;
  }
  headers['content-length'] = end - start + 1;

  process.stdout.write(`  ${from} → ${name}${range ? ` (resuming at ${start})` : ''}\n`);
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(entry.path, { start, end }).pipe(res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`Port ${port} is already in use. Try: node scripts/serve-release.mjs 8081\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, '0.0.0.0', () => {
  const out = [
    '',
    `Serving ${catalogue.size} file(s) from packages/desktop/release on ${base}`,
    '',
    'Run this on the Linux machine:',
    '',
    `  curl -fsSL ${base}/install.sh | sh`,
    '',
    `(browse ${base}/ for the individual files · ctrl-c to stop)`,
    '',
  ];
  process.stdout.write(out.join('\n'));
});
