'use strict';
const net = require('node:net');

// An optional local binding, never a remotely supplied route or shell argument.
function egressIpv4(value) {
  if (value === undefined || value === '') return undefined;
  if (net.isIP(value) !== 4 || /^(0|127)\./.test(value)
    || Number(value.split('.')[0]) >= 224 || value === '255.255.255.255') {
    throw new TypeError('Invalid outgoing IPv4 address');
  }
  return value;
}
module.exports = { egressIpv4 };
