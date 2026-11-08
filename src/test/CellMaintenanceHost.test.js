'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { identity } = require('../lib/CellRegistration');
const { CellMaintenanceHost } = require('../lib/CellMaintenanceHost');
const { MainCellMaintenance, sign } = require('../lib/CellMaintenance');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-host-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cell = identity(), controller = identity();
  const host = new CellMaintenanceHost(directory);
  const anchor = { identity: cell, connection: { status: 'registered', cellKey: cell.publicKey,
    controllerKey: controller.publicKey }, containerId: 'a'.repeat(64), imageId: `sha256:${'b'.repeat(64)}` };
  await host.initialize(anchor);
  const main = new MainCellMaintenance(path.join(directory, 'main.json'), {
    controller, cellKey: cell.publicKey, endpointHost: 'example.com', version: '1.2.3' });
  const request = command => sign({ version: 1, command }, cell.privateKey, 'network-maintenance-host/v1');
  return { directory, host, main, anchor, request };
}
test('host pins the installed container and resumes only forward terminal phases', async t => {
  const f = await fixture(t), command = await f.main.remove();
  await f.host.prepare(f.request(command));
  await assert.rejects(f.host.advance('container-removed'), /transition/);
  for (const phase of ['stopped', 'resources-removed', 'container-removed', 'complete']) {
    await f.host.advance(phase);
    assert.equal((await new CellMaintenanceHost(f.directory).read()).phase, phase);
  }
  await assert.rejects(f.host.initialize({ ...f.anchor, containerId: 'c'.repeat(64) }), /another container/);
  await assert.rejects(f.host.advance('stopped'), /transition/);
});
test('host rejects a different Cell and protects a pending removal from replacement', async t => {
  const f = await fixture(t), command = await f.main.remove();
  await assert.rejects(f.host.prepare(sign({ version: 1, command }, identity().privateKey,
    'network-maintenance-host/v1')), /signature/);
  await f.host.prepare(f.request(command)); await f.host.advance('stopped');
  await assert.rejects(f.host.prepare(f.request(await f.main.command('remove'))), /still pending/);
  await assert.rejects(f.host.replace({ containerId: 'c'.repeat(64), imageId: `sha256:${'d'.repeat(64)}` }), /No pending update/);
});
test('verified host replacement survives a crash between anchor and completion writes', async t => {
  const f = await fixture(t), command = await f.main.poll('1.2.2');
  await f.host.prepare(f.request(command));
  const anchor = await f.host.anchor.read();
  await f.host.anchor.write({ ...anchor, containerId: 'c'.repeat(64), imageId: `sha256:${'d'.repeat(64)}` });
  const resumed = await new CellMaintenanceHost(f.directory).read();
  assert.equal(resumed.phase, 'complete'); assert.equal(resumed.containerId, 'c'.repeat(64));
});
