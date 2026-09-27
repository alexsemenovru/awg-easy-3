'use strict';
const { verifyControl, signControl, signControlReply, verifyControlReply } = require('./CellControlProtocol');
const { exchangeOverTls, createRegistrationServer } = require('./CellRegistrationTransport');
const { verifySettings } = require('./CellSettings');
const { acknowledgeApplied } = require('./CellSettingsAck');
const PROTOCOL = 'awg-easy-3-control/1';

class CellControlService {
  constructor({ identityStore, enrollmentStore, publisherForCell, monotonicNow = () => performance.now() }) {
    this.identityStore = identityStore;
    this.enrollmentStore = enrollmentStore;
    this.publisherForCell = publisherForCell;
    this.inFlight = 0;
    this.monotonicNow = monotonicNow;
    this.tokens = 16;
    this.lastRefill = monotonicNow();
  }

  async handle(bytes) {
    const now = this.monotonicNow();
    if (!Number.isFinite(now)) return { ok: false, error: 'control_busy' };
    this.tokens = Math.min(16, this.tokens + Math.max(0, now - this.lastRefill) / 1000);
    this.lastRefill = Math.max(now, this.lastRefill);
    if (this.inFlight >= 4 || this.tokens < 1) return { ok: false, error: 'control_busy' };
    this.tokens--;
    this.inFlight++;
    try {
      const controller = await this.identityStore.load('controller');
      const request = verifyControl(bytes, controller.publicKey);
      const enrollment = await this.enrollmentStore.read();
      if (!enrollment.invitations.some(item => item.status === 'consumed' && item.cellKey === request.cellKey)) {
        throw new Error('Unknown cell');
      }
      const publisher = this.publisherForCell(request.cellKey);
      if (request.action === 'ack') {
        const result = await publisher.acknowledge(request.payload);
        return signControlReply({ ok: true, requestId: request.requestId,
          applied: result.revision }, controller.privateKey);
      }
      const state = await publisher.load();
      return signControlReply({ ok: true, requestId: request.requestId,
        settings: state?.desired || null }, controller.privateKey);
    } catch { return { ok: false, error: 'control_unavailable' }; }
    finally { this.inFlight--; }
  }
}

async function prepareControlEndpoint({ identityStore, certificateStore, enrollmentStore, publisherForCell }) {
  const identity = await identityStore.load('controller');
  const cert = await certificateStore.ensure();
  return createRegistrationServer({ key: identity.privateKey, cert, protocol: PROTOCOL,
    handler: new CellControlService({ identityStore, enrollmentStore, publisherForCell }) });
}

// One explicit sync, not a daemon. Control address supplied locally until installer
// assigns the service port; the key must remain the registered controller's key.
async function syncCellSettings({ connectionStore, identityStore, receiver, host, port }) {
  const connection = await connectionStore.read();
  if (connection?.status !== 'registered') throw new Error('Cell is not registered');
  const identity = await identityStore.load('cell');
  if (identity.publicKey !== connection.cellKey) throw new Error('Cell identity changed');
  const exchange = async (action, payload = null) => {
    const request = signControl({ controllerKey: connection.controllerKey, action, payload }, identity.privateKey);
    return exchangeOverTls({ host, port, request, controllerKey: connection.controllerKey,
      protocol: PROTOCOL, responseLimit: 2 * 1024 * 1024, verifyResponse: response => {
        return verifyControlReply(response, connection.controllerKey, request.requestId);
      } });
  };
  const reply = await exchange('poll');
  if (reply.settings === null) return { status: 'no-settings' };
  verifySettings(reply.settings, connection);
  await receiver.receive(reply.settings);
  const ack = await acknowledgeApplied(receiver, identityStore);
  const result = await exchange('ack', ack);
  if (result.applied !== ack.revision) throw new Error('Applied acknowledgement mismatch');
  return { status: 'applied', revision: ack.revision };
}

module.exports = { CellControlService, prepareControlEndpoint, syncCellSettings };
