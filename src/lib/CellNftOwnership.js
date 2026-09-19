'use strict';
const crypto = require('node:crypto');
const TABLES = new Set(['awg_easy_3_routes', 'awg_easy_3_routing_guard']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
};
function normalizeNftSnapshot(snapshot, table) {
  if (!TABLES.has(table) || !plain(snapshot) || Object.keys(snapshot).join(',') !== 'nftables'
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
function nftFingerprint(snapshot, table) {
  return crypto.createHash('sha256').update(JSON.stringify(normalizeNftSnapshot(snapshot, table))).digest('hex');
}
function planNftReplacement({ table, current, owned, desired }) {
  if (!TABLES.has(table)) throw new TypeError('Not a cell routing table');
  const normalize = value => value === null ? null : normalizeNftSnapshot(value, table);
  const actual = normalize(current), previous = normalize(owned), next = normalize(desired);
  if (actual && (!previous || JSON.stringify(actual) !== JSON.stringify(previous))) {
    throw new Error('Foreign or changed cell nft table; refusing replacement');
  }
  const nftables = [];
  if (JSON.stringify(actual) === JSON.stringify(next)) return { batch: { nftables }, changed: false, desired: next };
  if (actual) nftables.push({ delete: { table: { family: 'inet', name: table } } });
  if (next) for (const item of next.nftables) nftables.push({ add: item });
  return { batch: { nftables }, changed: true, desired: next };
}
module.exports = { normalizeNftSnapshot, nftFingerprint, planNftReplacement };
