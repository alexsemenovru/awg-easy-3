'use strict';
const { isHomeGroup } = require('./NetworkGroups');

const { createVpnLink } = require('./AmneziaVpnLink');
const { renderClientConfig, renderServerConfig } = require('./AwgConfigRenderer');
const { buildClientRoutes } = require('./ClientRoutes');
const { buildDnsPolicy } = require('./DnsPolicy');
const { renderNftablesPolicy } = require('./NftablesPolicy');
const { clientTraffic } = require('./ClientTraffic');
const { validateCellUserDescriptor } = require('./CellUserDescriptor');
const { addressInSubnet } = require('./AddressAllocator');

const peerAddresses = (client, serverHasIPv6) => [
  `${client.address4}/32`,
  ...(serverHasIPv6 && client.address6 ? [`${client.address6}/128`] : []),
];

const buildAwgArtifacts = ({ server, clients, geoDatabase = {}, entryDescriptors = {} }) => {
  if (!server || typeof server !== 'object' || Array.isArray(server)) {
    throw new TypeError('server must be an object');
  }
  if (!Array.isArray(clients) || clients.length === 0) {
    throw new TypeError('clients must be a non-empty array');
  }

  const enabledClients = clients.filter((client) => !client.entryCellId && clientTraffic(client).enabled);
  const activeHomes = enabledClients.filter((client) => isHomeGroup(client.networkGroup));
  if (activeHomes.length === 0) throw new Error('At least one enabled home client is required');

  const serverHasIPv6 = Boolean(server.ipv6Subnet && server.address6);
  const serverAddresses = [
    `${server.address4}/${server.ipv4Prefix ?? 24}`,
    ...(serverHasIPv6 ? [`${server.address6}/${server.ipv6Prefix ?? 64}`] : []),
  ];

  const serverConfig = renderServerConfig({
    privateKey: server.privateKey,
    addresses: serverAddresses,
    listenPort: server.listenPort,
    profile: server.profile,
    peers: enabledClients.map((client) => ({
      name: client.name,
      publicKey: client.publicKey,
      presharedKey: client.presharedKey,
      allowedIps: peerAddresses(client, serverHasIPv6),
    })),
  });

  const nftables = renderNftablesPolicy({
    geoDatabase,
    geoClients: enabledClients.map(client => ({
      policy: client.geoPolicy,
      address4: clientTraffic(client).ipv4Enabled ? client.address4 : undefined,
      address6: serverHasIPv6 && clientTraffic(client).ipv6Enabled ? client.address6 : undefined,
    })),
    interfaceName: server.interfaceName ?? 'awg0',
    wanInterface: server.wanInterface ?? 'eth0',
    ipv4Subnet: server.ipv4Subnet,
    ...(serverHasIPv6 ? { ipv6Subnet: server.ipv6Subnet } : {}),
    nat66: serverHasIPv6 && server.ipv6Mode === 'nat66',
    panelPort: server.panelPort ?? 51821,
    home4: activeHomes.filter((client) => client.networkGroup === 'home'
      && clientTraffic(client).ipv4Enabled).map((client) => client.address4),
    homeGroups4: Object.fromEntries(Array.from({ length: 9 }, (_, index) => {
      const group = `home${index + 2}`;
      return [group, activeHomes.filter(client => client.networkGroup === group
        && clientTraffic(client).ipv4Enabled).map(client => client.address4)];
    })),
    guest4: enabledClients.filter((client) => client.networkGroup === 'guest' && clientTraffic(client).ipv4Enabled)
      .map((client) => client.address4),
    home6: serverHasIPv6 ? activeHomes.filter((client) => client.networkGroup === 'home'
      && clientTraffic(client).ipv6Enabled)
      .map((client) => client.address6).filter(Boolean) : [],
    homeGroups6: Object.fromEntries(Array.from({ length: 9 }, (_, index) => {
      const group = `home${index + 2}`;
      return [group, serverHasIPv6 ? activeHomes.filter(client => client.networkGroup === group
        && clientTraffic(client).ipv6Enabled).map(client => client.address6).filter(Boolean) : []];
    })),
    guest6: serverHasIPv6
      ? enabledClients.filter((client) => client.networkGroup === 'guest' && clientTraffic(client).ipv6Enabled)
        .map((client) => client.address6).filter(Boolean)
      : [],
  });

  const clientArtifacts = Object.fromEntries(clients.filter(client => !client.entryCellId
    || entryDescriptors[client.entryCellId] || client.enabled).map((client) => {
    const entry = client.entryCellId
      ? validateCellUserDescriptor(entryDescriptors[client.entryCellId]) : null;
    if (entry && (!addressInSubnet(client.address4, entry.ipv4Subnet)
      || client.address4 === entry.address4
      || client.address6 && (!entry.address6
        || !addressInSubnet(client.address6, entry.ipv6Subnet)
        || client.address6 === entry.address6))) {
      throw new TypeError('Client address does not belong to its Cell entry');
    }
    const target = entry || { endpointHost: server.endpointHost,
      endpointPort: server.endpointPort ?? server.listenPort,
      serverPublicKey: server.publicKey, profile: server.profile };
    const entryHasIPv6 = entry ? Boolean(entry.address6) : serverHasIPv6;
    const routes = buildClientRoutes({ serverHasIPv6: entryHasIPv6 });
    const dnsPolicy = buildDnsPolicy({ serverHasIPv6: entryHasIPv6 });
    const addresses = peerAddresses(client, entryHasIPv6);
    const nativeConfig = renderClientConfig({
      privateKey: client.privateKey,
      addresses,
      dnsPolicy,
      mtu: client.mtu ?? 1280,
      profile: target.profile,
      serverPublicKey: target.serverPublicKey,
      presharedKey: client.presharedKey,
      allowedIps: routes.allowedIps,
      persistentKeepalive: client.persistentKeepalive ?? '25-35',
      endpointHost: target.endpointHost,
      endpointPort: target.endpointPort,
    });
    const vpnLink = createVpnLink({
      description: client.name,
      hostName: target.endpointHost,
      port: target.endpointPort,
      dns: dnsPolicy.amneziaDns,
      profile: target.profile,
      client: {
        addresses,
        privateKey: client.privateKey,
        publicKey: client.publicKey,
        serverPublicKey: target.serverPublicKey,
        presharedKey: client.presharedKey,
        allowedIps: routes.allowedIps,
        persistentKeepalive: client.persistentKeepalive ?? '25-35',
        mtu: client.mtu ?? 1280,
        nativeConfig,
      },
    });

    return [client.id, Object.freeze({ dnsPolicy, nativeConfig, routes, vpnLink })];
  }));

  return Object.freeze({
    clientArtifacts: Object.freeze(clientArtifacts),
    nftables,
    serverConfig,
    serverHasIPv6,
  });
};

module.exports = {
  buildAwgArtifacts,
};
