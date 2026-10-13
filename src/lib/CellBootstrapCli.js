'use strict';

const path = require('node:path');
const { openCellBootstrapInstallationHost } = require('./CellBootstrapInstallationHost');

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
  return { stateDirectory, interfaceName, resources: {
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
  openHost = openCellBootstrapInstallationHost } = {}) {
  if (!Array.isArray(args) || args.length !== 1
    || !['begin', 'resume', 'register'].includes(args[0])) {
    throw new Error('Usage: cell-cli.js begin|resume|register');
  }
  const config = configFromEnvironment(env);
  const code = args[0] === 'begin' ? await readInvitation(input) : null;
  const host = await openHost(config);
  const result = args[0] === 'begin' ? await host.initial.begin(code)
    : args[0] === 'resume' ? await host.initial.resume()
      : await host.registration.register();
  if (args[0] === 'register') {
    if (result?.status !== 'registered') throw new Error('Cell registration not complete');
    output.write('{"status":"registered"}\n');
  } else {
    if (result?.ready !== true) throw new Error('Cell bootstrap not ready');
    output.write('{"status":"bootstrap-ready"}\n');
  }
}

module.exports = { configFromEnvironment, readInvitation, runCellBootstrapCli };
