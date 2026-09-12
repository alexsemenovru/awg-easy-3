'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { GeoIpUpdater, packSnapshot, unpackSnapshot } = require('../lib/GeoIpUpdater');
const { parseDatabase, downloadDatabase, databaseUrl, MAX_DOWNLOAD } = require('../lib/GeoIpSource');
const { parseInWorker } = require('../lib/GeoIpWorker');
const { validatePrefixes } = require('../lib/GeoIpPolicy');
const { ipNumber } = require('../lib/GeoIpAddress');

const bytes = gzipSync('"192.0.2.0","192.0.2.255","RU"\r\n2001:db8::,2001:db8::ff,RU\n');
const parse = async buffer => parseDatabase(buffer, { minRows: 2, minCountries: 1 });
const fixture = async (t, options = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-geo-test-'));
  const errors = [];
  const updater = new GeoIpUpdater({ directory, parse, download: async () => bytes,
    now: () => new Date('2026-09-10T12:00:00Z'), onError: error => errors.push(error), ...options });
  t.after(async () => { await updater.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return { updater, errors, directory };
};

test('DB-IP CSV validates both families, quoting and nft ranges', async () => {
  const result = await parse(bytes);
  assert.equal(result.rows, 2);
  assert.deepEqual(result.database.RU, { ipv4: ['192.0.2.0-192.0.2.255'], ipv6: ['2001:db8::-2001:db8::ff'] });
  assert.deepEqual(validatePrefixes(result.database.RU.ipv6, 6), result.database.RU.ipv6);
  assert.equal(ipNumber('::ffff:192.0.2.1'), ipNumber('::ffff:c000:201'));
  assert.throws(() => validatePrefixes(['2001:db8::ff-2001:db8::'], 6), /Invalid/);
  for (const csv of ['192.0.2.1,192.0.2.0,RU', '192.0.2.0,::1,RU', '192.0.2.0,192.0.2.1,RU;flush ruleset',
    '192.0.2.0,192.0.2.255,RU\n192.0.2.1,192.0.2.2,US', '192.0.2.0,192.0.2.255,RU']) {
    assert.throws(() => parseDatabase(gzipSync(csv), { minRows: 1, minCountries: 1 }), /GeoIP/);
  }
  assert.throws(() => parseDatabase(Buffer.from('not gzip')));
  assert.throws(() => parseDatabase(bytes), /Incomplete/);
  await assert.rejects(parseInWorker(bytes), /Incomplete/);
});

test('snapshot checksum detects truncation and corruption', () => {
  const packed = packSnapshot('2026-09', bytes);
  assert.deepEqual(unpackSnapshot(packed), { release: '2026-09', bytes });
  packed[packed.length - 1] ^= 1;
  assert.throws(() => unpackSnapshot(packed), /checksum/);
  assert.throws(() => unpackSnapshot(Buffer.from('bad')), /Invalid/);
  assert.throws(() => databaseUrl('../../other'), /Invalid/);
});

test('worker accepts a production-sized synthetic database without blocking the main thread', async () => {
  const rows = [];
  for (let i = 0; i < 100000; i++) {
    const address = `11.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    // Synthetic alpha-2 labels deliberately test format, not geolocation accuracy.
    const code = String.fromCharCode(65 + Math.floor((i % 200) / 26), 65 + (i % 26));
    rows.push(`${address},${address},${code}`);
  }
  rows.push('2001:db8::,2001:db8::ffff,AA');
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 0);
  const result = await parseInWorker(gzipSync(rows.join('\n')));
  clearTimeout(timer);
  assert.equal(ticked, true);
  assert.equal(result.rows, 100001);
  assert.ok(result.countries.length >= 200);
});

test('automatically downloads once, saves atomically and restores without a network', async t => {
  let downloads = 0;
  const { updater, directory } = await fixture(t, { download: async () => { downloads++; return bytes; } });
  assert.equal(await updater.load(), null);
  await updater.refresh();
  await updater.refresh();
  assert.equal(downloads, 1);
  assert.equal(updater.status.state, 'ready');
  assert.equal(updater.current.release, '2026-09');
  assert.deepEqual(await fs.readdir(directory), ['current.db']);
  const restored = new GeoIpUpdater({ directory, parse, download: () => { throw new Error('offline'); } });
  assert.equal((await restored.load()).release, '2026-09');
});

test('failed downloads, parsing and rename preserve the last working snapshot', async t => {
  let date = new Date('2026-09-10T00:00:00Z');
  const { updater, directory } = await fixture(t, { now: () => date });
  await updater.refresh();
  const previous = await fs.readFile(updater.filename);
  date = new Date('2026-10-10T00:00:00Z');
  updater.download = async () => { throw new Error('offline'); };
  await updater.refresh();
  assert.equal(updater.status.state, 'stale');
  updater.download = async () => Buffer.from('invalid');
  await updater.refresh();
  updater.download = async () => bytes;
  updater.fs = { ...fs, rename: async () => { throw new Error('disk failure'); } };
  await updater.refresh();
  assert.equal(updater.current.release, '2026-09');
  assert.deepEqual(await fs.readFile(updater.filename), previous);
  assert.deepEqual(await fs.readdir(directory), ['current.db']);
});

test('fallback to previous month only for a first-install 404, never a general network failure', async t => {
  const releases = [];
  const { updater } = await fixture(t, { download: async release => {
    releases.push(release);
    if (release === '2026-09') throw Object.assign(new Error('not published'), { status: 404 });
    return bytes;
  } });
  await updater.refresh();
  assert.deepEqual(releases, ['2026-09', '2026-08']);
  assert.equal(updater.current.release, '2026-08');
  await updater.refresh();
  assert.deepEqual(releases, ['2026-09', '2026-08', '2026-09']);
  assert.equal(updater.status.state, 'stale');
});

test('updater is single flight and stop cancels an in-progress download', async t => {
  let calls = 0;
  const { updater } = await fixture(t, { download: (release, { signal }) => new Promise((resolve, reject) => {
    calls++;
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) });
  const first = updater.refresh();
  assert.equal(updater.refresh(), first);
  await updater.stop();
  assert.equal(calls, 1);
  assert.equal(updater.current, null);
});

test('scheduler retries with backoff and runs independently of reboot', async t => {
  const timers = [];
  const { updater } = await fixture(t, { random: () => 0,
    setTimer: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, clearTimer: () => {},
    download: async () => { throw new Error('offline'); } });
  updater.start(); updater.start();
  assert.equal(timers.length, 1);
  await timers.shift().fn();
  assert.equal(timers[0].delay, 300000);
  await timers.shift().fn();
  assert.equal(timers[0].delay, 600000);
  updater.download = async () => bytes;
  await timers.shift().fn();
  assert.equal(timers[0].delay, 86400000);
});

test('HTTPS downloader checks size, status, redirects and enforces deadlines', async () => {
  let options;
  assert.deepEqual(await downloadDatabase('2026-09', { fetchImpl: async (url, input) => {
    options = input;
    assert.match(url, /^https:\/\/download\.db-ip\.com\/free\/dbip-country-lite-2026-09\.csv\.gz$/);
    return new Response(bytes);
  } }), bytes);
  assert.equal(options.redirect, 'error');
  await assert.rejects(downloadDatabase('2026-09', { fetchImpl: async () => new Response('', { status: 404 }) }), /404/);
  await assert.rejects(downloadDatabase('2026-09', { fetchImpl: async () => new Response('x', {
    headers: { 'content-length': String(MAX_DOWNLOAD + 1) },
  }) }), /large/);
  await assert.rejects(downloadDatabase('2026-09', { timeoutMs: 10, fetchImpl: () => new Promise(() => {}) }), /timed out/);
});
