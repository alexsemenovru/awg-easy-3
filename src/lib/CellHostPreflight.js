'use strict';

const { runProcess } = require('./ProcessRunner');

const interfaceName = value => typeof value === 'string'
  && /^[a-zA-Z0-9_.-]{1,15}$/.test(value);
const port = value => Number.isSafeInteger(value) && value >= 1 && value <= 65535;
const tableName = value => typeof value === 'string'
  && /^awg_easy_3(?:_[a-z0-9_]+)?$/.test(value);

function distinct(values, check, label) {
  if (!Array.isArray(values) || values.length === 0
    || values.some(value => !check(value)) || new Set(values).size !== values.length) {
    throw new TypeError(`Invalid ${label} reservation`);
  }
  return values;
}

// New installation only. Recovery of an existing installation must use its
// ownership journals, not infer ownership from a free-resource scan.
async function assertFreeCellHostResources({ interfaceNames, udpPorts, tcpPorts, nftTables,
  runner = runProcess }) {
  const interfaces = distinct(interfaceNames, interfaceName, 'interface');
  const ports = distinct(udpPorts, port, 'UDP port');
  const tcp = tcpPorts === undefined ? [] : distinct(tcpPorts, port, 'TCP port');
  const tables = distinct(nftTables, tableName, 'nft table');
  if (typeof runner !== 'function') throw new TypeError('Host runner required');

  const [linksResult, socketsResult, tcpResult, tablesResult] = await Promise.all([
    runner('ip', ['-j', 'link', 'show']),
    runner('ss', ['-H', '-u', '-l', '-n']),
    ...(tcp.length ? [runner('ss', ['-H', '-t', '-l', '-n'])] : [Promise.resolve(null)]),
    runner('nft', ['-j', 'list', 'tables']),
  ]);
  const links = JSON.parse(linksResult.stdout);
  if (!Array.isArray(links) || links.some(item => !item || !interfaceName(item.ifname))) {
    throw new Error('Invalid host interface inventory');
  }
  const existingInterfaces = new Set(links.map(item => item.ifname));
  for (const name of interfaces) {
    if (existingInterfaces.has(name)) throw new Error(`Host interface already exists: ${name}`);
  }

  if (typeof socketsResult.stdout !== 'string') throw new Error('Invalid UDP socket inventory');
  const listeningPorts = new Set();
  for (const line of socketsResult.stdout.split(/\r?\n/).filter(Boolean)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || !['UNCONN', 'ESTAB'].includes(columns[0])) {
      throw new Error('Unrecognized UDP socket inventory');
    }
    const match = columns[3].match(/:(\d+)$/);
    if (!match) throw new Error('Unrecognized UDP socket address');
    listeningPorts.add(Number(match[1]));
  }
  for (const value of ports) {
    if (listeningPorts.has(value)) throw new Error(`Host UDP port already in use: ${value}`);
  }

  if (tcpResult) {
    if (typeof tcpResult.stdout !== 'string') throw new Error('Invalid TCP socket inventory');
    const listeningTcp = new Set();
    for (const line of tcpResult.stdout.split(/\r?\n/).filter(Boolean)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5 || columns[0] !== 'LISTEN') {
        throw new Error('Unrecognized TCP socket inventory');
      }
      const match = columns[3].match(/:(\d+)$/);
      if (!match) throw new Error('Unrecognized TCP socket address');
      listeningTcp.add(Number(match[1]));
    }
    for (const value of tcp) {
      if (listeningTcp.has(value)) throw new Error(`Host TCP port already in use: ${value}`);
    }
  }

  const inventory = JSON.parse(tablesResult.stdout);
  if (!inventory || !Array.isArray(inventory.nftables)) throw new Error('Invalid nft table inventory');
  const existingTables = new Set();
  for (const item of inventory.nftables) {
    if (!item || typeof item !== 'object' || Object.keys(item).length !== 1
      || !item.table && !item.metainfo) throw new Error('Invalid nft table inventory');
    if (item.table?.family === 'inet') existingTables.add(item.table.name);
  }
  for (const name of tables) {
    if (existingTables.has(name)) throw new Error(`Host nft table already exists: ${name}`);
  }
  return { free: true };
}

module.exports = { assertFreeCellHostResources };
