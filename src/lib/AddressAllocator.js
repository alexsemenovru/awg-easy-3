'use strict';

const parseIPv4 = (value) => {
  if (typeof value !== 'string') throw new TypeError('IPv4 address must be a string');
  const parts = value.split('.');
  if (parts.length !== 4) throw new TypeError(`Invalid IPv4 address: ${value}`);
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) throw new TypeError(`Invalid IPv4 address: ${value}`);
    result = (result << 8n) | BigInt(part);
  }
  return result;
};

const formatIPv4 = (value) => [24n, 16n, 8n, 0n]
  .map((shift) => Number((value >> shift) & 255n)).join('.');

const parseIPv6 = (value) => {
  if (typeof value !== 'string' || value.includes('.')) throw new TypeError(`Invalid IPv6 address: ${value}`);
  const halves = value.split('::');
  if (halves.length > 2) throw new TypeError(`Invalid IPv6 address: ${value}`);
  const parseHalf = (half) => half === '' ? [] : half.split(':').map((part) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) throw new TypeError(`Invalid IPv6 address: ${value}`);
    return Number.parseInt(part, 16);
  });
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    throw new TypeError(`Invalid IPv6 address: ${value}`);
  }
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill(0), ...right] : left;
  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n);
};

const formatIPv6 = (value) => {
  const groups = Array.from({ length: 8 }, (_, index) => (
    Number((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16)
  ));
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length;) {
    if (groups[start] !== '0') { start++; continue; }
    let end = start;
    while (end < groups.length && groups[end] === '0') end++;
    if (end - start > bestLength) [bestStart, bestLength] = [start, end - start];
    start = end;
  }
  if (bestLength < 2) return groups.join(':');
  const left = groups.slice(0, bestStart).join(':');
  const right = groups.slice(bestStart + bestLength).join(':');
  return `${left}::${right}`;
};

const parseCidr = (value, bits, parser, family) => {
  if (typeof value !== 'string') throw new TypeError(`${family} subnet must be a CIDR string`);
  const match = value.match(/^(.+)\/(\d{1,3})$/);
  if (!match) throw new TypeError(`Invalid ${family} CIDR: ${value}`);
  const prefix = Number(match[2]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) throw new TypeError(`Invalid ${family} CIDR: ${value}`);
  const address = parser(match[1]);
  const hostBits = BigInt(bits - prefix);
  const size = 1n << hostBits;
  const start = address & ~(size - 1n);
  return { start, end: start + size - 1n };
};

const allocateIPv4 = ({ subnet, serverAddress, usedAddresses = [] }) => {
  const range = parseCidr(subnet, 32, parseIPv4, 'IPv4');
  const blocked = new Set([serverAddress, ...usedAddresses].map((address) => parseIPv4(address).toString()));
  for (let candidate = range.start + 1n; candidate < range.end; candidate++) {
    if (!blocked.has(candidate.toString())) return formatIPv4(candidate);
  }
  throw new Error(`No free client IPv4 addresses remain in ${subnet}`);
};

const allocateIPv6 = ({ subnet, serverAddress, usedAddresses = [] }) => {
  const range = parseCidr(subnet, 128, parseIPv6, 'IPv6');
  const blocked = new Set([serverAddress, ...usedAddresses].map((address) => parseIPv6(address).toString()));
  for (let candidate = range.start + 1n; candidate <= range.end; candidate++) {
    if (!blocked.has(candidate.toString())) return formatIPv6(candidate);
  }
  throw new Error(`No free client IPv6 addresses remain in ${subnet}`);
};

const allocateClientAddresses = ({ server, clients }) => {
  if (!server || !Array.isArray(clients)) throw new TypeError('server and clients are required');
  const address4 = allocateIPv4({
    subnet: server.ipv4Subnet,
    serverAddress: server.address4,
    usedAddresses: clients.map((client) => client.address4),
  });
  const address6 = server.ipv6Subnet && server.address6
    ? allocateIPv6({
      subnet: server.ipv6Subnet,
      serverAddress: server.address6,
      usedAddresses: clients.map((client) => client.address6).filter(Boolean),
    })
    : undefined;
  return Object.freeze({ address4, ...(address6 ? { address6 } : {}) });
};

module.exports = {
  allocateClientAddresses,
  allocateIPv4,
  allocateIPv6,
  formatIPv6,
  parseIPv6,
};
