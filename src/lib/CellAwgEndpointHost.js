'use strict';

const net = require('node:net');

function validEndpointHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return false;
  const family = net.isIP(host);
  if (family === 4) {
    const [first, second] = host.split('.').map(Number);
    return first !== 0 && first !== 127 && first < 224 && !(first === 169 && second === 254);
  }
  if (family === 6) return host !== '::' && host !== '::1'
    && !/^f[ef]/i.test(host) && !/^fe[89ab]/i.test(host);
  return host.split('.').every(label =>
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

module.exports = { validEndpointHost };
