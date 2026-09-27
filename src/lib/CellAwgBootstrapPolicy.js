'use strict';

const net = require('node:net');
const { privateAddress } = require('./CellTunnelControlTransport');
const { ruleExpressions } = require('./CellNftPolicyJson');
const { normalizeNftSnapshot } = require('./CellNftOwnership');

const TABLE = 'awg_easy_3_bootstrap';

// This table limits only the dedicated AWG bootstrap interface. It does not
// open UFW or WAN ports. The installer must allow the inner TCP port on this
// exact interface when host firewall policy otherwise drops it.
function bootstrapPolicySnapshot({ interfaceName, controllerAddress, registrationPort, peers }) {
  if (typeof interfaceName !== 'string' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(interfaceName)
    || !privateAddress(controllerAddress) || controllerAddress.startsWith('127.')
    || controllerAddress === '::1' || !Number.isSafeInteger(registrationPort)
    || registrationPort < 1 || registrationPort > 65535
    || !Array.isArray(peers) || peers.length > 64
    || peers.some(peer => !peer || !['preparing', 'ready', 'closing', 'closed'].includes(peer.phase))) {
    throw new TypeError('Invalid bootstrap policy');
  }
  const family = net.isIP(controllerAddress), protocol = family === 4 ? 'ip' : 'ip6';
  const active = peers.filter(peer => ['preparing', 'ready'].includes(peer.phase));
  const addresses = new Set();
  for (const peer of active) {
    if (!peer || !privateAddress(peer.cellAddress) || peer.cellAddress.startsWith('127.')
      || peer.cellAddress === '::1' || net.isIP(peer.cellAddress) !== family
      || peer.cellAddress === controllerAddress || addresses.has(peer.cellAddress)) {
      throw new TypeError('Invalid bootstrap policy peer');
    }
    addresses.add(peer.cellAddress);
  }
  const nftables = [{ table: { family: 'inet', name: TABLE } }];
  for (const hook of ['input', 'output', 'forward']) {
    nftables.push({ chain: { family: 'inet', table: TABLE, name: hook,
      type: 'filter', hook, prio: -15, policy: 'accept' } });
  }
  const add = (chain, line) => nftables.push({ rule: { family: 'inet', table: TABLE,
    chain, ...ruleExpressions(line) } });
  for (const address of [...addresses].sort()) {
    add('input', `iifname "${interfaceName}" ${protocol} saddr ${address} ${protocol} daddr ${controllerAddress} tcp dport ${registrationPort} accept`);
    add('output', `oifname "${interfaceName}" ${protocol} saddr ${controllerAddress} ${protocol} daddr ${address} tcp sport ${registrationPort} accept`);
  }
  add('input', `iifname "${interfaceName}" drop`);
  add('output', `oifname "${interfaceName}" drop`);
  add('forward', `iifname "${interfaceName}" drop`);
  add('forward', `oifname "${interfaceName}" drop`);
  return normalizeNftSnapshot({ nftables }, TABLE);
}

module.exports = { bootstrapPolicySnapshot };
