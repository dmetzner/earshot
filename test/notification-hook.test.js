const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// BADGE_HOOK_JS runs inside each chat page; main.js needs Electron, so read the string out.
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const hook = new Function(`return ${src.match(/const BADGE_HOOK_JS = (`[\s\S]*?`);\n/)[1]}`)();

test('a notification click logs the line main.js listens for', () => {
  class N {
    constructor() {
      this.on = {};
    }
    addEventListener(k, f) {
      this.on[k] = f;
    }
    static get permission() {
      return 'granted';
    }
    static requestPermission() {
      return Promise.resolve('granted');
    }
  }
  const logged = [];
  const window = { Notification: N };
  new Function('window', 'Navigator', 'console', hook)(window, class {}, {
    debug: (m) => logged.push(m),
  });
  const n = new window.Notification('hi');
  assert.ok(n instanceof N);
  assert.strictEqual(window.Notification.permission, 'granted');
  n.on.click();
  assert.deepStrictEqual(logged, ['__earshot:open']);
  // Hidden by mode: no real notification is created at all.
  window.__earshotQuiet = true;
  assert.ok(!(new window.Notification('secret') instanceof N));
  assert.match(src, /'console-message'[\s\S]{0,120}'__earshot:open'/);
});
