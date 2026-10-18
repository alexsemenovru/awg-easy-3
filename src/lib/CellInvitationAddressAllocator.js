'use strict';

const net = require('node:net');
const { privateAddress } = require('./CellTunnelControlTransport');

function prefix(address) {
  if (net.isIP(address) !== 4 || !privateAddress(address)) {
    throw new Error('Automatic Cell addresses require private IPv4 control endpoints');
  }
  const parts = address.split('.').map(Number);
  if (parts[3] !== 1 || parts[2] > 250) {
    throw new Error('Automatic Cell addresses require a control endpoint ending in .1');
  }
  return parts;
}

function allocateCellInvitationAddresses({ controllerAddress, permanentControllerAddress,
  invitations } = {}) {
  const temporary = prefix(controllerAddress);
  const permanent = prefix(permanentControllerAddress);
  if (temporary[0] === permanent[0] && temporary[1] === permanent[1]
    && Math.abs(temporary[2] - permanent[2]) < 4) {
    throw new Error('Automatic Cell address pools overlap');
  }
  if (!Array.isArray(invitations) || invitations.length > 1024) {
    throw new TypeError('Bounded Main invitation inventory required');
  }
  const used = new Set();
  for (const record of invitations) {
    if (!record || net.isIP(record.cellAddress) !== 4
      || record.permanentDescriptor
        && net.isIP(record.permanentDescriptor.cellAddress) !== 4) {
      throw new Error('Main invitation inventory has incomplete Cell addresses');
    }
    used.add(record.cellAddress);
    if (record.permanentDescriptor) used.add(record.permanentDescriptor.cellAddress);
  }
  for (let index = 0; index < 4 * 253; index++) {
    const third = Math.floor(index / 253);
    const last = 2 + index % 253;
    const cellAddress = `${temporary[0]}.${temporary[1]}.${temporary[2] + third}.${last}`;
    const permanentCellAddress = `${permanent[0]}.${permanent[1]}.${permanent[2] + third}.${last}`;
    if (!used.has(cellAddress) && !used.has(permanentCellAddress)
      && cellAddress !== permanentCellAddress) {
      return Object.freeze({ cellAddress, permanentCellAddress });
    }
  }
  throw new Error('No free automatic Cell control address remains');
}

module.exports = { allocateCellInvitationAddresses };
