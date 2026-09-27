'use strict';
// Invoked by an isolated lab after v2 provisioning, never on a working server.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CellNetworkTransaction, specification } = require('../src/lib/CellNetworkTransaction');
const { compileCellRouting } = require('../src/lib/CellRoutingPolicy');
assert.equal(process.env.AWG_CELL_ISOLATED_TEST, '1');
async function main() {
  const [directory, bundleFile] = process.argv.slice(2);
  const bundle = JSON.parse(await fs.readFile(bundleFile, 'utf8'));
  const built = compileCellRouting(bundle);
  const before = specification({ version: 1, devices: bundle.devices,
    routing: { version: 1, interfaces: bundle.devices.map(d => d.owner.interfaceName), commands: built.commands, nftSnapshot: built.nftSnapshot } });
  const tx = new CellNetworkTransaction({ directory });
  await tx.initialize(before);
  let after = structuredClone(before);
  // Keep the protocol and keys intact. Keepalive affects local transmission,
  // not client import compatibility. A no-peer fixture uses unchanged AWG.
  after.devices.forEach(d => { d.owner.config = d.owner.config.replace(/PersistentKeepalive = 5\b/g, 'PersistentKeepalive = 10'); });
  after.routing.nftSnapshot.nftables.find(x => x.rule).rule.comment = 'network update test';
  after = specification(after);
  await tx.apply(after); assert.equal(await tx.verify(after), true);
  assert.equal(await tx.guard.current(), null);
  // Parent intent plus partially committed children, including AWG changed
  // before its lifecycle journal was advanced. Recovery must use parent state.
  await tx.protect(after);
  await tx.save({ version: 1, committed: after, pending: { desired: before } });
  await tx.routing.apply(before.routing, { retainGuard: true });
  const index = Math.max(0, before.devices.findIndex((d, i) => d.owner.config !== after.devices[i].owner.config));
  const d = before.devices[index];
  await tx.awg(d.owner.interfaceName).reconcile([after.devices[index].owner, d.owner], d.owner);
  const fresh = new CellNetworkTransaction({ directory });
  await fresh.recover(); assert.equal(await fresh.verify(after), true);
  assert.ok(await fresh.guard.current());
  await fresh.apply(before); assert.equal(await fresh.verify(before), true);
  assert.equal(await fresh.guard.current(), null);
  console.log('PASS real parent AWG/routes/nft update and recovery from mixed child commits');
  process.env.AWG_CELL_FIELD_TEST = '1';
  const field = action => JSON.parse(execFileSync(process.execPath,
    [require.resolve('./cell-routing-field.cjs'), action, directory, bundleFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.throws(() => field('apply')); // old harness must not bypass new parent
  bundle.version = 3; await fs.writeFile(bundleFile, JSON.stringify(bundle), { mode: 0o600 });
  assert.equal(field('status').verified, true);
  assert.equal(field('recover').guarded, true);
  assert.equal(field('apply').guarded, false);
  assert.equal(field('status').verified, true);
  assert.equal(field('boot').guarded, false);
  const stale = structuredClone(bundle);
  stale.devices[0].owner.mtu += 1;
  const staleFile = path.join(directory, 'stale-boot.json');
  await fs.writeFile(staleFile, JSON.stringify(stale), { mode: 0o600 });
  let staleRefused = false;
  try {
    execFileSync(process.execPath, [require.resolve('./cell-routing-field.cjs'), 'boot', directory, staleFile],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { staleRefused = true; }
  assert.equal(staleRefused, true);
  const afterStale = field('status');
  assert.equal(afterStale.guardPresent, true);
  assert.equal(field('apply').guarded, false);
  console.log('PASS locked field v3 recovery; legacy controller cannot bypass network journal');
  const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // Lose only this fixture's volatile objects. Never flush host tables/rules.
  for (const d of before.devices) run('ip', ['link', 'delete', 'dev', d.owner.interfaceName]);
  run('nft', ['delete', 'table', 'inet', 'awg_easy_3_routes']);
  for (const command of before.routing.commands.filter(c => c.args[1] === 'rule')) {
    const args = [...command.args]; assert.equal(args[2], 'add'); args[2] = 'del'; run(command.file, args);
  }
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(field('recover').guarded, true);
  assert.equal(field('status').verified, true); assert.equal(field('status').guardPresent, true);
  assert.equal(field('apply').guarded, false);
  console.log('PASS private journals reconstruct lost devices, nft policy and owned selectors under guard');
}
main().catch(() => { console.error('Network update lab failed; private details withheld'); process.exitCode = 1; });
