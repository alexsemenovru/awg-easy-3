'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyMainRoutingInterfaceSet } = require('../lib/MainRoutingInterfaceVerifier');

test('Main verifies an old committed link subset while joining another Cell', async () => {
  const checked = [];
  const links = ['awgd0', 'awgd1'].map(interfaceName => ({ path: {
    interfaceName, verifyOwned: async () => { checked.push(interfaceName); return true; },
  } }));
  const verify = names => verifyMainRoutingInterfaceSet({ names,
    userInterface: 'awg0', links, verifyUser: async () => true });
  assert.equal(await verify(['awg0', 'awgd0']), true);
  assert.deepEqual(checked, ['awgd0']);
  assert.equal(await verify(['awg0', 'awgd0', 'awgd1']), true);
  assert.deepEqual(checked, ['awgd0', 'awgd0', 'awgd1']);
  assert.equal(await verify(['awg0', 'awgd2']), false);
  assert.equal(await verify(['awgd0']), false);
  assert.equal(await verify(['awg0', 'awgd0', 'awgd0']), false);
});

test('Main does not accept a previous link if ownership or user tunnel is lost', async () => {
  const links = [{ path: { interfaceName: 'awgd0', verifyOwned: async () => false } }];
  const input = { names: ['awg0', 'awgd0'], userInterface: 'awg0', links,
    verifyUser: async () => true };
  assert.equal(await verifyMainRoutingInterfaceSet(input), false);
  assert.equal(await verifyMainRoutingInterfaceSet({ ...input,
    verifyUser: async () => false }), false);
});
