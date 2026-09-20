'use strict';
const crypto = require('node:crypto');
const { normalizeAwgConfig, matchesAwgConfig } = require('./CellAwgSnapshot');
function validateAwgOwnership(value) {
  if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'config,interfaceName,mtu,ownerTag,version'
    || typeof value.interfaceName !== 'string' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(value.interfaceName)
    || typeof value.ownerTag !== 'string' || !/^awg-easy-3-cell:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.ownerTag)
    || !Number.isSafeInteger(value.mtu) || value.mtu < 576 || value.mtu > 9000) throw new TypeError('Invalid AWG ownership manifest');
  normalizeAwgConfig(value.config);
  return { version: 1, interfaceName: value.interfaceName, ownerTag: value.ownerTag, mtu: value.mtu, config: value.config };
}
function createAwgOwnership({ interfaceName, config, mtu = 1280 }) {
  return validateAwgOwnership({ version: 1, interfaceName, config, mtu, ownerTag: `awg-easy-3-cell:${crypto.randomUUID()}` });
}
// The caller must persist the manifest PRIVATELY before interface creation.
// A name alone is never ownership. This checks existing objects only; it does
// not adopt, relabel, configure or delete an interface, even after a crash.
function inspectAwgOwnership({ manifest, links, actualConfig }) {
  const owned = validateAwgOwnership(manifest);
  if (!Array.isArray(links)) throw new TypeError('Invalid AWG link inventory');
  const matches = links.filter(link => link?.ifname === owned.interfaceName);
  if (matches.length === 0) return { present: false, verified: false, up: false };
  if (matches.length !== 1) throw new Error('Ambiguous AWG link inventory');
  const link = matches[0], kind = link.linkinfo?.info_kind;
  if (link.ifalias !== owned.ownerTag || !['tun', 'amneziawg', 'wireguard'].includes(kind)
    || (kind === 'tun' && link.linkinfo?.info_data?.type !== 'tun')) throw new Error('Foreign or unproven AWG interface');
  if (link.mtu !== owned.mtu || !Array.isArray(link.flags) || !matchesAwgConfig(owned.config, actualConfig)) {
    throw new Error('Owned AWG interface configuration changed');
  }
  return { present: true, verified: true, up: link.flags.includes('UP') };
}
module.exports = { createAwgOwnership, validateAwgOwnership, inspectAwgOwnership };
