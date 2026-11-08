'use strict';
const { isHomeGroup } = require('./NetworkGroups');

const { validateState, CELL_STATE_VERSION } = require('./StateStore');
const { validateCellUserDescriptor } = require('./CellUserDescriptor');
const { assignmentFromClient } = require('./CellAssignedSettings');
const { planCellTopology } = require('./CellTopology');
const { assertDistinctClientSubnets } = require('./CellSubnetIsolation');

// Construct the routing view from persisted panel state. Only explicitly
// verified data links appear here; a working control AWG channel is NOT a
// client traffic link. No private client material is copied into the view.
function productCellTopology({ state: input, cells, readyLinks = [], exits = {} } = {}) {
  const state = validateState(input);
  if (state.version !== CELL_STATE_VERSION || !Array.isArray(cells)
    || cells.length > 127 || !Array.isArray(readyLinks)
    || readyLinks.length > cells.length || !exits || typeof exits !== 'object'
    || Array.isArray(exits)) throw new TypeError('Invalid product Cell topology input');
  const descriptors = new Map();
  for (const row of cells) {
    if (!row || typeof row.id !== 'string' || !/^[a-f0-9]{32}$/.test(row.id)
      || descriptors.has(row.id)) throw new TypeError('Invalid registered Cell identity');
    descriptors.set(row.id, validateCellUserDescriptor(row.descriptor));
  }
  assertDistinctClientSubnets([state.server.ipv4Subnet,
    ...[...descriptors.values()].map(value => value.ipv4Subnet)]);
  assertDistinctClientSubnets([state.server.ipv6Subnet,
    ...[...descriptors.values()].map(value => value.ipv6Subnet)].filter(Boolean));
  const nodes = [{ id: 'main', role: 'controller', ipv4: true,
    ipv6: Boolean(state.server.address6 && state.server.ipv6Subnet) },
  ...[...descriptors].map(([id, descriptor]) => ({ id, role: 'cell', ipv4: true,
    ipv6: Boolean(descriptor.address6 && descriptor.ipv6Subnet) }))];
  const links = [];
  const linked = new Map();
  for (const link of readyLinks) {
    if (!link || typeof link.cellId !== 'string' || !descriptors.has(link.cellId)
      || linked.has(link.cellId) || typeof link.ipv4 !== 'boolean'
      || typeof link.ipv6 !== 'boolean'
      || Object.keys(link).sort().join(',') !== 'cellId,ipv4,ipv6'
      || !link.ipv4 && !link.ipv6
      || link.ipv6 && (!nodes[0].ipv6 || !descriptors.get(link.cellId).address6)) {
      throw new TypeError('Invalid verified data link');
    }
    linked.set(link.cellId, link);
    links.push({ a: 'main', b: link.cellId, ipv4: link.ipv4, ipv6: link.ipv6 });
  }
  const clientIds = new Set(state.clients.map(client => client.id));
  if (Object.keys(exits).some(id => !clientIds.has(id))) {
    throw new TypeError('Unknown client exit assignment');
  }
  const clients = state.clients.filter(client => client.enabled
    || ((!client.entryCellId || descriptors.has(client.entryCellId))
      && (!client.exitNodeId || client.exitNodeId === 'main' || descriptors.has(client.exitNodeId)))).map(client => {
    const entry = client.entryCellId || 'main';
    if (entry !== 'main' && !descriptors.has(entry)) {
      throw new TypeError('Client entry Cell has no descriptor');
    }
    const exit = Object.hasOwn(exits, client.id) ? exits[client.id] : client.exitNodeId ?? entry;
    if (exit !== 'main' && !descriptors.has(exit)) {
      throw new TypeError('Client exit Cell has no descriptor');
    }
    return { entry, exit, ...(entry !== exit && entry !== 'main' && exit !== 'main' ? { via: 'main' } : {}),
      assignment: assignmentFromClient(client) };
  });
  const topology = { version: 1, nodes, links, clients };
  const planned = planCellTopology(topology);
  const panelPath = Object.freeze(Object.fromEntries(clients.filter(row => isHomeGroup(row.assignment.networkGroup))
    .map(row => [row.assignment.id, Object.freeze({
      ipv4: Boolean(row.assignment.ipv4Enabled && (row.entry === 'main' || linked.get(row.entry)?.ipv4)),
      ipv6: Boolean(row.assignment.ipv6Enabled && nodes[0].ipv6
        && (row.entry === 'main' || linked.get(row.entry)?.ipv6)),
    })])));
  return Object.freeze({ topology: structuredClone(topology), plans: planned.plans,
    panelPath });
}

// This view is only a desired route draft for guarded application. A staged
// data offer is enough to plan the route, but not to advertise readiness.
function plannedCellRoutingTopology({ state, cells, plannedLinks = [], exits = {} } = {}) {
  return productCellTopology({ state, cells, readyLinks: plannedLinks, exits }).topology;
}

module.exports = { productCellTopology, plannedCellRoutingTopology };
