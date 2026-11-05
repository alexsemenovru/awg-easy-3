'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { validateSnapshot } = require('./BackupSnapshot');
const { validateState } = require('./StateStore');
const { validateKey } = require('./AwgKeyManager');
const { deriveAwgPublicKey } = require('./CellAwgConnectionStore');
const { validateControlIdentity } = require('./ControlIdentityStore');
const { validateBootstrapState } = require('./CellAwgBootstrapStore');
const { MainBootstrapConfigStore } = require('./MainBootstrapConfigStore');
const { validatePermanentPlan } = require('./CellAwgPermanentPlanStore');
const { CellAwgPermanentRevisionStore } = require('./CellAwgPermanentRevisionStore');
const { permanentControllerPlan } = require('./CellAwgPermanentPlan');
const { validateCellUserDescriptor } = require('./CellUserDescriptor');
const { validateDataKeyAnnouncement } = require('./CellDataKeyStore');
const { validateStoredOffer } = require('./CellDataOfferStore');
const { controllerDataLinkPlan } = require('./CellDataLinkPlan');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');
const { verifySettings } = require('./CellSettings');
const { validateCellSettings } = require('./CellSettingsSchema');
const { verifySettingsAck } = require('./CellSettingsAck');
const { verifyRoutingRevision } = require('./CellRoutingRevision');
const { verifyRoutingAck } = require('./CellRoutingAck');
const fail = () => { throw new Error('Backup configuration identities or plans disagree'); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyManager = { derivePublicKey: async value => deriveAwgPublicKey(value) };
function equivalentPlan(actual, expected) {
  // A fresh owner UUID may differ, but no executable rule, route, address,
  // interface, peer, private key or profile can differ from generated plans.
  return actual.spec.owner.interfaceName === expected.spec.owner.interfaceName
    && actual.spec.owner.mtu === expected.spec.owner.mtu
    && same(normalizeAwgConfig(actual.spec.owner.config), normalizeAwgConfig(expected.spec.owner.config))
    && same(actual.spec.addresses, expected.spec.addresses)
    && same(actual.policy, expected.policy) && same(actual.routeCommands, expected.routeCommands);
}
function validatePublished(value, trust) {
  if (!value || value.version !== 1 || !['ack,desired,version', 'ack,confirmed,desired,version']
    .includes(Object.keys(value).sort().join(','))) fail();
  validateCellSettings(verifySettings(value.desired, trust).settings);
  if (value.ack !== null) verifySettingsAck(value.ack, value.desired);
  if (value.confirmed !== undefined && value.confirmed !== null) {
    if (Object.keys(value.confirmed).sort().join(',') !== 'ack,desired') fail();
    validateCellSettings(verifySettings(value.confirmed.desired, trust).settings);
    verifySettingsAck(value.confirmed.ack, value.confirmed.desired);
    if (value.confirmed.desired.revision > value.desired.revision) fail();
    if (value.confirmed.desired.revision === value.desired.revision
      && (!same(value.confirmed.desired, value.desired) || !same(value.confirmed.ack, value.ack))) fail();
  }
  if (value.ack !== null && value.confirmed !== undefined
    && (!value.confirmed || !same(value.confirmed.desired, value.desired)
      || !same(value.confirmed.ack, value.ack))) fail();
}

// Semantic validation BEFORE restore touches live state. This runs no archived
// commands and no external executables, even for X25519 key-pair derivation.
async function validateBackupConfiguration(input) {
  const snapshot = structuredClone(input);
  validateSnapshot(snapshot);
  const files = new Map(snapshot.files.map(file => [`${file.area}/${file.name}`,
    JSON.parse(Buffer.from(file.data, 'base64').toString('utf8'))]));
  const state = validateState(files.get('panel/state.json'));
  if (deriveAwgPublicKey(state.server.privateKey) !== state.server.publicKey) fail();
  for (const client of state.clients) {
    if (deriveAwgPublicKey(client.privateKey) !== client.publicKey) fail();
    validateKey(client.presharedKey, 'backupClientPresharedKey');
  }
  if (![...files.keys()].some(name => name.startsWith('main/'))) {
    if (state.clients.some(client => client.entryCellId)) fail();
    return { main: false, cells: 0, clients: state.clients.length };
  }
  const identity = validateControlIdentity(files.get('main/identity.json'));
  if (identity.role !== 'controller') fail();
  const config = new MainBootstrapConfigStore(path.resolve('backup-validation-config.json'))
    .validate(files.get('main/config.json'));
  if (deriveAwgPublicKey(config.privateKey) !== config.publicKey) fail();
  const enrollment = validateBootstrapState(files.get('main/bootstrap.json'));
  const records = enrollment.invitations.filter(record => record.status === 'consumed');
  if (records.some(record => record.phase !== 'closed' || !record.permanentDescriptor
    || !record.awgPublicKey || record.permanentDescriptor.serverPublicKey !== config.publicKey
    || !same(record.permanentDescriptor.profile, config.profile))) {
    throw new Error('Complete the pending Cell transition before restoring this backup');
  }
  const byHash = new Map(records.map(record => [crypto.createHash('sha256').update(record.cellKey).digest('hex'), record]));
  if (state.clients.some(client => client.entryCellId && !records.some(record => record.id === client.entryCellId))) fail();
  const baseValue = files.get('main/permanent/plan.json');
  const revisionValue = files.get('main/permanent/revision.json');
  let effectivePlan = null;
  if (baseValue) {
    const base = validatePermanentPlan(baseValue);
    if (!revisionValue) fail(); // Never resurrect peers from a stale base.
    const revision = new CellAwgPermanentRevisionStore(path.resolve('backup-validation-revision.json'), base).validate(revisionValue);
    if (revision.pending) throw new Error('Complete the pending permanent revision before restoring this backup');
    effectivePlan = revision.committed ?? base;
    if (!records.length) fail();
    const expected = validatePermanentPlan({ version: 1, ...await permanentControllerPlan({
      privateKey: config.privateKey, descriptor: records[0].permanentDescriptor,
      peers: records.map(record => ({ cellAddress: record.permanentDescriptor.cellAddress,
        awgPublicKey: record.awgPublicKey, awgPresharedKey: record.awgPresharedKey })),
      interfaceName: effectivePlan.spec.owner.interfaceName, keyManager }) });
    if (!equivalentPlan(effectivePlan, expected)) fail();
  } else if (records.length || revisionValue) fail();
  const slots = new Set(), ports = new Set();
  for (const [name, value] of files) {
    if (!/^main\/(?:cell-|data-links\/)/.test(name)) continue;
    const match = name.match(/^main\/(cell-settings|cell-descriptors|cell-data-keys|cell-data-offers|cell-routing|data-links)\/([a-f0-9]{64})(?:\.json(\.ack)?|\/plan\.json)$/);
    if (!match) fail();
    const [, kind, hash, ackSuffix] = match;
    const record = byHash.get(hash);
    if (!record) fail();
    const trust = { controllerKey: identity.publicKey, cellKey: record.cellKey, nodeId: record.id };
    if (kind === 'cell-settings') validatePublished(value, trust);
    if (kind === 'cell-descriptors') validateCellUserDescriptor(value);
    if (kind === 'cell-data-keys') validateDataKeyAnnouncement(value);
    if (kind === 'cell-routing') {
      const desired = ackSuffix ? files.get(`main/cell-routing/${hash}.json`) : value;
      if (!desired) fail();
      verifyRoutingRevision(desired, trust);
      // Older acknowledgements are ignored by runtime, never readiness proof.
      if (ackSuffix && value.revision === desired.revision) verifyRoutingAck(value, desired);
    }
    if (kind === 'cell-data-offers') {
      const offer = await validateStoredOffer(value, keyManager);
      const announced = files.get(`main/cell-data-keys/${hash}.json`);
      if (!announced || announced.publicKey !== offer.cellPublicKey
        || slots.has(offer.descriptor.slot) || ports.has(offer.descriptor.endpointPort)) fail();
      slots.add(offer.descriptor.slot); ports.add(offer.descriptor.endpointPort);
    }
    if (kind === 'data-links') {
      const offer = files.get(`main/cell-data-offers/${hash}.json`);
      if (!offer) fail();
      const generated = await controllerDataLinkPlan({ storedOffer: offer,
        slot: offer.descriptor.slot, keyManager });
      const actual = validatePermanentPlan(value, { policyTable: generated.policyTable });
      if (!equivalentPlan(actual, generated.plan)) fail();
    }
  }
  return { main: true, cells: records.length, clients: state.clients.length };
}
module.exports = { validateBackupConfiguration };
