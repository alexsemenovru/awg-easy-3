'use strict';
const path = require('node:path');
const { BackupJournal } = require('./BackupJournal');
const { verifyCommand, verifyHostRequest } = require('./CellMaintenance');
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const image = x => typeof x === 'string' && /^sha256:[a-f0-9]{64}$/.test(x);
const exact = (x, fields) => x && typeof x === 'object' && !Array.isArray(x)
  && Object.keys(x).sort().join(',') === [...fields].sort().join(',');
function anchorValue(x) {
  if (!exact(x, ['version', 'controllerKey', 'cellKey', 'containerId', 'imageId']) || x.version !== 1
    || ![x.controllerKey, x.cellKey].every(k => typeof k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k))
    || !digest(x.containerId) || !image(x.imageId)) throw new Error('Invalid host maintenance anchor');
  return x;
}
const phases = ['queued', 'stopped', 'resources-removed', 'container-removed', 'complete'];
class CellMaintenanceHost {
  constructor(directory) {
    this.anchor = new BackupJournal(path.join(directory, 'anchor.json'), anchorValue, 4096);
    this.operation = new BackupJournal(path.join(directory, 'operation.json'), x => {
      if (!exact(x, ['version', 'command', 'phase', 'containerId', 'imageId', ...(Object.hasOwn(x, 'replacementImageId') ? ['replacementImageId'] : [])]) || x.version !== 1
        || !phases.includes(x.phase) || !digest(x.containerId) || !image(x.imageId)) throw new Error('Invalid host maintenance operation');
      if (x.replacementImageId !== undefined && (x.command?.action !== 'update' || !image(x.replacementImageId))) throw new Error('Invalid replacement image intent');
      verifyCommand(x.command, x.command);
      if (x.command.action === 'update' && !['queued', 'complete'].includes(x.phase)) throw new Error('Invalid update phase');
      return x;
    }, 8192);
  }
  async initialize({ identity, connection, containerId, imageId }) {
    if (connection?.status !== 'registered' || connection.cellKey !== identity.publicKey) throw new Error('Registered local Cell required');
    const wanted = anchorValue({ version: 1, controllerKey: connection.controllerKey,
      cellKey: identity.publicKey, containerId, imageId });
    return this.anchor.exclusive(async () => {
      const old = await this.anchor.read();
      if (old && JSON.stringify(old) !== JSON.stringify(wanted)) throw new Error('Host anchor already belongs to another container');
      if (!old) await this.anchor.write(wanted);
      return wanted;
    });
  }
  async prepare(request) {
    const anchor = await this.anchor.read();
    if (!anchor) throw new Error('Host anchor missing');
    verifyHostRequest(request, anchor);
    return this.operation.exclusive(async () => {
      let state = await this.operation.read();
      if (state && state.command.id !== request.command.id && state.command.action === 'update'
        && state.phase === 'queued' && state.replacementImageId) return state;
      if (state && state.command.id !== request.command.id && !['queued', 'complete'].includes(state.phase)) {
        throw new Error('Terminal operation is still pending');
      }
      if (!state || state.command.id !== request.command.id) {
        state = { version: 1, command: request.command, phase: 'queued',
          containerId: anchor.containerId, imageId: anchor.imageId };
        await this.operation.write(state);
      }
      return state;
    });
  }
  async read() {
    let state = await this.operation.read(); const anchor = await this.anchor.read();
    if (!state || !anchor) throw new Error('Host maintenance intent missing');
    verifyCommand(state.command, anchor);
    if (state.containerId !== anchor.containerId || state.imageId !== anchor.imageId) {
      if (state.command.action !== 'update' || state.phase !== 'queued' || state.replacementImageId !== anchor.imageId) throw new Error('Container anchor changed');
      // Root advanced the anchor only after the replacement passed its running
      // version check. Resume the interrupted second journal write.
      state = await this.operation.write({ ...state, containerId: anchor.containerId,
        imageId: anchor.imageId, phase: 'complete' });
    }
    return state;
  }
  advance(phase) { return this.operation.exclusive(async () => {
    const state = await this.read();
    const next = state.command.action === 'update' ? ['queued', 'complete'] : phases;
    if (!next.includes(phase) || next.indexOf(phase) < next.indexOf(state.phase)
      || next.indexOf(phase) > next.indexOf(state.phase) + 1) throw new Error('Invalid host maintenance transition');
    return this.operation.write({ ...state, phase });
  }); }
  async planReplacement(imageId) {
    if (!image(imageId)) throw new Error('Invalid replacement image');
    const state = await this.read();
    if (state.command.action !== 'update' || state.phase !== 'queued') throw new Error('No pending update');
    if (state.replacementImageId && state.replacementImageId !== imageId) throw new Error('Replacement image intent changed');
    await this.operation.write({ ...state, replacementImageId: imageId });
  }
  async replace({ containerId, imageId }) {
    if (!digest(containerId) || !image(imageId)) throw new Error('Invalid replacement container');
    const state = await this.read();
    if (state.command.action !== 'update' || state.phase !== 'queued' || state.replacementImageId !== imageId) throw new Error('No pending update or verified replacement image intent');
    // Root calls this only after verifying the signed image and inspecting its
    // new running container. The Cell itself has no mount of this directory.
    await this.anchor.write({ ...await this.anchor.read(), containerId, imageId });
    await this.operation.write({ ...state, containerId, imageId, phase: 'complete' });
  }
}
module.exports = { CellMaintenanceHost, anchorValue };
