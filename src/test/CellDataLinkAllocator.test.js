'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { allocateCellDataLink, CAPACITY } = require('../lib/CellDataLinkAllocator');

test('allocates separate Main interfaces and immutable route table slots', () => {
  const first = allocateCellDataLink();
  const second = allocateCellDataLink({ usedSlots: [first.slot] });
  assert.deepEqual([first.controllerAddress4, first.cellAddress4, first.endpointPort],
    ['10.252.0.1', '10.252.0.2', 53000]);
  assert.deepEqual([second.controllerAddress4, second.cellAddress4, second.endpointPort],
    ['10.252.0.5', '10.252.0.6', 53001]);
  assert.notEqual(first.controllerInterfaceName, second.controllerInterfaceName);
  assert.notEqual(first.controllerTable, second.controllerTable);
  assert.equal(first.cellInterfaceName, second.cellInterfaceName);
  assert.equal(allocateCellDataLink({ unavailablePorts: [53000] }).slot, 1);
});

test('all reserved slots remain inside separate address pairs and the bounded port range', () => {
  const seen = new Set();
  for (let slot = 0; slot < CAPACITY; slot++) {
    const allocated = allocateCellDataLink({ usedSlots: Array.from({ length: slot }, (_, i) => i),
      pool6: 'fd91::/112' });
    assert.equal(allocated.slot, slot);
    assert.ok(!seen.has(allocated.controllerAddress4));
    seen.add(allocated.controllerAddress4);
    seen.add(allocated.cellAddress4);
    assert.equal(allocated.endpointPort, 53000 + slot);
  }
  assert.throws(() => allocateCellDataLink({ usedSlots: Array.from({ length: CAPACITY }, (_, i) => i) }),
    /No free/);
});

test('refuses public, noncanonical or malformed pools and colliding slot inventory', () => {
  for (const options of [{ pool4: '192.0.2.0/23' }, { pool4: '10.252.1.0/23' },
    { pool6: '2001:db8::/112' }, { pool6: 'fd91::1/112' },
    { usedSlots: [1, 1] }, { usedSlots: [127] }, { portStart: 65500 }]) {
    assert.throws(() => allocateCellDataLink(options));
  }
});
