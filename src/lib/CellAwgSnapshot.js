'use strict';
const net = require('node:net');
const crypto = require('node:crypto');
const { ipNumber } = require('./GeoIpAddress');
const { formatIPv6 } = require('./AddressAllocator');
const FIELDS = new Set(['privatekey', 'listenport', 'fwmark', 'jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4',
  'h1', 'h2', 'h3', 'h4', 'i1', 'i2', 'i3', 'i4', 'i5', 'headerprotectionkey', 'contentpaddingaddition',
  'rekeyaftertime', 'rekeytimeout', 'rejectaftertime', 'keepalivetimeout', 'maxhandshakeattempts', 'randomtrailers', 'disablecookies']);
const PEER_FIELDS = new Set(['publickey', 'presharedkey', 'allowedips', 'endpoint', 'persistentkeepalive']);
const sorted = object => Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
const ipText = (value, family) => family === 6 ? formatIPv6(value)
  : [24n, 16n, 8n, 0n].map(shift => Number((value >> shift) & 255n)).join('.');
function key(value) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, 'base64').toString('base64') !== value) throw new TypeError('Invalid AWG key');
  return value;
}
function range(value, max) {
  if (!/^\d+(?:-\d+)?$/.test(value)) throw new TypeError('Invalid AWG numeric field');
  const parts = value.split('-').map(Number), a = parts[0], b = parts[1] ?? a;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || a > b || b > max) throw new TypeError('Invalid AWG numeric range');
  return a === b ? String(a) : `${a}-${b}`;
}
function allowedIps(value) {
  const networks = value ? value.split(',').map(part => {
    const [ip, prefix, extra] = part.trim().split('/'), family = net.isIP(ip);
    const bits = family === 4 ? 32 : 128;
    if (!family || ip.includes('%') || extra !== undefined || !/^\d+$/.test(prefix) || Number(prefix) > bits) throw new TypeError('Invalid AWG allowed network');
    const hostBits = BigInt(bits - Number(prefix)), start = (ipNumber(ip) >> hostBits) << hostBits;
    return `${ipText(start, family)}/${Number(prefix)}`;
  }) : [];
  return [...new Set(networks)].sort();
}
function endpoint(value) {
  const match = value.match(/^\[([^\]]+)\]:(\d+)$/) || value.match(/^([^:]+):(\d+)$/);
  if (!match || !net.isIP(match[1]) || match[1].includes('%') || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new TypeError('Literal AWG endpoint required');
  const family = net.isIP(match[1]), host = ipText(ipNumber(match[1]), family);
  return `${family === 6 ? `[${host}]` : host}:${Number(match[2])}`;
}
function normalizeField(name, value) {
  if (['privatekey', 'publickey', 'presharedkey', 'headerprotectionkey'].includes(name)) return key(value);
  if (name === 'allowedips') return allowedIps(value);
  if (name === 'endpoint') return endpoint(value);
  if (/^i[1-5]$/.test(name)) return value;
  if (['randomtrailers', 'disablecookies'].includes(name)) {
    if (['on', 'true', '1'].includes(value.toLowerCase())) return 'on';
    if (['off', 'false', '0'].includes(value.toLowerCase())) return 'off';
    throw new TypeError('Invalid AWG boolean');
  }
  if (name === 'fwmark') {
    if (value === 'off') return '0';
    if (!/^(?:0x[0-9a-fA-F]+|\d+)$/.test(value) || Number(value) > 4294967295) throw new TypeError('Invalid AWG fwmark');
    return String(Number(value));
  }
  if (name === 'persistentkeepalive' && value === 'off') return '0';
  const max = /^(?:jc|jmin|jmax|h[1-4])$/.test(name) ? 4294967295 : 65535;
  if (/^(?:jc|jmin|jmax|s[1-4]|listenport)$/.test(name) && !/^\d+$/.test(value)) throw new TypeError('Invalid AWG integer');
  return range(value, max);
}
// Only stripped `awg setconf/showconf` configuration, no wg-quick hooks, DNS,
// addresses or routes. Never include a config or key in diagnostics/errors.
function normalizeAwgConfig(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024 || text.includes('\0')) throw new TypeError('Invalid AWG configuration');
  let current = null, iface = null; const peers = [];
  for (const source of text.split(/\r?\n/)) {
    const line = source.trim(); if (!line || line.startsWith('#')) continue;
    if (line === '[Interface]') {
      if (iface) throw new TypeError('Duplicate AWG interface section');
      iface = Object.create(null); current = iface; continue;
    }
    if (line === '[Peer]') {
      if (!iface || peers.length >= 1000) throw new TypeError('Invalid AWG peer section');
      current = Object.create(null); peers.push(current); continue;
    }
    const match = line.match(/^([A-Za-z0-9]+)\s*=\s*(.*)$/);
    if (!current || !match) throw new TypeError('Invalid AWG configuration line');
    const field = match[1].toLowerCase();
    if (!(current === iface ? FIELDS : PEER_FIELDS).has(field) || Object.hasOwn(current, field)) throw new TypeError('Unknown or duplicate AWG field');
    current[field] = normalizeField(field, match[2].trim());
  }
  if (!iface || !iface.privatekey) throw new TypeError('Missing AWG interface identity');
  if (iface.fwmark === '0') delete iface.fwmark;
  for (const field of ['i1', 'i2', 'i3', 'i4', 'i5']) if (iface[field] === '') delete iface[field];
  const seen = new Set();
  for (const peer of peers) {
    if (!peer.publickey || seen.has(peer.publickey)) throw new TypeError('Missing or duplicate AWG peer identity');
    seen.add(peer.publickey);
    if (peer.presharedkey === Buffer.alloc(32).toString('base64')) delete peer.presharedkey;
    peer.allowedips ??= []; peer.persistentkeepalive ??= '0';
  }
  return { interface: sorted(iface), peers: peers.map(sorted).sort((a, b) => a.publickey < b.publickey ? -1 : a.publickey > b.publickey ? 1 : 0) };
}
function matchesAwgConfig(expectedText, actualText) {
  const expected = normalizeAwgConfig(expectedText), actual = normalizeAwgConfig(actualText);
  const byKey = new Map(expected.peers.map(peer => [peer.publickey, peer]));
  // Client roaming legitimately learns an endpoint when none was configured.
  // A configured transit endpoint, however, is checked exactly after canonicalization.
  for (const peer of actual.peers) if (byKey.has(peer.publickey) && !Object.hasOwn(byKey.get(peer.publickey), 'endpoint')) delete peer.endpoint;
  const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest();
  return crypto.timingSafeEqual(digest(expected), digest(actual));
}
module.exports = { normalizeAwgConfig, matchesAwgConfig };
