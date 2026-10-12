'use strict';

const { normalizeAwgConfig, matchesAwgConfig } = require('./CellAwgSnapshot');
const { permanentCellPlan, permanentControllerPlan } = require('./CellAwgPermanentPlan');
const { permanentControllerExpansionPlan } = require('./CellAwgPermanentExpansionPlan');

const sameConfig = (a, b) => matchesAwgConfig(a, b) && matchesAwgConfig(b, a);

function savedEndpoint(plan) {
  const peers = normalizeAwgConfig(plan.spec.owner.config).peers;
  if (peers.length !== 1 || !peers[0].endpoint) {
    throw new Error('Saved permanent cell endpoint is unavailable');
  }
  const match = peers[0].endpoint.match(/^\[([^\]]+)\]:\d+$/)
    || peers[0].endpoint.match(/^([^:]+):\d+$/);
  if (!match) throw new Error('Saved permanent cell endpoint is invalid');
  return match[1];
}

// Caller holds the installation-wide lock, has already registered over the
// temporary AWG path and wires retirement's own verification to the same gate.
async function joinPermanentCell({ connectionStore, deployment, gate, retirement,
  interfaceName, resolvedEndpointHost }) {
  if (!connectionStore || typeof connectionStore.read !== 'function'
    || !deployment || typeof deployment.install !== 'function'
    || !deployment.store || typeof deployment.store.read !== 'function'
    || !gate || typeof gate.verifyCell !== 'function'
    || !retirement || typeof retirement.retire !== 'function') {
    throw new TypeError('Invalid permanent cell join dependencies');
  }
  const connection = await connectionStore.read();
  if (connection?.status !== 'registered' || !connection.controllerPath) {
    throw new Error('Signed permanent cell registration required');
  }
  const saved = await deployment.store.read();
  const endpoint = saved ? savedEndpoint(saved) : resolvedEndpointHost;
  if (saved && resolvedEndpointHost && endpoint !== resolvedEndpointHost) {
    throw new Error('Permanent cell endpoint changed after reservation');
  }
  const plan = permanentCellPlan({ connection, interfaceName,
    resolvedEndpointHost: endpoint, ...(saved ? { owner: saved.spec.owner } : {}) });
  await deployment.install(plan);
  if (!await gate.verifyCell(connection)) {
    return { status: 'waiting-for-permanent-path', temporaryRetained: true };
  }
  await retirement.retire();
  return { status: 'ready', temporaryRetained: false };
}

// Caller holds the installation-wide lock. The second and later cells use the
// durable additive revision path; a base installation is never reinstalled.
async function joinPermanentController({ bootstrapStore, invitationId, deployment,
  gate, coordinator, interfaceName, privateKey, keyManager,
  expansionRuntime = null }) {
  if (!bootstrapStore || typeof bootstrapStore.read !== 'function'
    || !deployment || typeof deployment.install !== 'function'
    || !deployment.store || typeof deployment.store.read !== 'function'
    || !gate || typeof gate.verifyController !== 'function'
    || !coordinator || typeof coordinator.close !== 'function') {
    throw new TypeError('Invalid permanent controller join dependencies');
  }
  const records = (await bootstrapStore.read()).invitations;
  const record = records.find(item => item.id === invitationId);
  if (!record || record.status !== 'consumed' || !record.permanentDescriptor
    || !record.awgPublicKey || !record.awgPresharedKey) {
    throw new Error('Consumed permanent cell invitation required');
  }
  if (record.cellAddress === record.permanentDescriptor.cellAddress) {
    throw new Error('Temporary and permanent cell addresses overlap');
  }
  const enrolled = records.filter(item => item.status === 'consumed'
    && item.permanentDescriptor);
  const saved = await deployment.store.read();
  if (!saved) {
    // More than one invitation may be consumed before the first permanent
    // join runs. Reserve only this cell as the base; later joins expand it.
    const plan = await permanentControllerPlan({ privateKey,
      descriptor: record.permanentDescriptor, interfaceName,
      peers: [{ cellAddress: record.permanentDescriptor.cellAddress,
        awgPublicKey: record.awgPublicKey,
        awgPresharedKey: record.awgPresharedKey }],
      ...(keyManager ? { keyManager } : {}) });
    await deployment.install(plan);
  } else if (enrolled.length === 1) {
    // The first join may be retried after its plan was reserved. Preserve the
    // pre-expansion path and require the exact previously owned identity.
    const plan = await permanentControllerPlan({ privateKey,
      descriptor: record.permanentDescriptor, interfaceName,
      peers: [{ cellAddress: record.permanentDescriptor.cellAddress,
        awgPublicKey: record.awgPublicKey,
        awgPresharedKey: record.awgPresharedKey }],
      ...(keyManager ? { keyManager } : {}), owner: saved.spec.owner });
    await deployment.install(plan);
  } else {
    if (!expansionRuntime || expansionRuntime.deployment !== deployment
      || !expansionRuntime.revisionStore
      || typeof expansionRuntime.recoverCurrent !== 'function'
      || typeof expansionRuntime.prepare !== 'function'
      || gate.revisionStore !== expansionRuntime.revisionStore) {
      throw new Error('Multi-cell join requires one revision-aware guarded runtime and gate');
    }
    const original = normalizeAwgConfig(saved.spec.owner.config);
    if (saved.spec.owner.interfaceName !== interfaceName
      || original.interface.privatekey !== privateKey) {
      throw new Error('Permanent controller identity changed before expansion');
    }
    const current = await expansionRuntime.recoverCurrent();
    const next = await permanentControllerExpansionPlan({ currentPlan: current,
      records: enrolled, ...(keyManager ? { keyManager } : {}) });
    if (!sameConfig(current.spec.owner.config, next.spec.owner.config)) {
      await expansionRuntime.prepare(next);
    }
  }
  if (!await gate.verifyController(record)) {
    return { status: 'waiting-for-permanent-path', temporaryRetained: true };
  }
  await coordinator.close(invitationId);
  return { status: 'ready', temporaryRetained: false };
}

module.exports = { joinPermanentCell, joinPermanentController };
