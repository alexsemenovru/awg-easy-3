'use strict';

const net = require('node:net');

const { renderInterfaceFields, renderPeerSecurity } = require('./Awg3Config');
const { renderDnsLine } = require('./DnsPolicy');

const lineValue = (value, field) => {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/.test(value)) {
    throw new TypeError(`${field} must be a non-empty single-line string`);
  }
  return value;
};

const portValue = (value, field) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError(`${field} must be an integer between 1 and 65535`);
  }
  return parsed;
};

const cidrValue = (value, field) => {
  const normalized = lineValue(value, field);
  const separator = normalized.lastIndexOf('/');
  if (separator < 1) throw new TypeError(`${field} must be an IP CIDR`);
  const address = normalized.slice(0, separator);
  const prefix = Number(normalized.slice(separator + 1));
  const family = net.isIP(address);
  const maxPrefix = family === 4 ? 32 : 128;
  if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new TypeError(`${field} must be an IP CIDR`);
  }
  return normalized;
};

const cidrList = (value, field) => {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a non-empty array`);
  return value.map((cidr, index) => cidrValue(cidr, `${field}[${index}]`));
};

const formatEndpoint = (host, port) => {
  const normalizedHost = lineValue(host, 'endpointHost');
  const ipFamily = net.isIP(normalizedHost);
  if (!ipFamily && !/^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/.test(normalizedHost)) {
    throw new TypeError('endpointHost must be an IPv4, IPv6 or DNS name');
  }
  return `${ipFamily === 6 ? `[${normalizedHost}]` : normalizedHost}:${portValue(port, 'endpointPort')}`;
};

const renderServerPeer = (peer, index) => {
  if (!peer || typeof peer !== 'object') throw new TypeError(`peers[${index}] must be an object`);
  const lines = [
    `[Peer]`,
    `# ${lineValue(peer.name || `peer-${index + 1}`, `peers[${index}].name`)}`,
    `PublicKey = ${lineValue(peer.publicKey, `peers[${index}].publicKey`)}`,
  ];
  if (peer.presharedKey) lines.push(`PresharedKey = ${lineValue(peer.presharedKey, `peers[${index}].presharedKey`)}`);
  lines.push(renderPeerSecurity({ advancedSecurity: true }));
  lines.push(`AllowedIPs = ${cidrList(peer.allowedIps, `peers[${index}].allowedIps`).join(', ')}`);
  return lines.join('\n');
};

const renderServerConfig = ({ privateKey, addresses, listenPort, profile, peers = [] }) => {
  if (!Array.isArray(peers)) throw new TypeError('peers must be an array');
  const sections = [
    [
      '[Interface]',
      `PrivateKey = ${lineValue(privateKey, 'privateKey')}`,
      `Address = ${cidrList(addresses, 'addresses').join(', ')}`,
      `ListenPort = ${portValue(listenPort, 'listenPort')}`,
      renderInterfaceFields(profile),
    ].join('\n'),
    ...peers.map(renderServerPeer),
  ];
  return `${sections.join('\n\n')}\n`;
};

const renderClientConfig = ({
  privateKey,
  addresses,
  dnsPolicy,
  mtu = 1280,
  profile,
  serverPublicKey,
  presharedKey,
  allowedIps,
  persistentKeepalive = '25-35',
  endpointHost,
  endpointPort,
}) => {
  const normalizedMtu = Number(mtu);
  if (!Number.isInteger(normalizedMtu) || normalizedMtu < 576 || normalizedMtu > 9_000) {
    throw new TypeError('mtu must be an integer between 576 and 9000');
  }
  const keepalive = String(persistentKeepalive);
  if (!/^\d+(?:-\d+)?$/.test(keepalive)) {
    throw new TypeError('persistentKeepalive must be an integer or range');
  }

  const lines = [
    '[Interface]',
    `PrivateKey = ${lineValue(privateKey, 'privateKey')}`,
    `Address = ${cidrList(addresses, 'addresses').join(', ')}`,
    renderDnsLine(dnsPolicy),
    `MTU = ${normalizedMtu}`,
    renderInterfaceFields(profile),
    '',
    '[Peer]',
    `PublicKey = ${lineValue(serverPublicKey, 'serverPublicKey')}`,
  ];
  if (presharedKey) lines.push(`PresharedKey = ${lineValue(presharedKey, 'presharedKey')}`);
  lines.push(renderPeerSecurity({ advancedSecurity: true }));
  lines.push(`AllowedIPs = ${cidrList(allowedIps, 'allowedIps').join(', ')}`);
  lines.push(`PersistentKeepalive = ${keepalive}`);
  lines.push(`Endpoint = ${formatEndpoint(endpointHost, endpointPort)}`);
  return `${lines.join('\n')}\n`;
};

module.exports = {
  renderClientConfig,
  renderServerConfig,
};

