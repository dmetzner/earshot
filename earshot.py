"""Earshot — a menubar / tray hub for web chats, on Qt WebEngine (Chromium).

One window, one tray icon, every chat service loaded in the background in its own
persistent profile, and an unread indicator that says where and how urgent.
"""

import json
import os
import platform
import re
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qs

# Must be set before Qt WebEngine starts. The window is hidden ~all the time, so no GPU
# process (~100-300 MB), and the background views must keep their timers running or the
# counts go stale — Chromium otherwise throttles every page that is not on screen.
os.environ.setdefault(
    'QTWEBENGINE_CHROMIUM_FLAGS',
    '--disable-gpu --disable-background-timer-throttling '
    '--disable-renderer-backgrounding --disable-backgrounding-occluded-windows',
)

from PySide6.QtCore import QEvent, QProcess, QRect, QSize, Qt, QTimer, QUrl  # noqa: E402
from PySide6.QtGui import (  # noqa: E402
    QColor,
    QCursor,
    QDesktopServices,
    QFont,
    QFontMetrics,
    QGuiApplication,
    QIcon,
    QPainter,
    QPixmap,
)
from PySide6.QtNetwork import QLocalServer, QLocalSocket  # noqa: E402
from PySide6.QtWebEngineCore import (  # noqa: E402
    QWebEnginePage,
    QWebEngineProfile,
    QWebEngineScript,
    qWebEngineChromiumVersion,
)
from PySide6.QtWebEngineWidgets import QWebEngineView  # noqa: E402
from PySide6.QtWidgets import (  # noqa: E402
    QAbstractItemView,
    QApplication,
    QComboBox,
    QDialog,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMenu,
    QPushButton,
    QStackedWidget,
    QSystemTrayIcon,
    QTableWidget,
    QTableWidgetItem,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

MAC = sys.platform == 'darwin'
WINDOWS = sys.platform == 'win32'
FROZEN = getattr(sys, 'frozen', False)  # running from the built app, not from source

# Google sign-in ("This browser or app may not be secure") sniffs the UA *and* the
# Sec-CH-UA client hints; QtWebEngine brands both as itself. Claim the Chrome we actually
# are — same Chromium major, so feature sniffing agrees with the string.
CHROME_MAJOR = qWebEngineChromiumVersion().split('.')[0]
CHROME_FULL = f'{CHROME_MAJOR}.0.0.0'
CHROME_UA = (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    f'(KHTML, like Gecko) Chrome/{CHROME_FULL} Safari/537.36'
)

SIDEBAR_W = 72

# Google Chat doesn't use the Badging API or a title count — it puts the unread total in
# aria-labels ("2 ungelesene Nachrichten" / "2 unread messages"). The aggregate is the
# largest such number.
GCHAT_UNREAD_JS = r"""(() => {
  const re = /(\d+)\s+(ungelesene?\s+Nachricht|unread\s+(message|conversation))/i;
  let total = 0;
  for (const el of document.querySelectorAll('[aria-label]')) {
    const m = (el.getAttribute('aria-label') || '').match(re);
    if (m) total = Math.max(total, parseInt(m[1], 10));
  }
  return total;
})()"""

# Who it is from, per service. Counts come from three generic signals (title, Badging API,
# unreadJs); a NAME only ever comes from the service's own DOM, so each of these is a
# bespoke, deliberately fragile extractor. Contract: return an array of strings, newest
# first, or [] when the selectors no longer match — an empty answer degrades the dashboard
# row to a bare count. Bounded in sanitize_senders: this is untrusted page text.
GMAIL_SENDERS_JS = r"""(() => {
  const out = [];
  for (const tr of document.querySelectorAll('tr.zE')) {
    const el = tr.querySelector('.yW span[name], .yW span[email], .yW span');
    const t = (el?.getAttribute('name') || el?.textContent || '').trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 5) break;
  }
  return out;
})()"""

# Chat has no unread class to hook: the aria-label carries both the name and the count
# ("Ada Lovelace, 2 unread messages"), so the name is the part before the first comma.
GCHAT_SENDERS_JS = r"""(() => {
  const re = /(ungelesene?\s+Nachricht|unread\s+(message|conversation))/i;
  const out = [];
  for (const el of document.querySelectorAll('[aria-label]')) {
    const label = el.getAttribute('aria-label') || '';
    if (!re.test(label)) continue;
    const name = label.split(',')[0].trim();
    if (name && !/^\d+$/.test(name) && !out.includes(name)) out.push(name);
    if (out.length >= 5) break;
  }
  return out;
})()"""

# WhatsApp: chat-list rows are listitems; the unread pill is an aria-label somewhere inside
# the row, the chat name a title attribute on the row. Searched loosely on purpose — this
# DOM is obfuscated and reshuffled often, and a miss costs the names, not the count.
WHATSAPP_SENDERS_JS = r"""(() => {
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
})()"""

# Injected into each page's main world at document creation. Overrides the Badging API so
# the latest count is stashed on window.__earshotBadge, which the poll reads.
BADGE_HOOK_JS = """(() => {
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
})()"""

# Seed config — written to services.json on first run, then managed via the Settings
# window. prio 'high' → red alert; 'low' → shown quietly. `group` is not about this app at
# all: a free label carried through to the state file so an external dashboard can scope a
# row without keeping a second copy of this list.
DEFAULT_SERVICES = [
    {
        'id': 'gchat',
        'name': 'Google Chat',
        'url': 'https://chat.google.com',
        'emoji': '💬',
        'prio': 'high',
        'group': 'work',
        'unreadJs': GCHAT_UNREAD_JS,
        'sendersJs': GCHAT_SENDERS_JS,
    },
    {
        'id': 'gmail',
        'name': 'Gmail (Work)',
        'url': 'https://mail.google.com/mail/u/0/#inbox',
        'emoji': '✉️',
        'prio': 'high',
        'group': 'work',
        'sendersJs': GMAIL_SENDERS_JS,
    },
    {
        'id': 'gmailpriv',
        'name': 'Gmail (Private)',
        'url': 'https://mail.google.com/mail/u/0/#inbox',
        'emoji': '📧',
        'prio': 'low',
        'group': 'private',
        'sendersJs': GMAIL_SENDERS_JS,
    },
    {
        'id': 'slack',
        'name': 'Slack',
        'url': 'https://app.slack.com/client',
        'emoji': '💼',
        'prio': 'high',
        'group': 'work',
    },
    {
        'id': 'whatsapp',
        'name': 'WhatsApp',
        'url': 'https://web.whatsapp.com',
        'emoji': '🟢',
        'prio': 'low',
        'group': 'private',
        'sendersJs': WHATSAPP_SENDERS_JS,
    },
    {
        'id': 'discord',
        'name': 'Discord',
        'url': 'https://discord.com/app',
        'emoji': '🎮',
        'prio': 'low',
        'group': 'private',
    },
]


# Same folder the Electron build used, so services.json / order.json / prio.json carry over
# and every reader of unread.json (mission-control) keeps finding it.
def data_dir():
    if MAC:
        base = Path.home() / 'Library' / 'Application Support'
    elif WINDOWS:
        base = Path(os.environ['APPDATA'])
    else:
        base = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config'))
    d = base / 'earshot'
    d.mkdir(parents=True, exist_ok=True)
    return d


DATA = data_dir()
SERVICES_PATH = DATA / 'services.json'
ORDER_PATH = DATA / 'order.json'
PRIO_PATH = DATA / 'prio.json'
STATE_PATH = DATA / 'unread.json'


def read_json(path, default):
    try:
        return json.loads(path.read_text('utf-8'))
    except (OSError, ValueError):
        return default


def write_json(path, data):
    try:
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), 'utf-8')
    except OSError:
        pass


def slug(s):
    return re.sub(r'^-+|-+$', '', re.sub(r'[^a-z0-9]+', '-', (s or '').lower())) or 'svc'


# Clean a list from the config UI: require name+url, assign stable unique ids, fill defaults.
def normalize_services(lst):
    used, out = set(), []
    for s in lst:
        if not (isinstance(s, dict) and s.get('name') and s.get('url')):
            continue
        sid = base = s.get('id') or slug(s['name'])
        n = 2
        while sid in used:
            sid, n = f'{base}-{n}', n + 1
        used.add(sid)
        svc = {
            'id': sid,
            'name': str(s['name']).strip(),
            'url': str(s['url']).strip(),
            'emoji': str(s.get('emoji') or '•').strip() or '•',
            'prio': 'high' if s.get('prio') == 'high' else 'low',
            'group': 'work' if s.get('group') == 'work' else 'private',
        }
        for k in ('unreadJs', 'sendersJs'):
            if s.get(k):
                svc[k] = s[k]
        out.append(svc)
    return out


# A services.json from an older version lacks `group`/`sendersJs`; for a seed service
# (matched by id) fill only what is ABSENT, so a value chosen in Settings wins.
def backfill_from_defaults(lst):
    changed = False
    for s in lst:
        seed = next((d for d in DEFAULT_SERVICES if d['id'] == s.get('id')), None)
        for key in ('group', 'unreadJs', 'sendersJs'):
            if seed and seed.get(key) and not s.get(key):
                s[key] = seed[key]
                changed = True
    return changed


def load_services():
    saved = read_json(SERVICES_PATH, None)
    if isinstance(saved, list) and saved:
        filled = backfill_from_defaults(saved)
        services = normalize_services(saved)
        if filled:
            write_json(SERVICES_PATH, services)
        if services:
            return services
    services = normalize_services(DEFAULT_SERVICES)
    write_json(SERVICES_PATH, services)
    return services


def parse_unread(title):
    # Chat/Slack/WhatsApp/Discord all put the count in the tab title: "(3) ..." / "(9+)".
    m = re.search(r'\((\d+)\+?\)', title or '')
    return int(m.group(1)) if m else 0


# Registrable-domain approximation (last two labels), used only to derive the same-service base.
def base_domain(host):
    return '.'.join(host.split('.')[-2:])


# Domain-boundary match: `slack.com` accepts `app.slack.com`, rejects `evilslack.com`.
def same_service(host, service_base):
    return host == service_base or host.endswith(f'.{service_base}')


def is_login_host(host):
    return bool(
        re.search(
            r'(^|\.)accounts\.google\.com$|(^|\.)accounts\.youtube\.com$|(^|\.)login\.microsoftonline\.com$', host
        )
    )


# Gmail/Chat wrap outbound links in https://www.google.com/url?q=<target>. Same base
# domain, so left alone they would hijack the pane; hand the real target out instead.
def redirect_target(url):
    u = QUrl(url)
    if re.search(r'(^|\.)google\.[a-z.]+$', u.host()) and u.path() == '/url':
        q = parse_qs(u.query(QUrl.ComponentFormattingOption.FullyDecoded))
        t = (q.get('q') or q.get('url') or [''])[0]
        if re.match(r'^https?://', t, re.I):
            return t
    return None


def classify_nav(url, service_base):
    host = QUrl(url).host()
    if not host:
        return 'deny'
    if redirect_target(url):
        return 'external'
    if is_login_host(host) or same_service(host, service_base):
        return 'in-view'
    return 'external'


# Only http/https may reach the OS browser — file://, smb://, app schemes are an RCE/exfil
# primitive. Redirector URLs are unwrapped so the browser opens the real destination.
def open_external_safe(url):
    target = QUrl(redirect_target(url) or url)
    if target.scheme() in ('http', 'https'):
        QDesktopServices.openUrl(target)


CTRL_RE = re.compile(r'[\x00-\x1f\x7f]')


# Senders come out of an untrusted page and end up in a file, then in someone's HTML.
# Bound them where they enter: strings only, 5 max, 60 chars, no control characters.
def sanitize_senders(lst):
    if not isinstance(lst, list):
        return []
    out = [CTRL_RE.sub(' ', x).strip()[:60] for x in lst if isinstance(x, str)]
    return [x for x in out if x][:5]


# Win32 gives a tray tooltip a 128-char buffer and cuts wherever it lands. Drop whole
# lines and say how many, so the breakdown that survives can be trusted.
TOOLTIP_MAX = 127


def fit_tooltip(lines):
    whole = '\n'.join(lines)
    if not WINDOWS or len(whole) <= TOOLTIP_MAX:
        return whole
    kept, length = [], 0
    for line in lines:
        room = TOOLTIP_MAX - len(f'\n+{len(lines) - len(kept)} more')
        if length + len(line) > room:
            break
        kept.append(line)
        length += len(line) + 1
    if not kept:
        return f'{len(lines)} services with unread messages'
    return '\n'.join(kept) + f'\n+{len(lines) - len(kept)} more'


# ---- the indicator --------------------------------------------------------
# macOS: the indicator is menubar TEXT ("💬2 ✉5 · 🟢3"). QSystemTrayIcon has no title,
# but it takes a non-square icon at menubar height, so the text is painted.
# Windows: a disc — grey all clear, amber low only, red high — with the total on it.
DISC_HIGH = QColor('#e5484d')
DISC_LOW = QColor('#f5a623')
DISC_CALM = QColor('#6e7681')


def title_icon(text):
    dpr = 2
    h = 18  # Qt fits tray icons to menubar thickness - 4
    font = QFont(QApplication.font())
    font.setPixelSize(14)
    w = QFontMetrics(font).horizontalAdvance(text) + 4
    pix = QPixmap(w * dpr, h * dpr)
    pix.fill(Qt.GlobalColor.transparent)
    p = QPainter(pix)
    p.scale(dpr, dpr)
    p.setFont(font)
    dark = QGuiApplication.styleHints().colorScheme() == Qt.ColorScheme.Dark
    p.setPen(QColor('white' if dark else 'black'))
    p.drawText(QRect(0, 0, w, h), Qt.AlignmentFlag.AlignCenter, text)
    p.end()
    return QIcon(pix)


def disc_icon(disc, label):
    icon = QIcon()
    # Every size Windows hands out (100/150/200 %): it rescales whatever is missing and
    # small digits do not survive a 32→24 resample.
    for size in (16, 24, 32):
        pix = QPixmap(size, size)
        pix.fill(Qt.GlobalColor.transparent)
        p = QPainter(pix)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(disc)
        m = size / 32
        p.drawEllipse(m, m, size - 2 * m, size - 2 * m)
        if label:
            font = QFont()
            font.setBold(True)
            font.setPixelSize(round(size * (0.7 if len(label) == 1 else 0.56)))
            p.setFont(font)
            p.setPen(QColor('white'))
            p.drawText(QRect(0, 0, size, size), Qt.AlignmentFlag.AlignCenter, label)
        p.end()
        icon.addPixmap(pix)
    return icon


def sidebar_icon(favicon, name, count):
    dpr = 2
    s = 48
    pix = QPixmap(s * dpr, s * dpr)
    pix.setDevicePixelRatio(dpr)
    pix.fill(Qt.GlobalColor.transparent)
    p = QPainter(pix)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    if favicon and not favicon.isNull():
        p.drawPixmap(9, 9, favicon.pixmap(30, 30))
    else:
        font = QFont()
        font.setPixelSize(18)
        font.setBold(True)
        p.setFont(font)
        p.setPen(QColor('#dbdee1'))
        p.drawText(QRect(0, 0, s, s), Qt.AlignmentFlag.AlignCenter, name[:1])
    if count > 0:
        label = '99+' if count > 99 else str(count)
        font = QFont()
        font.setPixelSize(11)
        font.setBold(True)
        bw = max(18, QFontMetrics(font).horizontalAdvance(label) + 10)
        r = QRect(s - bw, s - 18, bw, 18)
        p.setPen(QColor('#1e1f22'))
        p.setBrush(QColor('#f23f42'))
        p.drawRoundedRect(r, 9, 9)
        p.setFont(font)
        p.setPen(QColor('white'))
        p.drawText(r, Qt.AlignmentFlag.AlignCenter, label)
    p.end()
    icon = QIcon(pix)
    icon.addPixmap(pix, QIcon.Mode.Selected)  # no selection tint over the badge
    return icon


# ---- keeping a long-lived hub small ----------------------------------------
# Eight chat SPAs for weeks: caches emptied once a day and one view at a time reloaded
# (the only thing that gives a renderer its memory back), and only while the window has
# been put away. A reload loses unsent typed text, so the last-open view is exempt.
IDLE_S = 30 * 60
MAINTAIN_TICK_MS = 5 * 60 * 1000
RECYCLE_AFTER_S = 6 * 60 * 60
SWEEP_EVERY_S = 24 * 60 * 60
RELOAD_GRACE_S = 45  # a reloaded SPA paints its badges seconds after load; hold the old count
POLL_MS = 4000
IDLE_POLL_EVERY = 4  # while away, only every 4th poll tick (~16 s)
STATE_HEARTBEAT_MS = 30000
CACHE_MAX = 48 * 1024 * 1024


now = time.monotonic


# PySide hands JS objects and arrays back as '' — only scalars survive the trip, so
# serialise in the page and parse here. None when the script threw or the page is gone.
def run_json(page, js, cb):
    def done(raw):
        try:
            cb(json.loads(raw))
        except (TypeError, ValueError):
            cb(None)

    page.runJavaScript(f'(() => {{ try {{ return JSON.stringify({js}); }} catch (e) {{ return null; }} }})()', 0, done)


class ServicePage(QWebEnginePage):
    """Gates navigation: login + same-service hosts load in-view, the rest go to the browser."""

    def __init__(self, profile, svc, parent):
        super().__init__(profile, parent)
        self.base = base_domain(QUrl(svc['url']).host())
        self.newWindowRequested.connect(self._new_window)
        # Electron grants web permissions by default (notifications, mic for calls); keep that.
        self.permissionRequested.connect(lambda perm: perm.grant())

    # Like Electron's will-navigate: gate what the page itself starts (links, forms, JS),
    # not what we load or what the server redirects to — login flows redirect a lot.
    def acceptNavigationRequest(self, url, nav_type, is_main_frame):
        gated = (
            QWebEnginePage.NavigationType.NavigationTypeLinkClicked,
            QWebEnginePage.NavigationType.NavigationTypeFormSubmitted,
            QWebEnginePage.NavigationType.NavigationTypeOther,
        )
        if not is_main_frame or nav_type not in gated:
            return True
        if classify_nav(url.toString(), self.base) == 'in-view':
            return True
        open_external_safe(url.toString())
        return False

    def _new_window(self, req):
        url = req.requestedUrl().toString()
        decision = classify_nav(url, self.base)
        if decision == 'in-view':
            self.load(QUrl(url))
        elif decision == 'external':
            open_external_safe(url)


class Settings(QDialog):
    COLS = ['Icon', 'Name', 'URL', 'Priority', 'Mode']

    def __init__(self, hub):
        super().__init__()
        self.hub = hub
        self.setWindowTitle('Services')
        self.resize(760, 520)
        lay = QVBoxLayout(self)
        hint = QLabel(
            'Each service is an isolated login. Saving restarts the app (logins are kept).\n'
            'Priority drives the indicator; Mode is only a label passed to the state file.'
        )
        hint.setStyleSheet('color: #949ba4')
        lay.addWidget(hint)
        self.table = QTableWidget(0, len(self.COLS))
        self.table.setHorizontalHeaderLabels(self.COLS)
        self.table.verticalHeader().hide()
        hdr = self.table.horizontalHeader()
        hdr.setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        self.table.setColumnWidth(0, 50)
        self.table.setColumnWidth(1, 160)
        lay.addWidget(self.table)
        for s in hub.services:
            self.add_row(s)
        self.err = QLabel()
        self.err.setStyleSheet('color: #f23f42')
        row = QHBoxLayout()
        for text, fn in (('+ Add service', self.add_row), ('Remove selected', self.remove_row)):
            b = QPushButton(text)
            b.clicked.connect(lambda _=False, fn=fn: fn())
            row.addWidget(b)
        row.addStretch()
        cancel, save = QPushButton('Cancel'), QPushButton('Save && Restart')
        cancel.clicked.connect(self.reject)
        save.clicked.connect(self.save)
        save.setDefault(True)
        row.addWidget(cancel)
        row.addWidget(save)
        lay.addWidget(self.err)
        lay.addLayout(row)

    def add_row(self, s=None):
        s = s or {}
        r = self.table.rowCount()
        self.table.insertRow(r)
        icon = QTableWidgetItem(s.get('emoji', ''))
        # id + the JS extractors ride along invisibly, so editing a row keeps them.
        icon.setData(Qt.ItemDataRole.UserRole, {k: s[k] for k in ('id', 'unreadJs', 'sendersJs') if s.get(k)})
        self.table.setItem(r, 0, icon)
        self.table.setItem(r, 1, QTableWidgetItem(s.get('name', '')))
        self.table.setItem(r, 2, QTableWidgetItem(s.get('url', '')))
        for col, opts, cur in (
            (3, [('High (red)', 'high'), ('Low (quiet)', 'low')], s.get('prio', 'low')),
            (4, [('Private', 'private'), ('Work', 'work')], s.get('group', 'private')),
        ):
            box = QComboBox()
            for label, val in opts:
                box.addItem(label, val)
            box.setCurrentIndex(max(0, box.findData(cur)))
            self.table.setCellWidget(r, col, box)

    def remove_row(self):
        rows = sorted({i.row() for i in self.table.selectedIndexes()}, reverse=True)
        for r in rows:
            self.table.removeRow(r)

    def save(self):
        lst = []
        for r in range(self.table.rowCount()):
            cells = [self.table.item(r, c) for c in range(3)]
            emoji, name, url = ((c.text() if c else '').strip() for c in cells)
            extra = (cells[0].data(Qt.ItemDataRole.UserRole) if cells[0] else None) or {}
            lst.append(
                {
                    **extra,
                    'emoji': emoji,
                    'name': name,
                    'url': url,
                    'prio': self.table.cellWidget(r, 3).currentData(),
                    'group': self.table.cellWidget(r, 4).currentData(),
                }
            )
        if not lst:
            self.err.setText('Add at least one service.')
            return
        if any(not s['name'] or not s['url'] for s in lst):
            self.err.setText('Every service needs a name and a URL.')
            return
        write_json(SERVICES_PATH, normalize_services(lst))
        self.hub.relaunch()


class Window(QWidget):
    def __init__(self, hub):
        super().__init__()
        self.hub = hub
        self.hidden_since = now()

    # Close hides — that is what makes it a menubar app. A real quit (menu, ⌘Q, logout)
    # sets hub.quitting first, or a macOS logout would hang on a window that refuses to go.
    def closeEvent(self, e):
        if self.hub.quitting:
            e.accept()
        else:
            e.ignore()
            self.hide()

    def hideEvent(self, e):
        self.hidden_since = now()
        super().hideEvent(e)


class App(QApplication):
    # macOS hands earshot:// links over as FileOpen; Quit (⌘Q, logout, Apple event) must
    # mark the app as quitting before the windows are asked to close.
    def event(self, e):
        if e.type() == QEvent.Type.FileOpen and e.url().scheme() == 'earshot':
            self.hub.handle_deep_link(e.url().toString())
            return True
        if e.type() == QEvent.Type.Quit:
            self.hub.quitting = True
        return super().event(e)


class Hub:
    def __init__(self, app, server):
        self.app = app
        self.server = server
        self.quitting = False
        self.services = load_services()
        self.by_id = {s['id']: s for s in self.services}
        ids = list(self.by_id)
        saved = read_json(ORDER_PATH, [])
        saved = saved if isinstance(saved, list) else []
        self.order = [i for i in saved if i in self.by_id] + [i for i in ids if i not in saved]
        saved_prio = read_json(PRIO_PATH, {})
        saved_prio = saved_prio if isinstance(saved_prio, dict) else {}
        self.prio = {
            i: saved_prio.get(i) if saved_prio.get(i) in ('high', 'low') else self.by_id[i]['prio'] for i in ids
        }
        self.active = ids[0]
        self.unread = dict.fromkeys(ids, 0)
        self.signals = {i: {'title': 0, 'badge': 0, 'dom': 0} for i in ids}
        self.senders = {i: [] for i in ids}
        self.icons = {}
        self.loaded_at = dict.fromkeys(ids, now())
        self.reloading_until = {}
        self.last_sweep = now()
        self.tick = 0
        self.settings = None
        self.notif_service = None
        self.pages = {}
        self.views = {}

        self.win = Window(self)
        self.win.setWindowTitle('Earshot')
        self.win.resize(1200, 820)
        self.win.setStyleSheet('background: #1e1f22; color: #dbdee1;')
        if WINDOWS:  # no taskbar button — the tray is the app
            self.win.setWindowFlag(Qt.WindowType.Tool)
        root = QHBoxLayout(self.win)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        root.addWidget(self.build_sidebar())
        self.stack = QStackedWidget()
        root.addWidget(self.stack, 1)
        for s in self.services:
            self.create_view(s)
        self.stack.setCurrentWidget(self.views[self.active])
        self.refresh_sidebar()

        self.tray = QSystemTrayIcon()
        self.tray.activated.connect(self.on_tray)
        self.tray.messageClicked.connect(self.on_notification_click)
        self.update_tray()
        self.tray.show()

        for ms, fn in (
            (POLL_MS, self.poll_all),
            (STATE_HEARTBEAT_MS, self.write_state),
            (MAINTAIN_TICK_MS, self.maintain),
        ):
            t = QTimer(self.app)
            t.timeout.connect(fn)
            t.start(ms)
        self.write_state()
        self.app.aboutToQuit.connect(self.on_quit)

    # ---- views ----
    def create_view(self, s):
        sid = s['id']
        profile = QWebEngineProfile(sid, self.app)
        store = DATA / 'webengine' / sid
        profile.setPersistentStoragePath(str(store))
        profile.setCachePath(str(store / 'cache'))
        # Chrome drops session cookies on quit; a hub that restarts on every config save
        # would log you out of anything that only sets those.
        profile.setPersistentCookiesPolicy(QWebEngineProfile.PersistentCookiesPolicy.ForcePersistentCookies)
        profile.setHttpCacheMaximumSize(CACHE_MAX)
        profile.setHttpUserAgent(CHROME_UA)
        ch = profile.clientHints()
        ch.setAllClientHintsEnabled(True)
        ch.setPlatform('macOS')
        ch.setPlatformVersion('15.5.0')
        ch.setFullVersion(CHROME_FULL)
        ch.setFullVersionList({'Chromium': CHROME_FULL, 'Google Chrome': CHROME_FULL, 'Not=A?Brand': '24.0.0.0'})
        ch.setArch('arm' if platform.machine().lower() in ('arm64', 'aarch64') else 'x86')
        ch.setBitness('64')
        ch.setModel('')
        ch.setIsMobile(False)
        ch.setIsWow64(False)
        profile.setNotificationPresenter(lambda n, sid=sid: self.show_notification(sid, n))
        profile.downloadRequested.connect(lambda d: d.accept())  # into ~/Downloads

        script = QWebEngineScript()
        script.setSourceCode(BADGE_HOOK_JS)
        script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        script.setRunsOnSubFrames(False)
        profile.scripts().insert(script)

        page = ServicePage(profile, s, profile)
        view = QWebEngineView()
        view.setPage(page)
        page.titleChanged.connect(lambda t, sid=sid: self.set_signal(sid, 'title', parse_unread(t)))
        page.iconChanged.connect(lambda icon, sid=sid: (self.icons.__setitem__(sid, icon), self.refresh_sidebar()))
        page.loadFinished.connect(lambda _ok, sid=sid: self.loaded_at.__setitem__(sid, now()))
        page.load(QUrl(s['url']))
        self.pages[sid] = page
        self.views[sid] = view
        self.stack.addWidget(view)

    def set_signal(self, sid, kind, value):
        self.signals[sid][kind] = value
        self.recompute(sid)

    def recompute(self, sid):
        nxt = max(self.signals[sid].values())
        # A recycled view reports nothing between load and first paint; a false all-clear is
        # the worst thing this app can show, so a drop to zero inside our own reload waits.
        if nxt == 0 and now() < self.reloading_until.get(sid, 0):
            return
        if nxt == self.unread[sid]:
            return
        self.unread[sid] = nxt
        self.update_tray()
        self.refresh_sidebar()
        self.write_state()

    # Backstop poll for what has no event: the Badging API global and the DOM extractors.
    # Titles are event-driven. While away, read 4× less often.
    def poll_all(self):
        self.tick += 1
        if self.is_away() and self.tick % IDLE_POLL_EVERY:
            return
        for s in self.services:
            js = f'({{b: window.__earshotBadge|0, d: Number({s.get("unreadJs") or "0"}) || 0}})'
            run_json(self.pages[s['id']], js, lambda r, s=s: self.on_poll(s, r))

    def on_poll(self, s, r):
        sid = s['id']
        if isinstance(r, dict):
            self.signals[sid]['badge'] = int(r.get('b') or 0)
            self.signals[sid]['dom'] = int(r.get('d') or 0)
            self.recompute(sid)
        if not s.get('sendersJs'):
            return
        # Names only while something is unread — with an empty inbox there is nobody to name.
        if self.unread[sid] > 0:
            run_json(self.pages[sid], s['sendersJs'], lambda v, sid=sid: self.set_senders(sid, v))
        else:
            self.set_senders(sid, [])

    def set_senders(self, sid, value):
        nxt = sanitize_senders(value)
        if nxt != self.senders[sid]:
            self.senders[sid] = nxt
            self.write_state()  # a changed sender list is news even when the count didn't move

    # ---- sidebar ----
    def build_sidebar(self):
        side = QWidget()
        side.setFixedWidth(SIDEBAR_W)
        lay = QVBoxLayout(side)
        lay.setContentsMargins(0, 10, 0, 10)
        nav = QHBoxLayout()
        nav.setSpacing(2)
        for text, tip, fn in (
            ('‹', 'Back', lambda: self.pages[self.active].triggerAction(QWebEnginePage.WebAction.Back)),
            ('›', 'Forward', lambda: self.pages[self.active].triggerAction(QWebEnginePage.WebAction.Forward)),
            ('⌂', 'Home (reload service)', self.home),
        ):
            b = QToolButton()
            b.setText(text)
            b.setToolTip(tip)
            b.setFixedSize(20, 20)
            b.clicked.connect(fn)
            b.setStyleSheet(
                'QToolButton{background:#2b2d31;border:none;border-radius:6px}QToolButton:hover{background:#404249}'
            )
            nav.addWidget(b)
        lay.addLayout(nav)
        self.list = QListWidget()
        self.list.setIconSize(QSize(48, 48))
        self.list.setDragDropMode(QAbstractItemView.DragDropMode.InternalMove)
        self.list.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.list.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.list.setStyleSheet(
            'QListWidget{border:none;background:#1e1f22;outline:0}'
            'QListWidget::item{background:#2b2d31;border-radius:14px;margin:4px 10px;padding:0}'
            'QListWidget::item:hover{background:#35373c}'
            'QListWidget::item:selected{background:#404249;border-left:3px solid white}'
        )
        self.list.itemClicked.connect(lambda it: self.switch_to(it.data(Qt.ItemDataRole.UserRole)))
        self.list.model().rowsMoved.connect(self.on_reorder)
        lay.addWidget(self.list)
        return side

    def refresh_sidebar(self):
        if self.list.count() != len(self.order):
            self.list.clear()
            for sid in self.order:
                it = QListWidgetItem()
                it.setData(Qt.ItemDataRole.UserRole, sid)
                it.setToolTip(self.by_id[sid]['name'])
                self.list.addItem(it)
        for i in range(self.list.count()):
            it = self.list.item(i)
            sid = it.data(Qt.ItemDataRole.UserRole)
            it.setIcon(sidebar_icon(self.icons.get(sid), self.by_id[sid]['name'], self.unread[sid]))
            if sid == self.active:
                self.list.setCurrentItem(it)

    def on_reorder(self, *_):
        self.order = [self.list.item(i).data(Qt.ItemDataRole.UserRole) for i in range(self.list.count())]
        write_json(ORDER_PATH, self.order)
        self.update_tray()
        self.write_state()

    def switch_to(self, sid):
        if sid not in self.views:
            return
        self.active = sid
        self.stack.setCurrentWidget(self.views[sid])
        self.refresh_sidebar()

    # Home: reload the start URL — the escape from a page the nav gate got stuck on.
    def home(self):
        self.pages[self.active].load(QUrl(self.by_id[self.active]['url']))

    # ---- window / tray ----
    def show_window(self):
        self.win.showMaximized()
        self.win.raise_()
        self.win.activateWindow()

    def toggle_window(self):
        if self.win.isVisible() and self.win.isActiveWindow():
            self.win.hide()
        else:
            self.show_window()

    def is_away(self):
        return not self.win.isVisible() and now() - self.win.hidden_since >= IDLE_S

    def ordered(self):
        return [self.by_id[i] for i in self.order]

    def update_tray(self):
        unread = [s for s in self.ordered() if self.unread[s['id']] > 0]
        high = [s for s in unread if self.prio[s['id']] == 'high']
        low = [s for s in unread if self.prio[s['id']] == 'low']
        total = sum(self.unread.values())
        if WINDOWS or not MAC:
            disc = DISC_HIGH if high else DISC_LOW if low else DISC_CALM
            self.tray.setIcon(disc_icon(disc, '' if total <= 0 else '9+' if total > 99 else str(total)))
        else:
            fmt = lambda arr: ' '.join(f'{s["emoji"]}{self.unread[s["id"]]}' for s in arr)  # noqa: E731
            parts = [fmt(high)] if high else []
            if low:
                parts.append(('· ' if high else '') + fmt(low))
            self.tray.setIcon(title_icon('  '.join(parts) if parts else '💬'))
        detail = fit_tooltip([f'{s["name"]}: {self.unread[s["id"]]} ({self.prio[s["id"]]})' for s in unread])
        self.tray.setToolTip(detail or 'Earshot — no new messages')

    def on_tray(self, reason):
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            self.toggle_window()
        elif reason == QSystemTrayIcon.ActivationReason.Context:
            self.menu().popup(QCursor.pos())

    def menu(self):
        m = QMenu()
        for s in self.ordered():
            n = self.unread[s['id']]
            m.addAction(
                s['name'] + (f'  ({n})' if n else ''), lambda sid=s['id']: (self.show_window(), self.switch_to(sid))
            )
        m.addSeparator()
        sub = m.addMenu('Priority (high = red alert)')
        for s in self.ordered():
            a = sub.addAction(s['name'], lambda sid=s['id']: self.toggle_prio(sid))
            a.setCheckable(True)
            a.setChecked(self.prio[s['id']] == 'high')
        m.addSeparator()
        m.addAction('Edit services…', self.open_settings)
        m.addAction('Reload current', lambda: self.pages[self.active].triggerAction(QWebEnginePage.WebAction.Reload))
        m.addAction('Quit', self.quit)
        self._menu = m  # keep a reference while it is open
        return m

    def toggle_prio(self, sid):
        self.prio[sid] = 'low' if self.prio[sid] == 'high' else 'high'
        write_json(PRIO_PATH, self.prio)
        self.update_tray()
        self.write_state()

    def show_notification(self, sid, n):
        self.notif_service = sid
        self.tray.showMessage(n.title(), n.message())
        n.show()

    def on_notification_click(self):
        self.show_window()
        if self.notif_service:
            self.switch_to(self.notif_service)

    def open_settings(self):
        if not self.settings:
            self.settings = Settings(self)
            self.settings.finished.connect(lambda _: setattr(self, 'settings', None))
        self.settings.show()
        self.settings.raise_()
        self.settings.activateWindow()

    def quit(self):
        self.quitting = True
        self.app.quit()

    # Restart so all views rebuild cleanly. Release the single-instance socket first, or the
    # new process would find us still listening and hand its launch back to a dying app.
    def relaunch(self):
        self.server.close()
        args = sys.argv[1:] if FROZEN else sys.argv
        QProcess.startDetached(sys.executable, [a for a in args if not a.startswith('earshot://')])
        self.quit()

    # ---- state export: unread.json ----
    # The `at` stamp is a HEARTBEAT (rewritten every 30 s even when nothing moved), so a
    # reader can tell "no unread" (fresh, zeros) from "earshot is not running" (stale).
    # tmp + rename, so a reader never sees a half-written file.
    def write_state(self):
        if self.quitting:  # teardown fires title changes; never resurrect the file on_quit removed
            return
        payload = {
            'at': datetime.now(UTC).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            'total': sum(self.unread.values()),
            'services': [
                {
                    'id': s['id'],
                    'name': s['name'],
                    'emoji': s['emoji'],
                    'prio': self.prio[s['id']],
                    'group': s.get('group', 'private'),
                    'unread': self.unread[s['id']],
                    'senders': self.senders[s['id']],
                }
                for s in self.ordered()
            ],
        }
        tmp = STATE_PATH.with_suffix('.json.tmp')
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp, STATE_PATH)
        except OSError:
            pass

    # ---- deep link: earshot://open/<service-id> ----
    # Only ids of configured services, and deliberately NO url parameter: any process can
    # open a URL scheme, and "load this address in my logged-in session" is not a knob to hand out.
    def handle_deep_link(self, raw):
        u = QUrl(raw)
        if u.scheme() != 'earshot':
            return
        self.show_window()
        sid = u.path().lstrip('/')
        if u.host() == 'open' and sid in self.views:
            self.switch_to(sid)

    def on_message(self, msg):
        if msg.startswith('earshot://'):
            self.handle_deep_link(msg)
        else:
            self.show_window()

    # ---- housekeeping ----
    def maintain(self):
        if not self.is_away():
            return
        if now() - self.last_sweep > SWEEP_EVERY_S:
            self.last_sweep = now()
            # The HTTP cache only — cookies, IndexedDB and service workers are the logins.
            for page in self.pages.values():
                page.profile().clearHttpCache()
        t = now()
        stale = sorted(
            (s for s in self.services if s['id'] != self.active and t - self.loaded_at[s['id']] > RECYCLE_AFTER_S),
            key=lambda s: self.loaded_at[s['id']],
        )
        if stale:  # one per tick — eight at once is a stampede, not maintenance
            sid = stale[0]['id']
            self.loaded_at[sid] = t  # claim it, so a load that never finishes is not picked again
            self.reloading_until[sid] = t + RELOAD_GRACE_S
            self.pages[sid].triggerAction(QWebEnginePage.WebAction.Reload)

    # A missing unread.json is how a reader knows earshot is gone; make that immediate.
    def on_quit(self):
        try:
            STATE_PATH.unlink()
        except OSError:
            pass
        # Pages before profiles, or Qt warns that a profile is released while still in use.
        for view in self.views.values():
            view.setPage(None)
        for page in self.pages.values():
            page.deleteLater()


# Start at login and own earshot://, from the built app only (a dev run must not register
# itself). macOS gets the scheme from Info.plist (see build.sh).
def register_with_os():
    if not FROZEN:
        return
    if MAC:
        import plistlib

        bundle = Path(sys.executable).resolve().parents[2]
        agent = Path.home() / 'Library' / 'LaunchAgents' / 'uk.metzner.earshot.plist'
        want = {
            'Label': 'uk.metzner.earshot',
            'RunAtLoad': True,
            'ProgramArguments': ['/usr/bin/open', '-g', str(bundle)],
        }
        try:
            if not agent.exists() or plistlib.loads(agent.read_bytes()) != want:
                agent.parent.mkdir(parents=True, exist_ok=True)
                agent.write_bytes(plistlib.dumps(want))
        except (OSError, ValueError):
            pass
    elif WINDOWS:
        import winreg

        exe = f'"{sys.executable}"'
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run') as k:
            winreg.SetValueEx(k, 'Earshot', 0, winreg.REG_SZ, exe)
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r'Software\Classes\earshot') as k:
            winreg.SetValueEx(k, '', 0, winreg.REG_SZ, 'URL:Earshot')
            winreg.SetValueEx(k, 'URL Protocol', 0, winreg.REG_SZ, '')
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r'Software\Classes\earshot\shell\open\command') as k:
            winreg.SetValueEx(k, '', 0, winreg.REG_SZ, f'{exe} "%1"')


def main():
    if WINDOWS:  # recognisable name in Task Manager's Startup tab and on notifications
        import ctypes

        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('uk.metzner.earshot')
    app = App(sys.argv)
    app.setApplicationName('earshot')
    app.setQuitOnLastWindowClosed(False)

    # Single instance. A second launch is how an earshot:// link reaches the running app on
    # Windows (and a plain re-launch means "show the window"): pass it on and leave.
    link = next((a for a in sys.argv[1:] if a.startswith('earshot://')), '')
    name = f'earshot-{os.environ.get("USER") or os.environ.get("USERNAME", "")}'
    sock = QLocalSocket()
    sock.connectToServer(name)
    if sock.waitForConnected(500):
        sock.write((link or 'show').encode())
        sock.waitForBytesWritten(500)
        return 0
    QLocalServer.removeServer(name)
    server = QLocalServer()
    server.listen(name)

    register_with_os()
    hub = Hub(app, server)
    app.hub = hub

    def on_conn():
        c = server.nextPendingConnection()
        c.readyRead.connect(lambda: hub.on_message(bytes(c.readAll()).decode(errors='replace')))

    server.newConnection.connect(on_conn)
    if link:  # cold start from a link (Windows): the URL is in our own argv
        hub.handle_deep_link(link)
    return app.exec()


if __name__ == '__main__':
    sys.exit(main())
