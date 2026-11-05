'use strict';
const path = require('node:path');
const { CellBackupRecoveryStore } = require('./CellBackupRecoveryStore');
function recoveryStoreFor(connectionStore, connection) {
  return connectionStore.filePath ? new CellBackupRecoveryStore(
    path.join(path.dirname(connectionStore.filePath), 'backup-recovery.json'), connection) : null;
}
async function authorityFor(connectionStore, connection) {
  return (await epochFor(connectionStore, connection)).key;
}
async function epochFor(connectionStore, connection) {
  connection = connectionStore.filePath ? await connectionStore.read() : connection ?? await connectionStore.read();
  if (!connection || connection.status !== 'registered') throw new Error('Registered Cell authority required');
  const recovery = (await recoveryStoreFor(connectionStore, connection)?.read())?.authority;
  if (recovery && (recovery.grant.generation < (connection.authorityGeneration ?? 0)
    || recovery.grant.generation === connection.authorityGeneration
      && recovery.proof.authorityKey !== connection.authorityKey)) {
    throw new Error('Recovery authority disagrees with the pinned Cell connection');
  }
  return recovery ? { key: recovery.proof.authorityKey, generation: recovery.grant.generation }
    : { key: connection.authorityKey ?? null, generation: connection.authorityGeneration ?? 0 };
}
function validAuthority(value) {
  return value === null || typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}
function validEpochJournal(value) {
  return value && ([1, 2].includes(value.version))
    && Object.keys(value).sort().join(',') === (value.version === 1 ? 'applied,received,version'
      : 'applied,appliedAuthority,appliedGeneration,received,receivedAuthority,receivedGeneration,version')
    && (value.version === 1 || validEpoch({ key: value.receivedAuthority, generation: value.receivedGeneration })
      && validEpoch({ key: value.appliedAuthority, generation: value.appliedGeneration })
      && value.appliedGeneration <= value.receivedGeneration
      && (value.applied === null || value.appliedGeneration !== value.receivedGeneration
        || value.appliedAuthority === value.receivedAuthority));
}
function validEpoch(epoch) {
  return epoch && validAuthority(epoch.key) && Number.isSafeInteger(epoch.generation) && epoch.generation >= 0
    && (epoch.key !== null || epoch.generation === 0);
}
function normalizeEpoch(epoch) {
  epoch ??= { key: null, generation: 0 };
  if (!validEpoch(epoch)) throw new Error('Invalid pinned Cell authority');
  return epoch;
}
function sameEpoch(previous, epoch, applied = false) {
  epoch = normalizeEpoch(epoch);
  return (previous?.[applied ? 'appliedAuthority' : 'receivedAuthority'] ?? null) === epoch.key
    && (previous?.[applied ? 'appliedGeneration' : 'receivedGeneration'] ?? 0) === epoch.generation;
}
function receivingState(previous, envelope, epoch) {
  epoch = normalizeEpoch(epoch);
  const generation = previous?.receivedGeneration ?? 0;
  if (previous && (epoch.generation < generation || epoch.generation === generation && !sameEpoch(previous, epoch))) {
    throw new Error('Stale or conflicting Cell control authority');
  }
  return epoch.key !== null || previous?.version === 2
    ? { version: 2, received: envelope, receivedAuthority: epoch.key, receivedGeneration: epoch.generation,
      applied: previous?.applied ?? null, appliedAuthority: previous?.appliedAuthority ?? null,
      appliedGeneration: previous?.appliedGeneration ?? 0 }
    : { version: 1, received: envelope, applied: previous?.applied ?? null };
}
function appliedState(next, envelope, epoch) {
  epoch = normalizeEpoch(epoch);
  return { ...next, applied: envelope,
    ...(next.version === 2 ? { appliedAuthority: epoch.key, appliedGeneration: epoch.generation } : {}) };
}
module.exports = { recoveryStoreFor, authorityFor, epochFor, validEpochJournal,
  receivingState, sameEpoch, appliedState };
