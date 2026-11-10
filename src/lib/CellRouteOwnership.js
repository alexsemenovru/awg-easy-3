'use strict';
const net = require('node:net');
const { ipNumber } = require('./GeoIpAddress');
const fail = message => { throw new Error(`Cell route ownership: ${message}`); };
const iface = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,15}$/.test(value);
const tableNumber = value => value === 'main' ? 254 : Number(value);
const reservedTable = value => Number.isInteger(value) && value >= 52000 && value <= 52999;
const reservedPriority = value => Number.isInteger(value) && value >= 20000 && value <= 20999;
function destination(value, family) {
  if (value === 'default' || value === 'all') return 'default';
  if (typeof value !== 'string') fail('invalid address');
  const [address, prefix, extra] = value.split('/');
  const bits = family === 4 ? 32 : 128;
  if (extra !== undefined || net.isIP(address) !== family || (prefix !== undefined && Number(prefix) !== bits)) {
    fail('only exact host addresses are allowed');
  }
  return ipNumber(address).toString(16);
}
const identity = object => JSON.stringify(object);

// Accept only the small argv vocabulary emitted by CellRoutingPolicy. Never
// execute shell strings, replace/flush, host defaults or arbitrary route tables.
function parseCommand(command) {
  if (!command || command.file !== 'ip' || !Array.isArray(command.args)
    || command.args.some(a => typeof a !== 'string')) fail('invalid command');
  const a = command.args, family = a[0] === '-4' ? 4 : a[0] === '-6' ? 6 : 0;
  if (!family || a[2] !== 'add') fail('only IPv4/IPv6 add commands allowed');
  const fields = Object.create(null);
  let offset = 3, type;
  if (a[1] === 'route') {
    type = a[offset] === 'unreachable' ? (offset++, 'unreachable') : 'unicast';
    fields.dst = a[offset++];
  } else if (a[1] !== 'rule') fail('unsupported object');
  for (; offset < a.length; offset += 2) {
    const name = a[offset], value = a[offset + 1];
    if (value === undefined || Object.hasOwn(fields, name)) fail('duplicate or incomplete field');
    fields[name] = value;
  }
  let record;
  if (a[1] === 'route') {
    if (Object.keys(fields).some(k => !['dst', 'table', 'proto', 'dev', 'metric'].includes(k))) fail('unsupported route field');
    const table = tableNumber(fields.table), dst = destination(fields.dst, family);
    if ((!reservedTable(table) && table !== 254) || fields.proto !== '186'
      || (table === 254 && dst === 'default') || (type === 'unreachable' && (fields.dev || dst !== 'default'))
      || (type === 'unicast' && !iface(fields.dev))) fail('unsafe route');
    const metric = fields.metric === undefined ? (family === 6 ? 1024 : 0) : Number(fields.metric);
    if (!Number.isInteger(metric) || metric < 0 || metric > 32767) fail('invalid metric');
    record = { kind: 'route', family, table, dst, type, dev: fields.dev || null, metric, protocol: 186 };
  } else {
    if (Object.keys(fields).sort().join(',') !== (fields.fwmark === undefined ? 'from,iif,lookup,pref' : 'from,fwmark,iif,lookup,pref')) fail('unsupported rule fields');
    const priority = Number(fields.pref), table = tableNumber(fields.lookup), src = destination(fields.from, family);
    if (!reservedPriority(priority) || !reservedTable(table) || src === 'default' || !iface(fields.iif)) fail('unsafe rule');
    if (fields.fwmark !== undefined && !['0x0/0x4000000', '0x4000000/0x4000000'].includes(fields.fwmark)) fail('unsafe routing mark');
    record = { kind: 'rule', family, priority, table, src, iif: fields.iif, ...(fields.fwmark !== undefined ? { mark: Number(fields.fwmark.split('/')[0]), mask: 67108864 } : {}) };
  }
  return { record, command: { file: 'ip', args: [...a] } };
}
function manifest(commands) {
  if (!Array.isArray(commands) || commands.length > 20000) fail('invalid manifest');
  const parsed = commands.map(parseCommand), seen = new Set();
  for (const item of parsed) {
    const key = identity(item.record);
    if (seen.has(key)) fail('duplicate desired object');
    seen.add(key);
  }
  return parsed;
}
function normalizeRoute(row, family) {
  const keys = ['dst', 'table', 'type', 'dev', 'metric', 'protocol', 'scope', 'flags', 'pref'];
  if (!row || Object.keys(row).some(k => !keys.includes(k))) fail('unrecognized route attributes');
  if (row.flags !== undefined && (!Array.isArray(row.flags) || row.flags.some(f => f !== 'linkdown'))) fail('route flags');
  const type = row.type || 'unicast';
  if (row.pref !== undefined && row.pref !== 'medium') fail('route preference');
  if (row.scope !== undefined && row.scope !== (type === 'unicast' && family === 4 ? 'link' : 'global')) fail('route scope');
  return { kind: 'route', family, table: tableNumber(row.table ?? 254), dst: destination(row.dst, family),
    type, dev: type === 'unreachable' && family === 6 && row.dev === 'lo' ? null : row.dev || null,
    metric: Number(row.metric ?? (family === 6 ? 1024 : 0)),
    // iproute2 renders RTPROT_BGP (186) symbolically. This tag alone never
    // establishes ownership; the complete object still needs its journal entry.
    protocol: row.protocol === 'bgp' ? 186 : Number(row.protocol) };
}
function normalizeRule(row, family) {
  if (!row || Object.keys(row).some(k => !['priority', 'src', 'dst', 'iif', 'iifname', 'table', 'protocol', 'flags', 'action', 'fwmark', 'fwmask'].includes(k))) fail('unrecognized rule attributes');
  if ((row.dst !== undefined && row.dst !== 'all') || (row.action !== undefined && row.action !== 'to_tbl')
    || (row.protocol !== undefined && !['boot', 3, '3'].includes(row.protocol))
    || (row.flags !== undefined && (!Array.isArray(row.flags) || row.flags.length))
    || (row.iif && row.iifname && row.iif !== row.iifname)) fail('rule attributes');
  if (row.fwmark !== undefined && (![0, 67108864].includes(Number(row.fwmark)) || Number(row.fwmask) !== 67108864)) fail('unexpected routing mark');
  if (row.fwmark === undefined && row.fwmask !== undefined) fail('orphan routing mask');
  return { kind: 'rule', family, priority: Number(row.priority), table: tableNumber(row.table),
    src: destination(row.src, family), iif: row.iifname || row.iif, ...(row.fwmark !== undefined ? { mark: Number(row.fwmark), mask: 67108864 } : {}) };
}

// Inventory: {routes4, routes6, rules4, rules6}, unmodified ip -j output.
// A matching kernel object is NOT ownership evidence on first install: it must
// also be present in the caller's durable, exclusively owned previous manifest.
function planRouteChanges({ previous = [], desired, inventory }) {
  const old = manifest(previous), next = manifest(desired);
  const all = [...old, ...next], known = new Map(old.map(x => [identity(x.record), x]));
  const wanted = new Map(next.map(x => [identity(x.record), x]));
  const present = new Set();
  for (const family of [4, 6]) {
    const tables = new Set(all.filter(x => x.record.family === family && reservedTable(x.record.table)).map(x => x.record.table));
    const main = new Set(all.filter(x => x.record.family === family && x.record.kind === 'route' && x.record.table === 254).map(x => x.record.dst));
    const priorities = new Set(all.filter(x => x.record.family === family && x.record.kind === 'rule').map(x => x.record.priority));
    const routes = inventory?.[`routes${family}`], rules = inventory?.[`rules${family}`];
    if (!Array.isArray(routes) || !Array.isArray(rules)) fail('incomplete inventory');
    for (const row of routes) {
      const table = tableNumber(row.table ?? 254);
      let relevant = tables.has(table);
      if (table === 254 && main.size) {
        try { relevant ||= main.has(destination(row.dst, family)); } catch { /* unrelated network prefix */ }
      }
      if (!relevant) continue;
      const key = identity(normalizeRoute(row, family));
      if (!known.has(key) || present.has(key)) fail(`foreign or conflicting route: ${key}`);
      present.add(key);
    }
    for (const row of rules) {
      // A foreign selector referencing our table matters even at another priority.
      if (!priorities.has(Number(row.priority)) && !tables.has(tableNumber(row.table))) continue;
      const key = identity(normalizeRule(row, family));
      if (!known.has(key) || present.has(key)) fail('foreign or conflicting rule');
      present.add(key);
    }
  }
  const remove = old.filter(x => present.has(identity(x.record)) && !wanted.has(identity(x.record)))
    .sort((a, b) => (a.record.kind === 'rule' ? 0 : 1) - (b.record.kind === 'rule' ? 0 : 1));
  const add = next.filter(x => !present.has(identity(x.record)))
    .sort((a, b) => (a.record.kind === 'route' ? 0 : 1) - (b.record.kind === 'route' ? 0 : 1));
  return { remove: remove.map(x => ({ file: 'ip', args: x.command.args.map((s, i) => i === 2 ? 'del' : s) })),
    add: add.map(x => x.command), desired: next.map(x => x.command) };
}
module.exports = { planRouteChanges, manifest };
