'use strict';

// The persisted legacy value `home` is group 1. This preserves all existing
// profiles while allowing ten isolated Home networks.
const NETWORK_GROUPS = Object.freeze(['guest', 'home',
  ...Array.from({ length: 9 }, (_, index) => `home${index + 2}`)]);
const isHomeGroup = value => NETWORK_GROUPS.includes(value) && value !== 'guest';

module.exports = { NETWORK_GROUPS, isHomeGroup };
