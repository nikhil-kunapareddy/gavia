#!/usr/bin/env bash
#
# Package the built Gavia.app into a .dmg.
#
# Tauri's own `dmg` target mounts a scratch volume, drives Finder with
# AppleScript to lay the window out, then unmounts. On a bundle this size that
# unmount races Spotlight indexing the freshly copied app and loses often
# enough to be useless in a build:
#
#     hdiutil: couldn't unmount "disk5" - Resource busy
#
# `hdiutil create` builds the image straight from a directory and never mounts
# it, so there is no race to lose. The window layout Finder would have written
# is checked in instead: src-tauri/installer/dmg-DS_Store (made once by
# dmg-layout.py, which says how to regenerate it) goes in as .DS_Store, next to
# the background it names. It finds the background by path, so the volume
# must stay named "Gavia".
set -euo pipefail

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A plain `tauri build` writes to target/release; CI builds with an explicit
# `--target`, which nests the output one level deeper. Take whichever exists,
# or the one named by the first argument.
RELEASE="${1:-}"
if [[ -z "$RELEASE" ]]; then
  for candidate in "$DESKTOP"/src-tauri/target/*/release "$DESKTOP/src-tauri/target/release"; do
    [[ -d "$candidate/bundle/macos/Gavia.app" ]] && RELEASE="$candidate"
  done
fi
APP="$RELEASE/bundle/macos/Gavia.app"
OUT_DIR="$RELEASE/bundle/dmg"

if [[ -z "$RELEASE" || ! -d "$APP" ]]; then
  echo "no Gavia.app found under src-tauri/target — run 'npm run app:build' first" >&2
  exit 1
fi

# The signature is the whole reason this script exists as a checkpoint. A
# bundle with only the linker's ad-hoc signature on the main executable — no
# resource seal, Info.plist unbound — launches fine and then aborts the moment
# anything asks AppKit for an out-of-process panel, because the open/save panel
# service refuses to start for it. Catch that here, not after installing.
echo "verifying the app signature"
if ! codesign --verify --deep --strict "$APP" 2>&1; then
  echo "app bundle signature is not valid — check bundle.macOS.signingIdentity" >&2
  exit 1
fi

VERSION="$(/usr/bin/python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" \
  "$DESKTOP/src-tauri/tauri.conf.json")"
# Named for the architecture of the binary, not of the machine building it.
case "$(lipo -archs "$APP/Contents/MacOS/gavia" 2>/dev/null || uname -m)" in
  arm64) ARCH=aarch64 ;;
  x86_64) ARCH=x64 ;;
  *) ARCH=universal ;;
esac
DMG="$OUT_DIR/Gavia_${VERSION}_${ARCH}.dmg"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -R "$APP" "$STAGE/"
# What the user drags onto. Standard install gesture, no Finder scripting.
ln -s /Applications "$STAGE/Applications"
# The window: a background at 1x and 2x in one TIFF, and the layout.
INSTALLER="$DESKTOP/src-tauri/installer"
tiffutil -cathidpicheck "$INSTALLER/dmg-background.png" "$INSTALLER/dmg-background@2x.png" \
  -out "$STAGE/.background.tiff"
cp "$INSTALLER/dmg-DS_Store" "$STAGE/.DS_Store"

mkdir -p "$OUT_DIR"
rm -f "$DMG"
echo "building $DMG"
hdiutil create \
  -volname "Gavia" \
  -srcfolder "$STAGE" \
  -format UDZO \
  -fs HFS+ \
  -quiet \
  "$DMG"

hdiutil verify -quiet "$DMG"
echo "built $(du -h "$DMG" | cut -f1) $DMG"
