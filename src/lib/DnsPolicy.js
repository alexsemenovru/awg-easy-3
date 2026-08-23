'use strict';

const net = require('node:net');

const DEFAULT_DNS = Object.freeze({
  ipv4: Object.freeze(['94.140.14.14', '94.140.15.15']),
  ipv6: Object.freeze(['2a10:50c0::ad1:ff', '2a10:50c0::ad2:ff']),
});

const validateAddresses = (addresses, family, field) => {
  if (!Array.isArray(addresses) || addresses.length !== 2) {
    throw new TypeError(`${field} must contain exactly two addresses`);
  }
  for (const address of addresses) {
    if (net.isIP(address) !== family) {
      throw new TypeError(`${field} contains an invalid IPv${family} address: ${address}`);
    }
  }
  return [...addresses];
};

const buildDnsPolicy = ({
  serverHasIPv6 = false,
  ipv4 = DEFAULT_DNS.ipv4,
  ipv6 = DEFAULT_DNS.ipv6,
} = {}) => {
  const ipv4Servers = validateAddresses(ipv4, 4, 'ipv4 DNS');
  const ipv6Servers = validateAddresses(ipv6, 6, 'ipv6 DNS');

  return Object.freeze({
    servers: Object.freeze([
      ...ipv4Servers,
      ...(serverHasIPv6 ? ipv6Servers : []),
    ]),
    // AmneziaVPN's top-level dns1/dns2 model expects an IPv4 pair. The
    // complete dual-stack list is also rendered into the native config.
    amneziaDns: Object.freeze(ipv4Servers),
  });
};

const renderDnsLine = (policy) => {
  if (!policy || !Array.isArray(policy.servers) || policy.servers.length === 0) {
    throw new TypeError('A non-empty DNS policy is required');
  }
  return `DNS = ${policy.servers.join(', ')}`;
};

module.exports = {
  DEFAULT_DNS,
  buildDnsPolicy,
  renderDnsLine,
};
