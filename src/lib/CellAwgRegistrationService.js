'use strict';

const { signAwgReceipt } = require('./CellAwgRegistration');

// The v2 service is never attached to a public listener. Its caller must use
// the private AWG registration address and verified bootstrap firewall.
class CellAwgRegistrationService {
  constructor(identityStore, bootstrapStore) {
    if (!identityStore || typeof identityStore.load !== 'function'
      || !bootstrapStore || typeof bootstrapStore.completeAwgSigned !== 'function') {
      throw new TypeError('AWG registration identity and store required');
    }
    this.identityStore = identityStore;
    this.bootstrapStore = bootstrapStore;
  }

  async register(input, now = Date.now()) {
    const request = structuredClone(input);
    const controller = await this.identityStore.load('controller');
    const result = await this.bootstrapStore.completeAwgSigned(request, controller.publicKey, now);
    if (result.status !== 'consumed' || result.awgPublicKey !== request.awgPublicKey) {
      throw new Error('Permanent AWG registration was not committed');
    }
    return signAwgReceipt(request, controller.privateKey, now);
  }
}

module.exports = { CellAwgRegistrationService };
