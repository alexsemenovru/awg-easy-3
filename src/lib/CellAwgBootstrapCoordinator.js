'use strict';

const { createAwgBootstrapInvitation } = require('./CellAwgBootstrapInvitation');

// Runtime adapter contract: installPeer applies a fail-closed guard first,
// verifyPeer proves the exact owned peer/address, removePeer is idempotent and
// never mutates another peer. verifyPermanent proves the replacement before
// retiring a consumed invite. No invite is displayed before readback succeeds.
class CellAwgBootstrapCoordinator {
  constructor({ store, runtime, createInvitation = createAwgBootstrapInvitation,
    now = Date.now }) {
    if (!store || typeof store.reserve !== 'function' || typeof store.read !== 'function'
      || !runtime || !['installPeer', 'verifyPeer', 'removePeer', 'verifyPermanent'].every(name =>
        typeof runtime[name] === 'function')
      || typeof createInvitation !== 'function' || typeof now !== 'function') {
      throw new TypeError('Invalid AWG bootstrap coordinator');
    }
    Object.assign(this, { store, runtime, createInvitation, now });
  }

  async issue(options) {
    const { code, record } = await this.createInvitation(options);
    await this.store.reserve(record);
    try {
      await this.runtime.installPeer(record);
      if (!await this.runtime.verifyPeer(record)) throw new Error('Bootstrap peer readback failed');
      await this.store.markReady(record.id);
      return code;
    } catch {
      // A crash at any point leaves a durable preparing/closing record for
      // recover(). Do not display a code for an unverified or partial peer.
      const state = (await this.store.read()).invitations.find(item => item.id === record.id);
      if (state?.phase === 'preparing') await this.store.abandonPreparing(record.id, this.now());
      try {
        await this.runtime.removePeer(record);
        await this.store.markClosed(record.id);
      } catch { throw new Error('Bootstrap issue failed; peer cleanup required before retry'); }
      throw new Error('Bootstrap issue failed; no invitation was issued');
    }
  }

  async close(invitationId, { revoke = false } = {}) {
    const state = (await this.store.read()).invitations.find(item => item.id === invitationId);
    if (!state) throw new Error('Unknown bootstrap invitation');
    if (state.phase === 'closed') return { closed: true };
    if (state.phase === 'ready' && state.status === 'consumed'
      && !await this.runtime.verifyPermanent(state)) {
      throw new Error('Permanent cell path not verified; temporary peer retained');
    }
    if (state.phase === 'preparing') await this.store.abandonPreparing(invitationId, this.now());
    else if (state.phase !== 'closing') await this.store.beginClose(invitationId,
      { revoke, now: this.now() });
    await this.runtime.removePeer(state);
    await this.store.markClosed(invitationId);
    return { closed: true };
  }

  async recover() {
    const records = (await this.store.read()).invitations;
    for (const record of records) {
      if (record.phase === 'preparing' || record.phase === 'closing'
        || (record.phase === 'ready' && record.status === 'pending'
          && record.expiresAt <= this.now())) {
        await this.close(record.id, { revoke: true });
      } else if (record.phase === 'ready' && !await this.runtime.verifyPeer(record)) {
        throw new Error('Bootstrap peer drift; manual recovery required');
      }
    }
  }
}

module.exports = { CellAwgBootstrapCoordinator };
