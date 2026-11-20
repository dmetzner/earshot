const {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  Tray,
  Menu,
  nativeImage,
  shell,
  ipcMain,
  clipboard,
  session,
  globalShortcut,
  desktopCapturer,
} = require('electron');
const path = require('node:path');
const { baseDomain, classifyNav, classifyPopup, isMeetingUrl, redirectTarget } = require('./nav');
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

const SIDEBAR_W = 56;

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
  // A click on the page's own desktop notification only focuses the page, and the page
  // sits in a hidden window. Say so on the console; main listens for exactly this line.
  // Covers \`new Notification\`, not service-worker showNotification.
  try {
    const N = window.Notification;
    if (N) {
      const Hooked = function (title, opts) {
        // Hidden by Earshot's mode (work/private): no banner, a stand-in the page can use.
        if (window.__earshotQuiet) return { addEventListener() {}, removeEventListener() {}, close() {} };
        const n = new N(title, opts);
        n.addEventListener('click', () => console.debug('__earshot:open'));
        return n;
      };
      Hooked.prototype = N.prototype;
      Object.defineProperty(Hooked, 'permission', { get: () => N.permission });
      Hooked.requestPermission = N.requestPermission.bind(N);
      window.Notification = Hooked;
    }
  } catch (_e) {}
})()`;

// Seed config — written to services.json on first run, then managed via the Settings
// window. prio 'high' → red menubar alert; 'low' → shown quietly. Each gets its own session.
// `group` (`work` / `private` / `both`) picks which mode shows a service, and is also carried
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
        group: ['work', 'both'].includes(s.group) ? s.group : 'private',
      };
      if (s.onDemand) out.onDemand = true;
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
  writeState();
}

// Two id sets from the sidebar's context menu, persisted like prio.json. PAUSED: the view
// is destroyed (renderer process and all), so it costs nothing and reports nothing; its
// persist:<id> partition stays on disk, so resuming comes back logged in. MUTED: the view
// runs and counts in the sidebar as usual, but stays out of the tray, the dock badge and
// the exported total.
const paused = new Set();
const muted = new Set();
const waking = new Set(); // resumed, but its page has not reported a count yet
function idSetPath(name) {
  return path.join(app.getPath('userData'), `${name}.json`);
}
function loadIdSet(name, set) {
  try {
    for (const id of JSON.parse(fs.readFileSync(idSetPath(name), 'utf8'))) {
      if (SERVICES.some((s) => s.id === id)) set.add(id);
    }
  } catch {}
}
function saveIdSet(name, set) {
  try {
    fs.writeFileSync(idSetPath(name), JSON.stringify([...set]));
  } catch {}
}
// What reaches the tray, the dock badge and the exported total.
const counted = (id) => !paused.has(id) && !muted.has(id) && !hiddenByMode(id);

// ---- mode: all / work / private ----
// 'work' hides the private services and 'private' the work ones: out of the sidebar, the
// menu bar, the counts and their desktop notifications, so a shared screen shows nothing
// from the other side. They keep running; switching back is instant.
const MODES = { all: 'All', work: 'Work only', private: 'Private only' };
let mode = 'all';
const modePath = () => path.join(app.getPath('userData'), 'mode.json');
function hiddenByMode(id) {
  if (mode === 'all') return false;
  const s = SERVICES.find((x) => x.id === id);
  return !!s && s.group !== mode && s.group !== 'both'; // 'both': shown in every mode
}
const shownServices = () => orderedServices().filter((s) => !hiddenByMode(s.id));
function loadMode() {
  try {
    const m = JSON.parse(fs.readFileSync(modePath(), 'utf8'));
    if (Object.hasOwn(MODES, m)) mode = m;
  } catch {}
}
function setMode(m) {
  if (!Object.hasOwn(MODES, m)) return;
  mode = m;
  try {
    fs.writeFileSync(modePath(), JSON.stringify(m));
  } catch {}
  for (const [id, v] of Object.entries(views)) quietNotifications(id, v.webContents);
  if (hiddenByMode(activeId)) {
    const next = shownServices().find((s) => views[s.id]);
    if (next) switchTo(next.id);
  }
  updateTray();
  sendState();
  writeState();
}
// Tells the page hook (BADGE_HOOK_JS) whether this service's notifications are hidden.
function quietNotifications(id, wc) {
  if (!wc.isDestroyed())
    wc.executeJavaScript(`window.__earshotQuiet = ${hiddenByMode(id)}`).catch(() => {});
}
const modeMenu = () =>
  Object.entries(MODES).map(([m, label]) => ({
    label,
    type: 'radio',
    checked: mode === m,
    click: () => setMode(m),
  }));

// ---- single instance ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch is how an `earshot://` link reaches the ALREADY-RUNNING instance;
  // argv carries it. That is one of two paths on macOS (`open-url` below is the other)
  // and the only such path on Windows, which has no open-url event at all — a link that
  // starts the app cold is picked out of our own argv in whenReady instead.
  app.on('second-instance', (_e, argv) => {
    const link = argv.find(
      (x) => typeof x === 'string' && (x.startsWith('earshot://') || isMeetingUrl(x)),
    );
    if (link) handleDeepLink(link);
    else showWindow();
  });
}
// Clicking the pinned Dock icon of the running app: the window may be hidden, so show it.
app.on('activate', () => showWindow(mostUrgent()));
app.on('open-url', (e, url) => {
  e.preventDefault();
  handleDeepLink(url);
});

function parseUnread(title) {
  // Chat/Slack/WhatsApp/Discord all put the count in the tab title: "(3) ..." / "(9+)".
  const m = title?.match(/\((\d+)\+?\)/);
  return m ? parseInt(m[1], 10) : 0;
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

// Where a link leaving a service goes: a Meet room opens in Earshot, the rest in the browser.
function leave(url, from) {
  const target = redirectTarget(url) || url;
  if (isMeetingUrl(target)) openMeeting(target, from);
  else openExternalSafe(url);
}

// ---- meetings: a temporary sidebar entry ----
// It borrows the session of the service the link came from, so the meeting runs as the
// Google account that is signed in there. Never saved to services.json; right-click →
// Close meeting removes it.
// ponytail: one meeting slot; a second link replaces the first. Add ids per room if two
// meetings at once is ever real.
const MEET_ID = 'meeting';
function openMeeting(url, from) {
  let s = SERVICES.find((x) => x.id === MEET_ID);
  if (s) {
    views[MEET_ID]?.webContents.loadURL(url);
  } else {
    s = {
      id: MEET_ID,
      name: 'Meeting',
      url,
      emoji: '🎥',
      prio: 'low',
      group: 'both', // a call you are in never vanishes with a mode switch
      temp: true,
      partition: from.partition || `persist:${from.id}`,
    };
    SERVICES.push(s);
    order.push(MEET_ID);
    allowScreenShare(session.fromPartition(s.partition));
    createServiceView(s);
  }
  showWindow(MEET_ID);
}
// Whose Google session an outside meeting link joins with: the first work service on
// google.com (Google Chat), else any Google service, else the first service.
function meetingAccount() {
  const google = SERVICES.filter(
    (s) => !s.temp && /(^|\.)google\.com$/.test(new URL(s.url).hostname),
  );
  return google.find((s) => s.group === 'work') || google[0] || SERVICES[0];
}
function closeMeeting() {
  const view = views[MEET_ID];
  if (activeId === MEET_ID) {
    const back =
      views[lastId] && lastId !== MEET_ID
        ? lastId
        : order.find((id) => id !== MEET_ID && views[id]);
    if (back)
      switchTo(back); // detaches the meeting view
    else if (view) win.contentView.removeChildView(view);
  }
  delete views[MEET_ID];
  view?.webContents.close();
  SERVICES = SERVICES.filter((x) => x.id !== MEET_ID);
  order = order.filter((id) => id !== MEET_ID);
  clearTimeout(pollTimer[MEET_ID]);
  for (const o of [unread, unreadTitle, unreadBadge, unreadDom]) delete o[MEET_ID];
  updateTray();
  sendState();
}
// getDisplayMedia (Meet's "Present now") fails outright without a handler. macOS 15+
// shows its own screen/window picker. The handler sits on a BORROWED session (Chat's),
// so it answers Meet frames only: anything else in that session is refused instead of
// getting the main screen without a prompt where the system picker does not exist.
const screenShareReady = new WeakSet();
function allowScreenShare(ses) {
  if (screenShareReady.has(ses)) return;
  screenShareReady.add(ses);
  ses.setDisplayMediaRequestHandler(
    (req, cb) => {
      let host = '';
      try {
        host = new URL(req.frame?.url || '').hostname;
      } catch {}
      if (host !== 'meet.google.com') return cb({});
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then(([screen]) => cb(screen ? { video: screen } : {}))
        .catch(() => cb({}));
    },
    { useSystemPicker: true },
  );
}

function totalUnread() {
  return SERVICES.reduce((a, s) => a + (counted(s.id) ? unread[s.id] || 0 : 0), 0);
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

// No throttle: recompute only calls this when a count actually changed, and a throttled
// change used to sit unpublished until the next 30 s heartbeat.
function writeState() {
  const payload = {
    at: new Date().toISOString(),
    total: SERVICES.reduce(
      // all modes: a dashboard's total must match its rows
      (a, x) => a + (!paused.has(x.id) && !muted.has(x.id) ? unread[x.id] || 0 : 0),
      0,
    ),
    services: orderedServices()
      .filter(Boolean)
      .map((s) => ({
        id: s.id,
        name: s.name,
        emoji: s.emoji,
        prio: prio[s.id] || s.prio,
        group: s.group || 'private',
        // null, not 0: a paused service is not watched, and a zero would read as all-clear.
        unread: paused.has(s.id) || waking.has(s.id) ? null : unread[s.id] || 0,
        senders: senders[s.id] || [],
        paused: paused.has(s.id),
        muted: muted.has(s.id),
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
// The one exception is a Meet room (isMeetingUrl, exact host and code shape): it opens on
// Meet's own pre-join screen, so nothing is joined or shared without a click here.
function handleDeepLink(raw) {
  // A Meet link handed to the app from outside (MeetingBar, `open -a Earshot <url>`).
  // Before startup has built the window, wait for it: whenReady's first handler builds it.
  if (isMeetingUrl(raw)) {
    app.whenReady().then(() => openMeeting(raw, meetingAccount()));
    return;
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    return;
  }
  if (u.protocol !== 'earshot:') return;
  showWindow();
  // earshot://open/gchat -> host 'open', pathname '/gchat'
  // A malformed escape (earshot://open/%E0%A4%A) makes decodeURIComponent throw, and in
  // an open-url / second-instance handler that is an uncaught-exception dialog.
  let id;
  try {
    id = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  } catch {
    return;
  }
  if (u.host === 'open' && id && (Object.hasOwn(views, id) || paused.has(id))) switchTo(id);
}

function sendState() {
  if (!sidebar) return;
  sidebar.webContents.send('state', {
    mode,
    services: shownServices().map((s) => ({
      id: s.id,
      name: s.name,
      emoji: s.emoji,
      icon: icons[s.id] || null,
      unread: unread[s.id] || 0,
      paused: paused.has(s.id),
      muted: muted.has(s.id),
      work: s.group === 'work',
    })),
    activeId,
  });
}

// ---- the indicator ---------------------------------------------------------
// On macOS the indicator is a template glyph of the app icon (a dot added while anything
// is unread) plus one TEXT item per app with unread (`setTitle` on an empty image, see
// updateAppTrays). Neither survives the trip to Windows. `setTitle` still exists there — it is
// a macOS-only API that silently does nothing — and a tray built from an empty image is
// a slot in the notification area with nothing in it: invisible, so the counts are gone
// AND so is the only way left to open the window. The three facts the title carried
// (something / urgent / how many) therefore have to be painted.
const WINDOWS = process.platform === 'win32';
// "Template" in the name makes macOS tint it for light/dark bars; the @2x file is picked up.
const glyphs = {};
const trayGlyph = (dot) => {
  const f = dot ? 'trayDotTemplate.png' : 'trayTemplate.png';
  glyphs[f] ??= nativeImage.createFromPath(path.join(__dirname, 'assets', f)); // read once
  return glyphs[f];
};

// 5×7 pixel digits, drawn at whatever size the display asks for (see runs()). A tray
// image has no text API, and a font would be a dependency and a licence for eleven
// glyphs, so the count is drawn a pixel at a time: seven rows of five, `1` = ink. 5×7
// rather than the obvious 3×5 because the icon is SIXTEEN logical pixels — at 3×5 the
// digit is a third of its height and reads as a smudge; two of these fill it. `+` is the
// overflow mark, and only past 99 does the exact number stop being the point.
const GLYPH_W = 5;
const GLYPH_H = 7;
const GLYPHS = {
  0: '11111100011000110001100011000111111',
  1: '00100011000010000100001000010001110',
  2: '11111000010000111111100001000011111',
  3: '11111000010000111111000010000111111',
  4: '10001100011000111111000010000100001',
  5: '11111100001000011111000010000111111',
  6: '11111100001000011111100011000111111',
  7: '11111000010001000100010000100001000',
  8: '11111100011000111111100011000111111',
  9: '11111100011000111111000010000111111',
  '+': '00000001000010011111001000010000000',
};

// BGRA — the byte order nativeImage.createFromBitmap reads. Verified against a PNG
// round-trip rather than assumed: RGBA here gives a blue alert and a red all-clear.
const DISC_HIGH = [0x4d, 0x48, 0xe5]; // red — act now
const DISC_LOW = [0x23, 0xa6, 0xf5]; // amber — you know, and it can wait
const DISC_CALM = [0x81, 0x76, 0x6e]; // grey — nothing unread, but still there to click

// How many device pixels each of `n` source cells gets when the block is `dest` pixels
// wide, by cumulative rounding — which is the part that matters: 5 columns over 8 pixels
// comes out 2,1,2,1,2, SYMMETRIC, where nearest-neighbour sampling gives 2,2,1,2,1 and a
// digit whose left edge is fatter than its right reads as a rendering fault. Integer
// scales fall out of the same formula unchanged (5 over 10 is 2,2,2,2,2).
function runs(n, dest) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.round(((i + 1) * dest) / n) - Math.round((i * dest) / n));
  }
  return out;
}

const INK = [255, 255, 255];

// `size` is device pixels, not a scale factor: Windows asks for 16 at 100 %, 24 at 150 %
// and 32 at 200 %, and 24 is not a whole multiple of anything.
function paintTray(size, disc, label) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, [b, g, r], a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 4;
    buf[o] = b;
    buf[o + 1] = g;
    buf[o + 2] = r;
    buf[o + 3] = a;
  };
  // Filled disc with a one-pixel alpha ramp at the rim: a hard-edged circle reads as a
  // rendering fault at 16 px beside the system's own icons. So the test is coverage, not
  // membership — `rad - d` is how far inside the rim the pixel centre falls, clamped to
  // one DEVICE pixel of ramp at any size.
  const c = size / 2;
  const rad = c - size / 32;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cov = rad - Math.hypot(x + 0.5 - c, y + 0.5 - c);
      if (cov <= 0) continue;
      set(x, y, disc, Math.round(255 * Math.min(1, cov)));
    }
  }
  const glyphs = [...label].map((ch) => GLYPHS[ch]).filter(Boolean);
  if (!glyphs.length) return buf;
  // Two glyphs plus a one-pixel gap is 11 of the 16, and its corners still fall inside
  // the disc — that is what caps the label at two characters rather than a taste call.
  const gw = Math.round((GLYPH_W * size) / 16);
  const gh = Math.round((GLYPH_H * size) / 16);
  const gap = Math.max(1, Math.round(size / 16));
  const cols = runs(GLYPH_W, gw);
  const rows = runs(GLYPH_H, gh);
  const x0 = Math.round((size - (glyphs.length * gw + (glyphs.length - 1) * gap)) / 2);
  const y0 = Math.round((size - gh) / 2);
  glyphs.forEach((bits, i) => {
    let cy = y0;
    for (let row = 0; row < GLYPH_H; row++) {
      let cx = x0 + i * (gw + gap);
      for (let col = 0; col < GLYPH_W; col++) {
        if (bits[row * GLYPH_W + col] === '1') {
          for (let dy = 0; dy < rows[row]; dy++) {
            for (let dx = 0; dx < cols[col]; dx++) set(cx + dx, cy + dy, INK, 255);
          }
        }
        cx += cols[col];
      }
      cy += rows[row];
    }
  });
  return buf;
}

// Every scale factor Windows actually hands out, because it picks one per MONITOR and
// rescales whatever it finds: with only 16 and 32 in the image, a 150 % display — the
// stock setting on every Windows laptop — resamples 32 down to 24 and 7-pixel-tall
// digits do not survive that. macOS never sees any of this; the title is the indicator
// there.
const TRAY_SIZES = [
  [1, 16],
  [1.5, 24],
  [2, 32],
];

function trayIcon(high, low, total) {
  const disc = high ? DISC_HIGH : low ? DISC_LOW : DISC_CALM;
  const label = total <= 0 ? '' : total > 99 ? '9+' : String(total);
  const [, base] = TRAY_SIZES[0];
  const img = nativeImage.createFromBitmap(paintTray(base, disc, label), {
    width: base,
    height: base,
  });
  for (const [scaleFactor, size] of TRAY_SIZES.slice(1)) {
    img.addRepresentation({
      scaleFactor,
      width: size,
      height: size,
      buffer: paintTray(size, disc, label),
    });
  }
  return img;
}

// Win32 hands the shell a fixed 128-char buffer for a tray tooltip (szTip), and a longer
// string is cut off wherever it lands — mid-service, mid-count. Drop whole lines and say
// how many, so the breakdown that survives is one you can trust. macOS has no such cap.
const TOOLTIP_MAX = 127;

function fitTooltip(lines) {
  const all = lines.join('\n');
  if (!WINDOWS || all.length <= TOOLTIP_MAX) return all;
  const kept = [];
  let len = 0;
  for (const line of lines) {
    const room = TOOLTIP_MAX - `\n+${lines.length - kept.length} more`.length;
    if (len + line.length > room) break;
    kept.push(line);
    len += line.length + 1; // + the newline that will join it
  }
  if (!kept.length) return `${lines.length} services with unread messages`;
  return `${kept.join('\n')}\n+${lines.length - kept.length} more`;
}

// macOS: one menu bar item per service with unread, so a click opens exactly that service
// (one item's text cannot tell which part of it was clicked). The main item, the app-icon
// glyph, is always there; any item's right-click opens the same menu.
const appTrays = {}; // id -> Tray
let trayMenu = () => null; // the right-click menu, built in whenReady; every item shares it
let trayIds = ''; // which services have an item now, in order
function updateAppTrays() {
  const want = shownServices().filter((s) => counted(s.id) && unread[s.id] > 0);
  const ids = want.map((s) => s.id).join();
  if (ids !== trayIds) {
    // macOS puts every NEW status item leftmost, so items added one by one end up scattered
    // among other apps' icons. Whenever the set changes, rebuild the whole group: the
    // Earshot glyph first, then the apps right to left, so they sit together in sidebar
    // order directly left of the glyph. Count changes alone only retitle.
    for (const t of Object.values(appTrays)) t.destroy();
    for (const id of Object.keys(appTrays)) delete appTrays[id];
    if (want.length) makeMainTray();
    for (const s of [...want].reverse()) {
      appTrays[s.id] = new Tray(nativeImage.createEmpty());
      appTrays[s.id].on('click', () => showWindow(s.id));
      appTrays[s.id].on('right-click', () => appTrays[s.id]?.popUpContextMenu(trayMenu()));
    }
    trayIds = ids;
  }
  for (const s of want) {
    const n = unread[s.id];
    appTrays[s.id].setTitle(`${s.emoji}${n}`);
    const who = senders[s.id]?.length ? ` — ${senders[s.id].join(', ')}` : '';
    appTrays[s.id].setToolTip(`${s.name}: ${n}${who}`);
  }
}

// The Earshot item itself. Also rebuilt by updateAppTrays to keep the group together.
function makeMainTray() {
  tray?.destroy();
  tray = new Tray(WINDOWS ? trayIcon(false, false, 0) : trayGlyph(false));
  tray.on('click', toggleWindow);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
}

function updateTray() {
  if (!tray) return;
  const unreadServices = shownServices().filter((s) => counted(s.id) && unread[s.id] > 0);
  const high = unreadServices.filter((s) => prio[s.id] === 'high');
  const low = unreadServices.filter((s) => prio[s.id] === 'low');
  if (WINDOWS) tray.setImage(trayIcon(high.length > 0, low.length > 0, totalUnread()));
  else {
    updateAppTrays(); // may rebuild the main item, so the image comes after
    tray.setImage(trayGlyph(unreadServices.length > 0));
  }

  // Named in the calm state: on Windows this tooltip is the only per-service breakdown
  // there is, hanging off an icon in a row of fifteen others.
  const detail = fitTooltip(
    unreadServices.map((s) => `${s.name}: ${unread[s.id]} (${prio[s.id]})`),
  );
  tray.setToolTip(detail || 'Earshot — no new messages');
  if (app.dock) app.dock.setBadge(totalUnread() > 0 ? String(totalUnread()) : '');
}

function recompute(id) {
  if (paused.has(id)) return; // a closing view's last events must not resurrect a count
  const next = Math.max(unreadTitle[id] || 0, unreadBadge[id] || 0, unreadDom[id] || 0);
  // A view we recycled reports nothing for the second or two between load and first
  // paint, and a false all-clear is the single worst thing this app can show — it is
  // believed, and it is shown exactly while you are away. So a drop to zero inside a
  // reload we started is held back; the page reports the real count moments later.
  if (next === 0 && Date.now() < (reloadingUntil[id] || 0)) return;
  // A resumed service stays "unknown" (null in unread.json) until a count gets past the
  // grace above; that first accepted count is published even when it equals the old 0.
  const wasWaking = waking.delete(id);
  // Every view's poll lands here every few seconds and the count almost never moved.
  // Repainting the tray (three bitmaps + a shell redraw on Windows), messaging the sidebar
  // and rewriting the state file for an unchanged number was the bulk of the idle cost.
  if (!wasWaking && next === unread[id]) return;
  unread[id] = next;
  updateTray();
  sendState();
  writeState();
}

function createServiceView(s) {
  const view = new WebContentsView({
    webPreferences: {
      partition: s.partition || `persist:${s.id}`,
      backgroundThrottling: false, // keep unread counts live while in the background
      contextIsolation: true, // isolate the preload world from the untrusted page
      sandbox: true, // run the remote page in a sandboxed renderer
      preload: path.join(__dirname, 'service-preload.js'),
      additionalArguments: [`--service-id=${s.id}`],
    },
  });
  const wc = view.webContents;
  handleKeys(wc);
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
    if (views[s.id] !== view) return; // a closing (paused/recycled) view must not leave a count
    unreadTitle[s.id] = parseUnread(title);
    recompute(s.id);
  });
  wc.on('dom-ready', () => {
    wc.executeJavaScript(BADGE_HOOK_JS).catch(() => {});
    if (zoom[s.id]) wc.setZoomLevel(zoom[s.id]); // Chromium forgets it across restarts
    quietNotifications(s.id, wc);
  });
  wc.on('found-in-page', (_e, r) =>
    findView?.webContents.send('found', r.activeMatchOrdinal, r.matches),
  );
  // The notification-click line from BADGE_HOOK_JS. Main frame only (an embedded iframe
  // must not summon the window), and at most every 2 s: showing the window takes keyboard
  // focus, so a page logging the line in a loop would otherwise steal what you type.
  let openedAt = 0;
  wc.on('console-message', (e, _level, legacyMessage) => {
    if ((e.message ?? legacyMessage) !== '__earshot:open' || views[s.id] !== view) return;
    if ((e.frame && e.frame !== wc.mainFrame) || Date.now() - openedAt < 2000) return;
    openedAt = Date.now();
    showWindow(s.id);
  });
  const poll = async () => {
    if (views[s.id] !== view) return; // this view was recycled; its successor polls itself
    try {
      const badge = Number(await wc.executeJavaScript('window.__earshotBadge|0')) || 0;
      const dom = s.unreadJs ? Number(await wc.executeJavaScript(s.unreadJs)) || 0 : 0;
      if (views[s.id] !== view) return; // paused or recycled mid-await: not ours to write
      unreadBadge[s.id] = badge;
      if (s.unreadJs) unreadDom[s.id] = dom;
      recompute(s.id);
      // Names only while something is unread — with an empty inbox there is nobody to
      // name, and the extractor would still walk the whole DOM every 4s in a background
      // view. Runs after recompute so it reads this tick's count, not the last one.
      if (s.sendersJs) {
        const next =
          unread[s.id] > 0 ? sanitizeSenders(await wc.executeJavaScript(s.sendersJs)) : [];
        if (views[s.id] !== view) return;
        if (JSON.stringify(next) !== JSON.stringify(senders[s.id] || [])) {
          senders[s.id] = next;
          writeState(); // a changed sender list is news even when the count didn't move
        }
      }
    } catch {}
    // The poll is a BACKSTOP, not the mechanism: a count that moves announces itself
    // through page-title-updated, which is event-driven and unaffected by any of this.
    // What the poll adds is the Badging API global and the DOM extractors, and reading
    // those every 4 s for eight services is most of the main process's share of the
    // 11 % of a core Earshot burns while hidden. While the window is away it is read
    // every 15 s instead — still twice as often as the state file is republished.
    if (views[s.id] !== view) return; // recycled mid-await: never steal the successor's timer
    pollTimer[s.id] = setTimeout(poll, isAway() ? IDLE_POLL_MS : POLL_MS);
  };
  pollTimer[s.id] = setTimeout(poll, POLL_MS);

  wc.on('did-finish-load', () => {
    loadedAt[s.id] = Date.now();
  });

  wc.on('page-favicon-updated', (_e, favs) => {
    if (favs?.[0]) {
      icons[s.id] = favs[0];
      sendState();
    }
  });

  // Popups: sign-in targets load in THIS view; every other http/https link goes to the
  // real browser; everything else (bad scheme/URL) is dropped.
  wc.setWindowOpenHandler(({ url }) => {
    // "Open in new window" (Google Chat's Meet button among them) often opens about:blank
    // and sets the address afterwards. Let that blank window exist, hidden, just long
    // enough to learn where it goes; did-create-window below routes it and closes it.
    if (!url || url === 'about:blank')
      return { action: 'allow', overrideBrowserWindowOptions: { show: false } };
    const decision = classifyPopup(url);
    if (decision === 'in-view') wc.loadURL(url);
    else if (decision === 'external') leave(url, s);
    return { action: 'deny' };
  });

  wc.on('did-create-window', (child) => {
    const route = (u) => {
      if (!u || u === 'about:blank' || child.isDestroyed()) return;
      child.destroy(); // before it loads anything: the target goes where any link would
      leave(u, s);
    };
    child.webContents.on('will-navigate', (e, u) => {
      e.preventDefault();
      route(u);
    });
    child.webContents.on('did-start-navigation', (d) => d.isMainFrame && route(d.url));
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    setTimeout(() => child.isDestroyed() || child.destroy(), 15000); // never went anywhere
  });

  // Top-level self-navigation gets the same gate: only login + same-service hosts
  // may load in the authenticated persist: session. Off-domain navigations are
  // cancelled and handed to the external-browser path instead (M1, folded in).
  wc.on('will-navigate', (e, url) => {
    if (classifyNav(url, serviceBase) === 'in-view') return;
    e.preventDefault();
    leave(url, s);
  });
  // Server-side redirects need the gate too: will-navigate never sees a 302, nor anything
  // started by loadURL (the window-open handler above), so an allowed host that
  // redirects off-domain would otherwise load foreign content in this session.
  // Cancelled SILENTLY, not handed to the browser: a redirect is not something the user
  // clicked, and a recycled view with an expired session would otherwise open a browser
  // tab on every reload.
  wc.on('will-redirect', (e) => {
    if (!e.isMainFrame || classifyNav(e.url, serviceBase) === 'in-view') return;
    e.preventDefault();
    console.warn(`earshot: blocked an off-service redirect in ${s.id}`);
  });

  wc.on('context-menu', (_e, p) => pageMenu(s.id, wc, p).popup({ window: win }));

  views[s.id] = view;
  loadedAt[s.id] = Date.now();
  // ??= because a recycled view comes through here too, and its last counts are what the
  // tray keeps showing until the new page reports (see RELOAD_GRACE_MS).
  unread[s.id] ??= 0;
  unreadTitle[s.id] ??= 0;
  unreadBadge[s.id] ??= 0;
}

// ---- keeping a long-lived hub small ---------------------------------------
// Eight chat SPAs in eight renderers is what Earshot costs, and none of them were built
// to run for a fortnight. Measured six hours after a cold start: the five heavy views at
// 350-650 MB each, 4.0 GB total RSS, and a userData directory of 1.5 GB — 840 MB of that
// HTTP cache, 145 MB compiled-code cache. Both are recoverable, and neither is worth a
// button (housekeeping you have to remember is housekeeping that never happens), so they
// are recovered while the window is put away: the caches emptied once a day, and one view
// at a time rebuilt in a fresh renderer process, which is the only thing that actually
// returns it to its load-time footprint. Counts survive both — they are re-derived from the page every 4 s.
//
// What the reload half costs: text typed into a service and never sent is gone. So the
// view you last had open is exempt (it holds the draft you are most likely to have), a
// view is only recycled once it has been up for hours, and nothing happens at all until
// the window has been away for half an hour.
const IDLE_MS = 30 * 60 * 1000;
const MAINTAIN_TICK_MS = 5 * 60 * 1000;
const RECYCLE_AFTER_MS = 6 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
// How long a recycled view's last count is trusted over a zero. A document that finished
// loading has not finished BOOTING — a chat SPA paints its badges seconds later — so the
// window has to outlast that, and the price of overshooting is only a count that stays up
// to 45 s stale on a view nobody is looking at.
const RELOAD_GRACE_MS = 45000;
const POLL_MS = 4000; // how often each view's badge global + DOM extractor is read
const IDLE_POLL_MS = 15000; // ...and how often once the window has been put away

let awaySince = Date.now();
let lastSweep = 0;
let maintainTimer = null;
const loadedAt = {}; // id -> ms, when its document last finished loading
const reloadingUntil = {}; // id -> ms, grace window of a reload we asked for
// Every reload or reboot of a page we start: its bare title reads 0 before the counts paint.
function holdZero(id) {
  reloadingUntil[id] = Date.now() + RELOAD_GRACE_MS;
}
const pollTimer = {}; // id -> the pending backstop poll, so a quit can cancel it

async function sweepCaches() {
  for (const s of SERVICES) {
    if (s.temp) continue; // a meeting borrows another service's session
    const ses = session.fromPartition(`persist:${s.id}`);
    // The caches and nothing else: a bare clearStorageData would take the cookies, the
    // IndexedDB and the service workers with it — the logins, and the apps' own stores.
    // CacheStorage is only the service workers' asset copies, and Slack's grew to 721 MB
    // of old bundles (2026-10-07); a worker re-fetches what it still needs.
    try {
      await ses.clearCache();
      await ses.clearCodeCaches({ urls: [] });
      await ses.clearStorageData({ storages: ['cachestorage'] });
    } catch {}
  }
}

// Age alone lets one view sit at several times the others' size for hours. Measured
// 2026-10-11 after 13 h up: one renderer at 432 MB resident (259 MB footprint, +80 MB in
// the last 40 min) while the other five idled at 12-29 MB footprint. So a view resident
// past this is recycled first, biggest first — but not within half an hour of its last
// load, or a service whose fresh baseline is above the line would reload on every tick.
const RECYCLE_ABOVE_KB = 400 * 1024;

function recycleOneView() {
  const now = Date.now();
  const rss = {};
  for (const m of app.getAppMetrics()) rss[m.pid] = m.memory.workingSetSize; // KB
  const memOf = (s) => rss[views[s.id]?.webContents.getOSProcessId()] || 0;
  const age = (s) => now - (loadedAt[s.id] || now);
  const others = SERVICES.filter((s) => s.id !== activeId && views[s.id] && !s.temp);
  const next =
    others
      .filter((s) => memOf(s) > RECYCLE_ABOVE_KB && age(s) > IDLE_MS)
      .sort((a, b) => memOf(b) - memOf(a))[0] ||
    others
      .filter((s) => age(s) > RECYCLE_AFTER_MS)
      .sort((a, b) => (loadedAt[a.id] || 0) - (loadedAt[b.id] || 0))[0];
  const old = next && views[next.id];
  if (!old || old.webContents.isDestroyed() || old.webContents.isLoading()) return;
  // A NEW view, not wc.reload(): a reload stays in the same renderer process, and that
  // process keeps what it grew — measured 2026-10-11, WhatsApp went 310 -> 358 -> 414 ->
  // 417 MB across four reloads. Only a fresh process starts from the load-time footprint.
  clearTimeout(pollTimer[next.id]);
  reloadingUntil[next.id] = now + RELOAD_GRACE_MS;
  createServiceView(next); // sets loadedAt, so the next tick does not pick it again
  old.webContents.close();
}

// Put away: hidden or left unfocused behind other windows, long enough that this is not
// just a glance elsewhere. Unfocused counts too (audit #2): a window left open was
// otherwise never maintained at all.
function isAway() {
  return !!win && !(win.isVisible() && win.isFocused()) && Date.now() - awaySince >= IDLE_MS;
}

function maintain() {
  unloadIdleOnDemand();
  if (!isAway()) return;
  if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
    lastSweep = Date.now();
    sweepCaches();
  }
  recycleOneView(); // one per tick — eight at once is a stampede, not maintenance
}

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  if (sidebar) sidebar.setBounds({ x: 0, y: 0, width: SIDEBAR_W, height });
  const v = views[activeId];
  if (v) v.setBounds({ x: SIDEBAR_W, y: 0, width: width - SIDEBAR_W, height });
  if (findView) findView.setBounds({ x: width - 340, y: 8, width: 330, height: 44 });
}

// ⌘1–8 (Ctrl on Windows) jumps to that sidebar slot and ⌘9 to the last, like browser tabs;
// Ctrl+Tab goes back to the previous chat; ⌘F finds, ⌘+/−/0 zoom, ⌘W hides.
// Not Alt+digit: on German layouts that is how { [ ] } are typed.
function handleKeys(wc) {
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const list = shownServices();
    const mod = WINDOWS ? input.control : input.meta;
    const plain = mod && !input.alt;
    const key = input.key.toLowerCase();
    if (plain && !input.shift && key === 'w') {
      e.preventDefault(); // close = hide, as the window's close button already does
      win.hide();
      return;
    }
    if (plain && key === 'f') {
      e.preventDefault();
      openFind();
      return;
    }
    // Zoom: + is its own key on German layouts, = carries it on US ones.
    const zoomBy = { '+': 0.5, '=': 0.5, '-': -0.5 }[input.key];
    if (plain && (zoomBy || input.key === '0')) {
      e.preventDefault();
      setZoom(activeId, zoomBy ? (zoom[activeId] || 0) + zoomBy : 0);
      return;
    }
    if (plain && !input.shift && /^[1-9]$/.test(input.key)) {
      const n = Number(input.key);
      const target = n === 9 ? list.at(-1) : list[n - 1];
      if (!target) return;
      e.preventDefault();
      switchTo(target.id);
    } else if (
      input.control &&
      input.key === 'Tab' &&
      lastId &&
      SERVICES.some((x) => x.id === lastId) &&
      !hiddenByMode(lastId)
    ) {
      e.preventDefault(); // back to the chat you were in before, like Alt+Tab
      switchTo(lastId);
    }
  });
}

function switchTo(id) {
  if (paused.has(id)) resumeService(id); // clicking a paused service is how you get it back
  if (id === activeId && views[id]) return;
  if (views[activeId]) win.contentView.removeChildView(views[activeId]);
  closeFind();
  lastId = activeId;
  leftAt[activeId] = Date.now();
  activeId = id;
  win.contentView.addChildView(views[id]);
  layout();
  sendState();
}

// On-demand services (a dashboard, no unread to watch) start unloaded, load when opened
// and unload ON_DEMAND_MS after you leave them. Unloading is pausing, so a click resumes.
const ON_DEMAND_MS = 10 * 60 * 1000;
const leftAt = {}; // id -> ms, when it stopped being the open service
let lastId = null; // the service open before this one, for Ctrl+Tab
function unloadIdleOnDemand() {
  for (const s of SERVICES) {
    if (
      s.onDemand &&
      s.id !== activeId &&
      views[s.id] &&
      Date.now() - (leftAt[s.id] || 0) > ON_DEMAND_MS
    )
      pauseService(s.id);
  }
}

// ---- zoom, remembered per service ----
const zoom = {}; // id -> Chromium zoom level, 0 = 100 %
const zoomPath = () => path.join(app.getPath('userData'), 'zoom.json');
function loadZoom() {
  try {
    Object.assign(zoom, JSON.parse(fs.readFileSync(zoomPath(), 'utf8')));
  } catch {}
}
function setZoom(id, level) {
  const wc = views[id]?.webContents;
  if (!wc) return;
  zoom[id] = Math.max(-3, Math.min(3, level));
  wc.setZoomLevel(zoom[id]);
  try {
    fs.writeFileSync(zoomPath(), JSON.stringify(zoom));
  } catch {}
}

// ---- find in page: a small bar over the top-right of the open service ----
let findView = null;
let findText = ''; // the last query, so Enter on the same text continues it
function openFind() {
  if (!findView) {
    findView = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'find-preload.js') },
    });
    findView.webContents.loadFile(path.join(__dirname, 'find.html'));
  }
  win.contentView.addChildView(findView); // (re)adding puts it on top
  layout();
  findView.webContents.focus();
  findView.webContents.send('find-open');
}
function closeFind() {
  if (!findView || !win.contentView.children.includes(findView)) return;
  views[activeId]?.webContents.stopFindInPage('clearSelection');
  findText = '';
  win.contentView.removeChildView(findView);
  views[activeId]?.webContents.focus();
}

// Pause = the recycle path in recycleOneView without the successor: close() is what frees
// the renderer process (a reload or a hidden view keeps it). The partition is untouched.
function pauseService(id) {
  const view = views[id];
  if (!view || paused.has(id)) return;
  paused.add(id);
  saveIdSet('paused', paused);
  clearTimeout(pollTimer[id]);
  delete views[id];
  if (id === activeId) {
    win.contentView.removeChildView(view);
    const next = order.find((x) => views[x]);
    if (next) switchTo(next);
  }
  view.webContents.close();
  unread[id] = unreadTitle[id] = unreadBadge[id] = unreadDom[id] = 0;
  senders[id] = [];
  updateTray();
  sendState();
  writeState();
}

function resumeService(id) {
  const s = SERVICES.find((x) => x.id === id);
  if (!s || !paused.delete(id)) return;
  saveIdSet('paused', paused);
  waking.add(id);
  holdZero(id);
  createServiceView(s);
  if (id === activeId) {
    win.contentView.addChildView(views[id]);
    layout();
  }
  sendState();
  writeState();
}

function toggleMute(id) {
  if (!muted.delete(id)) muted.add(id);
  saveIdSet('muted', muted);
  updateTray();
  sendState();
  writeState();
}

// Right-click inside a service view. Electron shows no menu of its own, so links, images,
// selections and text fields get the browser basics here. "New tab" means the OS browser.
function pageMenu(id, wc, p) {
  const items = [];
  const sep = () => items.length && items.push({ type: 'separator' });
  if (p.linkURL) {
    items.push(
      { label: 'Open link in browser', click: () => openExternalSafe(p.linkURL) },
      {
        label: 'Copy link address',
        click: () => clipboard.writeText(redirectTarget(p.linkURL) || p.linkURL),
      },
    );
  }
  // blob:/data: sources can't be opened outside the page, and a data: URL can be megabytes.
  const src = /^https?:/i.test(p.srcURL) ? p.srcURL : '';
  if (p.mediaType === 'image' && src) {
    sep();
    items.push(
      { label: 'Open image in browser', click: () => openExternalSafe(src) },
      { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
      { label: 'Copy image address', click: () => clipboard.writeText(src) },
      { label: 'Save image as…', click: () => wc.downloadURL(src) },
    );
  } else if (['video', 'audio'].includes(p.mediaType) && src) {
    sep();
    items.push(
      { label: `Open ${p.mediaType} in browser`, click: () => openExternalSafe(src) },
      { label: `Copy ${p.mediaType} address`, click: () => clipboard.writeText(src) },
    );
  }
  if (p.isEditable) {
    sep();
    items.push(
      { role: 'undo', enabled: p.editFlags.canUndo },
      { role: 'redo', enabled: p.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: p.editFlags.canCut },
      { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste },
      { role: 'selectAll' },
    );
  } else if (p.selectionText.trim()) {
    sep();
    items.push({ role: 'copy' });
  }
  sep();
  items.push(
    {
      label: 'Back',
      enabled: wc.navigationHistory.canGoBack(),
      click: () => wc.navigationHistory.goBack(),
    },
    {
      label: 'Reload',
      click: () => {
        holdZero(id);
        wc.reload();
      },
    },
    { label: 'Open page in browser', click: () => openExternalSafe(wc.getURL()) },
  );
  return Menu.buildFromTemplate(items);
}

// Right-click on a sidebar icon. The id has already been checked against SERVICES.
function serviceMenu(s) {
  const live = () => views[s.id]?.webContents; // looked up on click: the view may be replaced
  const isPaused = paused.has(s.id);
  if (s.temp)
    return Menu.buildFromTemplate([
      { label: 'Close meeting', click: closeMeeting },
      { label: 'Open in browser', click: () => openExternalSafe(live()?.getURL() || s.url) },
    ]);
  return Menu.buildFromTemplate([
    {
      label: isPaused ? 'Resume' : 'Pause (free its memory)',
      click: () => (isPaused ? resumeService(s.id) : pauseService(s.id)),
    },
    {
      label: 'Mute (keep out of the tray)',
      type: 'checkbox',
      checked: muted.has(s.id),
      click: () => toggleMute(s.id),
    },
    {
      label: 'Reload',
      enabled: !!live(),
      click: () => {
        holdZero(s.id);
        live()?.reload();
      },
    },
    { label: 'Open in browser', click: () => openExternalSafe(live()?.getURL() || s.url) },
    { type: 'separator' },
    {
      label: 'High priority (red alert)',
      type: 'checkbox',
      checked: prio[s.id] === 'high',
      click: () => togglePrio(s.id),
    },
    { label: 'Edit services…', click: openSettings },
  ]);
}

function showWindow(id) {
  if (!win) return;
  if (id && id !== activeId && views[id]) switchTo(id);
  win.maximize(); // fill the screen's work area (not macOS fullscreen)
  win.show();
  // A Dock-less app is not activated by showing its window: without this the keyboard
  // stays with the app you came from, so Alt+Space, ⌘F and typing would all miss.
  if (!WINDOWS) app.focus({ steal: true });
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
// Where opening the window should land: the open service if it has unread, else the
// first with unread in sidebar order, high priority before low; else stay put.
function mostUrgent() {
  if (unread[activeId] > 0 && counted(activeId)) return activeId;
  const waiting = shownServices().filter((s) => counted(s.id) && unread[s.id] > 0);
  return (waiting.find((s) => prio[s.id] === 'high') || waiting[0])?.id;
}
function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow(mostUrgent());
}

function createWindow() {
  // BaseWindow: everything visible lives in child views, so the BrowserWindow's own
  // renderer was an empty page costing a process (~21 MB, docs/windows-perf-audit.md #3).
  win = new BaseWindow({
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
  handleKeys(sidebar.webContents);
  win.contentView.addChildView(sidebar);

  // All services load up front (in the background) so unread counts stay live;
  // only the active one is attached to the layout.
  SERVICES.filter((s) => !paused.has(s.id)).forEach(createServiceView);
  if (!views[activeId]) activeId = order.find((id) => views[id]) || activeId;
  if (views[activeId]) win.contentView.addChildView(views[activeId]);

  sidebar.webContents.on('did-finish-load', sendState);
  win.on('resize', layout);
  for (const ev of ['hide', 'blur', 'minimize']) {
    win.on(ev, () => {
      awaySince = Date.now();
    });
  }
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  // A view attached while the window has never been shown stays blank on the first show
  // until a reload. Re-attaching it once the window is on screen makes it paint, as
  // switchTo already does for every later switch.
  win.once('show', () => {
    const v = views[activeId];
    if (!v) return;
    win.contentView.removeChildView(v);
    win.contentView.addChildView(v);
    layout();
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
const fromFind = (event) => fromWindow(event, findView?.webContents);

ipcMain.on('find', (event, text, forward) => {
  const wc = views[activeId]?.webContents;
  if (!fromFind(event) || !wc) return;
  if (!text) {
    wc.stopFindInPage('clearSelection');
    findView.webContents.send('found', 0, 0);
  } else wc.findInPage(String(text), { forward: forward !== false, findNext: text !== findText }); // true = a NEW search
  findText = text;
});
ipcMain.on('find-close', (event) => {
  if (fromFind(event)) closeFind();
});
// The sidebar button steps through the modes: All → Work only → Private only → All.
ipcMain.on('mode-next', (event) => {
  if (!fromSidebar(event)) return;
  const ms = Object.keys(MODES);
  setMode(ms[(ms.indexOf(mode) + 1) % ms.length]);
});
ipcMain.on('app-menu', (event) => {
  if (fromSidebar(event)) trayMenu()?.popup({ window: win });
});

ipcMain.handle('get-config', (event) => (fromSettings(event) ? SERVICES : []));
ipcMain.on('save-config', (event, list) => {
  if (fromSettings(event)) applyConfig(list);
});
ipcMain.on('close-settings', (event) => {
  if (fromSettings(event)) settingsWin?.close();
});
ipcMain.on('switch', (event, id) => {
  if (fromSidebar(event) && (Object.hasOwn(views, id) || paused.has(id))) switchTo(id);
});
ipcMain.on('service-menu', (event, id) => {
  const s = fromSidebar(event) && SERVICES.find((x) => x.id === id);
  if (s) serviceMenu(s).popup({ window: win });
});
ipcMain.on('reorder', (event, ids) => {
  if (!fromSidebar(event)) return;
  // In Work/Private mode the sidebar only sends what it shows; the hidden services keep
  // their slots and the shown ones are re-dealt into theirs.
  const shown = new Set(ids);
  let i = 0;
  order = normalizeOrder(order.map((id) => (shown.has(id) ? ids[i++] : id)));
  try {
    fs.writeFileSync(orderPath(), JSON.stringify(order));
  } catch {}
  sendState();
});
ipcMain.on('reload', (event) => {
  if (!fromSidebar(event)) return;
  holdZero(activeId);
  views[activeId]?.webContents.reload();
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
  if (!s) return;
  holdZero(activeId);
  views[activeId]?.webContents.loadURL(s.url, { userAgent: CHROME_UA });
});

// Menubar app: the window is hidden ~all the time and the web views don't need
// GPU-accelerated compositing. Dropping HW accel kills the separate GPU process
// (~100-300MB) at the cost of slightly less-smooth rendering when visible.
// Must be called before the app is ready.
app.disableHardwareAcceleration();

// Chromium sizes each partition's HTTP cache off free disk space, and eight partitions
// each helping themselves is how the userData directory reached 1.5 GB. A chat app's
// hot assets are a few MB; the rest of a 300 MB cache is history nobody reads.
app.commandLine.appendSwitch('disk-cache-size', String(48 * 1024 * 1024));

// The window's close handler hides instead of closing — that is what makes Earshot a
// menubar app, and it is also what hung every macOS logout, restart and shutdown: the
// OS asked politely, the window refused to go, and force-quit was the only way out.
// `app.isQuitting` was set in exactly one place, the tray's Quit item. `before-quit` is
// the one hook that fires for ALL of them (Apple-event quit, ⌘Q, OS shutdown), so it is
// where the flag belongs. Verified against `osascript -e 'tell application ... to quit'`,
// which is the same path a logout takes.
app.on('before-quit', () => {
  app.isQuitting = true;
});

// Windows identifies an app by its AppUserModelID, and Electron's default is
// `electron.app.Electron` — which is the name that then shows up in Task Manager's
// Startup tab for the login item, and the identity notifications are attributed to. An
// entry nobody can recognise is one that gets disabled. Same id as build.sh writes into
// CFBundleIdentifier, so the two platforms agree on what this app is called.
if (WINDOWS) app.setAppUserModelId('uk.metzner.earshot');

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  loadServices();
  initFromServices();
  loadOrder();
  loadPrio();
  loadIdSet('paused', paused);
  for (const s of SERVICES) if (s.onDemand && s.id !== activeId) paused.add(s.id);
  loadZoom();
  loadMode();
  loadIdSet('muted', muted);
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  // `earshot://open/<id>` — registered at runtime so a dev run (`npm start`) answers it
  // too, not only the packaged app.
  if (WINDOWS && !app.isPackaged) {
    // Windows registers a COMMAND LINE, not a bundle id, so the plain call writes
    // `electron.exe "%1"` — which starts Electron with no app in it. A dev run has to
    // name the source directory itself or the link opens an empty grey window.
    app.setAsDefaultProtocolClient('earshot', process.execPath, [path.resolve(__dirname)]);
  } else {
    app.setAsDefaultProtocolClient('earshot');
  }

  makeMainTray();
  updateTray(); // sets image + tooltip
  // Alt+Space from anywhere does what the tray click does. register() returns false
  // when another app already owns the chord (ChatGPT's default is the same one).
  if (!globalShortcut.register('Alt+Space', toggleWindow)) {
    console.warn('Alt+Space is taken by another app; no global shortcut for Earshot.');
  }
  trayMenu = () => {
    const menu = Menu.buildFromTemplate([
      ...modeMenu(),
      { type: 'separator' },
      ...shownServices().map((s) => ({
        label: `${s.name}${paused.has(s.id) ? '  (paused)' : unread[s.id] ? `  (${unread[s.id]})` : ''}`,
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
      {
        label: 'Reload current',
        click: () => {
          holdZero(activeId);
          views[activeId]?.webContents.reload();
        },
      },
      {
        label: 'Reload all services',
        click: () => {
          // Paused services have no view and stay paused.
          for (const [id, v] of Object.entries(views)) {
            if (v.webContents.isDestroyed()) continue;
            holdZero(id);
            v.webContents.reload();
          }
        },
      },
      { label: 'Quit', click: () => app.quit() }, // before-quit sets the flag
    ]);
    return menu;
  };

  createWindow();
  // The third delivery path, and the only one Windows has when the app was NOT already
  // running: the URL sits in our own argv. `second-instance` cannot fire (we are the
  // first instance) and there is no open-url event here, so without this a documented
  // `start "" "earshot://open/gchat"` silently starts a hidden app and nothing else.
  // Must come after createWindow, which is what makes views[id] exist to switch to.
  const coldLink = process.argv.find((x) => typeof x === 'string' && x.startsWith('earshot://'));
  if (coldLink) handleDeepLink(coldLink);
  // After the views exist, so the very first file already carries every service id.
  writeState();
  stateTimer = setInterval(() => writeState(), STATE_HEARTBEAT_MS);
  maintainTimer = setInterval(maintain, MAINTAIN_TICK_MS);
});

// A stale unread.json is how a reader knows earshot is gone; make that immediate on a
// clean quit instead of waiting for the heartbeat to age out.
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (stateTimer) clearInterval(stateTimer);
  if (maintainTimer) clearInterval(maintainTimer);
  for (const t of Object.values(pollTimer)) clearTimeout(t);
  try {
    fs.unlinkSync(statePath());
  } catch {}
});
