'use strict';
const { validateCellSettings } = require('./CellSettingsSchema');
const { ipNumber } = require('./GeoIpAddress');
const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x);
const exact = (x, fields, optional = []) => {
  if (!x || typeof x !== 'object' || Array.isArray(x)
    || Object.keys(x).some(k => !fields.includes(k) && !optional.includes(k)) || fields.some(k => !Object.hasOwn(x, k))) {
    throw new TypeError('Invalid topology fields');
  }
};

// Controller-side desired topology. No health input: outages must never silently
// select a new exit or a new intermediary. Initial routing supports direct links.
function planCellTopology(input) {
  exact(input, ['version', 'nodes', 'links', 'clients']);
  if (input.version !== 1 || !Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > 128
    || !Array.isArray(input.links) || input.links.length > 8128
    || !Array.isArray(input.clients) || input.clients.length > 1000) throw new TypeError('Invalid topology size');
  const nodes = new Map();
  for (const node of input.nodes) {
    exact(node, ['id', 'role', 'ipv4', 'ipv6']);
    if (!id(node.id) || nodes.has(node.id) || !['controller', 'cell'].includes(node.role)
      || typeof node.ipv4 !== 'boolean' || typeof node.ipv6 !== 'boolean') throw new TypeError('Invalid topology node');
    nodes.set(node.id, { ...node });
  }
  if ([...nodes.values()].filter(n => n.role === 'controller').length !== 1) throw new TypeError('One controller required');
  const links = new Map();
  const pair = (a, b) => JSON.stringify([a, b].sort());
  for (const link of input.links) {
    exact(link, ['a', 'b', 'ipv4', 'ipv6']);
    if (!nodes.has(link.a) || !nodes.has(link.b) || link.a === link.b || links.has(pair(link.a, link.b))
      || typeof link.ipv4 !== 'boolean' || typeof link.ipv6 !== 'boolean') throw new TypeError('Invalid topology link');
    links.set(pair(link.a, link.b), { ...link });
  }
  const assignments = input.clients.map(client => {
    exact(client, ['entry', 'exit', 'assignment'], ['via', 'geoRoute']);
    const geoRoute = require('./GeoExit').normalizeGeoExit(client.geoRoute);
    if (geoRoute && !nodes.has(geoRoute.exitNodeId)) throw new TypeError('Unknown GeoIP exit');
    if (!nodes.has(client.entry) || !nodes.has(client.exit)) throw new TypeError('Unknown entry or exit');
    if (client.via !== undefined && (!nodes.has(client.via) || nodes.get(client.via).role !== 'controller'
      || client.via === client.entry || client.via === client.exit || client.entry === client.exit)) {
      throw new TypeError('Invalid fixed transit node');
    }
    return client.assignment;
  });
  const normalized = validateCellSettings({ schema: 1, clients: assignments }).clients;
  // Reject unusable/multicast/loopback identities before creating route selectors.
  for (const client of normalized) {
    for (const family of [4, 6]) {
      const address = client[`address${family}`];
      if (!address) continue;
      const number = ipNumber(address);
      if (family === 4 ? number < 16777216n || (number >> 24n) === 127n || number >= 3758096384n
        : number <= 1n || (number >> 120n) === 255n || (number >> 118n) === 1018n
          || (number >> 32n) === 65535n) throw new TypeError('Invalid routed client address');
    }
  }
  const clients = input.clients.map((row, index) => {
    const assignment = normalized[index];
    const entry = nodes.get(row.entry), exit = nodes.get(row.exit);
    const link = row.entry === row.exit ? null : links.get(pair(row.entry, row.exit));
    const enabled = {}, reasons = {};
    for (const family of [4, 6]) {
      const key = `ipv${family}`;
      enabled[key] = Boolean(assignment[`${key}Enabled`] && entry[key] && exit[key]
        && (row.entry === row.exit || (row.via !== undefined
          ? nodes.get(row.via)[key] && links.get(pair(row.entry, row.via))?.[key]
            && links.get(pair(row.via, row.exit))?.[key] : link?.[key])));
      reasons[key] = enabled[key] ? null : !assignment[`${key}Enabled`] ? 'disabled-by-owner'
        : !entry[key] || !exit[key] ? 'family-unavailable' : 'direct-link-unavailable';
    }
    return { ...row, assignment, enabled, reasons };
  });
  // Per-node views never distribute a remote client's keys/PSK. The routing view
  // contains addresses/policy only; only the entry receives its AWG peer material.
  const plans = [...nodes.values()].map(node => ({
    node: { ...node },
    peers: clients.filter(c => c.entry === node.id).map(c => ({ ...c.assignment,
      ipv4Enabled: c.enabled.ipv4, ipv6Enabled: c.enabled.ipv6 })),
    routes: clients.map(c => ({ id: c.assignment.id, entry: c.entry, exit: c.exit,
      ...(c.via !== undefined ? { via: c.via } : {}),
      address4: c.assignment.address4, ...(c.assignment.address6 ? { address6: c.assignment.address6 } : {}),
      ...(c.geoRoute ? { geoRoute: require('./GeoExit').normalizeGeoExit(c.geoRoute) } : {}),
      group: c.assignment.networkGroup, geoPolicy: c.assignment.geoPolicy,
      enabled: { ...c.enabled }, reasons: { ...c.reasons } })),
    links: input.links.filter(l => l.a === node.id || l.b === node.id).map(l => ({
      peer: l.a === node.id ? l.b : l.a, ipv4: l.ipv4, ipv6: l.ipv6,
    })),
  }));
  return structuredClone({ version: 1, plans });
}

module.exports = { planCellTopology };
