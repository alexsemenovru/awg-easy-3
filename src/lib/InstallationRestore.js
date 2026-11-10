'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { BackupJournal, privateDirectory, syncDirectory } = require('./BackupJournal');
const { readSnapshotFile } = require('./BackupSnapshot');
const { validateState } = require('./StateStore');
const { prepareConfigurationRestore, inspectPreparedRestore } = require('./ConfigurationRestore');
const { assertFreeCellHostResources } = require('./CellHostPreflight');
const { addressInSubnet } = require('./AddressAllocator');
const { runProcess } = require('./ProcessRunner');
const { constants } = require('node:fs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const phases = ['prepared', 'switching', 'committed', 'starting', 'complete', 'rolling-back', 'rolled-back'];
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
async function info(file) { try { return await fs.lstat(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
const inode = value => ({ dev: String(value.dev), ino: String(value.ino) });
const matches = (stat, expected) => stat && !stat.isSymbolicLink() && String(stat.dev) === expected.dev && String(stat.ino) === expected.ino;
function validateJournal(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'id,main,moves,next,phase,targetHash,version'
    || value.version !== 1 || !uuid(value.id) || typeof value.main !== 'boolean' || !phases.includes(value.phase)
    || !/^[a-f0-9]{64}$/.test(value.targetHash) || !Number.isSafeInteger(value.next) || value.next < 0
    || !Array.isArray(value.moves) || value.moves.length !== (value.main ? 4 : 2) || value.next > value.moves.length) throw new Error('Invalid installation restore journal');
  const expected = [['data', `${value.id}/previous/data`], [`${value.id}/incoming/data`, 'data'],
    ...(value.main ? [[`${value.id}/incoming/cell-data`, 'cell-data'], [`${value.id}/incoming/main.env`, '.env.cells-main']] : [])];
  for (const [index, move] of value.moves.entries()) {
    if (!move || Object.keys(move).sort().join(',') !== 'dev,from,ino,to'
      || move.from !== expected[index][0] || move.to !== expected[index][1]
      || ![move.dev, move.ino].every(item => typeof item === 'string' && /^\d{1,30}$/.test(item))) throw new Error('Invalid restore rename intent');
  }
  return structuredClone(value);
}
async function writePrivate(file, bytes) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function copyPrivateTree(source, destination, budget = { count: 0, bytes: 0 }) {
  await privateDirectory(source);
  await fs.mkdir(destination, { mode: 0o700 });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (++budget.count > 4096 || entry.isSymbolicLink()) throw new Error('Unsafe restore workspace inventory');
    const a = path.join(source, entry.name), b = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyPrivateTree(a, b, budget);
    else if (entry.isFile()) {
      const bytes = await readSnapshotFile(source, entry.name);
      budget.bytes += bytes.length;
      if (budget.bytes > 16 * 1024 * 1024) throw new Error('Restore workspace is too large');
      await writePrivate(b, bytes);
    } else throw new Error('Unexpected restore workspace file');
  }
  await syncDirectory(destination);
}
async function payloadInventory(root, prefix = '') {
  const records = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) records.push(...await payloadInventory(path.join(root, entry.name), `${prefix}${entry.name}/`));
    else if (entry.isFile()) records.push({ name: `${prefix}${entry.name}`, hash: hash(await readSnapshotFile(root, entry.name)) });
    else throw new Error('Unexpected restore payload entry');
    if (records.length > 4096) throw new Error('Restore payload inventory too large');
  }
  return records;
}
// This transaction restores onto an initialized, standalone destination. It
// refuses to replace a different live Main/Cell network. Old destination data
// is retained intact in previous/data, never published as a new backup grant.
async function openInstallationRestore(projectDirectory, { runner = runProcess,
  preflight = options => assertFreeCellHostResources({ ...options, runner }), rename = fs.rename } = {}) {
  if (!path.isAbsolute(projectDirectory)) throw new Error('Absolute installation path required');
  const rootStat = await info(projectDirectory);
  // The installation checkout can belong to the administrator who cloned it;
  // sudo-created state and transaction directories remain private to root.
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || process.platform !== 'win32'
    && rootStat.mode & 0o022n) throw new Error('Unsafe destination installation');
  const root = path.join(projectDirectory, '.restore');
  await fs.mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await privateDirectory(root);
  const journal = new BackupJournal(path.join(root, 'transaction.json'), validateJournal);
  const location = relative => /^(?:data|cell-data|\.env\.cells-main)$/.test(relative)
    ? path.join(projectDirectory, relative) : path.join(root, relative);
  const status = async () => {
    const state = await journal.read();
    return state ? { phase: state.phase, main: state.main, id: state.id } : { phase: 'none', main: false };
  };
  const move = async ({ from, to, ...identity }) => {
    const source = location(from), destination = location(to);
    const a = await info(source), b = await info(destination);
    // A later rename may have filled the old source path with the new data.
    if (matches(b, identity)) return;
    if (!matches(a, identity) || b) throw new Error('Restore paths changed outside the transaction');
    if ((await fs.stat(path.dirname(destination), { bigint: true })).dev !== a.dev) throw new Error('Restore requires one filesystem');
    await rename(source, destination);
    await syncDirectory(path.dirname(source)); await syncDirectory(path.dirname(destination));
  };
  async function hostBindings(prepared, state, image) {
    const summary = await inspectPreparedRestore(prepared);
    if (!summary.main) return null;
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Pinned destination image ID required');
    const names = new Set([state.server.interfaceName, state.server.wanInterface]);
    const udp = new Set([state.server.listenPort]);
    const tcp = new Set([state.server.panelPort]);
    const subnets = [state.server.ipv4Subnet];
    const marker = JSON.parse(await fs.readFile(path.join(prepared, 'restore-prepared.json')));
    for (const item of marker.files.filter(item => item.area === 'main' && /(?:^permanent|^data-links)\/.*plan\.json$/.test(item.name))) {
      const plan = JSON.parse(await readSnapshotFile(path.join(prepared, 'main'), item.name));
      names.add(plan.spec.owner.interfaceName);
      const port = Number(plan.spec.owner.config.match(/^ListenPort\s*=\s*(\d+)/m)?.[1]);
      if (port) udp.add(port);
      subnets.push(...plan.spec.addresses.filter(address => address.includes('.')));
    }
    const rows = JSON.parse((await runner('ip', ['-j', '-4', 'route', 'show', 'table', 'all'])).stdout);
    if (!Array.isArray(rows)) throw new Error('Host routes unavailable');
    subnets.push(...rows.map(row => row.dst).filter(dst => typeof dst === 'string' && dst.includes('/') && dst !== '0.0.0.0/0'));
    const address = excluded => {
      for (let octet = 90; octet < 250; octet++) {
        const candidate = `10.${octet}.8.1`;
        if (candidate !== excluded && !subnets.some(subnet => addressInSubnet(candidate, subnet))) return candidate;
      }
      throw new Error('No private bootstrap address available');
    };
    const freePort = async (kind, start, reserved) => {
      const sockets = (await runner('ss', ['-H', kind === 'udp' ? '-u' : '-t', '-a', '-n'])).stdout;
      if (typeof sockets !== 'string') throw new Error('Host port inventory unavailable');
      const occupied = new Set();
      for (const line of sockets.split(/\r?\n/).filter(Boolean)) {
        const columns = line.trim().split(/\s+/), match = columns[3]?.match(/:(\d+)$/);
        if (columns.length < 5 || !match) throw new Error('Unrecognized host socket inventory');
        occupied.add(Number(match[1]));
      }
      for (let candidate = start; candidate <= start + 100; candidate++) {
        if (reserved.has(candidate) || occupied.has(candidate)) continue;
        reserved.add(candidate); return candidate;
      }
      throw new Error('No free restore service port');
    };
    if (names.has('awgmainb0')) throw new Error('Archived interface conflicts with restore bootstrap');
    const binding = summary.bindings;
    const controlInterface = binding?.AWG_MAIN_CONTROL_INTERFACE ?? 'awgmainc0';
    const controlPort = binding ? Number(binding.AWG_MAIN_CONTROL_PORT) : await freePort('udp', 53084, udp);
    const controlAddress = binding?.AWG_MAIN_CONTROL_ADDRESS ?? address(null);
    const controlTcpPort = binding ? Number(binding.AWG_MAIN_CONTROL_TCP_PORT) : await freePort('tcp', 53083, tcp);
    udp.add(controlPort); tcp.add(controlTcpPort);
    const bootstrapPort = await freePort('udp', 53081, udp);
    const registrationPort = await freePort('tcp', 53082, tcp);
    const dhtPort = await freePort('udp', 49033, udp);
    const values = { AWG_IMAGE: image, AWG_HOST: state.server.endpointHost,
      AWG_EGRESS_IPV4: state.server.egressIpv4 || '',
      AWG_PORT: state.server.listenPort, AWG_PANEL_PORT: state.server.panelPort,
      AWG_MAIN_USER_INTERFACE: state.server.interfaceName, AWG_MAIN_USER_PORT: state.server.listenPort,
      AWG_MAIN_BOOTSTRAP_INTERFACE: 'awgmainb0', AWG_MAIN_CONTROL_INTERFACE: controlInterface,
      AWG_MAIN_BOOTSTRAP_PORT: bootstrapPort, AWG_MAIN_CONTROL_PORT: controlPort,
      AWG_MAIN_REGISTRATION_PORT: registrationPort, AWG_MAIN_CONTROL_TCP_PORT: controlTcpPort,
      AWG_MAIN_BOOTSTRAP_ADDRESS: address(controlAddress), AWG_MAIN_CONTROL_ADDRESS: controlAddress,
      AWG_MAIN_ENDPOINT: state.server.endpointHost, AWG_MAIN_DHT_PORT: dhtPort };
    const reservation = { interfaceNames: ['awgmainb0', controlInterface, ...[...names].filter(name => ![state.server.interfaceName, state.server.wanInterface, controlInterface].includes(name))],
      udpPorts: [...udp].filter(value => value !== state.server.listenPort), tcpPorts: [registrationPort, controlTcpPort],
      nftTables: ['awg_easy_3_bootstrap', 'awg_easy_3_bootstrap_guard', 'awg_easy_3_control', 'awg_easy_3_control_guard'] };
    // Data tables are fixed by their validated generated interface slot.
    for (const name of names) if (/^awgd(?:0|[1-9][0-9]{0,2})$/.test(name)) {
      reservation.nftTables.push(`awg_easy_3_data_${name.slice(4)}`, `awg_easy_3_data_guard_${name.slice(4)}`);
    }
    await preflight(reservation);
    return { environment: Buffer.from(Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join('')),
      reservation: { ...reservation, interfaceNames: [...reservation.interfaceNames, state.server.interfaceName],
        udpPorts: [...reservation.udpPorts, state.server.listenPort], tcpPorts: [...reservation.tcpPorts, state.server.panelPort],
        nftTables: [...reservation.nftTables, 'awg_easy_3'] } };
  }
  return Object.freeze({ status,
    prepare: async ({ archive, recoveryKey, image }) => {
      const prior = await journal.read();
      if (prior && !['complete', 'rolled-back'].includes(prior.phase)) throw new Error('Resume the existing restore transaction first');
      for (const name of ['.env.cells-main', 'cell-data', 'cell-status']) if (await info(path.join(projectDirectory, name))) throw new Error('Restore destination must be a standalone panel without a Cell network');
      const data = path.join(projectDirectory, 'data');
      const currentBytes = await readSnapshotFile(data, 'state.json');
      const current = validateState(JSON.parse(currentBytes));
      if (current.clients.some(client => client.entryCellId)) throw new Error('Destination already has Cell clients');
      const id = crypto.randomUUID(), directory = path.join(root, id);
      await fs.mkdir(directory, { mode: 0o700 });
      const prepared = path.join(directory, 'prepared');
      const { interfaceName, wanInterface, endpointHost, listenPort, panelPort, egressIpv4 } = current.server;
      const summary = await prepareConfigurationRestore({ archive, recoveryKey, directory: prepared,
        target: { interfaceName, wanInterface, endpointHost, listenPort, panelPort, ...(egressIpv4 ? { egressIpv4 } : {}) } });
      const bindings = await hostBindings(prepared, current, image);
      const incoming = path.join(directory, 'incoming');
      await fs.mkdir(incoming, { mode: 0o700 });
      await fs.mkdir(path.join(directory, 'previous'), { mode: 0o700 });
      await copyPrivateTree(path.join(prepared, 'panel'), path.join(incoming, 'data'));
      if (summary.main) {
        await copyPrivateTree(path.join(prepared, 'main'), path.join(incoming, 'cell-data'));
        await writePrivate(path.join(incoming, 'main.env'), bindings.environment);
      }
      await writePrivate(path.join(directory, 'reservation.json'), JSON.stringify(bindings?.reservation ?? {
        interfaceNames: [current.server.interfaceName], udpPorts: [current.server.listenPort],
        tcpPorts: [current.server.panelPort], nftTables: ['awg_easy_3'] }));
      await writePrivate(path.join(directory, 'payload.json'), JSON.stringify(await payloadInventory(incoming)));
      const pairs = [['data', `${id}/previous/data`], [`${id}/incoming/data`, 'data'],
        ...(summary.main ? [[`${id}/incoming/cell-data`, 'cell-data'], [`${id}/incoming/main.env`, '.env.cells-main']] : [])];
      const moves = [];
      for (const [from, to] of pairs) moves.push({ from, to, ...inode(await fs.lstat(location(from), { bigint: true })) });
      await syncDirectory(incoming); await syncDirectory(directory); await syncDirectory(root);
      await journal.write({ version: 1, id, main: summary.main, phase: 'prepared', next: 0,
        targetHash: hash(currentBytes), moves });
      return status();
    },
    commit: async () => {
      let state = await journal.read();
      if (!state || !['prepared', 'switching', 'committed'].includes(state.phase)) throw new Error('Restore is not ready for activation');
      if (state.phase === 'committed') return status();
      await inspectPreparedRestore(path.join(root, state.id, 'prepared'));
      await preflight(JSON.parse(await readSnapshotFile(path.join(root, state.id), 'reservation.json')));
      const inventory = JSON.parse(await readSnapshotFile(path.join(root, state.id), 'payload.json'));
      if (!Array.isArray(inventory) || !inventory.length || inventory.length > 4096) throw new Error('Invalid restore payload inventory');
      for (const item of inventory) {
        if (!item || Object.keys(item).sort().join(',') !== 'hash,name' || !/^[a-f0-9]{64}$/.test(item.hash)
          || !/^(?:(?:data|cell-data)\/[A-Za-z0-9_.\/-]+|main\.env)$/.test(item.name)
          || item.name.split('/').some(segment => ['..', '.', ''].includes(segment))) throw new Error('Unsafe restore payload path');
        const [area, ...parts] = item.name.split('/');
        const intent = state.moves.find(value => value.from === `${state.id}/incoming/${area}`);
        if (!intent) throw new Error('Restore payload has no rename intent');
        const base = matches(await info(location(intent.from)), intent) ? location(intent.from) : location(intent.to);
        if (!matches(await info(base), intent)) throw new Error('Restore payload ownership changed');
        let bytes;
        if (area === 'main.env') {
          const handle = await fs.open(base, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || process.platform !== 'win32'
              && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw new Error('Unsafe restore environment');
            bytes = await handle.readFile();
          } finally { await handle.close(); }
        } else bytes = await readSnapshotFile(base, parts.join('/'));
        if (hash(bytes) !== item.hash) throw new Error('Restore payload changed after preparation');
      }
      if (state.phase === 'prepared') {
        if (hash(await readSnapshotFile(path.join(projectDirectory, 'data'), 'state.json')) !== state.targetHash) throw new Error('Destination configuration changed; prepare restore again');
        state = await journal.write({ ...state, phase: 'switching' });
      }
      for (let index = state.next; index < state.moves.length; index++) {
        await move(state.moves[index]);
        state = await journal.write({ ...state, next: index + 1 });
      }
      await journal.write({ ...state, phase: 'committed' });
      return status();
    },
    rollback: async () => {
      let state = await journal.read();
      if (!state || !['prepared', 'switching', 'committed', 'rolling-back'].includes(state.phase)) throw new Error('Restore rollback is unavailable after service startup');
      state = await journal.write({ ...state, phase: 'rolling-back' });
      for (const intent of [...state.moves].reverse()) {
        if (matches(await info(location(intent.from)), intent)) {
          // A previous destination path can legitimately hold the OLD data
          // until its forward rename runs; every other occupied target is foreign.
          const destination = await info(location(intent.to));
          if (destination && !state.moves.some(other => other.from === intent.to && matches(destination, other))) throw new Error('Foreign path blocks restore rollback');
          continue;
        }
        await move({ ...intent, from: intent.to, to: intent.from });
      }
      await journal.write({ ...state, phase: 'rolled-back', next: 0 });
      return status();
    },
    start: async () => {
      const state = await journal.read();
      if (!state || !['committed', 'starting'].includes(state.phase)) throw new Error('Restore is not committed');
      await journal.write({ ...state, phase: 'starting' }); // Durable before any service can issue takeover.
      return status();
    },
    complete: async () => {
      const state = await journal.read();
      if (!state || !['starting', 'complete'].includes(state.phase)) throw new Error('Restored service has not been started');
      await journal.write({ ...state, phase: 'complete' }); return status();
    },
  });
}
module.exports = { openInstallationRestore };
