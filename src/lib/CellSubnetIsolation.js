'use strict';

const net = require('node:net');
const { addressInSubnet } = require('./AddressAllocator');

function assertDistinctClientSubnets(subnets) {
  if (!Array.isArray(subnets) || subnets.length > 128) {
    throw new TypeError('Invalid client subnet inventory');
  }
  const rows = subnets.map(value => {
    if (typeof value !== 'string') throw new TypeError('Invalid client subnet');
    const [address, prefix, extra] = value.split('/');
    if (extra !== undefined || !net.isIP(address) || !/^\d+$/.test(prefix)) {
      throw new TypeError('Invalid client subnet');
    }
    addressInSubnet(address, value); // validates prefix and family
    return { address, value, family: net.isIP(address) };
  });
  for (let i = 0; i < rows.length; i++) for (let j = 0; j < i; j++) {
    if (rows[i].family !== rows[j].family) continue;
    if (addressInSubnet(rows[i].address, rows[j].value)
      || addressInSubnet(rows[j].address, rows[i].value)) {
      throw new Error('Main and Cell client subnets overlap');
    }
  }
  return true;
}

module.exports = { assertDistinctClientSubnets };
