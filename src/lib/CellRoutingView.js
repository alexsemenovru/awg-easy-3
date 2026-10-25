'use strict';

const net = require('node:net');
const { planCellTopology } = require('./CellTopology');
const { normalizeGeoPolicy } = require('./GeoIpPolicy');
const { ipNumber } = require('./GeoIpAddress');
const { validateCellSettings } = require('./CellSettingsSchema');

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const exact = (value, required, optional = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError('Invalid Cell routing view fields');
  }
};

// This is the wire view. It contains addresses and policies needed to route
// traffic, but never client keys, names, or the other Cells' public endpoints.
function routingViewFromTopology(topology, nodeId, { panel } = {}) {
  const plans = planCellTopology(topology).plans;
  const plan = plans.find(row => row.node.id === nodeId);
  if (!plan) throw new TypeError('Unknown Cell routing recipient');
  const controllerId = plans.find(row => row.node.role === 'controller').node.id;
  return validateRoutingView({ schema: 1, nodeId, controllerId,
    node: plan.node, links: plan.links, routes: plan.routes,
    ...(panel ? { panel } : {}) });
}

function validateRoutingView(input, expectedNodeId) {
  exact(input, ['schema', 'nodeId', 'controllerId', 'node', 'links', 'routes'], ['panel']);
  if (input.schema !== 1 || !identifier(input.nodeId) || !identifier(input.controllerId)
    || expectedNodeId !== undefined && input.nodeId !== expectedNodeId
    || !Array.isArray(input.links) || input.links.length > 127
    || !Array.isArray(input.routes) || input.routes.length > 1000) {
    throw new TypeError('Invalid Cell routing view');
  }
  exact(input.node, ['id', 'role', 'ipv4', 'ipv6']);
  if (input.node.id !== input.nodeId
    || input.node.role !== (input.nodeId === input.controllerId ? 'controller' : 'cell')
    || typeof input.node.ipv4 !== 'boolean' || typeof input.node.ipv6 !== 'boolean') {
    throw new TypeError('Invalid Cell routing recipient');
  }
  let panel;
  if (input.panel !== undefined) {
    exact(input.panel, ['address4', 'port'], ['address6']);
    if (net.isIP(input.panel.address4) !== 4
      || !Number.isSafeInteger(input.panel.port) || input.panel.port < 1
      || input.panel.port > 65535
      || input.panel.address6 !== undefined
        && (net.isIP(input.panel.address6) !== 6 || input.panel.address6.includes('%'))) {
      throw new TypeError('Invalid Cell panel route');
    }
    panel = Object.freeze({ ...input.panel });
  }
  const peers = new Set();
  const links = input.links.map(link => {
    exact(link, ['peer', 'ipv4', 'ipv6']);
    if (!identifier(link.peer) || link.peer === input.nodeId || peers.has(link.peer)
      || typeof link.ipv4 !== 'boolean' || typeof link.ipv6 !== 'boolean'
      || !link.ipv4 && !link.ipv6) throw new TypeError('Invalid Cell routing link');
    peers.add(link.peer);
    return Object.freeze({ ...link });
  });
  const ids = new Set(), addresses = new Set();
  const routes = input.routes.map(route => {
    exact(route, ['id', 'entry', 'exit', 'address4', 'group', 'geoPolicy', 'enabled', 'reasons'], ['address6']);
    if (!identifier(route.id) || ids.has(route.id) || !identifier(route.entry)
      || !identifier(route.exit) || !['home', 'guest'].includes(route.group)
      || net.isIP(route.address4) !== 4
      || route.address6 !== undefined && (net.isIP(route.address6) !== 6 || route.address6.includes('%'))) {
      throw new TypeError('Invalid Cell routed client');
    }
    ids.add(route.id);
    for (const family of [4, 6]) {
      const address = route[`address${family}`];
      if (!address) continue;
      const key = `${family}:${ipNumber(address)}`;
      if (addresses.has(key)) throw new TypeError('Duplicate Cell routed address');
      addresses.add(key);
    }
    exact(route.enabled, ['ipv4', 'ipv6']);
    exact(route.reasons, ['ipv4', 'ipv6']);
    for (const family of [4, 6]) {
      const key = `ipv${family}`;
      if (typeof route.enabled[key] !== 'boolean'
        || route.enabled[key] && (!route[`address${family}`] || !input.node[key] && route.entry === input.nodeId)
        || route.reasons[key] !== null && !['disabled-by-owner', 'family-unavailable', 'direct-link-unavailable']
          .includes(route.reasons[key])
        || route.enabled[key] !== (route.reasons[key] === null)) {
        throw new TypeError('Invalid Cell route capability');
      }
    }
    exact(route.geoPolicy, ['mode', 'countries']);
    if (route.geoPolicy.mode === 'off' && route.geoPolicy.countries.length !== 0) {
      throw new TypeError('Invalid disabled GeoIP policy');
    }
    const geoPolicy = normalizeGeoPolicy(route.geoPolicy);
    return Object.freeze({ ...route, geoPolicy,
      enabled: Object.freeze({ ...route.enabled }), reasons: Object.freeze({ ...route.reasons }) });
  });
  return Object.freeze({ schema: 1, nodeId: input.nodeId, controllerId: input.controllerId,
    node: Object.freeze({ ...input.node }), links: Object.freeze(links), routes: Object.freeze(routes),
    ...(panel ? { panel } : {}) });
}

// A signed routing revision must never silently grant a path to a peer absent
// from the separately signed user assignment currently applied on this Cell.
function assertRoutingMatchesAssignments(input, settings) {
  const view = validateRoutingView(input);
  const assigned = validateCellSettings(settings).clients;
  const local = view.routes.filter(route => route.entry === view.nodeId);
  if (local.length !== assigned.length) throw new Error('Routing and client assignments differ');
  const byId = new Map(local.map(route => [route.id, route]));
  for (const client of assigned) {
    const route = byId.get(client.id);
    if (!route || route.address4 !== client.address4
      || (route.address6 || null) !== (client.address6 || null)
      || route.group !== client.networkGroup
      || JSON.stringify(route.geoPolicy) !== JSON.stringify(client.geoPolicy)
      || route.enabled.ipv4 && !client.ipv4Enabled
      || route.enabled.ipv6 && !client.ipv6Enabled) {
      throw new Error('Routing and client assignments differ');
    }
  }
  return view;
}

module.exports = { routingViewFromTopology, validateRoutingView,
  assertRoutingMatchesAssignments };
