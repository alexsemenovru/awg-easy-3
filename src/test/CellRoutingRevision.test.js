'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { identity } = require('../lib/CellRegistration');
const { routingViewFromTopology, validateRoutingView,
  assertRoutingMatchesAssignments } = require('../lib/CellRoutingView');
const { signRoutingRevision, verifyRoutingRevision } = require('../lib/CellRoutingRevision');
const { compileCellRouting } = require('../lib/CellRoutingPolicy');

const key = n => Buffer.alloc(32, n).toString('base64');
const cellId = 'a'.repeat(32);
const topology = () => ({ version: 1,
  nodes: [{ id: 'main', role: 'controller', ipv4: true, ipv6: false },
    { id: cellId, role: 'cell', ipv4: true, ipv6: false }],
  links: [{ a: 'main', b: cellId, ipv4: true, ipv6: false }],
  clients: [{ entry: cellId, exit: 'main', assignment: {
    id: 'phone', publicKey: key(1), presharedKey: key(2),
    address4: '10.88.0.2', networkGroup: 'home', ipv4Enabled: true,
    ipv6Enabled: false, geoPolicy: { mode: 'off', countries: [] } } },
  { entry: 'main', exit: 'main', assignment: {
    id: 'desktop', publicKey: key(3), address4: '10.8.0.2',
    networkGroup: 'home', ipv4Enabled: true, ipv6Enabled: false,
    geoPolicy: { mode: 'off', countries: [] } } }] });
const context = { clientInterface: 'awgcellu0', wanInterface: 'eth0', nat66: false,
  links: { main: { interfaceName: 'awgdata0', table: 52000, priority: 20000 } },
  panel: { address4: '10.8.0.1', port: 51821 } };

test('routing-only signed view carries no peer keys and compiles the same guarded policy', () => {
  const controller = identity(), cell = identity();
  const view = routingViewFromTopology(topology(), cellId,
    { panel: { address4: '10.8.0.1', port: 51821 } });
  const envelope = signRoutingRevision({ cellKey: cell.publicKey, revision: 4, view },
    controller.privateKey);
  assert.ok(!JSON.stringify(envelope).includes(key(1)));
  assert.ok(!JSON.stringify(envelope).includes(key(2)));
  const verified = verifyRoutingRevision(envelope, {
    controllerKey: controller.publicKey, cellKey: cell.publicKey,
    nodeId: cellId, minimumRevision: 4 });
  assert.deepEqual(verified.view, view);
  const desired = compileCellRouting({ topology: topology(), nodeId: cellId, context });
  const delivered = compileCellRouting({ routingView: verified.view, nodeId: cellId, context });
  assert.deepEqual(delivered.commands, desired.commands);
  assert.deepEqual(delivered.nftSnapshot, desired.nftSnapshot);
  assert.throws(() => compileCellRouting({ routingView: verified.view, nodeId: cellId,
    context: { ...context, panel: { address4: '10.8.0.1', port: 80 } } }), /signed revision/);
});

test('routing signature binds exact revision, recipient, and route content', () => {
  const controller = identity(), cell = identity();
  const view = routingViewFromTopology(topology(), cellId);
  const signed = signRoutingRevision({ cellKey: cell.publicKey, revision: 2, view },
    controller.privateKey);
  const trust = { controllerKey: controller.publicKey, cellKey: cell.publicKey, nodeId: cellId };
  for (const patch of [{ revision: 3 }, { payload: '{}' },
    { cellKey: identity().publicKey }, { extra: 'x' }]) {
    assert.throws(() => verifyRoutingRevision({ ...signed, ...patch }, trust));
  }
  assert.throws(() => verifyRoutingRevision(signed, { ...trust, minimumRevision: 3 }));
  assert.throws(() => verifyRoutingRevision(signed, { ...trust, nodeId: 'b'.repeat(32) }));
});

test('routing view rejects executable fields, duplicate addresses and inactive policy ambiguity', () => {
  const view = routingViewFromTopology(topology(), cellId);
  assert.throws(() => validateRoutingView({ ...view, command: 'sh' }));
  assert.throws(() => validateRoutingView({ ...view,
    routes: [{ ...view.routes[0], publicKey: key(4) }, view.routes[1]] }));
  assert.throws(() => validateRoutingView({ ...view,
    routes: [view.routes[0], { ...view.routes[1], address4: view.routes[0].address4 }] }));
  assert.throws(() => validateRoutingView({ ...view,
    routes: [{ ...view.routes[0], enabled: { ipv4: true, ipv6: true } }, view.routes[1]] }));
  assert.throws(() => validateRoutingView({ ...view,
    routes: [{ ...view.routes[0], geoPolicy: { mode: 'off', countries: ['RU'] } }, view.routes[1]] }));
});

test('local route cannot exceed or contradict separately signed client assignments', () => {
  const view = routingViewFromTopology(topology(), cellId);
  const assignment = { schema: 1, clients: [topology().clients[0].assignment] };
  assert.deepEqual(assertRoutingMatchesAssignments(view, assignment), view);
  assert.throws(() => assertRoutingMatchesAssignments(view, { schema: 1, clients: [] }));
  assert.throws(() => assertRoutingMatchesAssignments(view, { schema: 1,
    clients: [{ ...assignment.clients[0], address4: '10.88.0.3' }] }));
  assert.throws(() => assertRoutingMatchesAssignments(view, { schema: 1,
    clients: [{ ...assignment.clients[0], ipv4Enabled: false }] }));
});
