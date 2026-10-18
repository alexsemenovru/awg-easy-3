'use strict';

const path = require('node:path');
const { AwgKeyManager } = require('./AwgKeyManager');
const { generateOfficialProfile } = require('./Awg3Config');
const { CellUserConfigStore } = require('./CellUserConfigStore');

function cellUserSubnet(descriptor) {
  const controller = descriptor?.controllerAddress?.split('.').map(Number);
  const cell = descriptor?.cellAddress?.split('.').map(Number);
  if (!controller || !cell || controller.length !== 4 || cell.length !== 4
    || controller.some(part => !Number.isInteger(part) || part < 0 || part > 255)
    || cell.some(part => !Number.isInteger(part) || part < 0 || part > 255)
    || controller[0] !== cell[0] || controller[1] !== cell[1]
    || controller[3] !== 1 || cell[2] < controller[2] || cell[2] > controller[2] + 3
    || cell[3] < 2 || cell[3] > 254) {
    throw new Error('Automatic Cell user subnet requires an allocated permanent IPv4 path');
  }
  const index = (cell[2] - controller[2]) * 253 + cell[3] - 2;
  const prefix = `10.${64 + Math.floor(index / 256)}.${index % 256}`;
  return Object.freeze({ address4: `${prefix}.1`, ipv4Subnet: `${prefix}.0/24` });
}

async function ensureCellUserBootstrap({ config, connection, wanInterface,
  newStore = (...args) => new CellUserConfigStore(...args),
  keyManager = new AwgKeyManager(), makeProfile = generateOfficialProfile } = {}) {
  if (!config || typeof config.stateDirectory !== 'string'
    || typeof wanInterface !== 'string' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(wanInterface)
    || !Array.isArray(config.resources?.interfaceNames)
    || config.resources.interfaceNames.includes(wanInterface)
    || connection?.status !== 'registered' || !connection.controllerPath) {
    throw new Error('Registered Cell, permanent path and WAN interface required');
  }
  const store = newStore(path.join(config.stateDirectory, 'user-config.json'), {
    interfaceName: config.resources.interfaceNames[2], listenPort: config.resources.udpPorts[0],
  });
  const existing = await store.read();
  if (existing) return { created: false };
  const key = await keyManager.generatePrivateKey();
  await store.create({ version: 1, server: {
    interfaceName: config.resources.interfaceNames[2],
    wanInterface, privateKey: key, listenPort: config.resources.udpPorts[0],
    ...cellUserSubnet(connection.controllerPath), profile: makeProfile(),
  } });
  return { created: true };
}

module.exports = { cellUserSubnet, ensureCellUserBootstrap };
