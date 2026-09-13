'use strict';

const { CellRegistrationService } = require('./CellRegistrationService');
const { CellRegistrationHandler } = require('./CellRegistrationHandler');
const { createRegistrationServer } = require('./CellRegistrationTransport');

// Preparation only: caller explicitly chooses when/where to listen.
async function prepareRegistrationEndpoint({ identityStore, certificateStore, enrollmentStore }) {
  const controller = await identityStore.load('controller');
  const cert = await certificateStore.ensure();
  const service = new CellRegistrationService(identityStore, enrollmentStore);
  const handler = new CellRegistrationHandler(service);
  return createRegistrationServer({ key: controller.privateKey, cert, handler });
}

module.exports = { prepareRegistrationEndpoint };
