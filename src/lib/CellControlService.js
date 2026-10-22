'use strict';
const { requireOwnedTunnelAddress } = require('./CellOwnedTunnel');
const { verifyControl, signControl, signControlReply, verifyControlReply } = require('./CellControlProtocol');
const { exchangeOverTls, createRegistrationServer } = require('./CellRegistrationTransport');
const { exchangeOverTunnel, listenControlOnTunnel } = require('./CellTunnelControlTransport');
const { verifySettings } = require('./CellSettings');
const { acknowledgeApplied } = require('./CellSettingsAck');
const { validateCellUserDescriptor } = require('./CellUserDescriptor');
const PROTOCOL = 'awg-easy-3-control/1';

class CellControlService {
  constructor({ identityStore, enrollmentStore, bootstrapStore, publisherForCell, descriptorForCell,
    monotonicNow = () => performance.now() }) {
    if (enrollmentStore && bootstrapStore) {
      throw new TypeError('Control service cannot mix legacy and AWG cell enrollment');
    }
    this.identityStore = identityStore;
    this.enrollmentStore = enrollmentStore;
    this.bootstrapStore = bootstrapStore;
    this.publisherForCell = publisherForCell;
    this.descriptorForCell = descriptorForCell;
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
      const enrollment = await (this.bootstrapStore || this.enrollmentStore).read();
      const allowed = this.bootstrapStore
        ? enrollment.version === 2 && enrollment.invitations.some(item =>
          item.status === 'consumed' && item.phase === 'closed'
          && item.cellKey === request.cellKey && item.awgPublicKey && item.awgPresharedKey)
        : enrollment.invitations.some(item => item.status === 'consumed'
          && item.cellKey === request.cellKey);
      if (!allowed) {
        throw new Error('Unknown cell');
      }
      if (request.action === 'announce') {
        if (!this.bootstrapStore || !this.descriptorForCell) {
          throw new Error('Cell descriptor announcements unavailable');
        }
        await this.descriptorForCell(request.cellKey).update(
          validateCellUserDescriptor(request.payload));
        return signControlReply({ ok: true, requestId: request.requestId,
          announced: true }, controller.privateKey);
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

// Never accept a merely private host address: prove it belongs to our ready,
// unchanged inter-server AWG device immediately before opening the listener.
async function listenTunnelControlEndpoint({ address, port, identityStore, bootstrapStore,
  lifecycle, publisherForCell, descriptorForCell }) {
  if (!bootstrapStore || typeof bootstrapStore.read !== 'function') {
    throw new TypeError('AWG bootstrap store required for tunnel control');
  }
  await requireOwnedTunnelAddress({ lifecycle, address });
  return listenControlOnTunnel({ address, port,
    handler: new CellControlService({ identityStore, bootstrapStore, publisherForCell,
      descriptorForCell }) });
}

// One explicit sync, not a daemon. Control address supplied locally until installer
// assigns the service port; the key must remain the registered controller's key.
async function syncCellSettings({ connectionStore, identityStore, receiver, host, port,
  transport = 'tls', userDescriptor }) {
  const connection = await connectionStore.read();
  if (connection?.status !== 'registered') throw new Error('Cell is not registered');
  if (connection.version !== 1 && connection.version !== 2) {
    throw new Error('Unsupported cell connection version');
  }
  if (connection.version === 2 && transport !== 'tunnel') {
    throw new Error('AWG cell control requires the tunnel transport');
  }
  if (connection.version === 1 && transport !== 'tls') {
    throw new Error('Legacy cell control requires the TLS transport');
  }
  const identity = await identityStore.load('cell');
  if (identity.publicKey !== connection.cellKey) throw new Error('Cell identity changed');
  const exchange = async (action, payload = null) => {
    const request = signControl({ controllerKey: connection.controllerKey, action, payload }, identity.privateKey);
    if (transport === 'tunnel') {
      return exchangeOverTunnel({ address: host, port, request,
        controllerKey: connection.controllerKey });
    }
    if (transport !== 'tls') throw new TypeError('Unknown cell control transport');
    return exchangeOverTls({ host, port, request, controllerKey: connection.controllerKey,
      protocol: PROTOCOL, responseLimit: 2 * 1024 * 1024, verifyResponse: response => {
        return verifyControlReply(response, connection.controllerKey, request.requestId);
      } });
  };
  if (userDescriptor !== undefined) {
    if (transport !== 'tunnel') throw new Error('Cell descriptor requires AWG control');
    const announced = await exchange('announce', validateCellUserDescriptor(userDescriptor));
    if (announced.announced !== true) throw new Error('Cell descriptor acknowledgement mismatch');
  }
  const reply = await exchange('poll');
  if (reply.settings === null) return { status: 'no-settings' };
  verifySettings(reply.settings, connection);
  await receiver.receive(reply.settings);
  const ack = await acknowledgeApplied(receiver, identityStore);
  const result = await exchange('ack', ack);
  if (result.applied !== ack.revision) throw new Error('Applied acknowledgement mismatch');
  return { status: 'applied', revision: ack.revision };
}

module.exports = { CellControlService, prepareControlEndpoint,
  listenTunnelControlEndpoint, syncCellSettings };
