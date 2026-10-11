# Build %LOCALAPPDATA%\Programs\Earshot from source with PyInstaller, then launch it.
# Logins live in %APPDATA%\earshot\webengine -- untouched by this. The app registers its
# own login item and earshot:// handler on first start.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$dest = Join-Path $env:LOCALAPPDATA 'Programs\Earshot'

uv sync --frozen
if ($LASTEXITCODE) { throw 'uv sync failed' }
Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue
uv run pyinstaller --noconfirm --windowed --name Earshot earshot.py
if ($LASTEXITCODE) { throw 'pyinstaller failed' }

# A running Earshot.exe holds its files open; replacing a half-deleted install is worse
# than refusing.
Get-Process Earshot -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
if (Get-Process Earshot -ErrorAction SilentlyContinue) {
  throw "Earshot is still running; close it and re-run. $dest is untouched."
}
Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
Move-Item -LiteralPath (Join-Path $PSScriptRoot 'dist\Earshot') -Destination $dest
Start-Process (Join-Path $dest 'Earshot.exe')
"Built and launched $dest"
