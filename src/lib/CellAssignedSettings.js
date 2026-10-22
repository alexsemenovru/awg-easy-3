'use strict';

const { validateState, CELL_STATE_VERSION } = require('./StateStore');
const { validateCellSettings } = require('./CellSettingsSchema');
const { validateCellUserDescriptor } = require('./CellUserDescriptor');
const { addressInSubnet } = require('./AddressAllocator');
const { clientTraffic } = require('./ClientTraffic');
const { normalizeGeoPolicy } = require('./GeoIpPolicy');

// Build all desired Cell views before publishing any one revision. A Cell only
// receives its own public client peers and policy, never client private keys,
// names or the topology of unrelated Cells.
function assignedSettingsFromState(input, cells) {
  const state = validateState(input);
  if (state.version !== CELL_STATE_VERSION) {
    throw new TypeError('Cell assignments require panel state version 4');
  }
  if (!Array.isArray(cells) || cells.length > 1012) throw new TypeError('Invalid Cell inventory');
  const descriptors = new Map();
  for (const cell of cells) {
    if (!cell || typeof cell.id !== 'string' || !/^[a-f0-9]{32}$/.test(cell.id)
      || descriptors.has(cell.id)) throw new TypeError('Invalid Cell identity');
    descriptors.set(cell.id, cell.descriptor === null ? null
      : validateCellUserDescriptor(cell.descriptor));
  }
  const result = Object.fromEntries([...descriptors.keys()].map(id => [id, []]));
  for (const client of state.clients) {
    if (!client.entryCellId) continue;
    if (!descriptors.has(client.entryCellId)) throw new TypeError('Assigned Cell is not registered');
    const descriptor = descriptors.get(client.entryCellId);
    if (!descriptor) throw new TypeError('Assigned Cell has not announced its user endpoint');
    if (!addressInSubnet(client.address4, descriptor.ipv4Subnet)
      || client.address4 === descriptor.address4
      || client.address6 && (!descriptor.address6
        || !addressInSubnet(client.address6, descriptor.ipv6Subnet)
        || client.address6 === descriptor.address6)) {
      throw new TypeError('Assigned client address conflicts with its Cell network');
    }
    const traffic = clientTraffic(client, { ipv6Available: Boolean(descriptor.address6 && client.address6) });
    result[client.entryCellId].push({ id: client.id, publicKey: client.publicKey,
      address4: client.address4, ...(client.address6 ? { address6: client.address6 } : {}),
      ...(client.presharedKey ? { presharedKey: client.presharedKey } : {}),
      networkGroup: client.networkGroup, ipv4Enabled: traffic.ipv4Enabled,
      ipv6Enabled: traffic.ipv6Enabled, geoPolicy: normalizeGeoPolicy(client.geoPolicy) });
  }
  return Object.freeze(Object.fromEntries(Object.entries(result).map(([id, clients]) =>
    [id, validateCellSettings({ schema: 1, clients })])));
}

module.exports = { assignedSettingsFromState };
