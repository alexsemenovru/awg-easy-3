'use strict';

const { validateAwgOwnership } = require('./CellAwgOwnership');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');
const { specification } = require('./CellAwgLifecycle');
const { validatePermanentDescriptor } = require('./CellAwgPermanentDescriptor');
const { renderPermanentServerConfig } = require('./CellAwgPermanentConfig');
const { permanentControlPolicySnapshot } = require('./CellAwgPermanentControlPolicy');
const { bootstrapServerRoutes } = require('./CellAwgBootstrapRoutes');
const { validatePermanentPlan } = require('./CellAwgPermanentPlanStore');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canonicalProfile = profile => JSON.stringify(Object.fromEntries(
  Object.keys(profile).sort().map(key => [key, profile[key]])));

async function permanentControllerExpansionPlan({ currentPlan, records, keyManager }) {
  const current = validatePermanentPlan(currentPlan);
  if (!Array.isArray(records) || records.length < 1 || records.length > 128) {
    throw new TypeError('Permanent controller peer records required');
  }
  const entries = records.map(record => {
    if (!record || record.status !== 'consumed' || !record.permanentDescriptor
      || !record.awgPublicKey || !record.awgPresharedKey) {
      throw new TypeError('Consumed signed permanent peer required');
    }
    const descriptor = validatePermanentDescriptor(record.permanentDescriptor);
    if (record.cellAddress === descriptor.cellAddress) {
      throw new TypeError('Temporary and permanent peer addresses overlap');
    }
    return { descriptor, peer: { cellAddress: descriptor.cellAddress,
      awgPublicKey: record.awgPublicKey, awgPresharedKey: record.awgPresharedKey } };
  });
  const descriptor = entries[0].descriptor;
  const identity = entry => {
    const d = entry.descriptor;
    return [d.endpointHost, d.endpointPort, d.controllerAddress, d.controlPort,
      d.serverPublicKey, canonicalProfile(d.profile)];
  };
  if (entries.some(entry => !same(identity(entry), identity(entries[0])))) {
    throw new TypeError('Permanent controller descriptors disagree');
  }
  const before = normalizeAwgConfig(current.spec.owner.config);
  // The AWG renderer orders peers by public key. Keep policy and routes in
  // that same order so signed readback is independent of invitation order.
  const peers = entries.map(entry => entry.peer)
    .sort((a, b) => a.awgPublicKey.localeCompare(b.awgPublicKey));
  const rendered = await renderPermanentServerConfig({ privateKey: before.interface.privatekey,
    descriptor, peers, ...(keyManager ? { keyManager } : {}) });
  const after = normalizeAwgConfig(rendered.config);
  if (!same(before.interface, after.interface)
    || current.spec.addresses.length !== 1
    || current.spec.addresses[0] !== rendered.address
    || before.peers.some(peer => !after.peers.some(next => same(peer, next)))
    || after.peers.length < before.peers.length
    || after.peers.length > before.peers.length + 1) {
    throw new Error('Permanent controller expansion changes existing identity or peers');
  }
  const interfaceName = current.spec.owner.interfaceName;
  const owner = validateAwgOwnership({ ...current.spec.owner, config: rendered.config });
  const spec = specification({ ...current.spec, owner });
  return validatePermanentPlan({ version: 1, spec,
    policy: permanentControlPolicySnapshot({ role: 'controller', interfaceName,
      descriptor, peerAddresses: peers.map(peer => peer.cellAddress) }),
    routeCommands: bootstrapServerRoutes({ interfaceName,
      controllerAddress: descriptor.controllerAddress,
      peers: peers.map(peer => ({ phase: 'ready', cellAddress: peer.cellAddress })) }) });
}

module.exports = { permanentControllerExpansionPlan };
