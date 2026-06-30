#!/bin/bash
# Rebuild the standalone /Applications/Earshot.app from source.
# Login sessions live in ~/Library/Application Support/earshot — untouched by this.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="/Applications/Earshot.app"
APP="$DEST/Contents/Resources/app"

pkill -9 -f "Earshot.app/Contents/MacOS/Electron" 2>/dev/null || true
sleep 1

# First build (or after delete): copy the full Electron runtime in.
if [ ! -d "$DEST" ]; then
  echo "Creating bundle from Electron runtime…"
  cp -R "$SRC/node_modules/electron/dist/Electron.app" "$DEST"
  PL="$DEST/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Earshot" "$PL"
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Earshot" "$PL" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier uk.metzner.earshot" "$PL"
fi

# Sync app code (everything but node_modules + the build artifacts).
mkdir -p "$APP"
for f in main.js preload.js service-preload.js sidebar.html package.json \
         settings.html settings-preload.js; do
  cp "$SRC/$f" "$APP/$f"
done

codesign --force --deep --sign - "$DEST" >/dev/null 2>&1
echo "Built $DEST"
open "$DEST"
echo "Launched."
