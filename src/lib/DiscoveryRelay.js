'use strict';

const dgram = require('node:dgram');
const { clientTraffic } = require('./ClientTraffic');
const { isHomeGroup } = require('./NetworkGroups');

const SERVICES = Object.freeze([
  Object.freeze({ name: 'mdns4', family: 'udp4', group: '224.0.0.251', port: 5353 }),
  Object.freeze({ name: 'ssdp4', family: 'udp4', group: '239.255.255.250', port: 1900 }),
]);

// A legacy installation may use one of these ports for its AWG transport.
// In that case don't start the conflicting discovery service or filter AWG.
const discoveryServices = (listenPort) => SERVICES.filter((service) => service.port !== listenPort);

const normalizedAddress = (value) => String(value).toLowerCase().replace(/^::ffff:/, '');

const rewriteSsdpLocation = (message, sourceAddress) => {
  const marker = message.indexOf('\r\n\r\n');
  const headerEnd = marker === -1 ? message.length : marker;
  const header = message.subarray(0, headerEnd).toString('utf8');
  const rewritten = header.replace(
    /^(LOCATION|AL):(\s*https?:\/\/)(\[[^\]]+\]|[^\s/:]+)(:\d+)?/gim,
    (_match, name, scheme, _host, port = '') => `${name}:${scheme}${sourceAddress}${port}`,
  );
  if (rewritten === header) return message;
  return Buffer.concat([Buffer.from(rewritten, 'utf8'), message.subarray(headerEnd)]);
};

class DiscoveryRelay {
  constructor({ socketFactory = dgram.createSocket, clock = () => Date.now(), requesterTtlMs = 15_000 } = {}) {
    if (typeof socketFactory !== 'function' || typeof clock !== 'function') {
      throw new TypeError('socketFactory and clock must be functions');
    }
    this.socketFactory = socketFactory;
    this.clock = clock;
    this.requesterTtlMs = requesterTtlMs;
    this.home4 = new Set();
    this.home6 = new Set();
    this.groups4 = new Map();
    this.groups6 = new Map();
    this.sockets = [];
    this.requesters = new Map();
  }

  refresh(state) {
    const homes = state.clients.filter((client) => clientTraffic(client).enabled
      && isHomeGroup(client.networkGroup));
    this.home4 = new Set(homes.filter((client) => clientTraffic(client).ipv4Enabled)
      .map((client) => normalizedAddress(client.address4)));
    this.home6 = new Set(homes.filter((client) => clientTraffic(client).ipv6Enabled)
      .map((client) => client.address6).filter(Boolean).map(normalizedAddress));
    this.groups4 = new Map(homes.filter(client => clientTraffic(client).ipv4Enabled)
      .map(client => [normalizedAddress(client.address4), client.networkGroup]));
    this.groups6 = new Map(homes.filter(client => clientTraffic(client).ipv6Enabled && client.address6)
      .map(client => [normalizedAddress(client.address6), client.networkGroup]));
    // Expire pending unicast replies immediately when permissions are revoked.
    for (const service of SERVICES) {
      this.requesters.set(service.name, (this.requesters.get(service.name) ?? [])
        .filter((item) => this.homes(service).has(item.address)
          && this.groups(service).get(item.address) === item.group));
    }
  }

  homes(service) {
    return service.family === 'udp4' ? this.home4 : this.home6;
  }

  groups(service) {
    return service.family === 'udp4' ? this.groups4 : this.groups6;
  }

  targets(service, rinfo) {
    const source = normalizedAddress(rinfo.address);
    const homes = this.homes(service);
    if (!homes.has(source)) return [];
    const group = this.groups(service).get(source);
    const now = this.clock();
    const key = service.name;
    const requesters = (this.requesters.get(key) ?? []).filter((item) => item.expires > now
      && homes.has(item.address) && this.groups(service).get(item.address) === item.group);
    if (rinfo.port !== service.port) {
      requesters.push({ address: source, group, port: rinfo.port,
        expires: now + this.requesterTtlMs });
    }
    this.requesters.set(key, requesters.slice(-128));

    const targets = [...homes]
      .filter((address) => address !== source && this.groups(service).get(address) === group)
      .map((address) => ({ address, port: service.port }));
    if (rinfo.port === service.port) {
      targets.push(...requesters.filter((item) => item.address !== source && item.group === group)
        .map((item) => ({ address: item.address, port: item.port })));
    }
    return [...new Map(targets.map((target) => [`${target.address}:${target.port}`, target])).values()];
  }

  newSocket(service, onMessage) {
    const socket = this.socketFactory({ type: service.family, reuseAddr: true });
    this.sockets.push(socket);
    socket.on('message', onMessage);
    return socket;
  }

  async bind(socket, port, address) {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, address, () => {
        socket.off('error', reject);
        resolve();
      });
    });
  }

  async startService(service, address4) {
    const onMessage = (message, rinfo) => {
      if (message.length > 65_507) return;
      const payload = service.name === 'ssdp4'
        ? rewriteSsdpLocation(message, normalizedAddress(rinfo.address))
        : message;
      for (const target of this.targets(service, rinfo)) {
        unicast.send(payload, target.port, target.address, () => {});
      }
    };
    // A unicast bind cannot receive multicast on Linux. Receive each on its
    // own destination and always send from the VPN address.
    const unicast = this.newSocket(service, onMessage);
    await this.bind(unicast, service.port, address4);
    const multicast = this.newSocket(service, onMessage);
    await this.bind(multicast, service.port, service.group);
    multicast.addMembership(service.group, address4);
  }

  async start(state) {
    this.refresh(state);
    try {
      for (const service of discoveryServices(state.server.listenPort)) {
        await this.startService(service, state.server.address4);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    const sockets = this.sockets.splice(0);
    await Promise.all(sockets.map((socket) => new Promise((resolve) => {
      try {
        socket.close(resolve);
      } catch {
        resolve();
      }
    })));
    this.requesters.clear();
  }
}

module.exports = { DiscoveryRelay, SERVICES, discoveryServices, normalizedAddress, rewriteSsdpLocation };
