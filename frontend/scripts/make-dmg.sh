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
# it, so there is no race to lose. The cost is the decorated background window;
# the Applications symlink below is what that window was for.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/frontend/src-tauri/target/release/bundle/macos/Gavia.app"
OUT_DIR="$ROOT/frontend/src-tauri/target/release/bundle/dmg"

if [[ ! -d "$APP" ]]; then
  echo "no app bundle at $APP — run 'npm run tauri:build' first" >&2
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
  "$ROOT/frontend/src-tauri/tauri.conf.json")"
case "$(uname -m)" in
  arm64) ARCH=aarch64 ;;
  x86_64) ARCH=x64 ;;
  *) ARCH="$(uname -m)" ;;
esac
DMG="$OUT_DIR/Gavia_${VERSION}_${ARCH}.dmg"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -R "$APP" "$STAGE/"
# What the user drags onto. Standard install gesture, no Finder scripting.
ln -s /Applications "$STAGE/Applications"

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
