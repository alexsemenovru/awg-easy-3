'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { generateOfficialProfile, renderInterfaceFields } = require('../src/lib/Awg3Config');
const { normalizeAwgConfig, matchesAwgConfig } = require('../src/lib/CellAwgSnapshot');
const { createAwgOwnership, inspectAwgOwnership } = require('../src/lib/CellAwgOwnership');
assert.equal(process.env.AWG_CELL_ISOLATED_TEST, '1');
const run = (file, args, input) => execFileSync(file, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const privateKey = run('awg', ['genkey']), peerKey = run('awg', ['pubkey'], run('awg', ['genkey']) + '\n');
const profile = generateOfficialProfile();
const config = `[Interface]\nPrivateKey = ${privateKey}\nListenPort = 54322\n${renderInterfaceFields(profile)}\n\n[Peer]\nPublicKey = ${peerKey}\nPresharedKey = ${crypto.randomBytes(32).toString('base64')}\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 5\nEndpoint = 192.0.2.1:54322\n`;
const file = '/tmp/awg-snapshot.conf';
fs.writeFileSync(file, config, { mode: 0o600 });
run('amneziawg-go', ['snapshot0']); run('awg', ['setconf', 'snapshot0', file]);
const actual = run('awg', ['showconf', 'snapshot0']);
if (!matchesAwgConfig(config, actual)) {
  const expected = normalizeAwgConfig(config), observed = normalizeAwgConfig(actual);
  // Only report field names, NEVER values (configuration contains secrets).
  for (const field of new Set([...Object.keys(expected.interface), ...Object.keys(observed.interface)])) {
    if (expected.interface[field] !== observed.interface[field]) console.error(`AWG interface field differs: ${field}`);
  }
  console.error('AWG snapshot mismatch; values withheld'); process.exit(1);
}
console.log('PASS generated AWG 3.1 config matches real showconf without logging secrets');
const changed = config.replace(`Jc = ${profile.jc}`, `Jc = ${profile.jc + 1}`);
fs.writeFileSync(file, changed, { mode: 0o600 }); run('awg', ['setconf', 'snapshot0', file]);
assert.equal(matchesAwgConfig(config, run('awg', ['showconf', 'snapshot0'])), false);
fs.writeFileSync(file, config, { mode: 0o600 }); run('awg', ['setconf', 'snapshot0', file]);
assert.equal(matchesAwgConfig(config, run('awg', ['showconf', 'snapshot0'])), true);
console.log('PASS real AWG profile drift is detected and restored configuration verifies');
const options = config.replace('RandomTrailers = on', 'RandomTrailers = off').replace('DisableCookies = on', 'DisableCookies = off')
  .replace('PersistentKeepalive = 5', 'PersistentKeepalive = 25-35').replace('192.0.2.1:54322', '[fd99::1]:54322');
fs.writeFileSync(file, options, { mode: 0o600 }); run('awg', ['setconf', 'snapshot0', file]);
assert.equal(matchesAwgConfig(options, run('awg', ['showconf', 'snapshot0'])), true);
console.log('PASS real AWG PSK, disabled flags, keepalive range and IPv6 endpoint roundtrip');
const manifest = createAwgOwnership({ interfaceName: 'snapshot0', config: options });
const inspect = () => inspectAwgOwnership({ manifest, links: JSON.parse(run('ip', ['-d', '-j', 'link', 'show', 'dev', 'snapshot0'])),
  actualConfig: run('awg', ['showconf', 'snapshot0']) });
assert.throws(inspect, /Foreign/);
// This fixture just created the interface in its own empty network namespace.
// Never use relabelling to adopt an existing interface in the product.
run('ip', ['link', 'set', 'dev', 'snapshot0', 'alias', manifest.ownerTag]);
run('ip', ['link', 'set', 'dev', 'snapshot0', 'mtu', '1280']);
assert.deepEqual(inspect(), { present: true, verified: true, up: false });
run('ip', ['link', 'set', 'dev', 'snapshot0', 'up']);
assert.deepEqual(inspect(), { present: true, verified: true, up: true });
console.log('PASS real AWG ownership requires explicit identity tag and distinguishes link up/down');
const stateDir = '/tmp/cell-field-runtime', bundleFile = '/tmp/cell-field-bundle.json';
fs.mkdirSync(stateDir, { mode: 0o700 });
fs.writeFileSync(bundleFile, JSON.stringify({ version: 1, nodeId: 'main',
  topology: { version: 1, nodes: [{ id: 'main', role: 'controller', ipv4: true, ipv6: true }], links: [], clients: [] },
  context: { clientInterface: 'snapshot0', wanInterface: 'wan', links: {}, nat66: true,
    panel: { address4: '10.88.0.1', address6: 'fd88::1', port: 51821 } }, geoDatabase: {}, owners: [manifest] }), { mode: 0o600 });
process.env.AWG_CELL_FIELD_TEST = '1';
const fieldScript = require.resolve('./cell-routing-field.cjs');
const field = action => JSON.parse(run(process.execPath, [fieldScript, action, stateDir, bundleFile]));
assert.equal(field('apply').applied, true);
assert.deepEqual(field('status'), { committed: true, pending: false, verified: true, guardPresent: false });
assert.equal(field('recover').guarded, true); assert.equal(field('status').guardPresent, true);
assert.equal(field('apply').guarded, false);
assert.throws(() => run('flock', ['-n', `${stateDir}/runtime.lock`, process.execPath, fieldScript, 'apply', stateDir, bundleFile]));
assert.equal(field('apply').applied, true);
console.log('PASS locked field CLI apply/status/recover across fresh processes; competing owner refused');

async function transactionTest() {
  const { CellAwgTransaction } = require('../src/lib/CellAwgTransaction');
  const { CellRoutingGuard } = require('../src/lib/CellRoutingGuard');
  const guard = new CellRoutingGuard({ journalPath: `${stateDir}/guard.json` });
  const txOptions = { journalPath: `${stateDir}/awg.json`, activateGuard: names => guard.protect(names) };
  const tx = new CellAwgTransaction(txOptions);
  await tx.initialize(manifest);
  const next = { ...manifest, config: options.replace(`Jc = ${profile.jc}`, `Jc = ${profile.jc + 1}`) };
  await tx.apply(next);
  assert.equal(matchesAwgConfig(next.config, run('awg', ['showconf', 'snapshot0'])), true);
  assert.ok(await guard.current());
  // Simulate kernel-after / journal-before completion; new instance restores
  // the last confirmed config, not an unconfirmed pending update.
  await tx.save({ version: 1, committed: manifest, pending: { desired: next } });
  await new CellAwgTransaction(txOptions).recover();
  assert.equal(inspect().verified, true); assert.ok(await guard.current());
  await tx.save({ version: 1, committed: manifest, pending: { desired: next } });
  const drift = options.replace(`Jc = ${profile.jc}`, `Jc = ${profile.jc + 2}`);
  fs.writeFileSync(file, drift, { mode: 0o600 }); run('awg', ['setconf', 'snapshot0', file]);
  await assert.rejects(new CellAwgTransaction(txOptions).recover(), /changed/);
  assert.equal(matchesAwgConfig(drift, run('awg', ['showconf', 'snapshot0'])), true);
  assert.ok((await tx.load()).pending); assert.ok(await guard.current());
  // Explicit fixture repair, not automatic adoption of the unexpected state.
  fs.writeFileSync(file, options, { mode: 0o600 }); run('awg', ['setconf', 'snapshot0', file]);
  await new CellAwgTransaction(txOptions).recover();
  await guard.release(async () => inspect().verified);
  assert.equal(await guard.current(), null);
  console.log('PASS real AWG transaction update, durable recovery and refusal of unexplained drift under guard');
}
transactionTest().catch(() => {
  console.error('AWG transaction lab failed; private configuration withheld'); process.exitCode = 1;
});
