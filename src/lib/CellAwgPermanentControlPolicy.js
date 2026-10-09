'use strict';

const net = require('node:net');
const { validatePermanentDescriptor } = require('./CellAwgPermanentDescriptor');
const { privateAddress } = require('./CellTunnelControlTransport');
const { ruleExpressions } = require('./CellNftPolicyJson');
const { normalizeNftSnapshot } = require('./CellNftOwnership');

const TABLE = 'awg_easy_3_control';

function permanentControlPolicySnapshot({ role, interfaceName, descriptor, peerAddresses = [] }) {
  const path = validatePermanentDescriptor(descriptor);
  if (!['controller', 'cell'].includes(role)
    || typeof interfaceName !== 'string' || !/^[A-Za-z0-9_.-]{1,15}$/.test(interfaceName)
    || !Array.isArray(peerAddresses) || peerAddresses.length > 128
    || (role === 'cell' && peerAddresses.length)) {
    throw new TypeError('Invalid permanent control policy');
  }
  const family = net.isIP(path.controllerAddress), protocol = family === 4 ? 'ip' : 'ip6';
  const addresses = role === 'controller' ? peerAddresses : [path.cellAddress];
  if (addresses.some(address => !privateAddress(address) || address.startsWith('127.')
    || address === '::1' || net.isIP(address) !== family
    || address === path.controllerAddress)
    || new Set(addresses).size !== addresses.length) {
    throw new TypeError('Invalid permanent control peer address');
  }
  const sorted = [...addresses].sort();
  const nftables = [{ table: { family: 'inet', name: TABLE } }];
  for (const hook of ['input', 'output', 'forward']) nftables.push({ chain: {
    family: 'inet', table: TABLE, name: hook,
    type: 'filter', hook, prio: -15, policy: 'accept',
  } });
  const add = (chain, line) => nftables.push({ rule: { family: 'inet', table: TABLE,
    chain, ...ruleExpressions(line) } });
  if (role === 'controller') {
    for (const address of sorted) add('input', `iifname "${interfaceName}" ${protocol} saddr ${address} ${protocol} daddr ${path.controllerAddress} tcp dport ${path.controlPort} accept`);
    add('input', `iifname "${interfaceName}" drop`);
    for (const address of sorted) add('output', `oifname "${interfaceName}" ${protocol} saddr ${path.controllerAddress} ${protocol} daddr ${address} tcp sport ${path.controlPort} accept`);
    for (const address of sorted) add('output', `${protocol} daddr ${address} drop`);
  } else {
    add('input', `iifname "${interfaceName}" ${protocol} saddr ${path.controllerAddress} ${protocol} daddr ${path.cellAddress} tcp sport ${path.controlPort} accept`);
    add('input', `iifname "${interfaceName}" drop`);
    add('output', `oifname "${interfaceName}" ${protocol} saddr ${path.cellAddress} ${protocol} daddr ${path.controllerAddress} tcp dport ${path.controlPort} accept`);
    add('output', `${protocol} daddr ${path.controllerAddress} drop`);
  }
  add('output', `oifname "${interfaceName}" drop`);
  add('forward', `iifname "${interfaceName}" drop`);
  add('forward', `oifname "${interfaceName}" drop`);
  return normalizeNftSnapshot({ nftables }, TABLE);
}

module.exports = { permanentControlPolicySnapshot };
