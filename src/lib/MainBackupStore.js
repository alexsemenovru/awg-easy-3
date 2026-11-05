'use strict';

const { BackupJournal } = require('./BackupJournal');
const { verifyBackupGrant, verifyBackupAck } = require('./BackupRecovery');
class MainBackupStore {
  constructor(filePath, controllerKey) {
    this.controllerKey = controllerKey;
    this.journal = new BackupJournal(filePath, value => {
      if (!value || Object.keys(value).sort().join(',') !== 'acks,grant,recipients,version'
        || value.version !== 1 || !Array.isArray(value.acks) || value.acks.length > 1024
        || !Array.isArray(value.recipients) || value.recipients.length > 1024
        || new Set(value.recipients).size !== value.recipients.length
        || !value.recipients.every(key => typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key)
          && Buffer.from(key, 'base64url').toString('base64url') === key)) {
        throw new Error('Invalid Main backup journal');
      }
      verifyBackupGrant(value.grant, controllerKey);
      const seen = new Set();
      for (const ack of value.acks) {
        verifyBackupAck(ack, value.grant, ack.cellKey);
        if (!value.recipients.includes(ack.cellKey)) throw new Error('Cell is not included in this backup');
        if (seen.has(ack.cellKey)) throw new Error('Duplicate backup acknowledgement');
        seen.add(ack.cellKey);
      }
      return structuredClone(value);
    }, 1024 * 1024);
  }
  read() { return this.journal.read(); }
  async grant(cellKey) {
    const state = await this.read();
    return state && (cellKey === undefined || state.recipients.includes(cellKey)) ? state.grant : null;
  }
  commit(grant, recipients = []) {
    grant = verifyBackupGrant(grant, this.controllerKey);
    recipients = structuredClone(recipients);
    return this.journal.exclusive(async () => {
      const prior = await this.read();
      if (prior && grant.generation !== prior.grant.generation + 1
        || !prior && grant.generation !== 1) throw new Error('Backup generation must increase exactly once');
      return this.journal.write({ version: 1, grant, acks: [], recipients });
    });
  }
  acknowledge(cellKey, ack, authorityKey = null) {
    ack = structuredClone(ack);
    return this.journal.exclusive(async () => {
      const state = await this.read();
      if (!state) throw new Error('No published backup generation');
      if (!state.recipients.includes(cellKey)) throw new Error('Cell is not included in this backup');
      verifyBackupAck(ack, state.grant, cellKey, authorityKey);
      if (!state.acks.some(item => item.cellKey === cellKey && item.authorityKey === authorityKey)) {
        await this.journal.write({ ...state, acks: [...state.acks.filter(item => item.cellKey !== cellKey), ack] });
      }
      return ack;
    });
  }
  async status(cellKey) {
    const state = await this.read();
    return { generation: state?.recipients.includes(cellKey) ? state.grant.generation : null,
      confirmed: Boolean(state?.acks.some(ack => ack.cellKey === cellKey)) };
  }
}
module.exports = { MainBackupStore };
