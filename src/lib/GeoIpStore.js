'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const RIPE_DELEGATIONS_URL = 'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-latest';
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;

const parseIPv4 = (value) => {
  const parts = String(value).split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw new TypeError(`Invalid IPv4 address: ${value}`);
  }
  return parts.reduce((result, part) => (result << 8n) | BigInt(part), 0n);
};

const formatIPv4 = (value) => [24n, 16n, 8n, 0n]
  .map((shift) => Number((value >> shift) & 255n)).join('.');

const rangeToCidrs = (start, count) => {
  const result = [];
  let current = start;
  let remaining = count;
  while (remaining > 0n) {
    let block = current === 0n ? 1n << 32n : current & -current;
    while (block > remaining) block >>= 1n;
    let hostBits = 0;
    for (let size = block; size > 1n; size >>= 1n) hostBits++;
    result.push(`${formatIPv4(current)}/${32 - hostBits}`);
    current += block;
    remaining -= block;
  }
  return result;
};

const validateCidr = (value) => {
  const match = String(value).match(/^(.+)\/(\d{1,2})$/);
  if (!match || Number(match[2]) > 32) throw new TypeError(`Invalid IPv4 CIDR: ${value}`);
  parseIPv4(match[1]);
  return value;
};

const parseRipeDelegations = (text, { country = 'RU', minRecords = 1 } = {}) => {
  if (typeof text !== 'string') throw new TypeError('RIPE delegation data must be text');
  const cidrs = [];
  let records = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith('#')) continue;
    const fields = rawLine.split('|');
    if (fields.length < 7 || fields[1] !== country || fields[2] !== 'ipv4') continue;
    if (!['allocated', 'assigned'].includes(fields[6])) continue;
    const count = BigInt(fields[4]);
    if (count < 1n || count > 1n << 32n) throw new Error(`Invalid RIPE IPv4 count: ${fields[4]}`);
    const start = parseIPv4(fields[3]);
    if (start + count > 1n << 32n) throw new Error(`RIPE IPv4 range exceeds address space: ${rawLine}`);
    cidrs.push(...rangeToCidrs(start, count));
    records++;
  }
  if (records < minRecords) throw new Error(`RIPE data contains only ${records} usable ${country} IPv4 records`);
  return Object.freeze([...new Set(cidrs)].sort());
};

const defaultFetchText = async (url = RIPE_DELEGATIONS_URL) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`RIPE download failed with HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) throw new Error('RIPE download is too large');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('RIPE download is too large');
  return buffer.toString('utf8');
};

class GeoIpStore {
  constructor(filePath, { fileSystem = fs, fetchText = defaultFetchText, minRecords = 1000 } = {}) {
    if (typeof filePath !== 'string' || filePath.trim() === '') throw new TypeError('GeoIP file path is required');
    this.filePath = path.resolve(filePath);
    this.fs = fileSystem;
    this.fetchText = fetchText;
    this.minRecords = minRecords;
  }

  async load() {
    const text = await this.fs.readFile(this.filePath, 'utf8');
    const cidrs = text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map(validateCidr);
    if (cidrs.length < this.minRecords) throw new Error(`GeoIP file contains only ${cidrs.length} prefixes`);
    return Object.freeze([...new Set(cidrs)]);
  }

  async update() {
    const source = await this.fetchText(RIPE_DELEGATIONS_URL);
    const cidrs = parseRipeDelegations(source, { minRecords: this.minRecords });
    const directory = path.dirname(this.filePath);
    await this.fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${path.basename(this.filePath)}.${crypto.randomUUID()}.tmp`);
    const output = [
      '# AWG-Easy 3 RU IPv4 prefixes',
      `# Source: ${RIPE_DELEGATIONS_URL}`,
      `# Generated: ${new Date().toISOString()}`,
      ...cidrs,
      '',
    ].join('\n');
    try {
      await this.fs.writeFile(temporary, output, { mode: 0o600, flag: 'wx' });
      await this.fs.rename(temporary, this.filePath);
      await this.fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await this.fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return cidrs;
  }
}

module.exports = {
  GeoIpStore,
  MAX_DOWNLOAD_BYTES,
  RIPE_DELEGATIONS_URL,
  parseRipeDelegations,
  rangeToCidrs,
};
