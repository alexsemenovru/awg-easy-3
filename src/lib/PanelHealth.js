'use strict';
const net = require('node:net');
const http = require('node:http');
const { StateStore } = require('./StateStore');
const { runProcess } = require('./ProcessRunner');
async function panelHealth({ stateFile, runner = runProcess, get = http.get }) {
  const state = await new StateStore(stateFile).load();
  const server = state?.server;
  if (!server || !/^[A-Za-z0-9_.-]{1,15}$/.test(server.interfaceName) || net.isIP(server.address4) !== 4) throw new Error('Invalid health target');
  const actual = Number((await runner('awg', ['show', server.interfaceName, 'listen-port'], { timeoutMs: 1500, maxOutputBytes: 128 })).stdout);
  if (actual !== server.listenPort) throw new Error('AWG health port mismatch');
  await new Promise((resolve, reject) => {
    const request = get({ hostname: server.address4, port: server.panelPort, path: '/api/v1/session', timeout: 1500 }, response => {
      response.resume();
      if (response.statusCode !== 200) reject(new Error('Panel health unavailable'));
      else resolve();
    });
    request.once('timeout', () => request.destroy(new Error('Panel health timeout')));
    request.once('error', reject);
  });
  return true;
}
module.exports = { panelHealth };
