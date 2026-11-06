'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { identity } = require('../../lib/CellRegistration');
const { deriveAwgPublicKey } = require('../../lib/CellAwgConnectionStore');
const { generateOfficialProfile } = require('../../lib/Awg3Config');
const { createAwgBootstrapInvitation } = require('../../lib/CellAwgBootstrapInvitation');
const { permanentControllerPlan } = require('../../lib/CellAwgPermanentPlan');
const { CellAwgPermanentRevisionStore } = require('../../lib/CellAwgPermanentRevisionStore');
const { controllerDataLinkPlan } = require('../../lib/CellDataLinkPlan');
const { signSettings } = require('../../lib/CellSettings');
const key = () => crypto.randomBytes(32).toString('base64');
const pair = () => {
  const bytes = crypto.randomBytes(32);
  bytes[0] &= 248; bytes[31] &= 127; bytes[31] |= 64; // Same canonical X25519 scalar as `awg genkey`.
  const privateKey = bytes.toString('base64');
  return { privateKey, publicKey: deriveAwgPublicKey(privateKey) };
};
const keyManager = { derivePublicKey: async value => deriveAwgPublicKey(value),
  generateKeyPair: async () => pair(),
  generatePeerKeys: async () => ({ ...pair(), presharedKey: key() }) };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function file(name, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const [area, ...parts] = name.split('/');
  return { area, name: parts.join('/'), sha256: hash(bytes), data: bytes.toString('base64') };
}
async function fixture({ onCell = () => {} } = {}) {
  const main = identity(), control = pair(), profile = generateOfficialProfile();
  const state = { version: 4, auth: { passwordHash: 'test-hash', sessionSecret: 'test-session' },
    server: { interfaceName: 'awg0', wanInterface: 'eth0', endpointHost: '198.51.100.1',
      listenPort: 51820, panelPort: 51821, ...pair(), address4: '10.8.0.1', ipv4Subnet: '10.8.0.0/24', profile },
    clients: [{ id: 'admin', name: 'Home admin', ...pair(), presharedKey: key(),
      networkGroup: 'home', enabled: true, address4: '10.8.0.2' }] };
  const values = { 'panel/state.json': state,
    'main/identity.json': { version: 1, role: 'controller', ...main },
    'main/config.json': { version: 1, ...control, profile } };
  const records = [];
  for (let index = 0; index < 2; index++) {
    const cell = identity(), cellAwg = pair();
    const descriptor = { version: 1, endpointHost: '198.51.100.1', endpointPort: 53084,
      controllerAddress: '10.91.8.1', cellAddress: `10.91.8.${index + 2}`, controlPort: 53083,
      serverPublicKey: control.publicKey, profile };
    const issued = await createAwgBootstrapInvitation({ controllerKey: main.publicKey,
      endpointHost: '198.51.100.1', endpointPort: 53081, registrationPort: 53082,
      controllerAddress: '10.90.8.1', cellAddress: `10.90.8.${index + 2}`,
      serverPublicKey: control.publicKey, profile, keyManager, now: 1000,
      permanentDescriptor: descriptor });
    const record = { ...issued.record, status: 'consumed', phase: 'closed',
      temporaryPresharedKey: null, cellKey: cell.publicKey, requestId: 'a'.repeat(32),
      changedAt: 1001, awgPublicKey: cellAwg.publicKey, awgPresharedKey: key() };
    records.push(record);
    onCell({ identity: cell, record });
    const digest = hash(cell.publicKey);
    values[`main/cell-settings/${digest}.json`] = { version: 1,
      desired: signSettings({ cellKey: cell.publicKey, revision: 1, settings: { schema: 1, clients: [] } }, main.privateKey),
      ack: null, confirmed: null };
    const data = pair(), cellData = pair();
    const offer = { version: 1, controllerPrivateKey: data.privateKey,
      cellPublicKey: cellData.publicKey, presharedKey: key(), descriptor: {
        version: 1, slot: index, endpointHost: '198.51.100.1', endpointPort: 54000 + index,
        controllerAddress4: `10.92.${index}.1`, cellAddress4: `10.92.${index}.2`,
        controllerPublicKey: data.publicKey, controllerClientSubnet4: '10.8.0.0/24',
        cellClientSubnet4: `10.64.${index}.0/24`, profile } };
    values[`main/cell-data-keys/${digest}.json`] = { version: 1, publicKey: cellData.publicKey };
    values[`main/cell-data-offers/${digest}.json`] = offer;
    values[`main/data-links/${digest}/plan.json`] = (await controllerDataLinkPlan({ storedOffer: offer,
      slot: index, keyManager })).plan;
  }
  values['main/bootstrap.json'] = { version: 2, invitations: records };
  const generated = await permanentControllerPlan({ privateKey: control.privateKey,
    descriptor: records[0].permanentDescriptor, interfaceName: 'awgmainc0', keyManager,
    peers: records.map(record => ({ cellAddress: record.permanentDescriptor.cellAddress,
      awgPublicKey: record.awgPublicKey, awgPresharedKey: record.awgPresharedKey })) });
  const base = { version: 1, ...generated };
  values['main/permanent/plan.json'] = base;
  values['main/permanent/revision.json'] = new CellAwgPermanentRevisionStore(path.resolve('unused.json'), base).empty();
  return { version: 1, kind: 'awg-easy-3/configuration-snapshot', createdAt: 2000,
    files: Object.entries(values).map(([name, value]) => file(name, value)) };
}
module.exports = { fixture, key, pair, keyManager, hash, file };
