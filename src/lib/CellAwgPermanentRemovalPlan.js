'use strict';

const net = require('node:net');
const { validateAwgOwnership } = require('./CellAwgOwnership');
const { normalizeAwgConfig, matchesAwgConfig } = require('./CellAwgSnapshot');
const { specification } = require('./CellAwgLifecycle');
const { validatePermanentDescriptor } = require('./CellAwgPermanentDescriptor');
const { renderPermanentServerConfig } = require('./CellAwgPermanentConfig');
const { permanentControlPolicySnapshot } = require('./CellAwgPermanentControlPolicy');
const { bootstrapServerRoutes } = require('./CellAwgBootstrapRoutes');
const { validatePermanentPlan } = require('./CellAwgPermanentPlanStore');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cidr = address => `${address}/${net.isIP(address) === 4 ? 32 : 128}`;

// Pure plan only. The additive revision journal must be upgraded to commit a
// guarded removal before this can be used for an actual Cell revocation.
async function permanentControllerRemovalPlan({ currentPlan, record, keyManager }) {
  const current = validatePermanentPlan(currentPlan);
  if (record?.status !== 'consumed' || !record.permanentDescriptor
    || !record.awgPublicKey || !record.awgPresharedKey) {
    throw new TypeError('Consumed permanent cell record required');
  }
  const descriptor = validatePermanentDescriptor(record.permanentDescriptor);
  const before = normalizeAwgConfig(current.spec.owner.config);
  const peers = before.peers.map(peer => {
    if (peer.allowedips.length !== 1) throw new Error('Unexpected permanent peer routes');
    const address = peer.allowedips[0].split('/')[0];
    if (peer.allowedips[0] !== cidr(address)) {
      throw new Error('Unexpected permanent peer address');
    }
    return { cellAddress: address, awgPublicKey: peer.publickey,
      awgPresharedKey: peer.presharedkey };
  });
  const target = peers.filter(peer => peer.cellAddress === descriptor.cellAddress
    && peer.awgPublicKey === record.awgPublicKey
    && peer.awgPresharedKey === record.awgPresharedKey);
  if (target.length !== 1 || record.cellAddress === descriptor.cellAddress) {
    throw new Error('Permanent cell identity to remove differs from signed record');
  }
  const interfaceName = current.spec.owner.interfaceName;
  const privateKey = before.interface.privatekey;
  const options = { privateKey, descriptor,
    ...(keyManager ? { keyManager } : {}) };
  const canonical = await renderPermanentServerConfig({ ...options, peers });
  const expectedPolicy = permanentControlPolicySnapshot({ role: 'controller', interfaceName,
    descriptor, peerAddresses: peers.map(peer => peer.cellAddress) });
  const expectedRoutes = bootstrapServerRoutes({ interfaceName,
    controllerAddress: descriptor.controllerAddress,
    peers: peers.map(peer => ({ phase: 'ready', cellAddress: peer.cellAddress })) });
  if (!matchesAwgConfig(canonical.config, current.spec.owner.config)
    || !matchesAwgConfig(current.spec.owner.config, canonical.config)
    || current.spec.addresses.length !== 1
    || current.spec.addresses[0] !== canonical.address
    || !same(current.policy, expectedPolicy)
    || !same(current.routeCommands, expectedRoutes)) {
    throw new Error('Current permanent path differs from signed cell topology');
  }
  const remaining = peers.filter(peer => peer !== target[0]);
  const rendered = await renderPermanentServerConfig({ ...options, peers: remaining });
  const owner = validateAwgOwnership({ ...current.spec.owner, config: rendered.config });
  const spec = specification({ ...current.spec, owner });
  const result = validatePermanentPlan({ version: 1, spec,
    policy: permanentControlPolicySnapshot({ role: 'controller', interfaceName,
      descriptor, peerAddresses: remaining.map(peer => peer.cellAddress) }),
    routeCommands: bootstrapServerRoutes({ interfaceName,
      controllerAddress: descriptor.controllerAddress,
      peers: remaining.map(peer => ({ phase: 'ready', cellAddress: peer.cellAddress })) }) });
  const after = normalizeAwgConfig(result.spec.owner.config);
  if (!same(before.interface, after.interface) || after.peers.length !== peers.length - 1
    || remaining.some(peer => !after.peers.some(item => item.publickey === peer.awgPublicKey
      && item.presharedkey === peer.awgPresharedKey
      && item.allowedips.length === 1 && item.allowedips[0] === cidr(peer.cellAddress)))) {
    throw new Error('Permanent removal changes another peer or server identity');
  }
  return result;
}

module.exports = { permanentControllerRemovalPlan };
