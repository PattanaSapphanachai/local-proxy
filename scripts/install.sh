#!/usr/bin/env bash
# Install Local Proxy on macOS without the Gatekeeper "damaged" error.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/PattanaSapphanachai/local-proxy/main/scripts/install.sh | bash
#
# Downloads the DMG from GitHub Releases with curl. curl does not add the
# quarantine flag, so Gatekeeper does not block the unnotarized app.
#
# Optional environment variables:
#   LOCAL_PROXY_VERSION      Version to install, e.g. 0.1.2. Defaults to the latest release.
#   LOCAL_PROXY_REPO         GitHub repository (owner/name) hosting the releases.
#   LOCAL_PROXY_DMG          Path to a local DMG to install instead of downloading.
#   LOCAL_PROXY_INSTALL_DIR  Install location. Defaults to /Applications.
#   LOCAL_PROXY_NO_OPEN      Set to 1 to skip launching the app after install.

set -euo pipefail

REPO="${LOCAL_PROXY_REPO:-PattanaSapphanachai/local-proxy}"
VERSION="${LOCAL_PROXY_VERSION:-}"
APP_NAME="Local Proxy"
INSTALL_DIR="${LOCAL_PROXY_INSTALL_DIR:-/Applications}"

info() { printf '==> %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "This installer only supports macOS."

# Pick the DMG for this CPU. Rosetta shells report x86_64, so ask the hardware.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  ARCH="arm64"
else
  ARCH="x64"
fi

WORK_DIR="$(mktemp -d -t local-proxy-install)"
MOUNT_POINT="$WORK_DIR/mnt"
MOUNTED=0
cleanup() {
  if [ "$MOUNTED" = "1" ]; then
    hdiutil detach "$MOUNT_POINT" -quiet -force >/dev/null 2>&1 || true
  fi
  # Never delete the work dir while the image is still attached.
  if ! mount | grep -q "$WORK_DIR"; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

if [ -n "${LOCAL_PROXY_DMG:-}" ]; then
  [ -f "$LOCAL_PROXY_DMG" ] || fail "DMG not found: $LOCAL_PROXY_DMG"
  DMG="$LOCAL_PROXY_DMG"
  info "Using local DMG $DMG"
else
  if [ -z "$VERSION" ]; then
    # /releases/latest redirects to /releases/tag/vX.Y.Z; read the tag from it.
    LATEST_URL="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" \
      || fail "Could not reach GitHub to find the latest release."
    case "$LATEST_URL" in
      */releases/tag/*) VERSION="${LATEST_URL##*/tag/}"; VERSION="${VERSION#v}" ;;
      *) fail "No published release found for $REPO." ;;
    esac
  fi
  URL="https://github.com/$REPO/releases/download/v${VERSION}/Local-Proxy-${VERSION}-${ARCH}.dmg"
  DMG="$WORK_DIR/LocalProxy.dmg"
  info "Downloading $APP_NAME $VERSION ($ARCH)"
  curl -fL --progress-bar -o "$DMG" "$URL" || fail "Download failed: $URL"
fi

info "Mounting disk image"
mkdir -p "$MOUNT_POINT"
hdiutil attach "$DMG" -nobrowse -readonly -noautoopen -mountpoint "$MOUNT_POINT" -quiet \
  || fail "Could not mount the disk image."
MOUNTED=1

SRC_APP="$MOUNT_POINT/$APP_NAME.app"
[ -d "$SRC_APP" ] || fail "$APP_NAME.app not found inside the disk image."

DEST_APP="$INSTALL_DIR/$APP_NAME.app"
DEST_BIN="$DEST_APP/Contents/MacOS/$APP_NAME"

# Only quit the copy we are about to replace, not one installed elsewhere.
if pgrep -fq "^$DEST_BIN"; then
  info "Quitting running $APP_NAME"
  osascript -e "quit app \"$DEST_APP\"" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do
    pgrep -fq "^$DEST_BIN" || break
    sleep 1
  done
  pkill -f "^$DEST_BIN" 2>/dev/null || true
fi

SUDO=""
if [ ! -w "$INSTALL_DIR" ] || { [ -e "$DEST_APP" ] && [ ! -w "$DEST_APP" ]; }; then
  info "Administrator password needed to write to $INSTALL_DIR"
  SUDO="sudo"
fi

info "Installing to $DEST_APP"
$SUDO rm -rf "$DEST_APP"
$SUDO ditto "$SRC_APP" "$DEST_APP"

# Belt and braces: clear quarantine in case the DMG arrived via a browser.
$SUDO xattr -dr com.apple.quarantine "$DEST_APP" 2>/dev/null || true

hdiutil detach "$MOUNT_POINT" -quiet && MOUNTED=0

if [ "${LOCAL_PROXY_NO_OPEN:-0}" = "1" ]; then
  info "$APP_NAME ${VERSION:-local build} installed to $DEST_APP"
else
  info "$APP_NAME ${VERSION:-local build} installed. Opening it now."
  open "$DEST_APP" || true
fi
