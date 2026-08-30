'use strict';

const net = require('node:net');

const trafficError = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });

// Addresses and exported routes describe capabilities, not current permissions.
const clientTraffic = (client, { ipv6Available = Boolean(client.address6) } = {}) => {
  for (const field of ['enabled', 'ipv4Enabled', 'ipv6Enabled']) {
    if (client[field] !== undefined && typeof client[field] !== 'boolean') {
      throw new TypeError(`${field} must be a boolean`);
    }
  }
  const explicit = client.ipv4Enabled !== undefined || client.ipv6Enabled !== undefined;
  if (explicit && (client.ipv4Enabled === undefined || client.ipv6Enabled === undefined)) {
    throw new TypeError('Both IP permissions must be stored together');
  }
  const ipv4Enabled = explicit ? client.ipv4Enabled : client.enabled !== false;
  const ipv6Enabled = explicit ? client.ipv6Enabled : client.enabled !== false && ipv6Available;
  if (ipv6Enabled && !ipv6Available) {
    throw trafficError('IPV6_UNAVAILABLE', 'IPv6 is not available for this client on this server');
  }
  return Object.freeze({ ipv4Enabled, ipv6Enabled, enabled: ipv4Enabled || ipv6Enabled });
};

const changeClientTraffic = (client, changes, options) => {
  const current = clientTraffic(client, options);
  if ('enabled' in changes && ('ipv4Enabled' in changes || 'ipv6Enabled' in changes)) {
    throw new TypeError('Do not combine enabled with IP permissions');
  }
  const updated = { ...client, ...current, ...changes };
  // Keep the old API as an explicit enable-all / disable-all operation.
  if ('enabled' in changes) {
    if (typeof changes.enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    updated.ipv4Enabled = changes.enabled;
    updated.ipv6Enabled = changes.enabled && (options?.ipv6Available ?? Boolean(client.address6));
  }
  return { ...updated, ...clientTraffic(updated, options) };
};

const canonicalAddress = (address) => {
  const text = String(address ?? '').toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
  if (net.isIP(text) === 4) return text;
  if (net.isIP(text) === 6 && !text.includes('%')) {
    const canonical = new URL(`http://[${text}]/`).hostname;
    const mapped = canonical.match(/^\[::ffff:([\da-f]+):([\da-f]+)\]$/);
    if (mapped) {
      const high = parseInt(mapped[1], 16);
      const low = parseInt(mapped[2], 16);
      return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
    }
    return canonical;
  }
  return null;
};

const assertCurrentPanelPathRemains = (client, nextClient, remoteAddress) => {
  const remote = canonicalAddress(remoteAddress);
  if (!remote) return;
  const family = remote === canonicalAddress(client.address4) ? 4
    : remote === canonicalAddress(client.address6) ? 6 : null;
  if (!family) return;
  if (!nextClient || nextClient.networkGroup !== 'home' || !clientTraffic(nextClient)[`ipv${family}Enabled`]) {
    throw trafficError('CURRENT_PANEL_PATH', 'This change would block your current connection to the panel');
  }
};

module.exports = { clientTraffic, changeClientTraffic, assertCurrentPanelPathRemains, trafficError };
