# Earshot

Electron menubar/tray hub for web chats, macOS and Windows 11. What it does, configuration and
the code layout: [`README.md`](README.md).

## The gate

```bash
npm ci && npx biome ci . && npm test && shellcheck build.sh
```

This is what CI runs. CI also parses `build.ps1` with Windows PowerShell 5.1 — see Gotchas.

## Invariants

- **This repo is PUBLIC.** No secrets, private addresses, employer material or personal data in
  code, fixtures, commits or docs.
- **Do not run `./build.sh` / `build.ps1` unless asked.** They `pkill` the running Earshot and
  replace the installed app (`/Applications/Earshot.app`, `%LOCALAPPDATA%\Programs\Earshot`).
- **`npm ci`, never `npm install`.** The build refuses when `node_modules` holds a different
  Electron from the lockfile's.
- **`nav.js` imports nothing from Electron**, so `node --test` covers the navigation policy
  directly. No new runtime dependency for it.

## Gotchas

- **`build.ps1` must parse in Windows PowerShell 5.1, not pwsh 7**: no ternary, no `??`, no `&&`
  pipeline chains. `npm run build:win` runs `powershell.exe`.

## More

- [`docs/windows-perf-audit.md`](docs/windows-perf-audit.md) — Windows memory/CPU audit and the
  ranked improvements still open.
