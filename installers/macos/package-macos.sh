#!/usr/bin/env bash
#
# Package a compiled privacy-screen darwin binary into a double-clickable
# privacy-screen.app bundle and a drag-to-install .dmg.
#
# macOS-only (uses hdiutil, sips/iconutil optional, codesign optional). Intended
# to run on the macOS CI runner after build-release.ts has produced the darwin
# binaries, but also works locally on a Mac:
#
#   installers/macos/package-macos.sh \
#       --binary dist/privacy-screen-darwin-arm64 \
#       --version 1.0.0 \
#       --arch arm64 \
#       --outdir dist
#
# Output: dist/privacy-screen-<version>-darwin-<arch>.dmg containing
#         privacy-screen.app and an /Applications symlink for drag-install.
#
# Signing/notarization is optional and only happens when CODESIGN_IDENTITY is
# exported (the release workflow already handles signing the raw binary; this
# script can additionally sign the .app bundle when an identity is present).

set -euo pipefail

BINARY=""
VERSION="0.0.0"
ARCH="arm64"
OUTDIR="dist"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary)  BINARY="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --arch)    ARCH="$2"; shift 2 ;;
    --outdir)  OUTDIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$BINARY" || ! -f "$BINARY" ]]; then
  echo "error: --binary <path> is required and must exist (got '$BINARY')" >&2
  exit 1
fi

APP_NAME="privacy-screen"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

APP="$WORK/$APP_NAME.app"
MACOS_DIR="$APP/Contents/MacOS"
RES_DIR="$APP/Contents/Resources"
mkdir -p "$MACOS_DIR" "$RES_DIR"

# The real server binary lives beside the launcher under a distinct name.
cp "$BINARY" "$MACOS_DIR/privacy-screen-bin"
chmod +x "$MACOS_DIR/privacy-screen-bin"

# Launcher script is the bundle's executable. Finder/LaunchServices give GUI
# apps a minimal PATH that usually omits the user's CLI install dirs, so we
# augment PATH the way a login shell would before checking for the required
# `claude` CLI. Then start the server with the browser-open flag.
cat > "$MACOS_DIR/$APP_NAME" <<'LAUNCHER'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  osascript -e 'display dialog "privacy-screen needs the Claude Code CLI (\"claude\") on your PATH.\n\nInstall it from https://docs.claude.com/en/docs/claude-code and run: claude login\n\nThen reopen privacy-screen." buttons {"OK"} with icon caution with title "privacy-screen"' >/dev/null 2>&1 || true
  exit 1
fi
export PRIVACY_SCREEN_OPEN=1
exec "$DIR/privacy-screen-bin"
LAUNCHER
chmod +x "$MACOS_DIR/$APP_NAME"

# Info.plist. LSBackgroundOnly=false so it shows in the Dock (user can Quit it,
# which stops the local server). No custom icon ships yet — Finder uses the
# generic app icon.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>            <string>privacy-screen</string>
  <key>CFBundleDisplayName</key>     <string>privacy-screen</string>
  <key>CFBundleIdentifier</key>      <string>com.adamcongdon.privacy-screen</string>
  <key>CFBundleVersion</key>         <string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleExecutable</key>      <string>privacy-screen</string>
  <key>CFBundlePackageType</key>     <string>APPL</string>
  <key>LSMinimumSystemVersion</key>  <string>11.0</string>
  <key>NSHighResolutionCapable</key> <true/>
</dict>
</plist>
PLIST

# Optional: sign the bundle when an identity is provided. Sign inner binaries
# first, then the bundle (inside-out), matching codesign requirements.
if [[ -n "${CODESIGN_IDENTITY:-}" ]]; then
  echo "→ codesigning .app with identity: $CODESIGN_IDENTITY"
  codesign --force --options runtime --timestamp --sign "$CODESIGN_IDENTITY" "$MACOS_DIR/privacy-screen-bin"
  codesign --force --options runtime --timestamp --sign "$CODESIGN_IDENTITY" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP" || true
fi

mkdir -p "$OUTDIR"
DMG_PATH="$OUTDIR/privacy-screen-${VERSION}-darwin-${ARCH}.dmg"
rm -f "$DMG_PATH"

# Stage a folder with the .app and an Applications symlink for drag-install.
STAGE="$WORK/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

echo "→ building $DMG_PATH"
# Size the image explicitly with headroom rather than relying on hdiutil's
# auto-size from -srcfolder, which is too tight for the larger x64 .app and
# fails inside the mounted volume with "No space left on device". Create a
# sized read-write image, then convert to the final compressed UDZO.
SIZE_KB=$(du -sk "$STAGE" | cut -f1)
IMG_SIZE=$(( SIZE_KB + 51200 ))   # +50MB headroom for filesystem overhead
RW_DMG="$WORK/rw.dmg"
hdiutil create \
  -volname "privacy-screen" \
  -srcfolder "$STAGE" \
  -fs HFS+ \
  -format UDRW \
  -size "${IMG_SIZE}k" \
  -ov \
  "$RW_DMG"
hdiutil convert "$RW_DMG" -format UDZO -ov -o "$DMG_PATH"
rm -f "$RW_DMG"

echo "✅ wrote $DMG_PATH"
