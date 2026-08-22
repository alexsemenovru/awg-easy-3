'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TABLE_NAME,
  buildAtomicNftBatch,
  renderNftablesPolicy,
} = require('../lib/NftablesPolicy');

const basePolicy = () => ({
  interfaceName: 'awg0',
  wanInterface: 'eth0',
  ipv4Subnet: '10.8.0.0/24',
  home4: ['10.8.0.2'],
  guest4: ['10.8.0.3'],
});

test('renders only the dedicated AWG-Easy 3 table', () => {
  const rules = renderNftablesPolicy(basePolicy());
  assert.match(rules, new RegExp(`table inet ${TABLE_NAME}`));
  assert.doesNotMatch(rules, /flush ruleset/);
  assert.doesNotMatch(rules, /delete table/);
  assert.doesNotMatch(rules, /iptables/);
});

test('allows home peer traffic and isolates guest peer traffic', () => {
  const rules = renderNftablesPolicy(basePolicy());
  assert.match(rules, /ip saddr @home4 ip daddr @home4 accept/);
  assert.match(rules, /iifname "awg0" oifname "awg0" drop comment "isolate guest peers"/);
  assert.match(rules, /ip saddr @guest4 ip daddr 10\.8\.0\.0\/24 drop/);
  assert.match(rules, /ip saddr @home4 tcp dport 51821 accept/);
});

test('adds IPv6 home, guest and RU-direct blocking policy when enabled', () => {
  const rules = renderNftablesPolicy({
    ...basePolicy(),
    ipv6Subnet: 'fd42:8:3::/64',
    home6: ['fd42:8:3::2'],
    guest6: ['fd42:8:3::3'],
    blockIPv6: ['fd42:8:3::3'],
  });
  assert.match(rules, /set block_ipv6/);
  assert.match(rules, /ip6 saddr @block_ipv6 drop/);
  assert.match(rules, /ip6 saddr @home6 ip6 daddr @home6 accept/);
});

test('rejects peer membership overlap', () => {
  assert.throws(
    () => renderNftablesPolicy({ ...basePolicy(), guest4: ['10.8.0.2'] }),
    /both home and guest/,
  );
});

test('rejects values that could inject nft syntax', () => {
  assert.throws(
    () => renderNftablesPolicy({ ...basePolicy(), interfaceName: 'awg0;flush' }),
    /interfaceName/,
  );
  assert.throws(
    () => renderNftablesPolicy({ ...basePolicy(), home4: ['10.8.0.2; drop'] }),
    /invalid IPv4/,
  );
});

test('replaces only its own existing table in one nft batch', () => {
  const policy = renderNftablesPolicy(basePolicy());
  const initial = buildAtomicNftBatch(policy);
  const replacement = buildAtomicNftBatch(policy, { tableExists: true });

  assert.match(initial, /^# Managed by AWG-Easy 3/);
  assert.match(replacement, /^delete table inet awg_easy_3\n# Managed by AWG-Easy 3/);
  assert.equal((replacement.match(/delete table/g) || []).length, 1);
});

test('refuses destructive statements in externally supplied policy text', () => {
  assert.throws(
    () => buildAtomicNftBatch(`flush ruleset\ntable inet ${TABLE_NAME} {}`),
    /forbidden destructive/,
  );
});
