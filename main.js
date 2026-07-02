const {
  app,
  BrowserWindow,
  WebContentsView,
  Tray,
  Menu,
  nativeImage,
  shell,
  ipcMain,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const SIDEBAR_W = 72;

// Google Chat doesn't use the Badging API or a title count — it puts the unread
// total in aria-labels ("2 ungelesene Nachrichten" / "2 unread messages"). The
// aggregate is the largest such number.
const GCHAT_UNREAD_JS = `(() => {
  const re = /(\\d+)\\s+(ungelesene?\\s+Nachricht|unread\\s+(message|conversation))/i;
  let total = 0;
  for (const el of document.querySelectorAll('[aria-label]')) {
    const m = (el.getAttribute('aria-label') || '').match(re);
    if (m) total = Math.max(total, parseInt(m[1], 10));
  }
  return total;
})()`;

// Injected into each service page's MAIN world (see createServiceView). Overrides
// the Badging API so the latest count is stashed on window.__earshotBadge, which
// main polls. Guarded so re-injection on each load is a no-op.
const BADGE_HOOK_JS = `(() => {
  if (window.__earshotBadgeHooked) return;
  window.__earshotBadgeHooked = true;
  window.__earshotBadge = 0;
  try {
    Object.defineProperty(Navigator.prototype, 'setAppBadge', {
      configurable: true,
      value: (n) => { window.__earshotBadge = Number(n) || 0; return Promise.resolve(); },
    });
    Object.defineProperty(Navigator.prototype, 'clearAppBadge', {
      configurable: true,
      value: () => { window.__earshotBadge = 0; return Promise.resolve(); },
    });
  } catch (_e) {}
})()`;

// Seed config — written to services.json on first run, then managed via the Settings
// window. prio 'high' → red menubar alert; 'low' → shown quietly. Each gets its own session.
const DEFAULT_SERVICES = [
  {
    id: 'gchat',
    name: 'Google Chat',
    url: 'https://chat.google.com',
    emoji: '💬',
    prio: 'high',
    unreadJs: GCHAT_UNREAD_JS,
  },
  {
    id: 'gmail',
    name: 'Gmail (Work)',
    url: 'https://mail.google.com/mail/u/0/#inbox',
    emoji: '✉️',
    prio: 'high',
  },
  {
    id: 'gmailpriv',
    name: 'Gmail (Private)',
    url: 'https://mail.google.com/mail/u/0/#inbox',
    emoji: '📧',
    prio: 'low',
  },
  { id: 'slack', name: 'Slack', url: 'https://app.slack.com/client', emoji: '💼', prio: 'high' },
  { id: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com', emoji: '🟢', prio: 'low' },
  { id: 'discord', name: 'Discord', url: 'https://discord.com/app', emoji: '🎮', prio: 'low' },
];
let SERVICES = DEFAULT_SERVICES; // replaced by loadServices() at startup

let win = null;
let tray = null;
let sidebar = null;
let settingsWin = null;
const views = {}; // id -> WebContentsView
const unread = {}; // id -> effective unread count
const unreadTitle = {}; // id -> count parsed from tab title
const unreadBadge = {}; // id -> count from the Badging API
const unreadDom = {}; // id -> count from a per-service DOM extractor
const icons = {}; // id -> favicon URL
let activeId = SERVICES[0].id;
let order = SERVICES.map((s) => s.id); // sidebar display order, user-reorderable

function servicesPath() {
  return path.join(app.getPath('userData'), 'services.json');
}
function slug(s) {
  return (
    (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'svc'
  );
}
// Clean a list from the config UI: require name+url, assign stable unique ids, fill defaults.
function normalizeServices(list) {
  const used = new Set();
  return list
    .filter((s) => s?.name && s.url)
    .map((s) => {
      let id = s.id || slug(s.name);
      const base = id;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
      const out = {
        id,
        name: String(s.name).trim(),
        url: String(s.url).trim(),
        emoji: String(s.emoji || '•').trim() || '•',
        prio: s.prio === 'high' ? 'high' : 'low',
      };
      if (s.unreadJs) out.unreadJs = s.unreadJs;
      return out;
    });
}
function loadServices() {
  try {
    const saved = JSON.parse(fs.readFileSync(servicesPath(), 'utf8'));
    if (Array.isArray(saved) && saved.length) {
      SERVICES = normalizeServices(saved);
      return;
    }
  } catch {}
  SERVICES = normalizeServices(DEFAULT_SERVICES);
  try {
    fs.writeFileSync(servicesPath(), JSON.stringify(SERVICES, null, 2));
  } catch {}
}
// Reset derived per-service state to match the current SERVICES (defaults; the
// persisted order/prio files are layered on top afterwards).
function initFromServices() {
  activeId = SERVICES[0].id;
  order = SERVICES.map((s) => s.id);
  for (const k of Object.keys(prio)) delete prio[k];
  SERVICES.forEach((s) => {
    prio[s.id] = s.prio;
  });
}
// Persist a new service list and restart so all views rebuild cleanly.
function applyConfig(list) {
  try {
    fs.writeFileSync(servicesPath(), JSON.stringify(normalizeServices(list), null, 2));
  } catch {}
  app.relaunch();
  app.exit(0);
}

function orderPath() {
  return path.join(app.getPath('userData'), 'order.json');
}
// Reconcile a saved order with the current SERVICES: drop unknown ids, append new ones.
function normalizeOrder(ids) {
  const known = SERVICES.map((s) => s.id);
  return [...ids.filter((id) => known.includes(id)), ...known.filter((id) => !ids.includes(id))];
}
function loadOrder() {
  try {
    order = normalizeOrder(JSON.parse(fs.readFileSync(orderPath(), 'utf8')));
  } catch {}
}
function orderedServices() {
  return order.map((id) => SERVICES.find((s) => s.id === id));
}

// id -> 'high' | 'low'. Populated by initFromServices() (defaults), then loadPrio() (overrides).
const prio = {};

function prioPath() {
  return path.join(app.getPath('userData'), 'prio.json');
}
function loadPrio() {
  try {
    const saved = JSON.parse(fs.readFileSync(prioPath(), 'utf8'));
    SERVICES.forEach((s) => {
      if (saved[s.id] === 'high' || saved[s.id] === 'low') prio[s.id] = saved[s.id];
    });
  } catch {}
}
function togglePrio(id) {
  prio[id] = prio[id] === 'high' ? 'low' : 'high';
  try {
    fs.writeFileSync(prioPath(), JSON.stringify(prio));
  } catch {}
  updateTray();
}

// ---- single instance ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function parseUnread(title) {
  // Chat/Slack/WhatsApp/Discord all put the count in the tab title: "(3) ..." / "(9+)".
  const m = title?.match(/\((\d+)\+?\)/);
  return m ? parseInt(m[1], 10) : 0;
}

// Registrable-domain approximation. No PSL available (no new deps), so this is a
// best-effort last-two-labels heuristic used only to derive the same-service base.
function baseDomain(host) {
  const p = host.split('.');
  return p.slice(-2).join('.');
}

// Domain-boundary match: host must BE serviceBase or a real subdomain of it.
// serviceBase `slack.com` accepts `slack.com` / `app.slack.com` but rejects
// `myslack.com` / `evilslack.com` — a plain `endsWith` suffix check accepts those.
function sameService(host, serviceBase) {
  return host === serviceBase || host.endsWith(`.${serviceBase}`);
}

// Gate a target URL for a service view: allow login hosts + same-service
// navigation to load in-view; everything else is external. Returns the decision
// so both the window-open handler and will-navigate can share one policy.
function classifyNav(url, serviceBase) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'deny';
  }
  if (isLoginHost(host) || sameService(host, serviceBase)) return 'in-view';
  return 'external';
}

// Only http/https may reach the OS browser. file://, smb://, custom app schemes,
// etc. are dropped — shell.openExternal on those is an RCE/exfil primitive.
function openExternalSafe(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:') shell.openExternal(url);
  } catch {}
}

function totalUnread() {
  return Object.values(unread).reduce((a, b) => a + b, 0);
}

function sendState() {
  if (!sidebar) return;
  sidebar.webContents.send('state', {
    services: orderedServices().map((s) => ({
      id: s.id,
      name: s.name,
      icon: icons[s.id] || null,
      unread: unread[s.id] || 0,
    })),
    activeId,
  });
}

function updateTray() {
  if (!tray) return;
  const unreadServices = orderedServices().filter((s) => unread[s.id] > 0);
  const high = unreadServices.filter((s) => prio[s.id] === 'high');
  const low = unreadServices.filter((s) => prio[s.id] === 'low');
  const fmt = (arr) => arr.map((s) => `${s.emoji}${unread[s.id]}`).join(' ');

  let title;
  if (unreadServices.length === 0) {
    title = '💬'; // calm idle — always visible
  } else {
    // Per-app icon + count says where & how many; high-priority apps come first,
    // low-priority sit after a "·" separator. No always-on red (it never turns off).
    const parts = [];
    if (high.length) parts.push(fmt(high));
    if (low.length) parts.push(`${high.length ? '· ' : ''}${fmt(low)}`);
    title = parts.join('  ');
  }
  tray.setTitle(title);

  const detail = unreadServices.map((s) => `${s.name}: ${unread[s.id]} (${prio[s.id]})`).join('\n');
  tray.setToolTip(detail || 'No new messages');
  if (app.dock) app.dock.setBadge(totalUnread() > 0 ? String(totalUnread()) : '');
}

function isLoginHost(host) {
  return /(^|\.)accounts\.google\.com$|(^|\.)accounts\.youtube\.com$|(^|\.)login\.microsoftonline\.com$/.test(
    host,
  );
}

function recompute(id) {
  unread[id] = Math.max(unreadTitle[id] || 0, unreadBadge[id] || 0, unreadDom[id] || 0);
  updateTray();
  sendState();
}

function createServiceView(s) {
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:${s.id}`,
      backgroundThrottling: false, // keep unread counts live while in the background
      contextIsolation: true, // isolate the preload world from the untrusted page
      sandbox: true, // run the remote page in a sandboxed renderer
      preload: path.join(__dirname, 'service-preload.js'),
      additionalArguments: [`--service-id=${s.id}`],
    },
  });
  const wc = view.webContents;
  const serviceBase = baseDomain(new URL(s.url).hostname);

  wc.setUserAgent(CHROME_UA);
  wc.loadURL(s.url, { userAgent: CHROME_UA });

  // Unread is the max of three signals (see recompute): Badging API, tab-title
  // "(N)", and an optional per-service DOM extractor. Title is event-driven.
  // With contextIsolation+sandbox the preload can no longer patch the page's
  // Badging API from an isolated world, so we hook it in the page's MAIN world
  // via executeJavaScript on each load: the override stashes the latest count on
  // a window global that we poll — same mechanism as the DOM extractor.
  wc.on('page-title-updated', (_e, title) => {
    unreadTitle[s.id] = parseUnread(title);
    recompute(s.id);
  });
  wc.on('dom-ready', () => {
    wc.executeJavaScript(BADGE_HOOK_JS).catch(() => {});
  });
  setInterval(async () => {
    try {
      unreadBadge[s.id] = Number(await wc.executeJavaScript('window.__earshotBadge|0')) || 0;
      if (s.unreadJs) unreadDom[s.id] = Number(await wc.executeJavaScript(s.unreadJs)) || 0;
      recompute(s.id);
    } catch {}
  }, 4000);

  wc.on('page-favicon-updated', (_e, favs) => {
    if (favs?.[0]) {
      icons[s.id] = favs[0];
      sendState();
    }
  });

  // Popups: login + same-service targets load in THIS view; external http/https
  // links go to the real browser; everything else (bad scheme/URL) is dropped.
  wc.setWindowOpenHandler(({ url }) => {
    const decision = classifyNav(url, serviceBase);
    if (decision === 'in-view') wc.loadURL(url);
    else if (decision === 'external') openExternalSafe(url);
    return { action: 'deny' };
  });

  // Top-level self-navigation gets the same gate: only login + same-service hosts
  // may load in the authenticated persist: session. Off-domain navigations are
  // cancelled and handed to the external-browser path instead (M1, folded in).
  wc.on('will-navigate', (e, url) => {
    if (classifyNav(url, serviceBase) === 'in-view') return;
    e.preventDefault();
    openExternalSafe(url);
  });

  views[s.id] = view;
  unread[s.id] = 0;
  unreadTitle[s.id] = 0;
  unreadBadge[s.id] = 0;
}

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  if (sidebar) sidebar.setBounds({ x: 0, y: 0, width: SIDEBAR_W, height });
  const v = views[activeId];
  if (v) v.setBounds({ x: SIDEBAR_W, y: 0, width: width - SIDEBAR_W, height });
}

function switchTo(id) {
  if (id === activeId && views[id]) return;
  if (views[activeId]) win.contentView.removeChildView(views[activeId]);
  activeId = id;
  win.contentView.addChildView(views[id]);
  layout();
  sendState();
}

function showWindow() {
  if (!win) return;
  win.maximize(); // fill the screen's work area (not macOS fullscreen)
  win.show();
  win.focus();
}

function openSettings() {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 760,
    height: 620,
    title: 'Services',
    backgroundColor: '#1e1f22',
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js') },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}
function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    skipTaskbar: true,
    backgroundColor: '#1e1f22',
    title: 'Chat Hub',
  });

  // Sidebar (local UI) — its own view, always pinned left.
  sidebar = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  sidebar.webContents.loadFile(path.join(__dirname, 'sidebar.html'));
  win.contentView.addChildView(sidebar);

  // All services load up front (in the background) so unread counts stay live;
  // only the active one is attached to the layout.
  SERVICES.forEach(createServiceView);
  win.contentView.addChildView(views[activeId]);

  sidebar.webContents.on('did-finish-load', sendState);
  win.on('resize', layout);
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  layout();
}

// IPC comes only from our two local windows (sidebar + settings), both loaded via
// loadFile from a file:// origin. Untrusted remote service views must never reach
// these channels — save-config writes the config file and force-relaunches the app,
// so an unchecked sender is at minimum a DoS knob. Match the caller's webContents to
// the window a channel belongs to and require a file:// frame; reject anything else.
function fromWindow(event, wc) {
  return !!wc && event.sender === wc && (event.senderFrame?.url || '').startsWith('file://');
}
const fromSidebar = (event) => fromWindow(event, sidebar?.webContents);
const fromSettings = (event) => fromWindow(event, settingsWin?.webContents);

ipcMain.handle('get-config', (event) => (fromSettings(event) ? SERVICES : []));
ipcMain.on('save-config', (event, list) => {
  if (fromSettings(event)) applyConfig(list);
});
ipcMain.on('close-settings', (event) => {
  if (fromSettings(event)) settingsWin?.close();
});
ipcMain.on('switch', (event, id) => {
  if (fromSidebar(event) && views[id]) switchTo(id);
});
ipcMain.on('reorder', (event, ids) => {
  if (!fromSidebar(event)) return;
  order = normalizeOrder(ids);
  try {
    fs.writeFileSync(orderPath(), JSON.stringify(order));
  } catch {}
  sendState();
});
ipcMain.on('reload', (event) => {
  if (fromSidebar(event)) views[activeId]?.webContents.reload();
});

// Menubar app: the window is hidden ~all the time and the web views don't need
// GPU-accelerated compositing. Dropping HW accel kills the separate GPU process
// (~100-300MB) at the cost of slightly less-smooth rendering when visible.
// Must be called before the app is ready.
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  loadServices();
  initFromServices();
  loadOrder();
  loadPrio();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });

  tray = new Tray(nativeImage.createEmpty());
  updateTray(); // sets title + tooltip
  tray.on('click', toggleWindow);
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      ...orderedServices().map((s) => ({
        label: `${s.name}${unread[s.id] ? `  (${unread[s.id]})` : ''}`,
        click: () => {
          showWindow();
          switchTo(s.id);
        },
      })),
      { type: 'separator' },
      {
        label: 'Priority (high = red alert)',
        submenu: orderedServices().map((s) => ({
          label: s.name,
          type: 'checkbox',
          checked: prio[s.id] === 'high',
          click: () => togglePrio(s.id),
        })),
      },
      { type: 'separator' },
      { label: 'Edit services…', click: openSettings },
      { label: 'Reload current', click: () => views[activeId]?.webContents.reload() },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.popUpContextMenu(menu);
  });

  createWindow();
});
