'use strict';

const net = require('node:net');

const ipNumber = (address) => {
  const family = net.isIP(address);
  if (!family || address.includes('%')) throw new TypeError('Invalid GeoIP address');
  if (family === 4) return address.split('.').reduce((n, part) => (n << 8n) + BigInt(part), 0n);
  let expanded = address;
  if (expanded.includes('.')) {
    const index = expanded.lastIndexOf(':');
    const tail = ipNumber(expanded.slice(index + 1));
    expanded = `${expanded.slice(0, index)}:${(tail >> 16n).toString(16)}:${(tail & 65535n).toString(16)}`;
  }
  const halves = expanded.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.reduce((n, part) => (n << 16n) + BigInt(`0x${part}`), 0n);
};

const validateRange = (value, family) => {
  if (typeof value !== 'string') throw new TypeError('Invalid GeoIP range');
  const parts = value.split('-');
  if (parts.length !== 2 || parts.some(part => net.isIP(part) !== family || part.includes('%'))
      || ipNumber(parts[0]) > ipNumber(parts[1])) throw new TypeError('Invalid GeoIP range');
  return value;
};

module.exports = { ipNumber, validateRange };
