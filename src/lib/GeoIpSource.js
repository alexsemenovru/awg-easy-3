'use strict';

const net = require('node:net');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { ipNumber } = require('./GeoIpAddress');

const SOURCE = 'DB-IP Lite';
const SOURCE_URL = 'https://db-ip.com/db/download/ip-to-country-lite';
const MAX_DOWNLOAD = 32 * 1024 * 1024;
const MAX_CSV = 96 * 1024 * 1024;
const MAX_ROWS = 1500000;

// Executed in a worker: decompression, parsing and address checks must not block
// sessions/diagnostics on a small VPS. A gzip CRC checks transport integrity;
// SHA-256 below detects damaged local snapshots, not a malicious publisher.
const parseDatabase = (compressed, { minRows = 100000, minCountries = 200 } = {}) => {
  const bytes = Buffer.from(compressed);
  if (!bytes.length || bytes.length > MAX_DOWNLOAD) throw new Error('GeoIP download size is invalid');
  const csv = gunzipSync(bytes, { maxOutputLength: MAX_CSV }).toString('utf8');
  const database = Object.create(null);
  const last = { 4: -1n, 6: -1n };
  const counts = { 4: 0, 6: 0 };
  let rows = 0;
  // The documented fields contain only IP addresses and a country code: accept
  // RFC4180 quoting of those fields, but no arbitrary CSV expressions/text.
  const field = '(?:"([^"\\r\\n,]+)"|([^"\\r\\n,]+))';
  const pattern = new RegExp(`^${field},${field},${field}$`);
  for (const line of csv.split('\n')) {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!text) continue;
    const match = pattern.exec(text);
    if (!match) throw new Error('Invalid GeoIP CSV row');
    const start = match[1] ?? match[2];
    const end = match[3] ?? match[4];
    const code = match[5] ?? match[6];
    const family = net.isIP(start);
    if (![4, 6].includes(family) || net.isIP(end) !== family
        || !/^[A-Z]{2}$/.test(code) || start.includes('%') || end.includes('%')) {
      throw new Error('Invalid GeoIP CSV address or country');
    }
    const first = ipNumber(start);
    const final = ipNumber(end);
    if (first > final || first <= last[family]) throw new Error('Unsorted or overlapping GeoIP ranges');
    last[family] = final;
    rows += 1;
    counts[family] += 1;
    if (rows > MAX_ROWS) throw new Error('GeoIP database has too many rows');
    database[code] ??= { ipv4: [], ipv6: [] };
    database[code][`ipv${family}`].push(`${start}-${end}`);
  }
  const countries = Object.keys(database).sort();
  if (rows < minRows || countries.length < minCountries || !counts[4] || !counts[6]) {
    throw new Error('Incomplete GeoIP database: IPv4, IPv6 and country coverage are required');
  }
  return { database, rows, countries, sha256: createHash('sha256').update(bytes).digest('hex') };
};

const releaseMonth = (date = new Date()) => date.toISOString().slice(0, 7);
const databaseUrl = (release) => {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(release)) throw new Error('Invalid GeoIP release');
  return `https://download.db-ip.com/free/dbip-country-lite-${release}.csv.gz`;
};

const downloadDatabase = async (release, { fetchImpl = fetch, signal, timeoutMs = 120000 } = {}) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(databaseUrl(release), {
          signal: controller.signal, redirect: 'error', headers: { 'User-Agent': 'AWG-Easy-3-GeoIP' },
        });
        if (!response.ok) {
          await response.body?.cancel();
          const error = new Error(`GeoIP download HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD) {
          await response.body?.cancel();
          throw new Error('GeoIP download is too large');
        }
        if (!response.body) throw new Error('Empty GeoIP download');
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_DOWNLOAD) {
            controller.abort();
            throw new Error('GeoIP download is too large');
          }
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks, size);
      })(),
      new Promise((resolve, reject) => {
        const cancelled = () => reject(new Error('GeoIP download cancelled or timed out'));
        controller.signal.addEventListener('abort', cancelled, { once: true });
        if (controller.signal.aborted) cancelled();
        timer = setTimeout(abort, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
};

module.exports = { SOURCE, SOURCE_URL, MAX_DOWNLOAD, parseDatabase, releaseMonth, databaseUrl, downloadDatabase };
