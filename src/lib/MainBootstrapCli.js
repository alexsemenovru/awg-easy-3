'use strict';

const path = require('node:path');
const { openMainBootstrapInstallationHost } = require('./MainBootstrapInstallationHost');

const NAME = /^[a-zA-Z0-9_.-]{1,15}$/;
const PORT = /^\d{1,5}$/;
const port = value => PORT.test(value || '') && Number(value) > 0 && Number(value) <= 65535
  ? Number(value) : NaN;

function configFromEnvironment(env) {
  if (!env || typeof env !== 'object') throw new TypeError('Main environment required');
  const stateDirectory = env.AWG_MAIN_CELL_STATE_DIR;
  const interfaceName = env.AWG_MAIN_BOOTSTRAP_INTERFACE;
  const permanentInterface = env.AWG_MAIN_CONTROL_INTERFACE;
  const listenPort = port(env.AWG_MAIN_BOOTSTRAP_PORT);
  const permanentEndpointPort = port(env.AWG_MAIN_CONTROL_PORT);
  const registrationPort = port(env.AWG_MAIN_REGISTRATION_PORT);
  const permanentControlPort = port(env.AWG_MAIN_CONTROL_TCP_PORT);
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
    || path.normalize(stateDirectory) !== stateDirectory
    || !NAME.test(interfaceName || '') || !NAME.test(permanentInterface || '')
    || interfaceName === permanentInterface
    || [listenPort, permanentEndpointPort, registrationPort, permanentControlPort]
      .some(value => !Number.isSafeInteger(value))
    || listenPort === permanentEndpointPort) {
    throw new Error('Explicit Main state path, two interfaces and four ports required');
  }
  return { stateDirectory, interfaceName, controllerAddress: env.AWG_MAIN_BOOTSTRAP_ADDRESS,
    registrationPort, listenPort, endpointHost: env.AWG_MAIN_ENDPOINT,
    permanentEndpointPort, permanentControllerAddress: env.AWG_MAIN_CONTROL_ADDRESS,
    permanentControlPort,
    resources: { interfaceNames: [interfaceName, permanentInterface],
      udpPorts: [listenPort, permanentEndpointPort], nftTables: [
        'awg_easy_3_bootstrap', 'awg_easy_3_bootstrap_guard',
        'awg_easy_3_control', 'awg_easy_3_control_guard',
      ] },
  };
}

async function runMainBootstrapCli({ args, env, output,
  openHost = openMainBootstrapInstallationHost } = {}) {
  if (!Array.isArray(args) || !output || typeof output.write !== 'function'
    || !['init', 'resume', 'issue', 'join', 'listen'].includes(args[0])
    || args.length !== (args[0] === 'issue' ? 3 : args[0] === 'join' ? 2 : 1)) {
    throw new Error('Usage: main-cell-cli.js init|resume|issue TEMP_CELL_IP PERMANENT_CELL_IP|join INVITATION_ID|listen');
  }
  const host = await openHost(configFromEnvironment(env));
  if (args[0] === 'init' || args[0] === 'resume') {
    const result = await host[args[0] === 'init' ? 'initialize' : 'resume']();
    if (result?.ready !== true) throw new Error('Main bootstrap not ready');
    output.write('{"status":"bootstrap-ready"}\n');
  } else if (args[0] === 'issue') {
    const code = await host.issue({ cellAddress: args[1], permanentCellAddress: args[2] });
    output.write(`${code}\n`);
  } else if (args[0] === 'join') {
    const result = await host.join(args[1]);
    if (!['ready', 'waiting-for-permanent-path'].includes(result?.status)) {
      throw new Error('Permanent Main join did not reach a known state');
    }
    output.write(`${JSON.stringify({ status: result.status })}\n`);
  } else {
    const listener = await host.listen();
    output.write('{"listening":true,"transport":"AWG"}\n');
    return listener;
  }
}

module.exports = { configFromEnvironment, runMainBootstrapCli };
