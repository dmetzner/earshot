#!/bin/bash
# Rebuild the standalone /Applications/Earshot.app from source.
# Login sessions live in ~/Library/Application Support/earshot — untouched by this.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="/Applications/Earshot.app"
APP="$DEST/Contents/Resources/app"
MARKER="$DEST/Contents/Resources/.electron-version"

# Copy the Electron runtime on first build, or whenever its version changed
# (a dep bump must actually land in the bundle, not just in node_modules).
# Everything below reconciles against the INSTALLED electron, because that is what actually
# gets copied. Repairing node_modules is npm's job and not a build script's — but a
# node_modules left behind by a `git pull` over a dependency bump is the ordinary way this
# drifts, and it is the one skew every guard here would otherwise pass while installing a
# runtime the repo does not declare. So compare, and refuse. A lockfile that cannot be read
# is not an error: this check exists to catch drift, not to require a lockfile.
if [ ! -f "$SRC/node_modules/electron/package.json" ]; then
  echo "No node_modules/electron here — run 'npm ci' first." >&2
  exit 1
fi
SRC_VER="$(node -e "process.stdout.write(require(process.argv[1]).version)"   "$SRC/node_modules/electron/package.json")"
# The path as an ARGUMENT, not interpolated into the script text, so nothing in it is parsed
# as JS. build.ps1 reads it the same way and for a sharper reason -- see the note there.
LOCK_VER="$(node -e "try{process.stdout.write(require(process.argv[1]).packages['node_modules/electron'].version)}catch{}" "$SRC/package-lock.json" 2>/dev/null)"
# Present but unreadable is not the same as absent — see build.ps1 for why that distinction
# is worth a line. A warning, not a refusal.
if [ -f "$SRC/package-lock.json" ] && [ -z "$LOCK_VER" ]; then
  echo "warning: could not read the electron pin from package-lock.json — drift check skipped." >&2
fi
if [ -n "$LOCK_VER" ] && [ "$LOCK_VER" != "$SRC_VER" ]; then
  echo "node_modules has Electron $SRC_VER; the lockfile pins $LOCK_VER." >&2
  echo "Run 'npm ci' first — building now would install a runtime this repo does not declare." >&2
  exit 1
fi
# The Electron package ships no postinstall script (electron 44.2.0), so `npm install` puts
# its JS in node_modules and never fetches the runtime at all — running
# `node install.js` is the supported way to get dist/, not a workaround. Check BEFORE the
# branch below, which starts by deleting the existing bundle: discovering the runtime is
# missing after that point leaves no app at all. That has happened twice.
DIST="$SRC/node_modules/electron/dist"
RUNTIME="$DIST/Electron.app"
RUNTIME_BIN="$RUNTIME/Contents/MacOS/Electron"
VER_FILE="$DIST/version"
PATH_TXT="$SRC/node_modules/electron/path.txt"
# The explicit -f, not `2>/dev/null`: redirections are applied left to right, so a failing
# open of $VER_FILE is reported BEFORE the 2> takes effect and the error reaches the real
# stderr anyway. The empty answer was also only accidental — the pipeline exits on sed's
# status, so adding `set -o pipefail` one day would turn this into an abort at exactly the
# moment it is supposed to trigger a repair.
dist_ver() { [ -f "$VER_FILE" ] || return 0; tr -d '[:space:]' <"$VER_FILE" | sed -e 's/^v//'; }
# Electron's own isInstalled(), all three of its questions: dist/version, path.txt, and the
# binary. Asked in ONE place because it is asked twice — before the repair and after it — and
# a predicate maintained in two copies is one silent edit away from a guard that no longer
# guards. -x rather than isInstalled()'s existsSync is deliberate and is the one place this is
# stricter: a binary that lost its execute bit (rsync without -p, an exFAT round-trip) passes
# upstream's check and cannot actually run.
runtime_ok() {
  [ -x "$RUNTIME_BIN" ] &&
  [ "$(dist_ver)" = "$SRC_VER" ] &&
  [ "$(cat "$PATH_TXT" 2>/dev/null)" = "Electron.app/Contents/MacOS/Electron" ]
}
repaired=0
if ! runtime_ok; then
  echo "Electron runtime missing or stale; running its installer…"
  # Clear dist BEFORE the installer, for two reasons. It makes isInstalled() false, so the
  # repair cannot be a no-op — install.js exits 0 without extracting anything when it
  # believes the runtime is present, and it can believe that while this script disagrees:
  # the execute-bit case above is exactly that, and the user would then be told to re-run a
  # command that keeps exiting 0. And install.js extracts the zip straight into dist without
  # emptying it first, so on the present-but-stale path — the one the comment above calls
  # motivating — the new version would unpack ON TOP of the old: same-named entries
  # replaced, entries the old version had and the new one does not left behind. The guard
  # would then pass on a tree that is two Electron versions at once, which is the corruption
  # this is supposed to catch.
  #
  # Moved aside rather than deleted, and put back below if the repair cannot finish. index.js
  # does re-run install.js by itself when the binary it names is missing — but that needs the
  # network, and the developer most likely to be here is the one whose download just failed.
  # Deleting would leave them with no runtime at all where they had a stale but runnable one.
  # path.txt lives OUTSIDE dist and is untouched either way.
  #
  # Cost is a re-extract when the Electron cache already holds this version's zip, and a
  # download when it does not. The cache is keyed by version, and nothing fills it on a
  # fresh clone (no install script), so a first build here always fetches a few hundred MB.
  # Refuse if one is already there; do not delete it. A dist.old surviving from an earlier
  # run is the developer's ONLY runnable Electron whenever that run's restore failed — this
  # script says exactly that when it happens — and deleting it here would take the fallback
  # away right before a repair that may fail the same way, leaving nothing at all. It is also
  # what makes the move fail, since mv cannot merge onto an existing directory.
  if [ -e "$DIST.old" ]; then
    echo "A previous Electron runtime is at $DIST.old. Remove it by hand if you no longer" >&2
    echo "need it, then re-run." >&2
    exit 1
  fi
  # The move has to be AUTHORITATIVE, not best-effort. The failure path below deletes $DIST
  # and puts the saved copy back — so if the move quietly failed while $DIST was still there,
  # that path would delete the developer's runtime and have nothing to restore, which is the
  # precise harm this whole move-aside exists to prevent. Refuse instead, having changed
  # nothing.
  moved_aside=0
  if [ -d "$DIST" ]; then
    if mv "$DIST" "$DIST.old"; then
      moved_aside=1
    else
      echo "Could not move $DIST aside — is something using it?" >&2
      exit 1
    fi
  fi
  # `|| true` because of `set -e` above: the installer's own non-zero exit would kill the
  # script HERE, on a stack trace from @electron/get, and the line telling Daniel what to do
  # would never print. The re-check below is what decides, so it can own the exit code.
  node "$SRC/node_modules/electron/install.js" || true
  if ! runtime_ok; then
    # The guidance FIRST. Restoring is several commands that can each fail, and under `set -e`
    # a failure in any of them would exit before these lines ever printed — the same trap the
    # `|| true` above exists for.
    # Not "run npm install": this script has just established that npm install does not
    # extract anything, so that is the one instruction guaranteed to change nothing. And an
    # absolute path, because $SRC exists so this script can be run from anywhere.
    # The retry is THIS SCRIPT, not a bare `node install.js`. Restoring the old tree below can
    # put back a dist that upstream's isInstalled() is perfectly happy with while this script
    # is not — the execute-bit case at the top of the guard is exactly that: version and
    # path.txt correct, existsSync true, only -x false. The installer against that tree exits
    # 0 having done nothing, so anyone following such a line would see success and then the
    # identical failure next build. Re-running here moves dist aside first, so the installer
    # always starts from nothing, and the restored runtime is kept rather than deleted.
    echo "Electron's installer could not produce a $SRC_VER runtime at $RUNTIME." >&2
    echo "Read its output above, then re-run: $SRC/$(basename "$0")" >&2
    # Then put back what we took, so a failed repair leaves the tree no worse than found. Only
    # if we actually took it, and only onto a cleared path: mv cannot merge a directory onto
    # an existing one, so a $DIST that refuses to delete would leave both a partial dist and
    # an orphan dist.old. Say so rather than leaving it to be discovered.
    if [ "$moved_aside" = 1 ]; then
      rm -rf "$DIST" || true
      if [ -d "$DIST" ] || ! mv "$DIST.old" "$DIST"; then
        echo "Also: could not restore $DIST — the previous runtime is at $DIST.old." >&2
      fi
    fi
    exit 1
  fi
  # `|| true`: this runs after a repair that WORKED, and `set -e` would turn a failure to
  # tidy up into an abort of it. An orphan is worth a warning, not a lost build.
  rm -rf "$DIST.old" || true
  if [ -e "$DIST.old" ]; then
    echo "warning: could not remove $DIST.old — a full Electron runtime is left there." >&2
  fi
  repaired=1
fi

# Only now: the kill exists to unlock files for the copy below, and until the guard has
# passed there is nothing to copy. Above it, a build that ended in the exit above had
# already stopped a running Earshot for nothing.
# Kill repeatedly and then CHECK, as the Windows twin does. `rm -rf` of a running bundle is
# fine on POSIX, so this is not build.ps1's half-deleted-install problem — it is the `open
# "$DEST"` at the foot: a process that outlives the wait gets ACTIVATED rather than launched,
# and the script then says "Launched." over the previous build. Polling alone would not stop
# that; only refusing does.
for _ in $(seq 100); do
  pgrep -f "Earshot.app/Contents/MacOS/Electron" >/dev/null 2>&1 || break
  pkill -9 -f "Earshot.app/Contents/MacOS/Electron" 2>/dev/null || true
  sleep 0.1
done
if pgrep -f "Earshot.app/Contents/MacOS/Electron" >/dev/null 2>&1; then
  echo "Earshot is still running after 10s of being asked to stop." >&2
  echo "Close it and re-run; your bundle has not been modified." >&2
  exit 1
fi

# The guard above proves node_modules is right and says nothing about the bundle already
# installed. Three ways that goes wrong, all ending in a build that reports success:
#   * $DEST's binary is gone (deleted, quarantined) while the marker still matches, so the
#     copy is skipped and the app cannot launch. -x answers that.
#   * the runtime just changed under us, so the bundle cannot be trusted to predate it.
#     `repaired` answers that.
#   * $DEST was filled with a STALE runtime by an older build, which recorded SRC_VER against
#     it anyway. Once node_modules is repaired the marker agrees and the copy is skipped
#     forever — the same never-healing shape as a stale dist, one level up.
# Two answers to the third. `cp -R` of Electron.app cannot carry dist/version inside the
# bundle, so this script copies that file in itself after the copy below — which is the same
# ONGOING check build.ps1 gets for free from $dest\version, and needs no guess at an
# Info.plist key. And the marker carries a format tag, which is the ONE-SHOT half: every
# marker an older script wrote is a bare version string, so bumping the tag makes each of
# them mismatch exactly once, forcing the single reinstall that heals a bundle predating all
# of this. Bump it again if that is ever needed twice.
# CFBundleExecutable is never rewritten, so the binary inside keeps Electron's own name —
# the pkill above matches on exactly that path.
DEST_BIN="$DEST/Contents/MacOS/Electron"
DEST_VER="$DEST/Contents/Resources/.electron-dist-version"
dest_ver() { [ -f "$DEST_VER" ] || return 0; tr -d '[:space:]' <"$DEST_VER" | sed -e 's/^v//'; }
MARKER_WANT="v2 $SRC_VER"
if [ "$repaired" = 1 ] || [ ! -x "$DEST_BIN" ] ||
   [ "$(dest_ver)" != "$SRC_VER" ] ||
   [ "$(cat "$MARKER" 2>/dev/null)" != "$MARKER_WANT" ]; then
  echo "Installing Electron runtime $SRC_VER…"
  rm -rf "$DEST"
  cp -R "$RUNTIME" "$DEST"
  # The version of what was actually copied, read back on every later run. dist/version sits
  # BESIDE Electron.app rather than inside it, so it has to be placed here deliberately.
  cp "$VER_FILE" "$DEST_VER"
  PL="$DEST/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Earshot" "$PL"
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Earshot" "$PL" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier uk.metzner.earshot" "$PL"
  printf '%s' "$MARKER_WANT" >"$MARKER"
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
