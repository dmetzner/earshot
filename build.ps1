# Rebuild the standalone Earshot install from source. The Windows twin of build.sh.
# Login sessions live in %APPDATA%\earshot and are untouched by this — the packaged app
# and a `npm start` dev run resolve the same userData directory, because Electron derives
# it from package.json's `name` and both copies carry the same one.
$ErrorActionPreference = 'Stop'

$src    = $PSScriptRoot
$dest   = Join-Path $env:LOCALAPPDATA 'Programs\Earshot'
$app    = Join-Path $dest 'resources\app'
$marker = Join-Path $dest '.electron-version'

Get-Process -Name 'Earshot' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# Copy the Electron runtime on first build, or whenever its version changed (a dep bump
# must actually land in the install, not just in node_modules) — build.sh's rule.
$srcVer = (Get-Content (Join-Path $src 'node_modules\electron\package.json') -Raw |
  ConvertFrom-Json).version
$have = if (Test-Path $marker) { (Get-Content $marker -Raw).Trim() } else { '' }
if (-not (Test-Path $dest) -or $have -ne $srcVer) {
  Write-Host "Installing Electron runtime $srcVer..."
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
  Copy-Item -Recurse (Join-Path $src 'node_modules\electron\dist') $dest
  # The BASENAME of the exe is what makes this a packaged app rather than a dev run:
  # app.isPackaged is `basename(execPath) != electron.exe`, and that flag is what gates
  # the login item and the protocol registration. It is also the name in Task Manager.
  Rename-Item (Join-Path $dest 'electron.exe') 'Earshot.exe'
  Set-Content -Path $marker -Value $srcVer -NoNewline -Encoding utf8
}

# Sync app code (everything but node_modules and the build artifacts) — same list as
# build.sh, and it has to stay the same list.
New-Item -ItemType Directory -Force $app | Out-Null
foreach ($f in 'main.js', 'preload.js', 'service-preload.js', 'sidebar.html',
                'package.json', 'settings.html', 'settings-preload.js') {
  Copy-Item (Join-Path $src $f) (Join-Path $app $f) -Force
}

# No signing step, and that is not an oversight: build.sh's `codesign --sign -` is an
# ad-hoc signature, whose Windows equivalent would need a real Authenticode certificate.
# An unsigned local build is judged by SmartScreen on reputation it will never earn, so
# the first launch may need "More info -> Run anyway". Nothing here is distributed.
Write-Host "Built $dest (Electron $srcVer)"
Start-Process (Join-Path $dest 'Earshot.exe')
Write-Host 'Launched.'
