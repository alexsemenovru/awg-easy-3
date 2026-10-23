'use strict';

const net = require('node:net');
const { createAwgOwnership } = require('./CellAwgOwnership');
const { validatePublicDataOffer } = require('./CellDataOfferStore');
const { validateDataLinkDescriptor, renderDataControllerConfig,
  renderDataCellConfig } = require('./CellDataLinkConfig');
const { validateKey } = require('./AwgKeyManager');
const { AwgKeyManager } = require('./AwgKeyManager');
const { validatePermanentPlan } = require('./CellAwgPermanentPlanStore');
const { validEndpointHost } = require('./CellAwgEndpointHost');

function tableFor(slot) {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot > 126) {
    throw new TypeError('Invalid data link slot');
  }
  const policyTable = `awg_easy_3_data_${slot}`;
  return { policyTable, guardTable: `awg_easy_3_data_guard_${slot}` };
}
function commonPlan({ config, addresses, interfaceName, peerAddress4, peerAddress6,
  policyTable, guardTable }) {
  const routeCommands = [
    { file: 'ip', args: ['-4', 'route', 'add', `${peerAddress4}/32`,
      'table', 'main', 'proto', '186', 'dev', interfaceName] },
    ...(peerAddress6 ? [{ file: 'ip', args: ['-6', 'route', 'add', `${peerAddress6}/128`,
      'table', 'main', 'proto', '186', 'dev', interfaceName] }] : []),
  ];
  const plan = validatePermanentPlan({ version: 1,
    spec: { version: 1, owner: createAwgOwnership({ interfaceName, config }), addresses },
    policy: { nftables: [{ table: { family: 'inet', name: policyTable } }] },
    routeCommands }, { policyTable });
  return Object.freeze({ plan, policyTable, guardTable, retainGuard: true });
}

async function controllerDataLinkPlan({ storedOffer, slot,
  keyManager = new AwgKeyManager() } = {}) {
  const { policyTable, guardTable } = tableFor(slot);
  if (!storedOffer || typeof storedOffer !== 'object') {
    throw new TypeError('Stored Main data offer required');
  }
  const descriptor = validateDataLinkDescriptor(storedOffer.descriptor);
  validateKey(storedOffer.cellPublicKey, 'cellDataPublicKey');
  const rendered = await renderDataControllerConfig({ privateKey: storedOffer.controllerPrivateKey,
    descriptor, cellPublicKey: storedOffer.cellPublicKey,
    presharedKey: storedOffer.presharedKey, keyManager });
  return commonPlan({ ...rendered, interfaceName: `awgd${slot}`,
    peerAddress4: descriptor.cellAddress4, peerAddress6: descriptor.cellAddress6,
    policyTable, guardTable });
}

function cellDataLinkPlan({ offer, privateKey, resolvedEndpointHost } = {}) {
  const { policyTable, guardTable } = { policyTable: 'awg_easy_3_data_cell',
    guardTable: 'awg_easy_3_data_guard_cell' };
  const publicOffer = validatePublicDataOffer(offer);
  const descriptor = publicOffer.descriptor;
  const endpointHost = resolvedEndpointHost ?? descriptor.endpointHost;
  if (!net.isIP(endpointHost) || !validEndpointHost(endpointHost)) {
    throw new TypeError('Resolved literal data endpoint required');
  }
  const literal = { ...descriptor, endpointHost };
  const rendered = renderDataCellConfig({ privateKey, descriptor: literal,
    presharedKey: publicOffer.presharedKey, remoteExit4: true,
    remoteExit6: Boolean(descriptor.cellAddress6) });
  return commonPlan({ ...rendered, interfaceName: 'awgdata0',
    peerAddress4: descriptor.controllerAddress4,
    peerAddress6: descriptor.controllerAddress6, policyTable, guardTable });
}

module.exports = { controllerDataLinkPlan, cellDataLinkPlan };
