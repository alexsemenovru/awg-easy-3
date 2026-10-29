'use strict';
const { NETWORK_GROUPS } = require('./NetworkGroups');

const net = require('node:net');
const { ipNumber } = require('./GeoIpAddress');
const { normalizeGeoPolicy } = require('./GeoIpPolicy');

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, required, optional = []) => {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError('Unsupported cell settings fields');
  }
};
const vpnKey = value => typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value)
  && Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value;

// Assignment schema only. Interface names, shell commands, private client keys,
// global server settings and arbitrary nftables text are deliberately not accepted.
function validateCellSettings(input) {
  exact(input, ['schema', 'clients']);
  if (input.schema !== 1 || !Array.isArray(input.clients) || input.clients.length > 1000) {
    throw new TypeError('Unsupported cell settings schema');
  }
  const ids = new Set();
  const keys = new Set();
  const addresses = new Set();
  const clients = input.clients.map(client => {
    exact(client, ['id', 'publicKey', 'address4', 'networkGroup', 'ipv4Enabled', 'ipv6Enabled', 'geoPolicy'],
      ['address6', 'presharedKey']);
    if (typeof client.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(client.id)
      || ids.has(client.id) || !vpnKey(client.publicKey) || keys.has(client.publicKey)
      || (client.presharedKey !== undefined && !vpnKey(client.presharedKey))
      || !NETWORK_GROUPS.includes(client.networkGroup)
      || typeof client.ipv4Enabled !== 'boolean' || typeof client.ipv6Enabled !== 'boolean') {
      throw new TypeError('Invalid cell client assignment');
    }
    ids.add(client.id);
    keys.add(client.publicKey);
    for (const family of [4, 6]) {
      const address = client[`address${family}`];
      if (family === 6 && address === undefined) continue;
      if (typeof address !== 'string' || address.includes('%') || net.isIP(address) !== family) {
        throw new TypeError('Invalid cell client address');
      }
      const canonical = `${family}:${ipNumber(address)}`;
      if (addresses.has(canonical)) throw new TypeError('Duplicate cell client address');
      addresses.add(canonical);
    }
    if (client.ipv6Enabled && !client.address6) throw new TypeError('IPv6 requires a client address');
    exact(client.geoPolicy, ['mode', 'countries']);
    // Do not silently discard a typo/leftover selection when filtering is off.
    if (client.geoPolicy.mode === 'off' && client.geoPolicy.countries?.length !== 0) {
      throw new TypeError('Disabled GeoIP policy must have no countries');
    }
    const geoPolicy = normalizeGeoPolicy(client.geoPolicy);
    return Object.freeze({ ...client, geoPolicy });
  });
  return Object.freeze({ schema: 1, clients: Object.freeze(clients) });
}

module.exports = { validateCellSettings };
