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

const CHROME_MAJOR = '140';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  `(KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

// Full Chrome UA Client-Hint set. Google sign-in ("This browser or app may not
// be secure") sniffs these: setUserAgent spoofs the UA string but Electron sends
// NO Sec-CH-UA* hints, and their absence is itself the tell (real Chrome always
// sends them). We inject the low-entropy hints plus the high-entropy ones the
// OAuth consent page requests via Accept-CH, making us indistinguishable from
// desktop Chrome so embedded Google logins pass.
const CLIENT_HINTS = {
  'sec-ch-ua': `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not=A?Brand";v="24"`,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-ch-ua-platform-version': '"15.5.0"',
  'sec-ch-ua-full-version-list': `"Chromium";v="${CHROME_MAJOR}.0.0.0", "Google Chrome";v="${CHROME_MAJOR}.0.0.0", "Not=A?Brand";v="24.0.0.0"`,
  'sec-ch-ua-full-version': `"${CHROME_MAJOR}.0.0.0"`,
  'sec-ch-ua-arch': process.arch === 'arm64' ? '"arm"' : '"x86"',
  'sec-ch-ua-bitness': '"64"',
  'sec-ch-ua-model': '""',
  'sec-ch-ua-wow64': '?0',
};

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

// Who it is from, per service. Counts come from three generic signals (title, Badging
// API, unreadJs); a NAME only ever comes from the service's own DOM, so each of these is
// a bespoke, deliberately fragile extractor. Contract: return an array of strings, newest
// first, or [] when the selectors no longer match — an empty answer degrades the dashboard
// row to a bare count, which is why none of them throws or guesses. Capped at 5 in the
// caller (sanitizeSenders), which also bounds the length: this is untrusted page text.
const GMAIL_SENDERS_JS = `(() => {
  const out = [];
  for (const tr of document.querySelectorAll('tr.zE')) {
    const el = tr.querySelector('.yW span[name], .yW span[email], .yW span');
    const t = (el?.getAttribute('name') || el?.textContent || '').trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 5) break;
  }
  return out;
})()`;

// Chat has no unread class to hook: the aria-label carries both the name and the count
// ("Ada Lovelace, 2 unread messages"), so the name is the part before the first comma.
const GCHAT_SENDERS_JS = `(() => {
  const re = /(ungelesene?\\s+Nachricht|unread\\s+(message|conversation))/i;
  const out = [];
  for (const el of document.querySelectorAll('[aria-label]')) {
    const label = el.getAttribute('aria-label') || '';
    if (!re.test(label)) continue;
    const name = label.split(',')[0].trim();
    if (name && !/^\\d+$/.test(name) && !out.includes(name)) out.push(name);
    if (out.length >= 5) break;
  }
  return out;
})()`;

// WhatsApp: chat-list rows are listitems; the unread pill is an aria-label somewhere
// inside the row ("2 unread messages"), the chat name is a title attribute on the row.
// Both are searched loosely on purpose — this DOM is obfuscated and reshuffled often, and
// a miss here costs the names, not the count.
const WHATSAPP_SENDERS_JS = `(() => {
  const out = [];
  for (const row of document.querySelectorAll('[role="listitem"], [role="row"]')) {
    const marked = [...row.querySelectorAll('[aria-label]')].some((el) =>
      /(unread|ungelesen)/i.test(el.getAttribute('aria-label') || ''));
    if (!marked) continue;
    const named = row.querySelector('[title]');
    const t = (named?.getAttribute('title') || named?.textContent || '').trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 5) break;
  }
  return out;
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
// `group` is not about this app at all: it is a free label (`work` / `private`) carried
// through to the exported state file, so an external dashboard can scope a row without
// keeping a second copy of this list.
const DEFAULT_SERVICES = [
  {
    id: 'gchat',
    name: 'Google Chat',
    url: 'https://chat.google.com',
    emoji: '💬',
    prio: 'high',
    group: 'work',
    unreadJs: GCHAT_UNREAD_JS,
    sendersJs: GCHAT_SENDERS_JS,
  },
  {
    id: 'gmail',
    name: 'Gmail (Work)',
    url: 'https://mail.google.com/mail/u/0/#inbox',
    emoji: '✉️',
    prio: 'high',
    group: 'work',
    sendersJs: GMAIL_SENDERS_JS,
  },
  {
    id: 'gmailpriv',
    name: 'Gmail (Private)',
    url: 'https://mail.google.com/mail/u/0/#inbox',
    emoji: '📧',
    prio: 'low',
    group: 'private',
    sendersJs: GMAIL_SENDERS_JS,
  },
  {
    id: 'slack',
    name: 'Slack',
    url: 'https://app.slack.com/client',
    emoji: '💼',
    prio: 'high',
    group: 'work',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    url: 'https://web.whatsapp.com',
    emoji: '🟢',
    prio: 'low',
    group: 'private',
    sendersJs: WHATSAPP_SENDERS_JS,
  },
  {
    id: 'discord',
    name: 'Discord',
    url: 'https://discord.com/app',
    emoji: '🎮',
    prio: 'low',
    group: 'private',
  },
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
const senders = {}; // id -> string[] of who the unread ones are from (sendersJs)
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
        group: s.group === 'work' ? 'work' : 'private',
      };
      if (s.unreadJs) out.unreadJs = s.unreadJs;
      if (s.sendersJs) out.sendersJs = s.sendersJs;
      return out;
    });
}
// A services.json written by an older version has no `group` and no `sendersJs`, and
// normalizeServices would happily call that "everything private, nobody named" — a
// silent downgrade of a config the user never edited. So for a seed service (matched by
// id) fill the fields the saved copy simply predates, and persist the result. Only ever
// fills in what is ABSENT: a value chosen in the Settings window wins.
function backfillFromDefaults(list) {
  let changed = false;
  for (const s of list) {
    const seed = DEFAULT_SERVICES.find((d) => d.id === s.id);
    if (!seed) continue;
    for (const key of ['group', 'unreadJs', 'sendersJs']) {
      if (seed[key] && !s[key]) {
        s[key] = seed[key];
        changed = true;
      }
    }
  }
  return changed;
}
function loadServices() {
  try {
    const saved = JSON.parse(fs.readFileSync(servicesPath(), 'utf8'));
    if (Array.isArray(saved) && saved.length) {
      const filled = backfillFromDefaults(saved);
      SERVICES = normalizeServices(saved);
      if (filled) {
        try {
          fs.writeFileSync(servicesPath(), JSON.stringify(SERVICES, null, 2));
        } catch {}
      }
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
  // A second launch is how macOS delivers an `earshot://` link to the running instance
  // when the app was already up; argv carries it. `open-url` covers the other path.
  app.on('second-instance', (_e, argv) => {
    const link = argv.find((x) => typeof x === 'string' && x.startsWith('earshot://'));
    if (link) handleDeepLink(link);
    else showWindow();
  });
}
app.on('open-url', (e, url) => {
  e.preventDefault();
  handleDeepLink(url);
});

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

// Some services wrap outbound links in a SAME-domain redirector — Gmail/Google
// Chat send you through https://www.google.com/url?q=<real target>. Left in-view
// these hijack the app pane (base domain matches, so classifyNav would allow
// them); detect them and hand off the *real* target to the OS browser instead.
function redirectTarget(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/url') {
    const t = u.searchParams.get('q') || u.searchParams.get('url');
    if (t && /^https?:\/\//i.test(t)) return t;
  }
  return null;
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
  if (redirectTarget(url)) return 'external';
  if (isLoginHost(host) || sameService(host, serviceBase)) return 'in-view';
  return 'external';
}

// Only http/https may reach the OS browser. file://, smb://, custom app schemes,
// etc. are dropped — shell.openExternal on those is an RCE/exfil primitive.
// Redirector URLs are unwrapped so the browser opens the real destination.
function openExternalSafe(url) {
  const target = redirectTarget(url) || url;
  try {
    const { protocol } = new URL(target);
    if (protocol === 'http:' || protocol === 'https:') shell.openExternal(target);
  } catch {}
}

function totalUnread() {
  return Object.values(unread).reduce((a, b) => a + b, 0);
}

// ---- state export (for any other tool on this machine) --------------------
// The menubar is the live view; this file is the same picture for anything else on the
// machine. Written to userData/unread.json via tmp + rename, because the reader polls it
// and a half-written file must never be observable.
//
// The `at` stamp is a HEARTBEAT, not a change log: it is refreshed every
// STATE_HEARTBEAT_MS whether or not anything moved, so a reader can tell "no unread
// messages" (fresh file, all zeros) from "earshot is not running" (stale file). A quiet
// app writing nothing looks identical to a dead one otherwise, and zeros rendered as an
// all-clear is the failure worth spending a timer on.
function statePath() {
  return path.join(app.getPath('userData'), 'unread.json');
}
const STATE_HEARTBEAT_MS = 30000;
const STATE_MIN_INTERVAL_MS = 1000; // recompute fires per title event; don't churn the disk
let stateWrittenAt = 0;
let stateTimer = null;

// Senders come out of an untrusted page (see the *_SENDERS_JS constants) and end up in a
// file, then in the dashboard's HTML. Bound them here, at the only place they enter our
// own data: strings only, 5 max, 60 chars, no control characters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CTRL_RE = /[\u0000-\u001f\u007f]/g;
function sanitizeSenders(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => typeof x === 'string')
    .map((x) => x.replace(CTRL_RE, ' ').trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 5);
}

function writeState(force) {
  const now = Date.now();
  if (!force && now - stateWrittenAt < STATE_MIN_INTERVAL_MS) return;
  stateWrittenAt = now;
  const payload = {
    at: new Date(now).toISOString(),
    total: totalUnread(),
    services: orderedServices()
      .filter(Boolean)
      .map((s) => ({
        id: s.id,
        name: s.name,
        emoji: s.emoji,
        prio: prio[s.id] || s.prio,
        group: s.group || 'private',
        unread: unread[s.id] || 0,
        senders: senders[s.id] || [],
      })),
  };
  const p = statePath();
  const tmp = `${p}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch {}
}

// ---- deep link: earshot://open/<service-id> --------------------------------
// So a click in an external tool lands on the right tab. The id is matched against the
// services we actually built views for and nothing else — in particular there is
// deliberately NO url parameter: any process on this machine can open a URL scheme, and
// "load this address in one of my logged-in sessions" is not a knob to hand out.
function handleDeepLink(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return;
  }
  if (u.protocol !== 'earshot:') return;
  showWindow();
  // earshot://open/gchat -> host 'open', pathname '/gchat'
  const id = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  if (u.host === 'open' && id && views[id]) switchTo(id);
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
  writeState();
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

  // Inject a Chrome-branded UA Client-Hint set (setUserAgent doesn't touch these,
  // and Electron sends none — their absence flags the embedded browser) so Google's
  // login sniffing accepts the flow. Drop any pre-existing hints first, then set ours.
  wc.session.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    for (const k of Object.keys(h)) {
      if (/^sec-ch-ua/i.test(k)) delete h[k];
    }
    Object.assign(h, CLIENT_HINTS);
    cb({ requestHeaders: h });
  });

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
      // Names only while something is unread — with an empty inbox there is nobody to
      // name, and the extractor would still walk the whole DOM every 4s in a background
      // view. Runs after recompute so it reads this tick's count, not the last one.
      if (s.sendersJs) {
        const next =
          unread[s.id] > 0 ? sanitizeSenders(await wc.executeJavaScript(s.sendersJs)) : [];
        if (JSON.stringify(next) !== JSON.stringify(senders[s.id] || [])) {
          senders[s.id] = next;
          writeState(true); // a changed sender list is news even when the count didn't move
        }
      }
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
ipcMain.on('back', (event) => {
  if (!fromSidebar(event)) return;
  const nav = views[activeId]?.webContents.navigationHistory;
  if (nav?.canGoBack()) nav.goBack();
});
ipcMain.on('forward', (event) => {
  if (!fromSidebar(event)) return;
  const nav = views[activeId]?.webContents.navigationHistory;
  if (nav?.canGoForward()) nav.goForward();
});
// Home: reload the active service's start URL — the reliable escape from a page
// the in-view nav gate got stuck on (e.g. a login dead-end) when back isn't enough.
ipcMain.on('home', (event) => {
  if (!fromSidebar(event)) return;
  const s = SERVICES.find((x) => x.id === activeId);
  if (s) views[activeId]?.webContents.loadURL(s.url, { userAgent: CHROME_UA });
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
  // `earshot://open/<id>` — registered at runtime so a dev run (`npm start`) answers it
  // too, not only the packaged app.
  app.setAsDefaultProtocolClient('earshot');

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
  // After the views exist, so the very first file already carries every service id.
  writeState(true);
  stateTimer = setInterval(() => writeState(true), STATE_HEARTBEAT_MS);
});

// A stale unread.json is how a reader knows earshot is gone; make that immediate on a
// clean quit instead of waiting for the heartbeat to age out.
app.on('will-quit', () => {
  if (stateTimer) clearInterval(stateTimer);
  try {
    fs.unlinkSync(statePath());
  } catch {}
});
