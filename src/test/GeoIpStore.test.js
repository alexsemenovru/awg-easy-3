'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { GeoIpStore, parseRipeDelegations, rangeToCidrs } = require('../lib/GeoIpStore');

const DATA = [
  '2|ripencc|20260823|0|0|20260823|summary',
  'ripencc|RU|ipv4|5.8.0.0|1024|20100901|allocated',
  'ripencc|RU|ipv4|5.8.4.0|768|20100901|allocated',
  'ripencc|DE|ipv4|5.9.0.0|256|20100901|allocated',
  'ripencc|RU|ipv6|2001:db8::|32|20100901|allocated',
].join('\n');

test('converts RIPE allocation counts into exact CIDR coverage', () => {
  assert.deepEqual(rangeToCidrs(0x05080400n, 768n), ['5.8.4.0/23', '5.8.6.0/24']);
  assert.deepEqual(parseRipeDelegations(DATA), ['5.8.0.0/22', '5.8.4.0/23', '5.8.6.0/24']);
});

test('atomically updates and reloads a validated local list', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-geoip-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'ru-ipv4.txt');
  const store = new GeoIpStore(filePath, { fetchText: async () => DATA, minRecords: 2 });
  assert.deepEqual(await store.update(), ['5.8.0.0/22', '5.8.4.0/23', '5.8.6.0/24']);
  assert.deepEqual(await store.load(), ['5.8.0.0/22', '5.8.4.0/23', '5.8.6.0/24']);
  assert.match(await fs.readFile(filePath, 'utf8'), /ftp\.ripe\.net/);
});

test('does not replace a good list with incomplete source data', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-geoip-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'ru-ipv4.txt');
  await fs.writeFile(filePath, '5.8.0.0/22\n5.8.4.0/23\n');
  const store = new GeoIpStore(filePath, {
    fetchText: async () => 'ripencc|RU|ipv4|5.8.0.0|256|date|allocated',
    minRecords: 2,
  });
  await assert.rejects(store.update(), /only 1 usable/);
  assert.equal(await fs.readFile(filePath, 'utf8'), '5.8.0.0/22\n5.8.4.0/23\n');
});
