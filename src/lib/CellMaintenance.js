'use strict';
const crypto = require('node:crypto');
const { validEndpointHost } = require('./CellAwgEndpointHost');
const { BackupJournal } = require('./BackupJournal');
const currentVersion = require('../package.json').version;
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x)
  && Object.keys(x).sort().join(',') === [...keys].sort().join(',');
const key = x => typeof x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(x)
  && Buffer.from(x, 'base64url').toString('base64url') === x;
const stable = x => typeof x === 'string' && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(x);
function newer(a, b) {
  if (!stable(a) || !stable(b)) throw new Error('Stable software version required');
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
function sign(value, privateKey, domain) {
  return { ...value, signature: crypto.sign(null, Buffer.from(JSON.stringify([domain, value])), privateKey).toString('base64url') };
}
function verify(value, publicKey, domain) {
  if (!value || !key(publicKey) || typeof value.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value.signature)) throw new Error('Invalid maintenance proof');
  const { signature, ...body } = value;
  const k = crypto.createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: publicKey } });
  if (!crypto.verify(null, Buffer.from(JSON.stringify([domain, body])), k, Buffer.from(signature, 'base64url'))) throw new Error('Invalid maintenance signature');
  return value;
}
function verifyCommand(value, trust) {
  if (!exact(value, ['version', 'id', 'controllerKey', 'cellKey', 'authorityKey', 'action', 'targetVersion', 'receiptHost', 'receiptPort', 'signature'])
    || value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.id) || !key(value.controllerKey) || !key(value.cellKey)
    || value.authorityKey !== null && !key(value.authorityKey)
    || !['update', 'remove'].includes(value.action)
    || (value.action === 'update' ? !stable(value.targetVersion) : value.targetVersion !== null)
    || !validEndpointHost(value.receiptHost) || !Number.isInteger(value.receiptPort) || value.receiptPort < 1 || value.receiptPort > 65535
    || value.controllerKey !== trust.controllerKey || value.cellKey !== trust.cellKey
    || Object.hasOwn(trust, 'authorityKey') && value.authorityKey !== trust.authorityKey) throw new Error('Invalid maintenance command');
  return verify(value, trust.controllerKey, 'network-maintenance-command/v1');
}
function verifyReceipt(value, command) {
  verifyCommand(command, command);
  if (!exact(value, ['version', 'commandId', 'controllerKey', 'cellKey', 'authorityKey', 'action', 'targetVersion', 'signature'])
    || value.version !== 1 || value.commandId !== command.id || value.controllerKey !== command.controllerKey
    || value.cellKey !== command.cellKey || value.authorityKey !== command.authorityKey
    || value.action !== command.action || value.targetVersion !== command.targetVersion) throw new Error('Maintenance receipt differs from command');
  return verify(value, command.cellKey, 'network-maintenance-receipt/v1');
}
const receiptFor = (command, identity) => sign({ version: 1, commandId: command.id,
  controllerKey: command.controllerKey, cellKey: command.cellKey, authorityKey: command.authorityKey,
  action: command.action, targetVersion: command.targetVersion }, identity.privateKey, 'network-maintenance-receipt/v1');
const receiptAckFor = (command, identity) => sign({ version: 1, commandId: command.id,
  cellKey: command.cellKey, accepted: true }, identity.privateKey, 'network-maintenance-ack/v1');
function verifyReceiptAck(value, command) {
  if (!exact(value, ['version', 'commandId', 'cellKey', 'accepted', 'signature']) || value.version !== 1
    || value.commandId !== command.id || value.cellKey !== command.cellKey || value.accepted !== true) throw new Error('Invalid maintenance acknowledgement');
  // Terminal acknowledgement cannot authorize settings, routes or a host
  // operation. Keep its signer stable across restore for a retrying courier.
  return verify(value, command.controllerKey, 'network-maintenance-ack/v1');
}
function verifyHostRequest(value, anchor) {
  if (!exact(value, ['version', 'command', 'signature']) || value.version !== 1) throw new Error('Invalid host request');
  verifyCommand(value.command, anchor);
  return verify(value, anchor.cellKey, 'network-maintenance-host/v1');
}
class MainCellMaintenance {
  constructor(file, { controller, cellKey, authority = async () => null, endpointHost, port = 49033, version = currentVersion }) {
    Object.assign(this, { controller, cellKey, authority, endpointHost, port, version });
    this.journal = new BackupJournal(file, state => {
      if (!exact(state, ['version', 'command', 'receipt', 'softwareVersion', ...(Object.hasOwn(state, 'finalized') ? ['finalized'] : [])]) || state.version !== 1
        || state.softwareVersion !== null && !stable(state.softwareVersion)) throw new Error('Invalid maintenance journal');
      if (state.finalized !== undefined && typeof state.finalized !== 'boolean'
        || state.finalized && (!state.receipt || state.command?.action !== 'remove')) throw new Error('Invalid final maintenance state');
      if (state.command) verifyCommand(state.command, { controllerKey: controller.publicKey, cellKey });
      if (state.receipt) { if (!state.command) throw new Error('Orphan maintenance receipt'); verifyReceipt(state.receipt, state.command); }
      return { ...state, finalized: state.finalized ?? false };
    });
  }
  async read() { return await this.journal.read() ?? { version: 1, command: null, receipt: null, softwareVersion: null, finalized: false }; }
  async command(action) {
    const authority = await this.authority();
    return sign({ version: 1, id: crypto.randomBytes(16).toString('hex'), controllerKey: this.controller.publicKey,
      cellKey: this.cellKey, authorityKey: authority?.publicKey ?? null, action,
      targetVersion: action === 'update' ? this.version : null, receiptHost: this.endpointHost,
      receiptPort: this.port }, this.controller.privateKey, 'network-maintenance-command/v1');
  }
  async poll(softwareVersion) {
    if (!stable(softwareVersion)) throw new Error('Invalid Cell software version');
    return this.journal.exclusive(async () => {
      const state = await this.read();
      const liveKey = (await this.authority())?.publicKey ?? null;
      if (state.command && !state.receipt && state.command.authorityKey !== liveKey) state.command = await this.command(state.command.action);
      if (state.command?.action === 'update' && !state.receipt && softwareVersion === state.command.targetVersion) {
        // A software report is authenticated by the live control request. The
        // updater sends no success before the new process actually runs.
        state.command = null;
        state.receipt = null;
      }
      if (state.command?.action !== 'remove' && stable(this.version) && newer(this.version, softwareVersion)
        && (!state.command || state.command.targetVersion !== this.version)) {
        state.command = await this.command('update'); state.receipt = null;
      }
      state.softwareVersion = softwareVersion;
      await this.journal.write(state);
      return state.command && !state.receipt ? state.command : null;
    });
  }
  remove() { return this.journal.exclusive(async () => {
    const state = await this.read();
    if (state.command?.action !== 'remove') { state.command = await this.command('remove'); state.receipt = null; state.finalized = false; await this.journal.write(state); }
    return state.command;
  }); }
  accept(receipt) { return this.journal.exclusive(async () => {
    const state = await this.read();
    if (!state.command) throw new Error('No maintenance command');
    verifyReceipt(receipt, state.command);
    state.receipt = receipt; await this.journal.write(state);
    return { accepted: true, commandId: receipt.commandId };
  }); }
  finishRemoval() { return this.journal.exclusive(async () => {
    const state = await this.read();
    if (state.command?.action !== 'remove' || !state.receipt) throw new Error('Verified removal receipt required');
    state.finalized = true; await this.journal.write(state);
  }); }
  async status() {
    const state = await this.read();
    return { version: state.softwareVersion, action: state.command?.action ?? null,
      targetVersion: state.command?.targetVersion ?? null, completed: state.finalized,
      matchesMain: state.softwareVersion === this.version };
  }
}
module.exports = { stable, newer, sign, verify, verifyCommand, verifyReceipt, receiptFor, receiptAckFor,
  verifyReceiptAck, verifyHostRequest, MainCellMaintenance };
