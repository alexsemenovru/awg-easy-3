'use strict';

const zlib = require('node:zlib');

const { validateProfile } = require('./Awg3Config');

const AWG_CONTAINER = 'amnezia-awg';
const AWG_PROTOCOL = 'awg';

const requireString = (value, field) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
};

const optionalString = (value, field) => {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(String(value), field);
};

const normalizePort = (value) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('port must be an integer between 1 and 65535');
  }
  return port;
};

const profileToAmneziaFields = (input) => {
  const profile = validateProfile(input);
  const fields = {
    Jc: String(profile.jc),
    Jmin: String(profile.jmin),
    Jmax: String(profile.jmax),
    S1: String(profile.s1),
    S2: String(profile.s2),
    S3: String(profile.s3),
    S4: String(profile.s4),
    H1: profile.h1,
    H2: profile.h2,
    H3: profile.h3,
    H4: profile.h4,
    HeaderProtectionKey: profile.headerProtectionKey,
  };

  for (const key of ['i1', 'i2', 'i3', 'i4', 'i5']) {
    if (Object.prototype.hasOwnProperty.call(profile, key)) {
      fields[key.toUpperCase()] = profile[key];
    }
  }

  const names = {
    contentPaddingAddition: 'ContentPaddingAddition',
    rekeyAfterTime: 'RekeyAfterTime',
    rekeyTimeout: 'RekeyTimeout',
    rejectAfterTime: 'RejectAfterTime',
    keepaliveTimeout: 'KeepaliveTimeout',
    maxHandshakeAttempts: 'MaxHandshakeAttempts',
    randomTrailers: 'RandomTrailers',
    disableCookies: 'DisableCookies',
  };
  for (const [property, configName] of Object.entries(names)) {
    if (Object.prototype.hasOwnProperty.call(profile, property)) {
      fields[configName] = typeof profile[property] === 'boolean'
        ? (profile[property] ? 'on' : 'off')
        : profile[property];
    }
  }

  return fields;
};

const buildAmneziaPayload = ({
  description = 'AWG-Easy 3',
  hostName,
  port,
  dns = ['1.1.1.1', '8.8.8.8'],
  profile,
  client,
}) => {
  const normalizedHost = requireString(hostName, 'hostName');
  const normalizedPort = normalizePort(port);
  if (!Array.isArray(dns) || dns.length < 1 || dns.length > 2) {
    throw new TypeError('dns must contain one or two addresses');
  }
  const normalizedDns = dns.map((address, index) => requireString(address, `dns[${index}]`));

  if (!client || typeof client !== 'object' || Array.isArray(client)) {
    throw new TypeError('client must be an object');
  }
  if (!Array.isArray(client.allowedIps) || client.allowedIps.length === 0) {
    throw new TypeError('client.allowedIps must contain at least one route');
  }

  const lastConfig = {
    config: requireString(client.nativeConfig, 'client.nativeConfig'),
    hostName: normalizedHost,
    port: normalizedPort,
    client_ip: requireString(client.address, 'client.address'),
    client_priv_key: requireString(client.privateKey, 'client.privateKey'),
    client_pub_key: requireString(client.publicKey, 'client.publicKey'),
    server_pub_key: requireString(client.serverPublicKey, 'client.serverPublicKey'),
    // Amnezia's WireGuard configurator uses the peer public key as clientId.
    clientId: requireString(client.publicKey, 'client.publicKey'),
    allowed_ips: client.allowedIps.map((route, index) => requireString(route, `client.allowedIps[${index}]`)),
    persistent_keep_alive: String(client.persistentKeepalive ?? 25),
    mtu: String(client.mtu ?? 1280),
    ...profileToAmneziaFields(profile),
  };

  const psk = optionalString(client.presharedKey, 'client.presharedKey');
  if (psk) lastConfig.psk_key = psk;

  return {
    description: requireString(description, 'description'),
    hostName: normalizedHost,
    containers: [{
      container: AWG_CONTAINER,
      [AWG_PROTOCOL]: {
        isThirdPartyConfig: true,
        port: String(normalizedPort),
        transport_proto: 'udp',
        last_config: JSON.stringify(lastConfig),
      },
    }],
    defaultContainer: AWG_CONTAINER,
    dns1: normalizedDns[0],
    ...(normalizedDns[1] ? { dns2: normalizedDns[1] } : {}),
  };
};

// Qt's qCompress format is a four-byte big-endian uncompressed length followed
// by a zlib stream. AmneziaVPN decodes vpn:// payloads with qUncompress.
const qtCompress = (input, level = 8) => {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (source.length > 0xffffffff) throw new RangeError('Payload is too large for qCompress');
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(source.length);
  return Buffer.concat([size, zlib.deflateSync(source, { level })]);
};

const qtUncompress = (input) => {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (source.length < 5) throw new TypeError('Invalid qCompress payload');
  const expectedLength = source.readUInt32BE(0);
  const result = zlib.inflateSync(source.subarray(4));
  if (result.length !== expectedLength) throw new Error('qCompress length mismatch');
  return result;
};

const toBase64Url = (input) => Buffer.from(input)
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/g, '');

const fromBase64Url = (input) => {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new TypeError('Invalid base64url payload');
  }
  const padding = '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + padding, 'base64');
};

const encodeVpnLink = (payload) => {
  const json = Buffer.from(JSON.stringify(payload));
  return `vpn://${toBase64Url(qtCompress(json))}`;
};

const decodeVpnLink = (link) => {
  if (typeof link !== 'string' || !link.startsWith('vpn://')) {
    throw new TypeError('AmneziaVPN link must start with vpn://');
  }
  const json = qtUncompress(fromBase64Url(link.slice('vpn://'.length)));
  return JSON.parse(json.toString('utf8'));
};

const createVpnLink = (options) => encodeVpnLink(buildAmneziaPayload(options));

module.exports = {
  buildAmneziaPayload,
  createVpnLink,
  decodeVpnLink,
  encodeVpnLink,
  qtCompress,
  qtUncompress,
};
