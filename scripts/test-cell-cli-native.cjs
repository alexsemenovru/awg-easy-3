'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { AwgKeyManager } = require('../src/lib/AwgKeyManager');
const { generateOfficialProfile } = require('../src/lib/Awg3Config');
const { createAwgBootstrapInvitation } = require('../src/lib/CellAwgBootstrapInvitation');

assert.equal(process.env.AWG_CELL_ISOLATED_TEST, '1');
assert.notEqual(fs.readlinkSync('/proc/self/ns/net'), fs.readlinkSync('/proc/1/ns/net'));
const stateParent = '/tmp/awg-cell-cli-lab';
fs.mkdirSync(stateParent, { mode: 0o700 });
const stateDirectory = `${stateParent}/state`;
assert.equal(fs.existsSync(stateDirectory), false);
const environment = { ...process.env,
  AWG_CELL_STATE_DIR: stateDirectory,
  AWG_CELL_BOOTSTRAP_INTERFACE: 'clijoin0',
  AWG_CELL_CONTROL_INTERFACE: 'clictl0',
  AWG_CELL_USER_INTERFACE: 'cliuser0',
  AWG_CELL_USER_PORT: '51830',
};
const run = (file, args, options = {}) => execFileSync(file, args,
  { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, ...options }).trim();
let stage = 'keys';

async function main() {
  const keyManager = new AwgKeyManager();
  const server = await keyManager.generateKeyPair();
  const controller = crypto.generateKeyPairSync('ed25519');
  const invitation = await createAwgBootstrapInvitation({
    controllerKey: controller.publicKey.export({ format: 'jwk' }).x,
    endpointHost: '203.0.113.2', endpointPort: 51831,
    registrationPort: 51832, controllerAddress: '10.91.0.1',
    cellAddress: '10.91.0.2', serverPublicKey: server.publicKey,
    profile: generateOfficialProfile(),
  });
  const cli = path.join(__dirname, '..', 'src', 'cell-cli.js');
  stage = 'begin';
  const begin = run(process.execPath, [cli, 'begin'],
    { env: environment, input: `${invitation.code}\n` });
  assert.equal(begin, '{"status":"bootstrap-ready"}');
  stage = 'resume';
  assert.equal(run(process.execPath, [cli, 'resume'], { env: environment }), begin);
  stage = 'readback';
  const stat = fs.statSync(stateDirectory);
  assert.equal(stat.mode & 0o077, 0);
  assert.equal(run('ip', ['-d', '-j', 'link', 'show', 'clijoin0']).includes('clijoin0'), true);
  const tables = JSON.parse(run('nft', ['-j', 'list', 'tables']));
  assert.ok(tables.nftables.some(item => item.table?.name === 'awg_easy_3_bootstrap'));
  assert.ok(!tables.nftables.some(item => item.table?.name === 'awg_easy_3_bootstrap_guard'));
  console.log('PASS Cell CLI begin/resume with private state, real AWG and released bootstrap guard');
}
main().catch(error => {
  console.error(`Cell CLI native lab failed at ${stage}; child status ${error.status ?? 'unknown'}; invitation and keys withheld`);
  process.exitCode = 1;
});
