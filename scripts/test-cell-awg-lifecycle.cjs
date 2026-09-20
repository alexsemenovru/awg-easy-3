'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { CellAwgLifecycle } = require('../src/lib/CellAwgLifecycle');
const { CellRoutingGuard } = require('../src/lib/CellRoutingGuard');
const { createAwgOwnership } = require('../src/lib/CellAwgOwnership');
const { generateOfficialProfile, renderInterfaceFields } = require('../src/lib/Awg3Config');
assert.equal(process.env.AWG_CELL_ISOLATED_TEST, '1');
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function main() {
  const directory = '/tmp/lifecycle'; fs.mkdirSync(directory, { mode: 0o700 });
  const guard = new CellRoutingGuard({ journalPath: `${directory}/guard.json` });
  const options = { journalPath: `${directory}/life.json`, activateGuard: names => guard.protect(names) };
  const spec = { version: 1, owner: createAwgOwnership({ interfaceName: 'life0',
    config: `[Interface]\nPrivateKey = ${run('awg', ['genkey'])}\nListenPort = 54323\n${renderInterfaceFields(generateOfficialProfile())}\n` }),
    addresses: ['10.88.0.1/24', 'fd88::1/64'] };
  // A coexisting VPN must survive every operation byte-for-byte.
  run('amneziawg-go', ['foreign0']);
  const foreign = run('awg', ['showconf', 'foreign0']);
  let life = new CellAwgLifecycle(options);
  await life.create(spec);
  assert.equal((await life.verify(spec)).up, true); assert.ok(await guard.current());
  console.log('PASS real userspace AWG creation, addresses, ownership and retained guard');
  life = new CellAwgLifecycle(options);
  run('ip', ['link', 'set', 'dev', 'life0', 'down']);
  await life.recover(); assert.equal((await life.verify(spec)).up, true);
  run('ip', ['address', 'add', '10.99.0.1/24', 'dev', 'life0']);
  await assert.rejects(life.remove(), /Unexpected AWG addresses/);
  run('ip', ['address', 'del', '10.99.0.1/24', 'dev', 'life0']);
  console.log('PASS down device recovery and refusal to delete a drifted device');
  run('ip', ['link', 'delete', 'dev', 'life0']);
  // Wait for the old userspace daemon to observe TUN deletion and remove UAPI.
  for (let attempt = 0; attempt < 50 && fs.existsSync('/var/run/wireguard/life0.sock'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await new CellAwgLifecycle(options).recover();
  assert.equal((await life.verify(spec)).up, true);
  console.log('PASS missing device recreated from persisted identity after simulated device loss');
  await life.remove(); assert.equal((await life.load()).phase, 'empty');
  assert.equal(await life.link('life0'), null); assert.ok(await guard.current());
  assert.equal(run('awg', ['showconf', 'foreign0']), foreign);
  console.log('PASS owned device removal preserves other VPN and does not release guard');
}
main().catch(error => { console.error(`AWG lifecycle lab failed: ${error.message}`); process.exitCode = 1; });
