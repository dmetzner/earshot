// Runs inside each service page (contextIsolation off) so it can intercept the
// Badging API the web apps use to report unread counts to the OS.
const { ipcRenderer } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--service-id='));
const id = arg ? arg.split('=')[1] : 'unknown';

function report(n) {
  ipcRenderer.send('badge', id, Number(n) || 0);
}

// Override on the prototype — direct assignment to navigator.setAppBadge can be
// a silent no-op if the property is read-only.
try {
  Object.defineProperty(Navigator.prototype, 'setAppBadge', {
    configurable: true,
    value: (n) => {
      report(n || 0);
      return Promise.resolve();
    },
  });
  Object.defineProperty(Navigator.prototype, 'clearAppBadge', {
    configurable: true,
    value: () => {
      report(0);
      return Promise.resolve();
    },
  });
} catch (_e) {}
