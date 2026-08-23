'use strict';

const dgram = require('node:dgram');

const SERVICES = Object.freeze([
  Object.freeze({ name: 'mdns4', family: 'udp4', group: '224.0.0.251', port: 5353 }),
  Object.freeze({ name: 'ssdp4', family: 'udp4', group: '239.255.255.250', port: 1900 }),
  Object.freeze({ name: 'mdns6', family: 'udp6', group: 'ff02::fb', port: 5353 }),
  Object.freeze({ name: 'ssdp6', family: 'udp6', group: 'ff02::c', port: 1900 }),
]);

const normalizedAddress = (value) => String(value).toLowerCase().replace(/^::ffff:/, '');

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
    this.sockets = [];
    this.requesters = new Map();
  }

  refresh(state) {
    const homes = state.clients.filter((client) => client.enabled && client.networkGroup === 'home');
    this.home4 = new Set(homes.map((client) => normalizedAddress(client.address4)));
    this.home6 = new Set(homes.map((client) => client.address6).filter(Boolean).map(normalizedAddress));
  }

  homes(service) {
    return service.family === 'udp4' ? this.home4 : this.home6;
  }

  targets(service, rinfo) {
    const source = normalizedAddress(rinfo.address);
    const homes = this.homes(service);
    if (!homes.has(source)) return [];
    const now = this.clock();
    const key = service.name;
    const requesters = (this.requesters.get(key) ?? []).filter((item) => item.expires > now);
    if (rinfo.port !== service.port) {
      requesters.push({ address: source, port: rinfo.port, expires: now + this.requesterTtlMs });
    }
    this.requesters.set(key, requesters.slice(-128));

    const targets = [...homes]
      .filter((address) => address !== source)
      .map((address) => ({ address, port: service.port }));
    if (rinfo.port === service.port) {
      targets.push(...requesters.filter((item) => item.address !== source)
        .map((item) => ({ address: item.address, port: item.port })));
    }
    return [...new Map(targets.map((target) => [`${target.address}:${target.port}`, target])).values()];
  }

  async startService(service, interfaceValue) {
    const socket = this.socketFactory({ type: service.family, reuseAddr: true });
    socket.on('message', (message, rinfo) => {
      if (message.length > 65_507) return;
      for (const target of this.targets(service, rinfo)) {
        socket.send(message, target.port, target.address, () => {});
      }
    });
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(service.port, service.family === 'udp4' ? '0.0.0.0' : '::', () => {
        socket.off('error', reject);
        try {
          socket.addMembership(service.group, interfaceValue);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    this.sockets.push(socket);
  }

  async start(state) {
    this.refresh(state);
    const services = SERVICES.filter((service) => service.family === 'udp4' || state.server.address6);
    try {
      for (const service of services) {
        const interfaceValue = service.family === 'udp4' ? state.server.address4 : state.server.interfaceName;
        await this.startService(service, interfaceValue);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    const sockets = this.sockets.splice(0);
    await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve))));
    this.requesters.clear();
  }
}

module.exports = { DiscoveryRelay, SERVICES, normalizedAddress };
