#!/bin/bash
# Build /Applications/Earshot.app from source with PyInstaller, then launch it.
# Logins live in ~/Library/Application Support/earshot/webengine — untouched by this.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="/Applications/Earshot.app"
cd "$SRC"

uv sync --frozen
rm -rf build dist
uv run pyinstaller --noconfirm --windowed --name Earshot \
  --osx-bundle-identifier uk.metzner.earshot earshot.py

# Menubar-only (no Dock icon), and the owner of earshot:// links.
PL="dist/Earshot.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PL"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" \
  -c "Add :CFBundleURLTypes:0 dict" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLName string uk.metzner.earshot" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string earshot" "$PL"
codesign --force --deep --sign - dist/Earshot.app

# Stop the running copy and refuse to continue if it will not go: `open` on a live
# process activates the old build instead of launching the new one.
for _ in $(seq 100); do
  pgrep -f "Earshot.app/Contents/MacOS/" >/dev/null || break
  pkill -9 -f "Earshot.app/Contents/MacOS/" || true
  sleep 0.1
done
if pgrep -f "Earshot.app/Contents/MacOS/" >/dev/null; then
  echo "Earshot is still running after 10s; close it and re-run. $DEST is untouched." >&2
  exit 1
fi
rm -rf "$DEST"
mv dist/Earshot.app "$DEST"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST"
open "$DEST"
echo "Built and launched $DEST"
