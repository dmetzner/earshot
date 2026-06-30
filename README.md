# Earshot

A macOS **menubar hub** for all your web chats — Google Chat, Gmail, Slack, WhatsApp, Discord, or any other web-based messenger. One window, one menubar icon, and an at-a-glance unread indicator that tells you **where** you have messages and **how urgent** they are.

> Built because WebKit-based wrappers (Unite, Coherence, etc.) can't log into Google — Google blocks embedded webviews. Earshot runs on Electron's bundled Chromium, so logins work exactly like Chrome.

## Why

The point isn't the window — it's the **menubar indicator**. You should always know, without clicking anything, whether you have new messages, in which app, and whether it's worth interrupting your work for.

- **`💬`** — all clear
- **`🔴 💬2 ✉5`** — high-priority unread (act now), shown in red with each app's icon + count
- **`🔴 💬2 · 🟢3`** — high-priority plus low-priority (after the `·`, no red — you know, but it's not urgent)

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
- **Menubar-only** (no dock icon), **auto-starts at login**, single-instance.

## Install / Build

Requires Node + npm.

```bash
npm install
./build.sh        # or: npm run build
```

This builds a self-contained **`/Applications/Earshot.app`** (the full Electron runtime copied in, rebranded, ad-hoc code-signed) and launches it. Re-run `./build.sh` after any source change — it's the one command you need.

Development (runs from source, prints logs to the terminal):

```bash
npm start
```

## Configuration

Services are stored in `~/Library/Application Support/earshot/services.json`, seeded from `DEFAULT_SERVICES` in `main.js` on first run. Manage them via **right-click the menubar icon → Edit services…**:

- **Icon** — an emoji shown in the menubar/sidebar
- **Name**, **URL**
- **Priority** — High (red) or Low (quiet)

Saving rewrites the config and restarts the app. **Logins are preserved** — sessions are keyed by each service's stable id.

Other state, all in the same folder: `order.json` (sidebar order), `prio.json` (priority overrides), `Partitions/<id>/` (per-service cookies/sessions).

## Adding a service that needs custom unread detection

Most services report unread via the Badging API or their tab title and work automatically. If one doesn't (like Google Chat), add an `unreadJs` snippet to its entry in `DEFAULT_SERVICES` — a string of JS evaluated in the page every few seconds that returns the unread count as a number.

## Code layout

| File | Role |
|------|------|
| `main.js` | Electron main process — windows, service views, unread logic, tray, config, persistence |
| `preload.js` | sidebar IPC bridge |
| `sidebar.html` | the service sidebar (icons, badges, drag-reorder) |
| `service-preload.js` | hooks the Badging API inside each service page |
| `settings.html` / `settings-preload.js` | the Edit-services config UI |
| `build.sh` | builds + signs the standalone `.app` |

## Lint / format

```bash
npm run lint      # biome check
npm run format    # biome check --write
```

## License

MIT
