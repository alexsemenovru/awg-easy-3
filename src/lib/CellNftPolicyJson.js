'use strict';
const net = require('node:net');
const { ipNumber } = require('./GeoIpAddress');
const { formatIPv6 } = require('./AddressAllocator');
const { validatePrefixes } = require('./GeoIpPolicy');
const { normalizeNftSnapshot } = require('./CellNftOwnership');
const TABLE = 'awg_easy_3_routes';
const address = (number, family) => family === 6 ? formatIPv6(number)
  : [24n, 16n, 8n, 0n].map(shift => Number((number >> shift) & 255n)).join('.');
const canonical = value => address(ipNumber(value), net.isIP(value));

// Canonical union for immutable interval sets. No counters, timeouts or dynamic
// elements: kernel readback must be predictable BEFORE applying the policy.
function intervalElements(values, family) {
  const bits = family === 4 ? 32 : 128;
  const intervals = validatePrefixes(values, family).map(value => {
    if (value.includes('-')) return value.split('-').map(ipNumber);
    const [ip, prefix] = value.split('/'), size = 1n << BigInt(bits - Number(prefix));
    const start = ipNumber(ip) & ~(size - 1n);
    return [start, start + size - 1n];
  }).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const merged = [];
  for (const [start, end] of intervals) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1n) { if (end > last[1]) last[1] = end; }
    else merged.push([start, end]);
  }
  return merged.map(([start, end]) => {
    if (start === end) return address(start, family);
    const size = end - start + 1n;
    if ((size & (size - 1n)) === 0n && start % size === 0n) {
      return { prefix: { addr: address(start, family), len: bits - (size.toString(2).length - 1) } };
    }
    return { range: [address(start, family), address(end, family)] };
  });
}

// Deliberately restricted grammar for rules emitted by CellRoutingPolicy, not
// a general nft parser and never a network-input format. Unknown tokens fail.
function ruleExpressions(line) {
  let rest = line.trim(), comment;
  const note = rest.match(/ comment "(GeoIP (?:inbound|outbound))"$/);
  if (note) { comment = note[1]; rest = rest.slice(0, note.index); }
  const expr = [];
  while (rest) {
    let match;
    if ((match = rest.match(/^(iifname|oifname) ("[a-zA-Z0-9_.-]{1,15}"|\{ "[a-zA-Z0-9_.-]{1,15}"(?:, "[a-zA-Z0-9_.-]{1,15}")* \}) /))) {
      const values = [...match[2].matchAll(/"([^"]+)"/g)].map(x => x[1]);
      expr.push({ match: { op: '==', left: { meta: { key: match[1] } }, right: values.length === 1 ? values[0] : { set: values } } });
    } else if ((match = rest.match(/^(ip6?|ip) (saddr|daddr) (!= )?(@geo[46]_[a-f0-9]{16}|\{ [a-fA-F0-9.:]+(?:, [a-fA-F0-9.:]+)* \}|[a-fA-F0-9.:]+) /))) {
      const family = match[1] === 'ip' ? 4 : 6, raw = match[4]; let right;
      if (raw.startsWith('@')) right = raw;
      else {
        const ips = raw.replace(/[{}]/g, '').trim().split(/, /);
        if (ips.some(ip => net.isIP(ip) !== family)) throw new TypeError('Invalid policy JSON address');
        const values = [...new Set(ips.map(canonical))].sort((a, b) => ipNumber(a) < ipNumber(b) ? -1 : ipNumber(a) > ipNumber(b) ? 1 : 0);
        right = values.length === 1 ? values[0] : { set: values };
      }
      expr.push({ match: { op: match[3] ? '!=' : '==', left: { payload: { protocol: match[1], field: match[2] } }, right } });
    } else if ((match = rest.match(/^tcp (dport|sport) ([0-9]+) /))) {
      const port = Number(match[2]);
      if (port < 1 || port > 65535) throw new TypeError('Invalid JSON policy port');
      expr.push({ match: { op: '==', left: { payload: { protocol: 'tcp', field: match[1] } }, right: port } });
    } else if ((match = rest.match(/^ct state established,related /))) {
      expr.push({ match: { op: 'in', left: { ct: { key: 'state' } }, right: ['established', 'related'] } });
    } else if ((match = rest.match(/^(accept|drop|masquerade)$/))) {
      expr.push({ [match[1]]: null });
    } else throw new TypeError('Unsupported routing policy JSON expression');
    rest = rest.slice(match[0].length);
  }
  if (!expr.length || !['accept', 'drop', 'masquerade'].some(key => Object.hasOwn(expr.at(-1), key))) throw new TypeError('Missing policy verdict');
  return { expr, ...(comment ? { comment } : {}) };
}
function routingPolicySnapshot({ input, forward, output, nat, sets }) {
  const nftables = [{ table: { family: 'inet', name: TABLE } }];
  const chains = [['input', input], ['forward', forward], ['output', output], ['postrouting', nat]];
  for (const [name] of chains) nftables.push({ chain: { family: 'inet', table: TABLE, name,
    type: name === 'postrouting' ? 'nat' : 'filter', hook: name, prio: name === 'postrouting' ? 100 : -15, policy: 'accept' } });
  for (const set of sets) {
    if (!/^geo[46]_[a-f0-9]{16}$/.test(set.name) || ![4, 6].includes(set.family)) throw new TypeError('Invalid routing GeoIP set');
    const elem = intervalElements(set.elements, set.family);
    nftables.push({ set: { family: 'inet', table: TABLE, name: set.name, type: `ipv${set.family}_addr`, flags: ['interval'],
      ...(elem.length ? { elem } : {}) } });
  }
  for (const [chain, lines] of chains) for (const line of lines) if (line.trim()) {
    nftables.push({ rule: { family: 'inet', table: TABLE, chain, ...ruleExpressions(line) } });
  }
  // nft list table emits sets first, then each chain immediately followed by
  // its rules. The desired snapshot must match that exact kernel readback.
  const ordered = [nftables[0], ...nftables.filter(item => item.set)];
  for (const [name] of chains) {
    ordered.push(...nftables.filter(item => item.chain?.name === name));
    ordered.push(...nftables.filter(item => item.rule?.chain === name));
  }
  return normalizeNftSnapshot({ nftables: ordered }, TABLE);
}
module.exports = { routingPolicySnapshot, ruleExpressions, intervalElements };
