'use strict';

// Default for a NEW installation only. Loading/updating/restoring saved state
// must retain its previous prefix, including the older random ULA prefixes.
// Independent Main networks are isolated, just as for the default 10.8.0.0/24.
const createNat66Plan = () => {
  const prefix = 'fd08:8';
  return Object.freeze({
    mode: 'nat66',
    subnet: `${prefix}::/64`,
    serverAddress: `${prefix}::1`,
    firstClientAddress: `${prefix}::2`,
  });
};

module.exports = { createNat66Plan };
