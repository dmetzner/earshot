// Navigation policy for service views: which URLs may load inside a logged-in
// view and which go to the OS browser. No Electron imports, so `node --test`
// can cover it directly (test/nav.test.js).

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

// Hosts a sign-in flow passes through, which must stay in-view (cookies land in the
// view's session) even though they are not the service's own domain. Google's
// SetSID hop visits accounts.google.<ccTLD>; the suffix is pinned to the shapes
// Google uses (com, xx, co.xx, com.xx) so accounts.google.evil.com cannot match.
const LOGIN_HOST_RE =
  /(^|\.)accounts\.google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$|(^|\.)accounts\.youtube\.com$|(^|\.)login\.(microsoftonline|microsoft|live)\.com$/;
function isLoginHost(host) {
  return LOGIN_HOST_RE.test(host);
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

module.exports = { baseDomain, classifyNav, isLoginHost, redirectTarget };
