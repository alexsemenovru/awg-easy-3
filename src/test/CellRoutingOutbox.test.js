'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { identity } = require('../lib/CellRegistration');
const { verifyRoutingRevision } = require('../lib/CellRoutingRevision');
const { signRoutingAck } = require('../lib/CellRoutingAck');
const { CellRoutingOutbox } = require('../lib/CellRoutingOutbox');

const cellId = 'a'.repeat(32);
const assignment = { id: 'phone', publicKey: Buffer.alloc(32, 1).toString('base64'),
  address4: '10.88.0.2', networkGroup: 'home', ipv4Enabled: true,
  ipv6Enabled: false, geoPolicy: { mode: 'off', countries: [] } };
const topology = exit => ({ version: 1,
  nodes: [{ id: 'main', role: 'controller', ipv4: true, ipv6: false },
    { id: cellId, role: 'cell', ipv4: true, ipv6: false }],
  links: [{ a: 'main', b: cellId, ipv4: true, ipv6: false }],
  clients: [{ entry: cellId, exit, assignment }] });

test('routing outbox signs exactly one durable revision per desired view', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-routing-outbox-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const controller = identity(), cell = identity();
  const options = { identityStore: { load: async () => controller },
    cellKey: cell.publicKey, nodeId: cellId };
  const file = path.join(dir, 'routing.json');
  const outbox = new CellRoutingOutbox(file, options);
  const first = await outbox.publish(topology('main'));
  assert.equal(first.revision, 1);
  assert.deepEqual(await outbox.publish(topology('main')), first);
  const reopened = new CellRoutingOutbox(file, options);
  const second = await reopened.publish(topology(cellId));
  assert.equal(second.revision, 2);
  assert.equal(verifyRoutingRevision(second, { controllerKey: controller.publicKey,
    cellKey: cell.publicKey, nodeId: cellId }).view.routes[0].exit, cellId);
  await fs.writeFile(file, JSON.stringify({ ...second, payload: '{}' }));
  await assert.rejects(reopened.load());
  await assert.rejects(reopened.publish(topology('main')));
});

test('Cell route readiness requires a valid acknowledgement of the current revision', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-routing-ack-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const controller = identity(), cell = identity(), stranger = identity();
  const file = path.join(dir, 'routing.json');
  const options = { identityStore: { load: async () => controller },
    cellKey: cell.publicKey, nodeId: cellId };
  const outbox = new CellRoutingOutbox(file, options);
  const first = await outbox.publish(topology('main'));
  assert.equal(await outbox.applied(), null);
  assert.throws(() => signRoutingAck(first, stranger.privateKey));
  const ack = signRoutingAck(first, cell.privateKey);
  assert.equal((await outbox.acknowledge(ack)).revision, 1);
  assert.equal(await new CellRoutingOutbox(file, options).applied(), 1);
  await outbox.publish(topology(cellId));
  assert.equal(await outbox.applied(), null);
  await assert.rejects(outbox.acknowledge(ack));
});
