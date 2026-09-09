# Rebuild the standalone Earshot install from source. The Windows twin of build.sh.
# Login sessions live in %APPDATA%\earshot and are untouched by this — the packaged app
# and a `npm start` dev run resolve the same userData directory, because Electron derives
# it from package.json's `name` and both copies carry the same one.
$ErrorActionPreference = 'Stop'

$src    = $PSScriptRoot
$dest   = Join-Path $env:LOCALAPPDATA 'Programs\Earshot'
$app    = Join-Path $dest 'resources\app'
$marker = Join-Path $dest '.electron-version'

# Copy the Electron runtime on first build, or whenever its version changed (a dep bump
# must actually land in the install, not just in node_modules) — build.sh's rule.
# Everything below reconciles against the INSTALLED electron, because that is what actually
# gets copied. Repairing node_modules is npm's job and not a build script's -- but a
# node_modules left behind by a `git pull` over a dependency bump is the ordinary way this
# drifts, and it is the one skew every guard here would otherwise pass while installing a
# runtime the repo does not declare. So compare, and refuse. A lockfile that cannot be read
# is not an error: this check exists to catch drift, not to require a lockfile.
$electronPkg = Join-Path $src 'node_modules\electron\package.json'
# The likeliest failure of all -- a fresh clone -- named, rather than left as a raw
# "cannot find path" from Get-Content under `Stop`. Every other refusal in this file says
# what to run; this is the one that says it most often.
if (-not (Test-Path -LiteralPath $electronPkg)) {
  throw "No node_modules\electron here -- run 'npm ci' first."
}
$srcVer = (Get-Content -LiteralPath $electronPkg -Raw | ConvertFrom-Json).version
$lockPath = Join-Path $src 'package-lock.json'
# Through node, NOT ConvertFrom-Json: Windows PowerShell 5.1 refuses to parse a
# package-lock.json at all. Its `packages` map has a "" key for the root package, and 5.1
# turns JSON keys into PSObject property names, where the empty string is not a legal one --
# it fails with "the value of the argument name is invalid". A try/catch around that swallows
# the failure into an empty $lockVer and a check that silently never fires, which is how this
# was first written and how it was caught. build.sh reads the same version out of the same
# file, though without this try/catch -- there a missing node is the shell's own
# "command not found", which says enough on its own.
#
# The path goes in as an ARGUMENT rather than interpolated into the script text, so nothing
# in it is ever parsed as JS -- a Windows path is full of backslashes, which is an escape
# character on both sides of that boundary.
# Under `Continue`, for the NativeCommandError reason spelled out at the installer call
# below: with stderr redirected -- every `npm run build:win` -- one warning line from node
# would otherwise abort the build HERE, under `Stop`, with an opaque PowerShell error rather
# than either the drift message or the repair. try/catch names node when it is not on PATH,
# which this script now requires and the original did not.
$ErrorActionPreference = 'Continue'
try {
  $lockVer = & node -e "try{process.stdout.write(require(process.argv[1]).packages['node_modules/electron'].version)}catch{}" $lockPath
} catch {
  throw "Could not run node to read the lockfile -- is it on PATH? $_"
}
$ErrorActionPreference = 'Stop'
if ((Test-Path -LiteralPath $lockPath) -and -not $lockVer) {
  # Present but unreadable is not the same as absent. This guard exists to catch a bump that
  # dependabot merged unattended, so it going quiet -- a lockfileVersion change, electron
  # ceasing to be a top-level entry -- is the worst way for it to fail. Say so; do not refuse,
  # because the shape of someone else's file is not a reason to block a build.
  Write-Warning "could not read the electron pin from $lockPath -- drift check skipped."
}
if ($lockVer -and $lockVer -ne $srcVer) {
  throw ("node_modules has Electron $srcVer; the lockfile pins $lockVer. Run 'npm ci' first " +
         '-- building now would install a runtime this repo does not declare.')
}
# The Electron package ships no postinstall script (electron 44.2.0), so `npm install` puts
# its JS in node_modules\electron and never fetches the runtime at all —
# running `node install.js` is the supported way to get dist\, not a workaround. Check BEFORE
# the branch below, which starts by deleting the existing install: discovering the runtime is
# missing after that point leaves no app at all.
#
# The question is Electron's own isInstalled(): dist/version, not merely a dist that exists.
# See build.sh for why present-but-stale is the case that would otherwise install an old
# runtime and record the new version against it.
$dist    = Join-Path $src 'node_modules\electron\dist'
$runtime = Join-Path $dist 'electron.exe'
$verFile = Join-Path $dist 'version'
$pathTxt = Join-Path $src 'node_modules\electron\path.txt'
# Two helpers, not one: $verOf's `-replace '^v'` has no business running over path.txt, whose
# content is a platform path and not a version. Harmless for today's value, and it would
# silently mangle any path.txt beginning with a v. build.sh keeps them separate too — a bare
# `cat` there, a `sed` only in dist_ver.
# "$(...)" and not .Trim() directly: Get-Content -Raw on a ZERO-BYTE file returns $null, and
# $null.Trim() is a terminating error under `Stop` — an interrupted extraction that created a
# version file without writing it would abort the script instead of triggering the repair.
# Interpolating $null gives '', which mismatches $srcVer and repairs, as build.sh does.
# The try/catch is for Windows' mandatory locking, which POSIX does not have: a file another
# process holds with FileShare.None cannot even be READ, and Get-Content under `Stop` would
# abort the build with its own error instead of reaching the guard. For the guard's purposes
# a file that cannot be read is a file that does not say what it should -- treat it as absent,
# repair, and let the move-aside below produce the message that actually names the problem.
$textOf = { param($f) if (Test-Path -LiteralPath $f) { try { "$(Get-Content -LiteralPath $f -Raw)".Trim() } catch { '' } } else { '' } }
# `-replace '^v'` and not TrimStart('v'), which strips a RUN of them: one, like build.sh's sed.
$verOf  = { param($f) (& $textOf $f) -replace '^v', '' }
# Electron's own isInstalled(), all three of its questions: dist\version, path.txt, and the
# binary. Asked in ONE place because it is asked twice — before the repair and after it — and
# a predicate maintained in two copies is one silent edit away from a guard that no longer
# guards. path.txt is written LAST, so an extraction that unzipped and then died leaves the
# other two right and only this one wrong -- and `npm install` will not notice, because this
# package has no install script for it to run.
$runtimeOk = {
  (Test-Path -LiteralPath $runtime) -and
  (& $verOf $verFile) -eq $srcVer -and
  (& $textOf $pathTxt) -eq 'electron.exe'
}
$repaired = $false
if (-not (& $runtimeOk)) {
  Write-Host 'Electron runtime missing or stale; running its installer...'
  # Clear dist BEFORE the installer. The reason is not the one build.sh has -- there, -x is
  # genuinely stricter than upstream's existsSync, so install.js can believe the runtime is
  # present while the script disagrees and the repair becomes a no-op. The three questions
  # here match isInstalled()'s, and the differences (a trimmed path.txt, and PowerShell's
  # case-insensitive -eq and -replace) are all LOOSER -- which is only true because every
  # path here goes through -LiteralPath. The -Path parameters these cmdlets default to treat
  # [ and ] as a character class, so a checkout under a directory containing one would make
  # Test-Path answer false for a file that exists: STRICTER than upstream's existsSync, and
  # unrepairable, since the installer would keep succeeding while the guard kept failing.
  # -Destination and -NewName have no literal counterpart, so this file is not uniformly
  # bracket-proof — but those are only reached during a repair, where the failure is the
  # designed refusal ("could not move dist aside") rather than a guard that lies. So
  # that cannot happen on Windows. What does: install.js extracts the zip straight into dist
  # without emptying it first, so on the
  # present-but-stale path -- the one both comments above call motivating -- the new version
  # would unpack ON TOP of the old: same-named entries replaced, entries the old version had
  # and the new one does not left behind. The guard would then pass on a tree that is two
  # Electron versions at once, which is the corruption this is supposed to catch.
  #
  # Moved aside rather than deleted, and put back below if the repair cannot finish. index.js
  # does re-run install.js by itself when the binary it names is missing -- but that needs the
  # network, and the developer most likely to be here is the one whose download just failed.
  # Deleting would leave them with no runtime at all where they had a stale but runnable one.
  # path.txt lives OUTSIDE dist and is untouched either way.
  #
  # Cost is a re-extract when the Electron cache already holds this version's zip, and a
  # download when it does not. The cache is keyed by version, and nothing fills it on a
  # fresh clone (no install script), so a first build here always fetches a few hundred MB.
  $distOld = "$dist.old"
  # Refuse if one is already there; do not delete it. A dist.old surviving from an earlier
  # run is the developer's ONLY runnable Electron whenever that run's restore failed -- this
  # script says exactly that when it happens -- and deleting it here would take the fallback
  # away right before a repair that may fail the same way, leaving nothing at all. It is also
  # what makes Move-Item fail (-Force cannot merge onto an existing directory), and it would
  # confuse the undo below, which cannot tell someone else's leftover from the half-move this
  # run just made.
  if (Test-Path -LiteralPath $distOld) {
    throw ("A previous Electron runtime is at $distOld. Remove it by hand if you no longer " +
           'need it, then re-run.')
  }
  # The move has to be AUTHORITATIVE, not best-effort. The failure path below deletes $dist
  # and puts the saved copy back -- so if the move quietly failed while $dist was still there,
  # that path would delete the developer's runtime and have nothing to restore, which is the
  # precise harm this whole move-aside exists to prevent. A concurrent `npm start` holding
  # electron.exe is enough to make Move-Item fail with a sharing violation, and the kill loop
  # further down only matches Earshot. Refuse instead, having changed nothing.
  $movedAside = $false
  if (Test-Path -LiteralPath $dist) {
    try { Move-Item -LiteralPath $dist -Destination $distOld -Force -ErrorAction Stop; $movedAside = $true }
    catch {
      # A failed Move-Item is not necessarily a no-op. What was actually observed here, with
      # a locked file under dist: the move COMPLETED -- dist gone, dist.old holding the
      # contents -- and threw anyway. A genuine half-move is a further possibility rather
      # than a measured one, since dist and dist.old are siblings on one volume where a
      # directory rename either happens or does not. Both are handled below, and the
      # ambiguous one by refusing to guess.
      $note = ''
      if ((Test-Path -LiteralPath $dist) -and (Test-Path -LiteralPath $distOld)) {
        # Both present. $distOld was proven absent a few lines up, so the move did SOMETHING
        # -- but there is no way to tell "the copy finished and the source delete did not"
        # from "the copy died part way and the source is intact", and the two want opposite
        # repairs. Touch neither; name both and let a person look.
        $note = " Both $dist and $distOld now exist and it is not possible to tell which is " +
                'complete -- inspect them before re-running.'
      } elseif (Test-Path -LiteralPath $distOld) {
        Move-Item -LiteralPath $distOld -Destination $dist -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $distOld) { $note = " Your previous runtime is at $distOld." }
      }
      throw "Could not move $dist aside -- is something using it? $_$note"
    }
  }
  # Not under `Stop`: in Windows PowerShell a native command whose stderr is REDIRECTED --
  # which is every `npm run build:win`, since npm pipes child stdio -- has each stderr line
  # wrapped in a NativeCommandError, and `Stop` makes that terminating. One download-progress
  # or deprecation line would then abort a repair that actually worked. The re-check below is
  # what decides, so a genuine failure still ends in the throw.
  $ErrorActionPreference = 'Continue'
  # try/catch for the same reason the lockfile read has one: `Continue` does not soften a
  # CommandNotFoundException, so a missing node would die on a raw PowerShell message rather
  # than the named one. Narrow -- the lockfile read proved node runs moments ago -- but the
  # two call sites have no reason to differ.
  try { & node (Join-Path $src 'node_modules\electron\install.js') }
  catch { Write-Warning "could not run node to repair the runtime: $_" }
  $ErrorActionPreference = 'Stop'
  if (-not (& $runtimeOk)) {
    # Put back what we took, so a failed repair leaves the tree no worse than found. Only if
    # we actually took it, and only onto a cleared path: Move-Item cannot merge a directory
    # onto an existing one, so a $dist that refuses to delete would leave both a partial dist
    # and an orphan dist.old. Say where it went rather than leaving it to be discovered.
    $restoreNote = ''
    if ($movedAside) {
      Remove-Item -LiteralPath $dist -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $dist) {
        $restoreNote = " Could not restore $dist -- it is now a PARTIAL tree. Your previous " +
                       "runtime is intact at ${distOld} -- delete $dist and rename it back."
      }
      else {
        Move-Item -LiteralPath $distOld -Destination $dist -Force -ErrorAction SilentlyContinue
        # Checked, not assumed. The restore runs under SilentlyContinue and can fail for the
        # same held-handle reason everything else here can, and an unchecked failure leaves
        # the developer with no dist and no idea a full runtime is sitting beside it.
        # build.sh has always said this; the twin was silent.
        if (Test-Path -LiteralPath $distOld) { $restoreNote = " The previous runtime is at $distOld." }
      }
    }
    # Not "run npm install": this script has just established that npm install does not
    # extract anything, so that is the one instruction guaranteed to change nothing. And an
    # absolute path, because $src exists so this script can be run from anywhere.
    # The retry is THIS SCRIPT, not a bare install.js. Running the installer against the tree
    # just restored can be a no-op -- upstream may consider it installed where this guard does
    # not -- whereas re-running here moves dist aside first, so the installer always starts
    # from nothing. It also preserves the restored runtime, which telling anyone to delete
    # dist would throw away.
    throw ("Electron's installer could not produce a $srcVer runtime at $runtime. Read its " +
           "output above, then re-run: powershell -File '$PSCommandPath'" + $restoreNote)
  }
  Remove-Item -LiteralPath $distOld -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $distOld) {
    Write-Warning "could not remove $distOld -- a full Electron runtime is left there."
  }
  $repaired = $true
}

# Only now: the kill exists to unlock files for the copy below, and until the guard has
# passed there is nothing to copy. Above it, a build that ended in the throw above had
# already stopped a running Earshot for nothing.
# Kill REPEATEDLY, not once, and wait for them to actually go. Stop-Process returns when the
# kill is signalled rather than when the process is gone, and Windows keeps the exe locked
# until the last one has really exited -- which is how the Remove-Item below came to fail with
# "access denied" on Earshot.exe and, under `Stop`, abort the build PART WAY THROUGH DELETING
# the install. A settled Earshot dies in 0.1s (measured); one that is still STARTING keeps
# spawning children after the snapshot a single `Get-Process | Stop-Process` took, so a
# poll-only loop watched new processes appear for the full ten seconds. Re-killing each pass
# catches those.
for ($i = 0; $i -lt 100; $i++) {
  $procs = Get-Process -Name 'Earshot' -ErrorAction SilentlyContinue
  if (-not $procs) { break }
  $procs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 100
}
# Refuse HERE, not only where something is about to be deleted. A survivor is not merely a
# problem for the delete: the app-code copy below succeeds regardless (Electron does not hold
# those files open), and then Start-Process hits main.js's single-instance lock, so the OLD
# process just focuses while this script prints "Launched." -- new code on disk, old code
# running, exit 0. Stop-Process failures are silent by design here (an elevated Earshot
# against a non-elevated build refuses all hundred of them), which is exactly how that ends
# up unnoticed. Nothing under $dest has been touched yet, so the refusal is honest.
if (Get-Process -Name 'Earshot' -ErrorAction SilentlyContinue) {
  throw 'Earshot is still running after 10s of being asked to stop. Close it and re-run; your install has not been modified.'
}

# The guard above proves node_modules is right and says nothing about the install already on
# disk. Three ways that goes wrong, all ending in a build that reports success:
#   * $dest's exe is gone (deleted, quarantined -- this build is unsigned, see the note at the
#     foot) while the marker still matches, so the copy is skipped and nothing can launch.
#   * the runtime just changed under us, so the install cannot be trusted to predate it.
#     $repaired answers that.
#   * $dest was filled with a STALE runtime by an older build, which recorded $srcVer against
#     it anyway. Once node_modules is repaired the marker agrees and the copy is skipped
#     forever -- the same never-healing shape as a stale dist, one level up.
# Two answers to the third, and Windows can afford both. Copy-Item -Recurse lands dist's own
# `version` file in $dest, so the real version of what is INSTALLED is on disk and the marker
# need not be taken on trust -- an ONGOING check, which build.sh cannot have because `cp -R`
# of Electron.app cannot carry dist/version inside the bundle. The marker's format tag is the
# ONE-SHOT half and is the only half build.sh has: every marker an older script wrote is a
# bare version string, so bumping the tag makes each of them mismatch exactly once, forcing a
# single reinstall that heals the install. Both scripts carry the same tag; bump it again if
# this ever needs repeating.
$destExe = Join-Path $dest 'Earshot.exe'
$destVer = Join-Path $dest 'version'
$markerWant = "v2 $srcVer"
# "$(...)" for the zero-byte reason documented on $verOf above -- and this line runs AFTER
# Stop-Process, so a null here would kill Earshot and then abort without rebuilding it.
$have = & $textOf $marker
if ($repaired -or -not (Test-Path -LiteralPath $destExe) -or $have -ne $markerWant -or
    (& $verOf $destVer) -ne $srcVer) {
  Write-Host "Installing Electron runtime $srcVer..."
  # Retried, because on Windows a tree that was executing a moment ago is not reliably
  # deletable the instant its processes are gone: the image section is released lazily, and
  # an antivirus or the indexer can hold a freshly written file for a moment longer. Measured
  # here: once in ~25 forced reinstalls even WITH the wait above. A bare Remove-Item under
  # `Stop` turns that into the worst available outcome -- the script aborts PART WAY THROUGH
  # DELETING the install, which is this whole file's one job to avoid. build.sh needs none of
  # this: POSIX unlinks a running binary without complaint.
  # The cap lives in the LOOP CONDITION, not only in the catch. Remove-Item can return
  # without an error while the directory is still there -- a delete-pending entry, which is
  # the same lazily-released handle the comment above is about -- and a cap consulted only on
  # the error path would then spin with no sleep and no exit: a pinned core and a build that
  # never returns and never fails.
  # The wait is driven by the LOOP, not by the catch. Putting it in the catch meant the
  # delete-pending case -- no exception, directory still there, which is the case this whole
  # retry exists for -- span 31 iterations in a few milliseconds and then reported a 6s
  # timeout it never waited out.
  for ($try = 0; $try -lt 31 -and (Test-Path -LiteralPath $dest); $try++) {
    if ($try -gt 0) { Start-Sleep -Milliseconds 200 }
    Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $dest) {
    throw ("Could not delete $dest after 6s of retries." + [Environment]::NewLine +
           'The install is now INCOMPLETE. Close anything using it and re-run this script.')
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $dest) | Out-Null
  Copy-Item -LiteralPath $dist -Destination $dest -Recurse
  # The BASENAME of the exe is what makes this a packaged app rather than a dev run:
  # app.isPackaged is `basename(execPath) != electron.exe`, and that flag is what gates
  # the login item and the protocol registration. It is also the name in Task Manager.
  Rename-Item -LiteralPath (Join-Path $dest 'electron.exe') -NewName 'Earshot.exe'
  Set-Content -LiteralPath $marker -Value $markerWant -NoNewline -Encoding utf8
}

# Sync app code (everything but node_modules and the build artifacts) — same list as
# build.sh, and it has to stay the same list.
New-Item -ItemType Directory -Force -Path $app | Out-Null
foreach ($f in 'main.js', 'preload.js', 'service-preload.js', 'sidebar.html',
                'package.json', 'settings.html', 'settings-preload.js') {
  Copy-Item -LiteralPath (Join-Path $src $f) -Destination (Join-Path $app $f) -Force
}

# No signing step, and that is not an oversight: build.sh's `codesign --sign -` is an
# ad-hoc signature, whose Windows equivalent would need a real Authenticode certificate.
# An unsigned local build is judged by SmartScreen on reputation it will never earn, so
# the first launch may need "More info -> Run anyway". Nothing here is distributed.
Write-Host "Built $dest (Electron $srcVer)"
Start-Process (Join-Path $dest 'Earshot.exe')
Write-Host 'Launched.'
