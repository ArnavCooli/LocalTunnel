#!/bin/sh
#
# Installs the LocalTunnel terminal client on a Linux box from source.
#
#   curl -fsSL https://raw.githubusercontent.com/arnavko11/LocalTunnel/main/scripts/install-cli.sh | sh
#
# It clones the repository, builds it, packs the gateway bundle the SSH flow
# uploads to a VPS, and puts `localtunnel` on your PATH. Node.js 20+ is required;
# if the system does not have it, a private copy is downloaded into the install
# directory rather than touching the distribution's packages.
#
# Run it again at any time to update — it fetches and rebuilds in place.
#
# Options:
#   --dir DIR       where to install   (default /opt/localtunnel-cli as root,
#                                       ~/.local/share/localtunnel otherwise)
#   --bin-dir DIR   where to link the launcher (default /usr/local/bin or ~/.local/bin)
#   --ref REF       branch, tag or commit to install (default main)
#   --repo URL      clone from somewhere else
#   --no-bundle     skip building the gateway tarball (SSH gateway install needs it)
#   --uninstall     remove the install directory and the launcher
#   --help

set -eu

REPO="https://github.com/arnavko11/LocalTunnel.git"
REF="main"
DIR=""
BIN_DIR=""
BUNDLE=1
UNINSTALL=0
NODE_MAJOR_MIN=20
NODE_LINE="latest-v22.x"

say()  { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  # The header comment above is the help text; print it up to the first blank line.
  awk 'NR>2 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)       [ $# -ge 2 ] || fail "--dir needs a path";     DIR="$2"; shift 2 ;;
    --bin-dir)   [ $# -ge 2 ] || fail "--bin-dir needs a path"; BIN_DIR="$2"; shift 2 ;;
    --ref)       [ $# -ge 2 ] || fail "--ref needs a value";    REF="$2"; shift 2 ;;
    --repo)      [ $# -ge 2 ] || fail "--repo needs a URL";     REPO="$2"; shift 2 ;;
    --no-bundle) BUNDLE=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)   usage ;;
    *) fail "unknown option: $1 (try --help)" ;;
  esac
done

# ------------------------------------------------------------ where things go

if [ "$(id -u)" -eq 0 ]; then
  : "${DIR:=/opt/localtunnel-cli}"
  : "${BIN_DIR:=/usr/local/bin}"
else
  : "${DIR:=${XDG_DATA_HOME:-$HOME/.local/share}/localtunnel}"
  : "${BIN_DIR:=$HOME/.local/bin}"
fi
LAUNCHER="$BIN_DIR/localtunnel"

# ---------------------------------------------------------------- uninstall

if [ "$UNINSTALL" -eq 1 ]; then
  [ -d "$DIR" ] || [ -f "$LAUNCHER" ] || fail "nothing installed at $DIR"
  say "removing $LAUNCHER and $DIR"
  rm -f "$LAUNCHER"
  rm -rf "$DIR"
  note "Done. The agent's background service and credentials are separate — if you"
  note "connected this computer and want that gone too:"
  note "  systemctl --user disable --now localtunnel-agent.service"
  note "  rm -rf \"\${XDG_CONFIG_HOME:-\$HOME/.config}/localtunnel\""
  exit 0
fi

# ------------------------------------------------------------------ the box

case "$(uname -s)" in
  Linux) : ;;
  *) fail "this script is for Linux. On macOS or Windows use the desktop app." ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) fail "unsupported CPU: $(uname -m). LocalTunnel builds for x86_64 and arm64." ;;
esac

need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed. Install it and run this again ($2)."; }
need git "e.g. sudo apt-get install git"
need tar "e.g. sudo apt-get install tar"

if command -v curl >/dev/null 2>&1; then
  DL="curl -fsSL -o"
elif command -v wget >/dev/null 2>&1; then
  DL="wget -qO"
else
  fail "curl or wget is required but neither is installed (e.g. sudo apt-get install curl)."
fi
fetch() { $DL "$2" "$1"; }              # fetch URL DEST

say "$(uname -m) Linux, installing into $DIR"

mkdir -p "$DIR" 2>/dev/null || fail "cannot create $DIR. Re-run with sudo, or pass --dir ~/localtunnel."
[ -w "$DIR" ] || fail "$DIR is not writable by $(id -un). Re-run with sudo, or pass --dir ~/localtunnel."
mkdir -p "$BIN_DIR" || fail "cannot create $BIN_DIR. Pass --bin-dir with somewhere writable."

# -------------------------------------------------------------------- node
#
# A system Node.js is used when it is new enough. Otherwise a private copy goes
# under the install directory: no root needed, no distribution packages changed,
# and nothing else on the machine sees a different Node than it did before.

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

NODE_HOME="$DIR/runtime"
NODE=""
if command -v node >/dev/null 2>&1 && [ "$(node_major node)" -ge "$NODE_MAJOR_MIN" ]; then
  NODE="$(command -v node)"
  say "using the system Node.js ($("$NODE" -v))"
elif [ -x "$NODE_HOME/bin/node" ] && [ "$(node_major "$NODE_HOME/bin/node")" -ge "$NODE_MAJOR_MIN" ]; then
  NODE="$NODE_HOME/bin/node"
  say "using the Node.js already in $NODE_HOME ($("$NODE" -v))"
else
  if command -v node >/dev/null 2>&1; then
    say "Node.js $(node -v) is too old (need $NODE_MAJOR_MIN+), downloading a private copy"
  else
    say "Node.js is not installed, downloading a private copy into $NODE_HOME"
  fi

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT INT TERM

  BASE="https://nodejs.org/dist/$NODE_LINE"
  fetch "$BASE/SHASUMS256.txt" "$TMP/SHASUMS256.txt" \
    || fail "could not reach nodejs.org. Check this machine's internet access, or install Node.js $NODE_MAJOR_MIN+ yourself and re-run."

  LINE="$(grep -- "-linux-$NODE_ARCH\.tar\.gz\$" "$TMP/SHASUMS256.txt" | head -n 1)" \
    || fail "nodejs.org has no $NODE_LINE build for linux-$NODE_ARCH."
  [ -n "$LINE" ] || fail "nodejs.org has no $NODE_LINE build for linux-$NODE_ARCH."
  TARBALL="${LINE##* }"
  WANT_SUM="${LINE%% *}"

  say "downloading $TARBALL"
  fetch "$BASE/$TARBALL" "$TMP/$TARBALL" || fail "download of $TARBALL failed. Try again."

  # The tarball is executed as the runtime for everything below, so it is checked
  # against the checksum file rather than trusted for having arrived intact.
  if command -v sha256sum >/dev/null 2>&1; then
    GOT="$(sha256sum "$TMP/$TARBALL" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    GOT="$(shasum -a 256 "$TMP/$TARBALL" | cut -d' ' -f1)"
  elif command -v openssl >/dev/null 2>&1; then
    GOT="$(openssl dgst -sha256 "$TMP/$TARBALL" | awk '{print $NF}')"
  else
    # This tarball becomes the runtime every later step executes. "We could not
    # check it, so we ran it anyway" is not a decision to make on the user's
    # behalf — installing a known-good Node.js by hand is the safe way out.
    fail "no sha256sum, shasum or openssl on this machine, so the Node.js download cannot be verified. Install Node.js $NODE_MAJOR_MIN+ yourself and run this again."
  fi
  if [ "$GOT" != "$WANT_SUM" ]; then
    fail "$TARBALL failed its checksum — the download is corrupt or was tampered with. Nothing was installed."
  fi

  rm -rf "$NODE_HOME"
  mkdir -p "$NODE_HOME"
  tar -xzf "$TMP/$TARBALL" -C "$NODE_HOME" --strip-components=1 \
    || fail "could not unpack $TARBALL."
  rm -rf "$TMP"
  trap - EXIT INT TERM

  NODE="$NODE_HOME/bin/node"
  [ -x "$NODE" ] || fail "the Node.js download unpacked but $NODE is missing."
  say "Node.js $("$NODE" -v) installed in $NODE_HOME"
fi

NODE_BIN="$(dirname "$NODE")"
PATH="$NODE_BIN:$PATH"
export PATH
command -v npm >/dev/null 2>&1 || fail "npm is missing next to $NODE. Install the full Node.js distribution, not just the node binary."

# ------------------------------------------------------------------ source

SRC="$DIR/src"
if [ -d "$SRC/.git" ]; then
  say "updating the checkout in $SRC"
  git -C "$SRC" remote set-url origin "$REPO"
  git -C "$SRC" fetch --tags --prune origin || fail "could not fetch from $REPO."
  # A checkout that only this script writes to; local edits are not something to
  # preserve, and a half-applied merge would break the build in a confusing way.
  if git -C "$SRC" rev-parse --verify --quiet "origin/$REF" >/dev/null; then
    git -C "$SRC" reset --hard "origin/$REF" >/dev/null
  else
    git -C "$SRC" reset --hard "$REF" >/dev/null || fail "$REF is not a branch, tag or commit in $REPO."
  fi
  git -C "$SRC" clean -fdx -e node_modules -e build >/dev/null
else
  say "cloning $REPO"
  rm -rf "$SRC"
  git clone --quiet "$REPO" "$SRC" || fail "could not clone $REPO. Check the URL and this machine's internet access."
  git -C "$SRC" checkout --quiet "$REF" || fail "$REF is not a branch, tag or commit in $REPO."
fi
note "at $(git -C "$SRC" rev-parse --short HEAD) ($REF)"

# ------------------------------------------------------------------- build

# Only the workspaces a headless box needs. A plain `npm install` would also pull
# in the desktop app's Electron — a few hundred megabytes of GUI toolkit that this
# machine has no display for, and whose postinstall fails on a bare server.
say "installing dependencies (this takes a few minutes on a small VPS)"
( cd "$SRC" && npm install --no-audit --no-fund --loglevel=error --include-workspace-root \
    -w @localtunnel/protocol -w @localtunnel/gateway -w @localtunnel/agent -w @localtunnel/cli ) \
  || fail "npm install failed in $SRC. The output above says why; a full disk and no network are the usual reasons."

say "building protocol, gateway, agent and the terminal client"
( cd "$SRC" && npm run build --silent ) || fail "the build failed in $SRC. The output above says why."

CLI="$SRC/packages/cli/dist/index.js"
[ -f "$CLI" ] || fail "the build finished but $CLI is missing."

if [ "$BUNDLE" -eq 1 ]; then
  # The tarball the SSH flow uploads to a VPS. Without it the terminal client
  # still runs, but "Add a gateway → Sign in over SSH" has nothing to install.
  say "packing the gateway bundle"
  ( cd "$SRC" && ./scripts/bundle-gateway.sh >/dev/null ) \
    || fail "./scripts/bundle-gateway.sh failed. Re-run with --no-bundle to skip it; gateway installation over SSH will not work until it succeeds."
fi

# ---------------------------------------------------------------- launcher

# A wrapper rather than a symlink: the client shells out to node and npm for the
# agent, and putting this Node first on PATH keeps it from finding an older one.
cat > "$LAUNCHER" <<EOF
#!/bin/sh
# LocalTunnel terminal client — written by scripts/install-cli.sh, edits are lost on update.
PATH="$NODE_BIN:\$PATH"
export PATH
exec "$NODE" "$CLI" "\$@"
EOF
chmod +x "$LAUNCHER" || fail "could not make $LAUNCHER executable."

say "installed $LAUNCHER"

printf '\n'
say "Done."
case ":$PATH:" in
  *":$BIN_DIR:"*)
    note "Run it with:  localtunnel"
    ;;
  *)
    note "$BIN_DIR is not on your PATH. Either run it by full path:"
    note "  $LAUNCHER"
    note "or add it to your shell profile:"
    note "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile && . ~/.profile"
    ;;
esac
note ""
note "First run: Gateways -> Add a gateway -> Sign in over SSH, then Connect this computer."
note "Update:    re-run this script.   Remove: this script with --uninstall."
