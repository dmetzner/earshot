#!/bin/bash
# Rebuild the standalone /Applications/Earshot.app from source.
# Login sessions live in ~/Library/Application Support/earshot — untouched by this.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="/Applications/Earshot.app"
APP="$DEST/Contents/Resources/app"
MARKER="$DEST/Contents/Resources/.electron-version"

pkill -9 -f "Earshot.app/Contents/MacOS/Electron" 2>/dev/null || true
sleep 1

# Copy the Electron runtime on first build, or whenever its version changed
# (a dep bump must actually land in the bundle, not just in node_modules).
SRC_VER="$(node -e "console.log(require('$SRC/node_modules/electron/package.json').version)")"
if [ ! -d "$DEST" ] || [ "$(cat "$MARKER" 2>/dev/null)" != "$SRC_VER" ]; then
  echo "Installing Electron runtime $SRC_VER…"
  rm -rf "$DEST"
  cp -R "$SRC/node_modules/electron/dist/Electron.app" "$DEST"
  PL="$DEST/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Earshot" "$PL"
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Earshot" "$PL" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier uk.metzner.earshot" "$PL"
  printf '%s' "$SRC_VER" >"$MARKER"
fi

# Sync app code (everything but node_modules + the build artifacts).
mkdir -p "$APP"
for f in main.js preload.js service-preload.js sidebar.html package.json \
         settings.html settings-preload.js; do
  cp "$SRC/$f" "$APP/$f"
done

codesign --force --deep --sign - "$DEST" >/dev/null 2>&1
echo "Built $DEST (Electron $SRC_VER)"
open "$DEST"
echo "Launched."
