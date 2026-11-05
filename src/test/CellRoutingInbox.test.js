'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { identity } = require('../lib/CellRegistration');
const { routingViewFromTopology } = require('../lib/CellRoutingView');
const { signRoutingRevision } = require('../lib/CellRoutingRevision');
const { CellRoutingInbox } = require('../lib/CellRoutingInbox');

const cellId = 'a'.repeat(32);
const key = n => Buffer.alloc(32, n).toString('base64');
const assignment = { id: 'phone', publicKey: key(1), address4: '10.88.0.2',
  networkGroup: 'home', ipv4Enabled: true, ipv6Enabled: false,
  geoPolicy: { mode: 'off', countries: [] } };
function view(exit = 'main') {
  return routingViewFromTopology({ version: 1,
    nodes: [{ id: 'main', role: 'controller', ipv4: true, ipv6: false },
      { id: cellId, role: 'cell', ipv4: true, ipv6: false }],
    links: [{ a: 'main', b: cellId, ipv4: true, ipv6: false }],
    clients: [{ entry: cellId, exit, assignment }] }, cellId);
}

test('routing inbox persists applied proof, rejects replay and restores only last good view', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-routing-inbox-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const controller = identity(), cell = identity();
  let fail = false;
  const applied = [];
  const replayFlags = [];
  const options = { controllerKey: controller.publicKey, cellKey: cell.publicKey,
    nodeId: cellId, assignments: async () => ({ schema: 1, clients: [assignment] }),
    apply: async (route, revision, _geo, flags) => { replayFlags.push(flags?.replayApplied === true);
      if (fail) throw new Error('guard retained');
      applied.push([revision, route.routes[0].exit]); } };
  const file = path.join(dir, 'routing.json');
  const inbox = new CellRoutingInbox(file, options);
  const sign = (revision, route) => signRoutingRevision({ cellKey: cell.publicKey,
    revision, view: route }, controller.privateKey);
  const first = sign(1, view());
  await inbox.receive(first);
  await inbox.receive(first);
  assert.deepEqual(applied, [[1, 'main']]);
  const second = sign(2, view(cellId));
  fail = true;
  await assert.rejects(inbox.receive(second), /guard retained/);
  assert.equal((await inbox.load()).received.revision, 2);
  assert.equal((await inbox.load()).applied.revision, 1);
  await assert.rejects(inbox.receive(first), /Stale/);
  await assert.rejects(inbox.receive(sign(2, view())), /Conflicting/);
  fail = false;
  const restarted = new CellRoutingInbox(file, options);
  await restarted.restoreApplied();
  assert.deepEqual(applied, [[1, 'main'], [1, 'main']]);
  await restarted.receive(second);
  assert.deepEqual(applied.at(-1), [2, cellId]);
  assert.deepEqual(replayFlags, [false, false, true, false]);
});

test('routing inbox refuses a peer not in the applied assignment before any write', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-routing-unassigned-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const controller = identity(), cell = identity();
  const file = path.join(dir, 'routing.json');
  const inbox = new CellRoutingInbox(file, { controllerKey: controller.publicKey,
    cellKey: cell.publicKey, nodeId: cellId,
    assignments: async () => ({ schema: 1, clients: [] }), apply: async () => {} });
  const signed = signRoutingRevision({ cellKey: cell.publicKey, revision: 1,
    view: view() }, controller.privateKey);
  await assert.rejects(inbox.receive(signed), /assignments differ/);
  assert.equal(await inbox.load(), null);
});

test('routing revision can rebase only in a newer pinned authority generation and preserves the last applied route on failure', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-routing-epoch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const controller = identity(), cell = identity(), authority = identity();
  let epoch = null, fail = false;
  const file = path.join(dir, 'routing.json');
  const inbox = new CellRoutingInbox(file, { controllerKey: controller.publicKey,
    cellKey: cell.publicKey, nodeId: cellId, authority: async () => epoch,
    assignments: async () => ({ schema: 1, clients: [assignment] }),
    apply: async () => { if (fail) throw new Error('route apply failed'); } });
  const sign = revision => signRoutingRevision({ cellKey: cell.publicKey, revision,
    view: view() }, controller.privateKey);
  await inbox.receive(sign(8));
  epoch = { key: authority.publicKey, generation: 3 };
  fail = true;
  await assert.rejects(inbox.receive(sign(1)), /route apply failed/);
  assert.equal((await inbox.load()).applied.revision, 8);
  fail = false;
  assert.deepEqual(await inbox.restoreApplied(), { applied: 8 });
  await inbox.receive(sign(1));
  await inbox.receive(sign(2));
  await assert.rejects(inbox.receive(sign(1)), /Stale/);
  epoch = { key: authority.publicKey, generation: 2 };
  await assert.rejects(inbox.receive(sign(9)), /control authority/);
  assert.equal((await inbox.load()).applied.revision, 2);
});

test('GeoIP refresh reapplies the signed view without advancing its revision', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-routing-geo-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const controller = identity(), cell = identity();
  const file = path.join(dir, 'routing.json');
  const applied = [];
  let fail = false;
  const inbox = new CellRoutingInbox(file, { controllerKey: controller.publicKey,
    cellKey: cell.publicKey, nodeId: cellId,
    assignments: async () => ({ schema: 1, clients: [assignment] }),
    apply: async (_view, revision, database) => {
      if (fail) throw new Error('geo apply failed');
      applied.push({ revision, database });
    } });
  assert.deepEqual(await inbox.refreshApplied({ RU: {} }), { applied: null });
  await inbox.receive(signRoutingRevision({ cellKey: cell.publicKey,
    revision: 1, view: view() }, controller.privateKey));
  const before = await fs.readFile(file, 'utf8');
  await inbox.refreshApplied({ RU: { ipv4: ['203.0.113.0/24'], ipv6: [] } });
  assert.deepEqual(applied.at(-1), { revision: 1,
    database: { RU: { ipv4: ['203.0.113.0/24'], ipv6: [] } } });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  fail = true;
  await assert.rejects(inbox.refreshApplied({}), /geo apply failed/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});
