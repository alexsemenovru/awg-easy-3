'use strict';

const path = require('node:path');
const { openCellBootstrapInstallationHost } = require('./CellBootstrapInstallationHost');
const { decodeAwgBootstrapInvitation } = require('./CellAwgBootstrapInvitation');
const { CellUserConfigStore } = require('./CellUserConfigStore');
const { startCellService, syncCellOnce } = require('./CellService');

const INTERFACE = /^[a-zA-Z0-9_.-]{1,15}$/;
const PORT = /^\d{1,5}$/;

function configFromEnvironment(env) {
  if (!env || typeof env !== 'object') throw new TypeError('Cell environment required');
  const stateDirectory = env.AWG_CELL_STATE_DIR;
  const interfaceName = env.AWG_CELL_BOOTSTRAP_INTERFACE;
  const controlInterface = env.AWG_CELL_CONTROL_INTERFACE;
  const userInterface = env.AWG_CELL_USER_INTERFACE;
  const portText = env.AWG_CELL_USER_PORT;
  const userPort = PORT.test(portText || '') ? Number(portText) : NaN;
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
    || path.normalize(stateDirectory) !== stateDirectory
    || [interfaceName, controlInterface, userInterface].some(name => !INTERFACE.test(name || ''))
    || new Set([interfaceName, controlInterface, userInterface]).size !== 3
    || !Number.isInteger(userPort) || userPort < 1 || userPort > 65535) {
    throw new Error('Explicit Cell state path, three distinct interfaces and user UDP port required');
  }
  return { stateDirectory, interfaceName, runtimeDirectory: env.AWG_CELL_RUNTIME_DIR, resources: {
    interfaceNames: [interfaceName, controlInterface, userInterface],
    udpPorts: [userPort], nftTables: [
      'awg_easy_3_bootstrap', 'awg_easy_3_bootstrap_guard',
      'awg_easy_3_control', 'awg_easy_3_control_guard',
      'awg_easy_3', 'awg_easy_3_cell_guard',
    ],
  } };
}

async function readInvitation(input) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of input) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 8194) throw new Error('Cell invitation is too large');
    chunks.push(data);
  }
  const code = Buffer.concat(chunks).toString('utf8').trim();
  if (!code) throw new Error('Cell invitation required on stdin');
  return code;
}

async function runCellBootstrapCli({ args, env, input, output,
  openHost = openCellBootstrapInstallationHost,
  startService = startCellService,
  syncOnce = syncCellOnce,
  newUserStore = (...params) => new CellUserConfigStore(...params) } = {}) {
  if (!Array.isArray(args) || args.length !== 1
    || !['begin', 'resume', 'register', 'join', 'configure-user', 'sync', 'serve'].includes(args[0])) {
    throw new Error('Usage: cell-cli.js begin|resume|register|join|configure-user|sync|serve');
  }
  if (!output || typeof output.write !== 'function') throw new TypeError('Cell status output required');
  const config = configFromEnvironment(env);
  const code = args[0] === 'begin' ? await readInvitation(input) : null;
  if (code) decodeAwgBootstrapInvitation(code);
  const host = await openHost(config);
  if (args[0] === 'configure-user') {
    const state = await host.connectionStore.read();
    if (state?.status !== 'registered') throw new Error('Registered Cell required for user config');
    if (!input || typeof input[Symbol.asyncIterator] !== 'function') {
      throw new TypeError('Cell user config required on stdin');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 8192) throw new Error('Cell user config is too large');
      chunks.push(bytes);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Invalid Cell user config JSON'); }
    if (value?.server?.privateKey === state.permanent?.privateKey) {
      throw new Error('Cell user and control AWG keys must be distinct');
    }
    const store = newUserStore(path.join(config.stateDirectory, 'user-config.json'), {
      interfaceName: config.resources.interfaceNames[2],
      listenPort: config.resources.udpPorts[0],
    });
    await store.create(value);
    output.write('{"status":"user-configured"}\n');
    return;
  }
  if (args[0] === 'serve') {
    const service = await startService({ config, bootstrapHost: host });
    output.write('{"status":"serving","transport":"AWG"}\n');
    return service;
  }
  if (args[0] === 'sync') {
    const result = await syncOnce({ config, bootstrapHost: host });
    if (!result || !['applied', 'no-settings'].includes(result.status)) {
      throw new Error('Cell settings sync did not reach a known state');
    }
    output.write(`${JSON.stringify({ status: result.status,
      ...(result.status === 'applied' ? { revision: result.revision } : {}) })}\n`);
    return;
  }
  const result = args[0] === 'begin' ? await host.initial.begin(code)
    : args[0] === 'resume' ? await host.initial.resume()
      : args[0] === 'register' ? await host.registration.register()
        : await host.permanentJoin.join();
  if (args[0] === 'register') {
    if (result?.status !== 'registered') throw new Error('Cell registration not complete');
    output.write('{"status":"registered"}\n');
  } else if (args[0] === 'join') {
    if (!['ready', 'waiting-for-permanent-path'].includes(result?.status)) {
      throw new Error('Permanent Cell join did not reach a known state');
    }
    output.write(`${JSON.stringify({ status: result.status })}\n`);
  } else {
    if (result?.ready !== true) throw new Error('Cell bootstrap not ready');
    output.write('{"status":"bootstrap-ready"}\n');
  }
}

module.exports = { configFromEnvironment, readInvitation, runCellBootstrapCli };
