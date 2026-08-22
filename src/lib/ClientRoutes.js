'use strict';

const MAX_IPV4 = (1n << 32n) - 1n;

const parseIPv4 = (value) => {
  if (typeof value !== 'string') throw new TypeError('IPv4 address must be a string');
  const parts = value.split('.');
  if (parts.length !== 4) throw new TypeError(`Invalid IPv4 address: ${value}`);

  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new TypeError(`Invalid IPv4 address: ${value}`);
    const octet = Number(part);
    if (octet > 255) throw new TypeError(`Invalid IPv4 address: ${value}`);
    result = (result << 8n) | BigInt(octet);
  }
  return result;
};

const formatIPv4 = (value) => [24n, 16n, 8n, 0n]
  .map((shift) => Number((value >> shift) & 255n))
  .join('.');

const parseCidr = (value) => {
  if (typeof value !== 'string') throw new TypeError('IPv4 CIDR must be a string');
  const match = value.match(/^(.+)\/(\d{1,2})$/);
  if (!match) throw new TypeError(`Invalid IPv4 CIDR: ${value}`);
  const prefix = Number(match[2]);
  if (prefix < 0 || prefix > 32) throw new TypeError(`Invalid IPv4 CIDR: ${value}`);

  const address = parseIPv4(match[1]);
  const hostBits = BigInt(32 - prefix);
  const size = 1n << hostBits;
  const start = address & ~(size - 1n);
  return { start, end: start + size - 1n };
};

const mergeRanges = (ranges) => {
  const sorted = [...ranges].sort((left, right) => left.start < right.start ? -1 : 1);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end + 1n) {
      merged.push({ ...range });
    } else if (range.end > previous.end) {
      previous.end = range.end;
    }
  }
  return merged;
};

const rangeToCidrs = (range) => {
  const result = [];
  let current = range.start;
  while (current <= range.end) {
    let blockSize = current === 0n ? 1n << 32n : current & -current;
    const remaining = range.end - current + 1n;
    while (blockSize > remaining) blockSize >>= 1n;

    let hostBits = 0;
    for (let size = blockSize; size > 1n; size >>= 1n) hostBits++;
    result.push(`${formatIPv4(current)}/${32 - hostBits}`);
    current += blockSize;
  }
  return result;
};

const excludeIPv4Cidrs = (excludedCidrs) => {
  if (!Array.isArray(excludedCidrs) || excludedCidrs.length === 0) {
    throw new TypeError('At least one excluded IPv4 CIDR is required');
  }

  const excluded = mergeRanges(excludedCidrs.map(parseCidr));
  const included = [];
  let cursor = 0n;
  for (const range of excluded) {
    if (cursor < range.start) included.push({ start: cursor, end: range.start - 1n });
    cursor = range.end + 1n;
  }
  if (cursor <= MAX_IPV4) included.push({ start: cursor, end: MAX_IPV4 });
  return included.flatMap(rangeToCidrs);
};

const buildClientRoutes = ({ mode, ruIPv4Cidrs = [], serverHasIPv6 = false }) => {
  if (mode === 'vpn_all') {
    return {
      allowedIps: ['0.0.0.0/0', ...(serverHasIPv6 ? ['::/0'] : [])],
      ipv6Policy: serverHasIPv6 ? 'tunnel' : 'unavailable',
    };
  }

  if (mode === 'ru_direct') {
    return {
      // ::/0 is deliberately captured. The server policy drops IPv6 for this
      // peer so Android cannot bypass the VPN using a mismatched IPv6 region.
      allowedIps: [...excludeIPv4Cidrs(ruIPv4Cidrs), '::/0'],
      ipv6Policy: 'block',
    };
  }

  throw new TypeError(`Unknown client route mode: ${mode}`);
};

module.exports = {
  buildClientRoutes,
  excludeIPv4Cidrs,
};

