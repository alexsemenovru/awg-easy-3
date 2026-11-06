'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { StateStore } = require('../lib/StateStore');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { panelHealth } = require('../lib/PanelHealth');
test('health probe uses persisted interface, internal address and port rather than initialization environment', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-health-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/api/v1/session'); response.end('{"authenticated":false}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const stateFile = path.join(root, 'state.json');
  await new StateStore(stateFile).save({ version: 1, auth: { passwordHash: 'hash', sessionSecret: 'secret' },
    server: { interfaceName: 'awg3', wanInterface: 'eth0', endpointHost: '198.51.100.9',
      listenPort: 55000, panelPort: server.address().port, privateKey: 'private', publicKey: 'public',
      address4: '127.0.0.1', ipv4Subnet: '127.0.0.0/24', profile: generateOfficialProfile() },
    clients: [{ id: 'admin', name: 'Owner', networkGroup: 'home', enabled: true, address4: '127.0.0.2', privateKey: 'private', publicKey: 'public' }] });
  const runner = async (file, args) => {
    assert.equal(file, 'awg'); assert.deepEqual(args, ['show', 'awg3', 'listen-port']); return { stdout: '55000\n' };
  };
  assert.equal(await panelHealth({ stateFile, runner }), true);
  await assert.rejects(panelHealth({ stateFile, runner: async () => ({ stdout: '1\n' }) }), /mismatch/);
});
