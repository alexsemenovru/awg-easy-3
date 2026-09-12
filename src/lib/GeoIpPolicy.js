'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const { validateRange, ipNumber } = require('./GeoIpAddress');

const normalizeGeoPolicy = (input = { mode: 'off', countries: [] }) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || !['off', 'block', 'allow'].includes(input.mode)
      || !Array.isArray(input.countries) || input.countries.length > 250) {
    throw new TypeError('Invalid GeoIP policy');
  }
  const countries = [...new Set(input.countries.map(code => {
    if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code)) throw new TypeError('Invalid country code');
    return code.toUpperCase();
  }))].sort();
  if (input.mode !== 'off' && countries.length === 0) throw new TypeError('Select at least one country');
  return Object.freeze({ mode: input.mode, countries: Object.freeze(input.mode === 'off' ? [] : countries) });
};

const validatePrefixes = (values, family) => {
  if (!Array.isArray(values) || values.length > 200000) throw new TypeError('Invalid GeoIP prefix list');
  return [...new Set(values.map(value => {
    if (typeof value !== 'string') throw new TypeError('Invalid GeoIP prefix');
    if (value.includes('-')) {
      const range = validateRange(value, family);
      const [start, end] = range.split('-');
      // nft rejects zero-size ranges; DB-IP can describe a single address.
      return ipNumber(start) === ipNumber(end) ? `${start}/${family === 4 ? 32 : 128}` : range;
    }
    const parts = value.split('/');
    if (parts.length !== 2 || net.isIP(parts[0]) !== family || parts[0].includes('%')
        || !/^(0|[1-9][0-9]*)$/.test(parts[1])
        || Number(parts[1]) < 1 || Number(parts[1]) > (family === 4 ? 32 : 128)) {
      throw new TypeError('Invalid GeoIP prefix');
    }
    return value;
  }))].sort();
};

// Compiler only: the caller supplies a validated database snapshot. No network,
// DNS, host firewall changes or state writes take place here.
const renderGeoIpPolicy = ({ clients = [], database = {}, awg, wan, active4, active6 }) => {
  if (![awg, wan].every(v => typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,15}$/.test(v))) {
    throw new TypeError('Invalid GeoIP interface');
  }
  if (!Array.isArray(clients) || clients.length > 1000) throw new TypeError('Invalid GeoIP clients');
  const sets = new Map();
  const rules = [];
  const seen = new Set();
  for (const client of clients) {
    const policy = normalizeGeoPolicy(client.policy);
    if (policy.mode === 'off') continue;
    for (const family of [4, 6]) {
      const address = client[`address${family}`];
      if (!address) continue;
      if (net.isIP(address) !== family || address.includes('%')) throw new TypeError('Invalid GeoIP client address');
      if (!(family === 4 ? active4 : active6).includes(address)) throw new TypeError('GeoIP client is not active');
      if (seen.has(address)) throw new TypeError('Duplicate GeoIP client');
      seen.add(address);
      const name = `geo${family}_${crypto.createHash('sha256').update(policy.countries.join(',')).digest('hex').slice(0, 16)}`;
      if (!sets.has(name)) {
        const prefixes = [];
        for (const code of policy.countries) {
          if (!Object.hasOwn(database, code)) throw new TypeError(`GeoIP country unavailable: ${code}`);
          const entries = validatePrefixes(database[code]?.[`ipv${family}`], family);
          if (prefixes.length + entries.length > 200000) throw new TypeError('GeoIP selection is too large');
          for (const entry of entries) prefixes.push(entry);
        }
        const elements = [...new Set(prefixes)].sort();
        sets.set(name, `  set ${name} {\n    type ipv${family}_addr\n    flags interval\n    auto-merge\n${elements.length ? `    elements = { ${elements.join(', ')} }\n` : ''}  }\n`);
      }
      const ip = family === 4 ? 'ip' : 'ip6';
      const operator = policy.mode === 'allow' ? '!= ' : '';
      rules.push(`    iifname "${awg}" oifname "${wan}" ${ip} saddr ${address} ${ip} daddr ${operator}@${name} drop comment "GeoIP outbound"`);
      rules.push(`    iifname "${wan}" oifname "${awg}" ${ip} daddr ${address} ${ip} saddr ${operator}@${name} drop comment "GeoIP inbound"`);
    }
  }
  return { sets: [...sets.values()].join('\n'), rules: rules.join('\n') };
};

module.exports = { normalizeGeoPolicy, validatePrefixes, renderGeoIpPolicy };
