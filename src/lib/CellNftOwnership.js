'use strict';
const crypto = require('node:crypto');
const TABLES = new Set(['awg_easy_3', 'awg_easy_3_routes', 'awg_easy_3_routing_guard',
  'awg_easy_3_bootstrap', 'awg_easy_3_bootstrap_guard',
  'awg_easy_3_control', 'awg_easy_3_control_guard', 'awg_easy_3_cell_guard']);
function dataTable(table, guard = false) {
  const match = typeof table === 'string'
    && table.match(new RegExp(`^awg_easy_3_data_${guard ? 'guard_' : ''}(cell|(?:0|[1-9][0-9]{0,2}))$`));
  return Boolean(match && (match[1] === 'cell' || Number(match[1]) <= 126));
}
const ownedTable = table => TABLES.has(table) || dataTable(table) || dataTable(table, true);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
};
function normalizeNftSnapshot(snapshot, table) {
  if (!ownedTable(table) || !plain(snapshot) || Object.keys(snapshot).join(',') !== 'nftables'
    || !Array.isArray(snapshot.nftables) || snapshot.nftables.length > 50000) throw new TypeError('Invalid cell nft snapshot');
  const objects = []; let tables = 0;
  for (const item of snapshot.nftables) {
    if (!plain(item) || Object.keys(item).length !== 1) throw new TypeError('Invalid nft object');
    const [kind] = Object.keys(item), data = item[kind];
    if (kind === 'metainfo') continue;
    // Only declarative objects in ONE table; never accept commands from a snapshot.
    if (!['table', 'chain', 'rule', 'set'].includes(kind) || !plain(data)
      || data.family !== 'inet' || (kind === 'table' ? data.name : data.table) !== table) {
      throw new TypeError('Foreign or unsupported nft snapshot object');
    }
    if (kind === 'table') tables++;
    const copy = structuredClone(data);
    // Handles are kernel allocation IDs, not policy. Do not discard any rule
    // expression, comment, set element, counter or unknown policy attribute.
    delete copy.handle;
    objects.push({ [kind]: copy });
  }
  if (tables !== 1 || !objects[0]?.table) throw new TypeError('Exactly one leading nft table required');
  const normalized = stable({ nftables: objects });
  if (Buffer.byteLength(JSON.stringify(normalized)) > 32 * 1024 * 1024) throw new TypeError('Cell nft snapshot too large');
  return normalized;
}
// nft -j list groups declarations before rules on some kernels, while our
// declarative batches may interleave each chain with its rules. Canonicalize
// only for ownership comparison, not for the batch sent to nft; retain rule
// order *within* each chain.
function canonicalNftSnapshot(snapshot, table) {
  const objects = normalizeNftSnapshot(snapshot, table).nftables;
  // nft readback may reorder an anonymous set. Its members are unordered;
  // preserve every member and all other expression/rule ordering when
  // comparing ownership (including journals written before that reordering).
  for (const item of objects) for (const expression of item.rule?.expr || []) {
    const members = expression.match?.right?.set;
    if (Array.isArray(members) && members.every(member => typeof member === 'string')) {
      members.sort();
    }
  }
  const rank = { table: 0, chain: 1, set: 2, rule: 3 };
  objects.sort((left, right) => {
    const leftKind = Object.keys(left)[0], rightKind = Object.keys(right)[0];
    if (rank[leftKind] !== rank[rightKind]) return rank[leftKind] - rank[rightKind];
    if (leftKind === 'rule') return left.rule.chain.localeCompare(right.rule.chain);
    if (leftKind === 'chain' || leftKind === 'set') {
      return left[leftKind].name.localeCompare(right[rightKind].name);
    }
    return 0;
  });
  return { nftables: objects };
}
function nftFingerprint(snapshot, table) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalNftSnapshot(snapshot, table))).digest('hex');
}
function planNftReplacement({ table, current, owned, desired }) {
  if (!ownedTable(table)) throw new TypeError('Not a cell routing table');
  const normalize = value => value === null ? null : normalizeNftSnapshot(value, table);
  const actual = normalize(current), previous = normalize(owned), next = normalize(desired);
  const same = (a, b) => a === null || b === null ? a === b
    : nftFingerprint(a, table) === nftFingerprint(b, table);
  if (actual && !same(actual, previous)) {
    throw new Error('Foreign or changed cell nft table; refusing replacement');
  }
  const nftables = [];
  if (same(actual, next)) return { batch: { nftables }, changed: false, desired: next };
  if (actual) nftables.push({ delete: { table: { family: 'inet', name: table } } });
  if (next) for (const item of next.nftables) nftables.push({ add: item });
  return { batch: { nftables }, changed: true, desired: next };
}
function routingGuardSnapshot(interfaces, table = 'awg_easy_3_routing_guard') {
  if (!Array.isArray(interfaces) || interfaces.length < 1 || interfaces.length > 256
    || interfaces.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(name))
    || new Set(interfaces).size !== interfaces.length
    || !(['awg_easy_3_routing_guard', 'awg_easy_3_bootstrap_guard',
      'awg_easy_3_control_guard', 'awg_easy_3_cell_guard'].includes(table)
      || dataTable(table, true))) {
    throw new TypeError('Invalid routing guard interfaces');
  }
  const nftables = [{ table: { family: 'inet', name: table } }];
  for (const [hook, directions] of [['input', ['iifname']], ['output', ['oifname']], ['forward', ['iifname', 'oifname']]]) {
    nftables.push({ chain: { family: 'inet', table, name: hook, type: 'filter', hook, prio: -25, policy: 'accept' } });
    for (const name of [...interfaces].sort()) for (const key of directions) {
      nftables.push({ rule: { family: 'inet', table, chain: hook,
        expr: [{ match: { op: '==', left: { meta: { key } }, right: name } }, { drop: null }] } });
    }
  }
  // Fingerprinting groups declarations before rules while retaining the order
  // of rules inside each chain; the actual nft batch remains interleaved.
  return normalizeNftSnapshot({ nftables }, table);
}
module.exports = { normalizeNftSnapshot, nftFingerprint, planNftReplacement,
  routingGuardSnapshot, dataTable };
