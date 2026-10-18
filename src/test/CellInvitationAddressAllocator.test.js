'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { allocateCellInvitationAddresses } = require('../lib/CellInvitationAddressAllocator');

const defaults = () => ({ controllerAddress: '10.90.8.1',
  permanentControllerAddress: '10.91.8.1', invitations: [] });

test('Main allocates paired Cell addresses and never reuses historical invitations', () => {
  const first = allocateCellInvitationAddresses(defaults());
  assert.deepEqual(first, { cellAddress: '10.90.8.2', permanentCellAddress: '10.91.8.2' });
  const second = allocateCellInvitationAddresses({ ...defaults(), invitations: [
    { cellAddress: first.cellAddress, permanentDescriptor: { cellAddress: first.permanentCellAddress },
      status: 'revoked' },
  ] });
  assert.deepEqual(second, { cellAddress: '10.90.8.3', permanentCellAddress: '10.91.8.3' });
  const fullFirstPool = Array.from({ length: 253 }, (_, index) => ({
    cellAddress: `10.90.8.${index + 2}`,
    permanentDescriptor: { cellAddress: `10.91.8.${index + 2}` },
  }));
  assert.deepEqual(allocateCellInvitationAddresses({ ...defaults(),
    invitations: fullFirstPool }), { cellAddress: '10.90.9.2',
    permanentCellAddress: '10.91.9.2' });
});

test('Main rejects overlapping or malformed automatic address pools', () => {
  assert.throws(() => allocateCellInvitationAddresses({ ...defaults(),
    permanentControllerAddress: '10.90.9.1' }), /overlap/);
  assert.throws(() => allocateCellInvitationAddresses({ ...defaults(),
    controllerAddress: '10.90.8.3' }), /ending in \.1/);
  assert.throws(() => allocateCellInvitationAddresses({ ...defaults(),
    invitations: [{ cellAddress: 'missing' }] }), /incomplete/);
});
