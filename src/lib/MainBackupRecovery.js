'use strict';

const { BackupJournal } = require('./BackupJournal');
const { verifyBackupGrant, validateRecoveryMaterial, signTakeover } = require('./BackupRecovery');
class MainBackupRecovery {
  constructor(filePath, controllerKey) {
    this.controllerKey = controllerKey;
    this.journal = new BackupJournal(filePath, value => {
      if (!value || Object.keys(value).sort().join(',') !== 'grant,material,version' || value.version !== 1) {
        throw new Error('Invalid Main recovery state');
      }
      verifyBackupGrant(value.grant, controllerKey);
      validateRecoveryMaterial(value.material);
      if (value.material.generation !== value.grant.generation
        || value.material.backupId !== value.grant.backupId
        || value.material.publicKey !== value.grant.recoveryKey) throw new Error('Main recovery identity mismatch');
      return structuredClone(value);
    }, 4096);
  }
  async proof({ cellKey, challenge, grant, authority, endpointHost }) {
    const state = await this.journal.read();
    if (!state) return null;
    // A newer backup immediately invalidates this restore's original takeover
    // authority. No broad signing oracle and no arbitrary archive identifiers.
    if (!grant || JSON.stringify(state.grant) !== JSON.stringify(grant)
      || !challenge || Object.keys(challenge).sort().join(',') !== 'archiveHash,backupId,expiresAt,generation,nonce'
      || challenge.generation !== grant.generation || challenge.backupId !== grant.backupId
      || challenge.archiveHash !== grant.archiveHash || !Number.isSafeInteger(challenge.expiresAt)
      || challenge.expiresAt < 0 || !authority) throw new Error('Main recovery request mismatch');
    return signTakeover({ grant, material: state.material, cellKey, challenge: challenge.nonce,
      authorityKey: authority.publicKey, endpointHost });
  }
}
module.exports = { MainBackupRecovery };
