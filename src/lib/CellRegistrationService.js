'use strict';

const { signReceipt } = require('./CellRegistration');

// Transport-independent. No listener and no plaintext network fallback.
class CellRegistrationService {
  constructor(identityStore, enrollmentStore) {
    this.identityStore = identityStore;
    this.enrollmentStore = enrollmentStore;
  }

  async register(input, now = Date.now()) {
    // Take a snapshot before any await; caller mutation cannot change the receipt.
    const request = structuredClone(input);
    const controller = await this.identityStore.load('controller');
    const result = await this.enrollmentStore.completeSigned(request, controller.publicKey, now);
    if (result.status !== 'consumed') throw new Error('Cell registration was not committed');
    return signReceipt(request, controller.privateKey, now);
  }
}

module.exports = { CellRegistrationService };
