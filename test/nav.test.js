const test = require('node:test');
const assert = require('node:assert');
const { classifyNav, isLoginHost } = require('../nav');

test('isLoginHost accepts the sign-in hosts Google and Microsoft redirect through', () => {
  for (const h of [
    'accounts.google.com',
    'accounts.google.at',
    'accounts.google.co.uk',
    'accounts.google.com.au',
    'accounts.youtube.com',
    'login.microsoftonline.com',
    'login.microsoft.com',
    'login.live.com',
  ]) {
    assert.ok(isLoginHost(h), h);
  }
});

test('isLoginHost rejects look-alikes', () => {
  for (const h of [
    'accounts.google.evil.com',
    'accounts.google.com.evil.com',
    'accounts.google.co.evil.io',
    'accounts-google.com',
    'evilaccounts.google.com.x',
    'login.live.com.evil.com',
    'login.microsoftonline.com.evil.net',
    'notlogin.live.co',
  ]) {
    assert.ok(!isLoginHost(h), h);
  }
});

test('classifyNav keeps same-service and login hosts in-view, sends the rest out', () => {
  assert.strictEqual(classifyNav('https://app.slack.com/client', 'slack.com'), 'in-view');
  assert.strictEqual(classifyNav('https://accounts.google.de/SetSID', 'google.com'), 'in-view');
  assert.strictEqual(classifyNav('https://evilslack.com/', 'slack.com'), 'external');
  assert.strictEqual(
    classifyNav('https://www.google.com/url?q=https://x.example', 'google.com'),
    'external',
  );
  assert.strictEqual(classifyNav('not a url', 'slack.com'), 'deny');
});
