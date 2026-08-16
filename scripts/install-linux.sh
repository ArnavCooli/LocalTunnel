#!/bin/sh
# Installs LocalTunnel on a Linux desktop from whichever artifact is to hand,
# and says exactly what is wrong when it cannot.
#
# The failure modes this exists for are all environmental rather than anything
# wrong with the package: a lost executable bit, no libfuse2 for AppImages, a
# file manager with no .deb handler, the wrong architecture, a truncated copy.
#
# Usage: sh install-linux.sh [path-to-.deb-or-.AppImage]
#        sh install-linux.sh            # finds one next to this script

set -e

say()  { printf '%s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- the file

FILE="$1"
if [ -z "$FILE" ]; then
  for candidate in ./localtunnel-desktop_*.deb ./LocalTunnel-*.AppImage; do
    [ -f "$candidate" ] && FILE="$candidate" && break
  done
fi
[ -n "$FILE" ] || fail "No LocalTunnel package found here. Pass the path: sh install-linux.sh /path/to/file.deb"
[ -f "$FILE" ] || fail "$FILE does not exist. Check the name — 'ls' in the folder you copied it to."

SIZE=$(wc -c < "$FILE")
[ "$SIZE" -gt 50000000 ] || fail "$FILE is only $SIZE bytes, so the copy did not finish. Copy it again."

# --------------------------------------------------------- the machine

MACHINE=$(uname -m)
case "$MACHINE" in
  x86_64|amd64) WANT=amd64; APPIMAGE_ARCH=x86_64 ;;
  aarch64|arm64) WANT=arm64; APPIMAGE_ARCH=arm64 ;;
  *) fail "This computer is $MACHINE, which LocalTunnel has no build for (x86_64 and arm64 only)." ;;
esac
say "==> $MACHINE machine, using the $WANT build"

case "$FILE" in
  *.deb)
    case "$FILE" in
      *_"$WANT".deb) : ;;
      *) fail "$FILE is for a different CPU. This machine needs the $WANT package." ;;
    esac
    ;;
  *.AppImage)
    case "$FILE" in
      *"$APPIMAGE_ARCH".AppImage) : ;;
      *) fail "$FILE is for a different CPU. This machine needs the $APPIMAGE_ARCH AppImage." ;;
    esac
    ;;
esac

# ------------------------------------------------------------------ deb

install_deb() {
  head -c 8 "$1" | grep -q '!<arch>' \
    || fail "$1 is not a Debian package — the copy is corrupt. Copy it again and check its size."

  if command -v dpkg >/dev/null 2>&1; then
    say "==> installing with dpkg (you will be asked for your password)"
    sudo dpkg -i "$1" || {
      say "==> pulling in the libraries it needs"
      sudo apt-get -f install -y
    }
    say ""
    say "Installed. Launch it from the menu, or run: localtunnel-desktop"
    return 0
  fi

  fail "dpkg is missing, which is unusual on a Debian-family system. Use the AppImage instead."
}

# ------------------------------------------------------------- AppImage

run_appimage() {
  chmod +x "$1"
  say "==> made $1 executable"

  # AppImages mount themselves with FUSE 2, which Ubuntu 22.04 and later no
  # longer ship. Extracting instead needs nothing, so skip FUSE rather than
  # sending the user off to install libfuse2. Run in the foreground: if it
  # fails, the reason belongs on screen and not swallowed.
  say "==> starting it (ctrl-c to stop)"
  say ""
  exec "$1" --appimage-extract-and-run
}

case "$FILE" in
  *.deb) install_deb "$FILE" ;;
  *.AppImage) run_appimage "$FILE" ;;
  *) fail "$FILE is neither a .deb nor an .AppImage." ;;
esac
