'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAwgConfig, matchesAwgConfig } = require('../lib/CellAwgSnapshot');
const key = n => Buffer.alloc(32, n).toString('base64');
const base = `[Interface]\nPrivateKey = ${key(1)}\nListenPort = 54322\nJc = 5\nRandomTrailers = on\n[Peer]\nPublicKey = ${key(2)}\nAllowedIPs = 10.88.0.2/32, fd88::2/128\nPersistentKeepalive = 5\n`;
test('AWG snapshot canonicalizes whitespace, addresses, ranges and default fields', () => {
  const other = base.replace('Jc = 5', 'Jc = 05\nFwMark = off').replace('RandomTrailers = on', 'RandomTrailers = true')
    .replace('fd88::2/128', 'fd88:0:0:0:0:0:0:2/128').replace('PersistentKeepalive = 5', 'PersistentKeepalive = 5-5');
  assert.equal(matchesAwgConfig(base, other), true);
  assert.deepEqual(normalizeAwgConfig(base).peers[0].allowedips, ['10.88.0.2/32', 'fd88::2/128']);
});
test('AWG snapshot detects changed keys, profile, peer identity and AllowedIPs', () => {
  for (const changed of [base.replace(key(1), key(4)), base.replace('Jc = 5', 'Jc = 6'),
    base.replace(key(2), key(3)), base.replace('10.88.0.2/32', '0.0.0.0/0'), base.replace('= on', '= off')]) {
    assert.equal(matchesAwgConfig(base, changed), false);
  }
});
test('unconfigured peer endpoints can roam but explicitly configured transit endpoints are pinned', () => {
  const learned = base + 'Endpoint = 192.0.2.1:12345\n';
  assert.equal(matchesAwgConfig(base, learned), true);
  assert.equal(matchesAwgConfig(learned, learned.replace('12345', '54321')), false);
  const v6 = base + 'Endpoint = [fd99::1]:12345\n';
  assert.equal(matchesAwgConfig(v6, v6.replace('fd99::1', 'fd99:0:0:0:0:0:0:1')), true);
});
test('an unconfigured client listen port may be assigned dynamically, but an explicit port remains pinned', () => {
  const client = base.replace('ListenPort = 54322\n', '');
  assert.equal(matchesAwgConfig(client, base), true);
  assert.equal(matchesAwgConfig(base, base.replace('54322', '54323')), false);
});
test('peer ordering is irrelevant, duplicate identities and fields are rejected', () => {
  const peer = `[Peer]\nPublicKey = ${key(3)}\nAllowedIPs = 10.88.0.3/32\n`;
  const [iface, first] = base.split('[Peer]');
  assert.equal(matchesAwgConfig(base + peer, iface + peer + '[Peer]' + first), true);
  assert.throws(() => normalizeAwgConfig(base + peer.replace(key(3), key(2))), /duplicate/);
  assert.throws(() => normalizeAwgConfig(base + 'AllowedIPs = ::/0\n'), /duplicate/);
});
test('hooks, unknown fields and malformed values are rejected without exposing config secrets', () => {
  for (const text of [base.replace('ListenPort = 54322', 'PostUp = anything'), base + 'UnknownField = x\n',
    base.replace(key(1), 'invalid_secret'), base.replace('Jc = 5', 'Jc = 4294967296'),
    base + 'Endpoint = example.org:12345\n', base.replace('fd88::2/128', 'fd88::2/129')]) {
    assert.throws(() => normalizeAwgConfig(text), error => !error.message.includes('invalid_secret') && !error.message.includes(key(1)));
  }
});
