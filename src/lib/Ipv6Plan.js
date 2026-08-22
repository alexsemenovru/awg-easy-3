'use strict';

const crypto = require('node:crypto');

const createNat66Plan = ({ randomBytes = crypto.randomBytes } = {}) => {
  if (typeof randomBytes !== 'function') throw new TypeError('randomBytes must be a function');
  const id = randomBytes(5);
  if (!Buffer.isBuffer(id) || id.length !== 5) {
    throw new Error('randomBytes must return exactly five bytes for the ULA global ID');
  }
  const groups = [
    0xfd00 | id[0],
    (id[1] << 8) | id[2],
    (id[3] << 8) | id[4],
  ].map((group) => group.toString(16));
  const prefix = groups.join(':');
  return Object.freeze({
    mode: 'nat66',
    subnet: `${prefix}::/64`,
    serverAddress: `${prefix}::1`,
    firstClientAddress: `${prefix}::2`,
  });
};

module.exports = { createNat66Plan };
