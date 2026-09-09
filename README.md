# Earshot

[![CI](https://github.com/dmetzner/earshot/actions/workflows/ci.yml/badge.svg)](https://github.com/dmetzner/earshot/actions/workflows/ci.yml)

A **menubar / system-tray hub** for all your web chats — Google Chat, Gmail, Slack, WhatsApp, Discord, or any other web-based messenger. One window, one icon, and an at-a-glance unread indicator that tells you **where** you have messages and **how urgent** they are. macOS and Windows 11.

> Built because WebKit-based wrappers (Unite, Coherence, etc.) can't log into Google — Google blocks embedded webviews. Earshot runs on Electron's bundled Chromium, so logins work exactly like Chrome.

## Why

The point isn't the window — it's the **menubar indicator**. You should always know, without clicking anything, whether you have new messages, in which app, and whether it's worth interrupting your work for.

On **macOS** the indicator is menubar text:

- **`💬`** — all clear
- **`🔴 💬2 ✉5`** — high-priority unread (act now), shown in red with each app's icon + count
- **`🔴 💬2 · 🟢3`** — high-priority plus low-priority (after the `·`, no red — you know, but it's not urgent)

Windows has no menubar text to write into — `tray.setTitle` is a macOS-only API that
silently does nothing there — so the same three facts are **painted into the tray icon**: a
grey disc when all is clear, amber when only low-priority chats are waiting, red when
something is high-priority, with the total drawn over it (`9+` past 99). Which app it is
comes from the tooltip, which lists every service with an unread count.

**One-time step on Windows 11:** new tray icons start life hidden behind the `^` overflow
chevron, and Windows gives an app no way to promote itself out of it. An indicator you
have to click twice to see is not an indicator, so pin it once — *Settings → Personalisation
→ Taskbar → Other system tray icons → Earshot → On*, or just drag it out of the flyout.

## Features

- **Multiple services, isolated sessions** — each service logs in independently (`persist:<id>` partition), so two Gmail accounts (work + private) or two Slack workspaces coexist.
- **Reliable unread counts** from three signals, whichever is highest:
  1. the **Badging API** (`navigator.setAppBadge`) — used by Slack, WhatsApp, Discord
  2. the **tab title** `(N)` — Gmail, and others
  3. an optional **per-service DOM extractor** — e.g. Google Chat reports unread only in `aria-label`s
- **Per-service priority** — `high` (red alert) vs `low` (quiet). Toggle any service at runtime; persisted.
- **Drag-to-reorder** the sidebar; order persisted.
- **Config UI** — add / edit / remove services from a Settings window. No code editing.
- **Login stays in-app**, including Google sign-in (loaded in-view, not a popup).
- **Who messaged you**, not just how many — an optional per-service `sendersJs` extracts
  the sender names (Gmail, Google Chat, WhatsApp). Exported for other tools, not shown in
  the menubar.
- **Scriptable from outside** — a heartbeat state file other tools can poll, and an
  `earshot://open/<id>` deep link that focuses a service. See
  [Integrating with other tools](#integrating-with-other-tools).
- **Indicator-only** (no dock icon on macOS, no taskbar button on Windows), **auto-starts at
  login**, single-instance.
- **Cleans up after itself while you are away** — see below.

## Install / Build

Requires Node 22.12+ and npm — the build runs Electron's own installer, which asks for that
version.

```bash
npm ci
./build.sh        # macOS      — or: npm run build
./build.ps1       # Windows 11 — or: npm run build:win
```

`npm ci` rather than `npm install`: the build refuses to run when `node_modules` holds a
different Electron from the one the lockfile pins, and `npm ci` installs exactly the lockfile
and prunes everything else, so that check cannot be tripped by leftovers.

**macOS** builds a self-contained **`/Applications/Earshot.app`** (the full Electron runtime copied in, rebranded, ad-hoc code-signed) and launches it.

**Windows** builds **`%LOCALAPPDATA%\Programs\Earshot`** the same way: the Electron runtime copied in with `electron.exe` renamed to `Earshot.exe`, which is what makes `app.isPackaged` true and so what turns on the login item and the `earshot://` registration. There is no signing step — the Windows counterpart of an ad-hoc signature would be a real Authenticode certificate, so the first launch may need SmartScreen's *More info → Run anyway*.

Re-run the build script for your platform after any source change — it's the one command you need.

Development (runs from source, prints logs to the terminal):

```bash
npm start
```

## Running for weeks

Earshot keeps eight chat SPAs loaded at all times — that is what makes the counts live,
and it is not free. Measured six hours after a cold start: 4.0 GB resident, the five heavy
services 350–650 MB each, and 1.5 GB in the userData directory (840 MB of it HTTP cache).
Neither number is one you should have to go and reset by hand, so Earshot does it while the
window is put away — after 30 minutes hidden, once every 5 minutes:

- each service's HTTP cache and compiled-code cache are emptied, once a day, and each
  cache is capped at 48 MB regardless. Cookies, IndexedDB and service workers are never
  touched — those are your logins and the apps' own offline stores.
- one service view at a time is reloaded, oldest load first, if it has been up more than
  6 hours. This is the only thing that actually gives a renderer its memory back.

Counts survive both — they are re-derived from the page. The one thing a reload does cost
you: **text typed into a service and never sent is gone.** The view you last had open is
never recycled for exactly that reason, and nothing is recycled while the window is up.

## Configuration

Services are stored in `services.json` inside Electron's userData directory — `~/Library/Application Support/earshot` on macOS, `%APPDATA%\earshot` on Windows — seeded from `DEFAULT_SERVICES` in `main.js` on first run. Manage them via **right-click the tray/menubar icon → Edit services…**:

- **Icon** — an emoji shown in the sidebar (and, on macOS, in the menubar)
- **Name**, **URL**
- **Priority** — High (red) or Low (quiet)
- **Mode** — a free label, `private` or `work`. Earshot itself does nothing with it; it is
  passed through to the state file so an external tool can filter services by it.

Saving rewrites the config and restarts the app. **Logins are preserved** — sessions are keyed by each service's stable id.

Other state, all in the same folder: `order.json` (sidebar order), `prio.json` (priority overrides), `Partitions/<id>/` (per-service cookies/sessions).

## Adding a service that needs custom unread detection

Most services report unread via the Badging API or their tab title and work automatically. If one doesn't (like Google Chat), add an `unreadJs` snippet to its entry in `DEFAULT_SERVICES` — a string of JS evaluated in the page every few seconds that returns the unread count as a number.

## Integrating with other tools

Earshot is the live view, but it also publishes its state so a dashboard, status bar or
script can show the same picture without logging into anything.

**`unread.json`**, beside `services.json` in the userData directory above — rewritten via tmp + rename (so a
reader never observes a half-written file), and refreshed every 30 s **even when nothing
changed**:

```json
{
  "at": "2026-08-28T09:12:03.114Z",
  "total": 3,
  "services": [
    { "id": "gchat", "name": "Google Chat", "emoji": "\ud83d\udcac", "prio": "high",
      "group": "work", "unread": 2, "senders": ["Ada Lovelace"] },
    { "id": "whatsapp", "name": "WhatsApp", "emoji": "\ud83d\udfe2", "prio": "low",
      "group": "private", "unread": 1, "senders": [] }
  ]
}
```

The `at` stamp is a **heartbeat, not a change log**. That is the point: it lets a reader
tell "no unread messages" (fresh file, all zeros) from "Earshot is not running" (stale
file). A quiet app that writes nothing looks identical to a dead one, and zeros rendered
as an all-clear is the failure worth spending a timer on. Treat the file as stale after
~2 heartbeats.

`senders` names come out of an untrusted web page, so they are bounded where they enter
the file — strings only, max 5 per service, 60 chars each, control characters stripped.
Escape them anyway before putting them in HTML.

**`earshot://open/<service-id>`** — focuses the window on that service, so a row in
another app can link straight to the right tab:

```bash
open "earshot://open/gchat"                  # macOS
start "" "earshot://open/gchat"              # Windows
```

A reader on Windows must open the file as **UTF-8** explicitly and hand the URL to
`ShellExecute` (`os.startfile`, `start ""`) rather than building a command line: the state
file carries each service's emoji, so the default cp1252 decode fails, and a URL with an
`&` in it is re-parsed by `cmd`.

There is deliberately **no url parameter**: any process on the machine can open a URL
scheme, and "load this address in one of my logged-in sessions" is not a knob worth
handing out. Only ids that match a service you configured are accepted.

## Code layout

| File | Role |
|------|------|
| `main.js` | Electron main process — windows, service views, unread logic, tray, config, persistence |
| `preload.js` | sidebar IPC bridge |
| `sidebar.html` | the service sidebar (icons, badges, drag-reorder) |
| `service-preload.js` | hooks the Badging API inside each service page |
| `settings.html` / `settings-preload.js` | the Edit-services config UI |
| `build.sh` | builds + signs the standalone macOS `.app` |
| `build.ps1` | the Windows twin — builds `%LOCALAPPDATA%\Programs\Earshot` |

## Lint / format

```bash
npm run lint      # biome check
npm run format    # biome check --write
```

## License

MIT
