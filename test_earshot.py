"""Self-check for the pure logic: `uv run python test_earshot.py`."""

import earshot as e

assert e.parse_unread('(3) Inbox') == 3
assert e.parse_unread('(9+) Slack') == 9
assert e.parse_unread('Inbox') == 0

assert e.same_service('app.slack.com', 'slack.com')
assert not e.same_service('evilslack.com', 'slack.com')

assert e.redirect_target('https://www.google.com/url?q=https://example.org/a%3Fb') == 'https://example.org/a?b'
assert e.redirect_target('https://www.google.com/url?q=file:///etc/passwd') is None
assert e.classify_nav('https://www.google.com/url?q=https://x.org', 'google.com') == 'external'
assert e.classify_nav('https://accounts.google.com/signin', 'slack.com') == 'in-view'
assert e.classify_nav('https://files.slack.com/x', 'slack.com') == 'in-view'
assert e.classify_nav('https://example.org', 'slack.com') == 'external'
assert e.classify_nav('not a url', 'slack.com') == 'deny'

assert e.sanitize_senders(['Ada\x00\nL', 3, '', 'x' * 99, 'b', 'c', 'd', 'e']) == ['Ada  L', 'x' * 60, 'b', 'c', 'd']
assert e.sanitize_senders('nope') == []

svcs = e.normalize_services(
    [{'name': 'Slack', 'url': 'u'}, {'name': 'Slack', 'url': 'v', 'prio': 'high'}, {'name': 'x'}]
)
assert [s['id'] for s in svcs] == ['slack', 'slack-2'] and svcs[1]['prio'] == 'high' and svcs[0]['group'] == 'private'

old = [{'id': 'gchat', 'name': 'Chat', 'url': 'u'}, {'id': 'gmail', 'name': 'M', 'url': 'u', 'group': 'private'}]
assert e.backfill_from_defaults(old) and old[0]['group'] == 'work' and old[1]['group'] == 'private'

e.WINDOWS = True
tip = e.fit_tooltip([f'Service number {i}: {i} (high)' for i in range(10)])
assert len(tip) <= e.TOOLTIP_MAX and tip.endswith('more'), tip
print('ok')
