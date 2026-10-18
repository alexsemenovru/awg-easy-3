'use strict';

const { AwgKeyManager } = require('./AwgKeyManager');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');
const { permanentCellPlan, permanentControllerPlan } = require('./CellAwgPermanentPlan');
const { CellAwgPermanentVerifier } = require('./CellAwgPermanentVerifier');
const { validatePermanentDescriptor } = require('./CellAwgPermanentDescriptor');
const { nftFingerprint } = require('./CellNftOwnership');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const samePlan = (expected, saved) => same(expected.spec, saved.spec)
  && same(expected.routeCommands, saved.routeCommands)
  && nftFingerprint(expected.policy, 'awg_easy_3_control')
    === nftFingerprint(saved.policy, 'awg_easy_3_control');
function endpointHost(endpoint) {
  if (typeof endpoint !== 'string') return null;
  const match = endpoint.match(/^\[([^\]]+)\]:\d+$/) || endpoint.match(/^([^:]+):\d+$/);
  return match?.[1] ?? null;
}

// Bridges signed bootstrap identity to the exact permanent plan. This is a
// read-only retirement gate; it does not close invitations or mutate peers.
class CellAwgPermanentRetirementGate {
  constructor({ deployment, keyManager = new AwgKeyManager(),
    revisionStore = null,
    verifierFactory = options => new CellAwgPermanentVerifier(options) }) {
    if (!deployment || !deployment.store || typeof deployment.store.read !== 'function'
      || typeof deployment.buildPath !== 'function'
      || !keyManager || typeof keyManager.derivePublicKey !== 'function'
      || (revisionStore !== null && typeof revisionStore.read !== 'function')
      || typeof verifierFactory !== 'function') {
      throw new TypeError('Invalid permanent AWG retirement gate');
    }
    Object.assign(this, { deployment, keyManager, revisionStore, verifierFactory });
  }

  async load() {
    const base = await this.deployment.store.read();
    if (!base) return null;
    const revision = this.revisionStore && await this.revisionStore.read();
    // A prepared expansion is not yet proof of an operational path. The
    // caller must finish recovery and commit it before retiring bootstrap.
    if (revision?.pending) return null;
    const plan = revision?.committed || base;
    const path = this.deployment.buildPath({ stateDirectory: this.deployment.stateDirectory,
      plan, runner: this.deployment.runner });
    return { plan, path };
  }

  async verifyCell(connection) {
    if (connection?.status !== 'registered' || !connection.controllerPath) return false;
    const saved = await this.load();
    if (!saved) return false;
    let expected, descriptor, peer;
    try {
      descriptor = validatePermanentDescriptor(connection.controllerPath);
      const parsed = normalizeAwgConfig(saved.plan.spec.owner.config);
      if (parsed.peers.length !== 1) return false;
      peer = parsed.peers[0];
      expected = permanentCellPlan({ connection,
        interfaceName: saved.plan.spec.owner.interfaceName,
        resolvedEndpointHost: endpointHost(peer.endpoint), owner: saved.plan.spec.owner });
    } catch { return false; }
    if (!samePlan(expected, saved.plan)) return false;
    return this.verifierFactory({ path: saved.path, role: 'cell',
      peerPublicKey: descriptor.serverPublicKey,
      controlAddress: descriptor.controllerAddress,
      localAddress: descriptor.cellAddress, controlPort: descriptor.controlPort,
      runner: this.deployment.runner }).verify();
  }

  async verifyController(record) {
    if (record?.status !== 'consumed' || !record.permanentDescriptor
      || !record.awgPublicKey || !record.awgPresharedKey) return false;
    const saved = await this.load();
    if (!saved) return false;
    let expected, descriptor;
    try {
      descriptor = validatePermanentDescriptor(record.permanentDescriptor);
      if (descriptor.cellAddress === record.cellAddress) return false;
      const parsed = normalizeAwgConfig(saved.plan.spec.owner.config);
      const peers = parsed.peers.map(peer => ({
        cellAddress: peer.allowedips.length === 1 ? peer.allowedips[0].split('/')[0] : null,
        awgPublicKey: peer.publickey, awgPresharedKey: peer.presharedkey,
      }));
      if (!peers.some(peer => peer.cellAddress === descriptor.cellAddress
        && peer.awgPublicKey === record.awgPublicKey
        && peer.awgPresharedKey === record.awgPresharedKey)) return false;
      expected = await permanentControllerPlan({ privateKey: parsed.interface.privatekey,
        descriptor, peers, interfaceName: saved.plan.spec.owner.interfaceName,
        owner: saved.plan.spec.owner, keyManager: this.keyManager });
    } catch { return false; }
    if (!samePlan(expected, saved.plan)) return false;
    return this.verifierFactory({ path: saved.path, role: 'controller',
      peerPublicKey: record.awgPublicKey,
      controlAddress: descriptor.controllerAddress,
      localAddress: descriptor.cellAddress, controlPort: descriptor.controlPort,
      runner: this.deployment.runner }).verify();
  }
}

module.exports = { CellAwgPermanentRetirementGate };
