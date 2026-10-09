'use strict';

const { normalizeAwgConfig } = require('./CellAwgSnapshot');
const { permanentCellPlan, permanentControllerPlan } = require('./CellAwgPermanentPlan');

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

// First-cell path only. Expansion of an already running controller AWG peer
// set requires a separate guarded multi-peer transaction, not reinstallation.
async function joinPermanentController({ bootstrapStore, invitationId, deployment,
  gate, coordinator, interfaceName, privateKey, keyManager }) {
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
  if (records.some(item => item !== record && item.status === 'consumed'
    && item.permanentDescriptor)) {
    throw new Error('Multi-cell permanent AWG update is not yet supported');
  }
  const saved = await deployment.store.read();
  const plan = await permanentControllerPlan({ privateKey,
    descriptor: record.permanentDescriptor, interfaceName,
    peers: [{ cellAddress: record.cellAddress, awgPublicKey: record.awgPublicKey,
      awgPresharedKey: record.awgPresharedKey }],
    ...(keyManager ? { keyManager } : {}),
    ...(saved ? { owner: saved.spec.owner } : {}) });
  await deployment.install(plan);
  if (!await gate.verifyController(record)) {
    return { status: 'waiting-for-permanent-path', temporaryRetained: true };
  }
  await coordinator.close(invitationId);
  return { status: 'ready', temporaryRetained: false };
}

module.exports = { joinPermanentCell, joinPermanentController };
