'use strict';
// Explicitly invoked only on the disposable test installation.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { StateStore } = require('../../lib/StateStore');
const { GeoIpUpdater } = require('../../lib/GeoIpUpdater');
const { ClientManager } = require('../../lib/ClientManager');
const { RuntimeApplier } = require('../../lib/RuntimeApplier');
const { buildAwgArtifacts } = require('../../lib/AwgArtifacts');
const { execFileSync } = require('node:child_process');
(async () => {
  const store = new StateStore('/data/state.json');
  const geo = new GeoIpUpdater({ directory: '/data/geoip' });
  await geo.load();
  assert.ok(geo.current, 'Wait for automatic database download');
  const state = await store.load();
  const target = state.clients.find(c => c.id === 'home-admin');
  assert.ok(target);
  const build = s => buildAwgArtifacts({server:s.server,clients:s.clients,geoDatabase:geo.current.database});
  const snapshot = '/data/geoip-test-export.json';
  const mode = process.argv[2];
  if (mode === 'enable' || mode === 'allow') {
    if (mode === 'enable') await fs.writeFile(snapshot, JSON.stringify(build(state).clientArtifacts), {mode:0o600,flag:'wx'});
    const manager = new ClientManager({store,applier:new RuntimeApplier({runtimeDirectory:'/run/awg-easy-3'}),geoDatabase:()=>geo.current.database});
    await manager.updateClient(target.id, {geoPolicy:{mode:mode === 'allow' ? 'allow' : 'block',countries:['RU']}});
  } else if (mode !== 'verify') throw new Error('Use enable, allow or verify');
  const saved = await store.load();
  assert.equal(saved.version, 2);
  assert.equal(saved.clients.find(c=>c.id===target.id).geoPolicy.mode, mode === 'allow' ? 'allow' : 'block');
  assert.equal(JSON.stringify(build(saved).clientArtifacts), await fs.readFile(snapshot,'utf8'), 'Exports changed');
  const rules = execFileSync('nft',['list','ruleset'],{encoding:'utf8'});
  assert.ok(rules.includes('GeoIP outbound') && rules.includes('GeoIP inbound'));
  console.log('PASS GeoIP v2 persisted, both-direction rules present, exports unchanged');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
