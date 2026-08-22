'use strict';

const net = require('node:net');

const { runProcess } = require('./ProcessRunner');

const INTERFACE_PATTERN = /^[a-zA-Z0-9_.-]{1,15}$/;

const parseJson = (text, context) => {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${context} did not return valid JSON: ${error.message}`);
  }
  if (!Array.isArray(value)) throw new Error(`${context} must return a JSON array`);
  return value;
};

const validateInterface = (value) => {
  if (typeof value !== 'string' || !INTERFACE_PATTERN.test(value)) {
    throw new Error(`Invalid Linux interface reported by iproute2: ${value}`);
  }
  return value;
};

const routeMetric = (route) => Number.isFinite(Number(route.metric)) ? Number(route.metric) : 0;

const selectDefaultRoute = (routes, family) => {
  const candidates = routes
    .filter((route) => route && typeof route === 'object')
    .filter((route) => route.dst === 'default' || route.dst === (family === 4 ? '0.0.0.0/0' : '::/0'))
    .filter((route) => route.dev && (!route.type || route.type === 'unicast'))
    .sort((left, right) => routeMetric(left) - routeMetric(right));
  if (candidates.length === 0) return null;
  return Object.freeze({
    dev: validateInterface(candidates[0].dev),
    gateway: candidates[0].gateway,
    metric: routeMetric(candidates[0]),
  });
};

const usableAddresses = (links, family) => {
  const expected = family === 4 ? 'inet' : 'inet6';
  return links.flatMap((link) => Array.isArray(link.addr_info) ? link.addr_info : [])
    .filter((address) => address.family === expected && address.scope === 'global')
    .filter((address) => net.isIP(address.local) === family)
    .filter((address) => {
      const flags = new Set(Array.isArray(address.flags) ? address.flags.map((flag) => String(flag).toLowerCase()) : []);
      return !flags.has('tentative') && !flags.has('dadfailed') && !flags.has('deprecated');
    })
    .map((address) => Object.freeze({
      address: address.local,
      prefixLength: Number(address.prefixlen),
    }));
};

class NetworkDetector {
  constructor({ binary = 'ip', runner = runProcess } = {}) {
    if (typeof runner !== 'function') throw new TypeError('runner must be a function');
    if (typeof binary !== 'string' || binary.length === 0 || /[\0\r\n]/.test(binary)) {
      throw new TypeError('binary must be a non-empty single-line string');
    }
    this.binary = binary;
    this.runner = runner;
  }

  async json(args, context) {
    const { stdout } = await this.runner(this.binary, ['-j', ...args]);
    return parseJson(stdout, context);
  }

  async detect() {
    const routes4 = await this.json(['-4', 'route', 'show', 'default'], 'IPv4 route detection');
    const default4 = selectDefaultRoute(routes4, 4);
    if (!default4) throw new Error('No usable IPv4 default route was found');

    const links4 = await this.json(['-4', 'addr', 'show', 'dev', default4.dev], 'IPv4 address detection');
    const ipv4Addresses = usableAddresses(links4, 4);
    if (ipv4Addresses.length === 0) throw new Error(`No global IPv4 address was found on ${default4.dev}`);

    const routes6 = await this.json(['-6', 'route', 'show', 'default'], 'IPv6 route detection');
    const default6 = selectDefaultRoute(routes6, 6);
    let ipv6Addresses = [];
    if (default6 && default6.dev === default4.dev) {
      const links6 = await this.json(['-6', 'addr', 'show', 'dev', default4.dev], 'IPv6 address detection');
      ipv6Addresses = usableAddresses(links6, 6);
    }

    return Object.freeze({
      wanInterface: default4.dev,
      endpointCandidate: ipv4Addresses[0].address,
      ipv4Addresses: Object.freeze(ipv4Addresses),
      ipv6: Object.freeze({
        available: Boolean(default6 && default6.dev === default4.dev && ipv6Addresses.length > 0),
        addresses: Object.freeze(ipv6Addresses),
        defaultRoute: default6,
      }),
    });
  }
}

module.exports = {
  NetworkDetector,
  parseJson,
  selectDefaultRoute,
  usableAddresses,
};
