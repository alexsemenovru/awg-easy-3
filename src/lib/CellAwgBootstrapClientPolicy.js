'use strict';

const net = require('node:net');
const { privateAddress } = require('./CellTunnelControlTransport');
const { ruleExpressions } = require('./CellNftPolicyJson');
const { normalizeNftSnapshot } = require('./CellNftOwnership');

const TABLE = 'awg_easy_3_bootstrap';

function bootstrapClientPolicySnapshot({ interfaceName, cellAddress,
  controllerAddress, registrationPort }) {
  if (typeof interfaceName !== 'string' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(interfaceName)
    || !privateAddress(cellAddress) || cellAddress.startsWith('127.') || cellAddress === '::1'
    || !privateAddress(controllerAddress) || controllerAddress.startsWith('127.')
    || controllerAddress === '::1' || cellAddress === controllerAddress
    || net.isIP(cellAddress) !== net.isIP(controllerAddress)
    || !Number.isSafeInteger(registrationPort) || registrationPort < 1
    || registrationPort > 65535) throw new TypeError('Invalid cell bootstrap policy');
  const protocol = net.isIP(cellAddress) === 4 ? 'ip' : 'ip6';
  const nftables = [{ table: { family: 'inet', name: TABLE } }];
  for (const hook of ['input', 'output', 'forward']) {
    nftables.push({ chain: { family: 'inet', table: TABLE, name: hook,
      type: 'filter', hook, prio: -15, policy: 'accept' } });
  }
  const add = (chain, line) => nftables.push({ rule: { family: 'inet', table: TABLE,
    chain, ...ruleExpressions(line) } });
  add('input', `iifname "${interfaceName}" ${protocol} saddr ${controllerAddress} ${protocol} daddr ${cellAddress} tcp sport ${registrationPort} accept`);
  add('output', `oifname "${interfaceName}" ${protocol} saddr ${cellAddress} ${protocol} daddr ${controllerAddress} tcp dport ${registrationPort} accept`);
  add('input', `iifname "${interfaceName}" drop`);
  add('output', `oifname "${interfaceName}" drop`);
  add('forward', `iifname "${interfaceName}" drop`);
  add('forward', `oifname "${interfaceName}" drop`);
  return normalizeNftSnapshot({ nftables }, TABLE);
}

module.exports = { bootstrapClientPolicySnapshot };
