'use strict';

const crypto = require('node:crypto');
const { BackupJournal } = require('./BackupJournal');
const { verifyBackupGrant, signBackupAck, verifyTakeover } = require('./BackupRecovery');
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === fields.sort().join(',');
const fail = () => { throw new Error('Invalid Cell backup recovery state'); };
class CellBackupRecoveryStore {
  constructor(filePath, { controllerKey, cellKey }) {
    this.controllerKey = controllerKey;
    this.cellKey = cellKey;
    this.journal = new BackupJournal(filePath, value => {
      if (!exact(value, ['version', 'cellKey', 'grant', 'challenge', 'takeover', 'authority'])
        || value.version !== 1 || value.cellKey !== cellKey) fail();
      verifyBackupGrant(value.grant, controllerKey);
      if (value.challenge !== null && (!exact(value.challenge, ['nonce', 'expiresAt'])
        || !/^[A-Za-z0-9_-]{43}$/.test(value.challenge.nonce)
        || Buffer.from(value.challenge.nonce, 'base64url').toString('base64url') !== value.challenge.nonce
        || !Number.isSafeInteger(value.challenge.expiresAt) || value.challenge.expiresAt < 0)) fail();
      if (value.takeover !== null) {
        verifyTakeover(value.takeover, value.grant, cellKey, value.takeover.challenge);
        if (value.challenge !== null) fail();
      }
      if (value.authority !== null) {
        if (!exact(value.authority, ['grant', 'proof'])) fail();
        verifyBackupGrant(value.authority.grant, controllerKey);
        verifyTakeover(value.authority.proof, value.authority.grant, cellKey,
          value.authority.proof.challenge);
        if (value.authority.grant.generation > value.grant.generation) fail();
      }
      if (value.takeover !== null && (value.authority === null
        || JSON.stringify(value.authority.proof) !== JSON.stringify(value.takeover))) fail();
      return structuredClone(value);
    });
  }
  read() { return this.journal.read(); }
  accept(grant) {
    grant = verifyBackupGrant(grant, this.controllerKey);
    return this.journal.exclusive(async () => {
      const prior = await this.read();
      if (prior) {
        if (grant.generation < prior.grant.generation) throw new Error('Older backup generation rejected');
        if (grant.generation === prior.grant.generation) {
          if (JSON.stringify(grant) !== JSON.stringify(prior.grant)) throw new Error('Conflicting backup generation rejected');
          // A repeated poll must never unconsume a takeover or recreate a challenge.
          return prior;
        }
        // After takeover, accepting newer generations requires the NEW live
        // authority at the control transport, not merely an old signing key.
      }
      return this.journal.write({ version: 1, cellKey: this.cellKey,
        grant, challenge: null, takeover: null, authority: prior?.authority ?? null });
    });
  }
  async acknowledgement(cellPrivateKey) {
    const state = await this.read();
    if (!state) throw new Error('No accepted backup generation');
    const ack = signBackupAck(state.grant, cellPrivateKey);
    if (ack.cellKey !== this.cellKey) fail();
    return ack;
  }
  challenge(now = Date.now()) {
    return this.journal.exclusive(async () => {
      if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 60000) fail();
      const state = await this.read();
      if (!state || state.takeover) throw new Error('Backup takeover is unavailable');
      const challenge = state.challenge && state.challenge.expiresAt > now
        ? state.challenge : { nonce: crypto.randomBytes(32).toString('base64url'), expiresAt: now + 60000 };
      await this.journal.write({ ...state, challenge });
      return { generation: state.grant.generation, backupId: state.grant.backupId,
        archiveHash: state.grant.archiveHash, ...challenge };
    });
  }
  // Commit authority fencing BEFORE any caller changes host routing. This
  // module never activates the new endpoint itself. Restart resumes the same
  // committed authority; neither an old Main nor another restored copy wins.
  consume(proof, now = Date.now()) {
    proof = structuredClone(proof);
    return this.journal.exclusive(async () => {
      const state = await this.read();
      if (!state || state.takeover || !state.challenge
        || !Number.isSafeInteger(now) || now < 0 || state.challenge.expiresAt <= now) {
        throw new Error('Backup takeover challenge expired or consumed');
      }
      verifyTakeover(proof, state.grant, this.cellKey, state.challenge.nonce);
      await this.journal.write({ ...state, challenge: null, takeover: proof,
        authority: { grant: state.grant, proof } });
      return { authorityKey: proof.authorityKey, endpointHost: proof.endpointHost };
    });
  }
}
module.exports = { CellBackupRecoveryStore };
