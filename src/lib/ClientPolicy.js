'use strict';

const NETWORK_GROUPS = Object.freeze(['home', 'guest']);

const enumValue = (value, allowed, field) => {
  if (!allowed.includes(value)) {
    throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
};

const normalizeClientPolicy = (input = {}, { bootstrap = false } = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Client policy must be an object');
  }
  return Object.freeze({
    networkGroup: enumValue(
      input.networkGroup ?? (bootstrap ? 'home' : 'guest'),
      NETWORK_GROUPS,
      'networkGroup',
    ),
  });
};

const assertActiveHomeRemains = (clients, clientId, changes) => {
  if (!Array.isArray(clients) || clients.length === 0) {
    throw new TypeError('clients must be a non-empty array');
  }
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new TypeError('changes must be an object');
  }

  const target = clients.find((client) => client.id === clientId);
  if (!target) throw new TypeError(`Unknown client: ${clientId}`);

  const remaining = clients.filter((client) => !client.deleted).map((client) => {
    if (client.id !== clientId) return client;
    return { ...client, ...changes };
  });
  const activeHomes = remaining.filter((client) => (
    client.deleted !== true
    && client.enabled !== false
    && client.networkGroup === 'home'
  ));
  if (activeHomes.length === 0) {
    throw new Error('At least one enabled home client must remain');
  }
};

module.exports = {
  NETWORK_GROUPS,
  assertActiveHomeRemains,
  normalizeClientPolicy,
};
