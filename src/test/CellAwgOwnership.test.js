'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAwgOwnership, validateAwgOwnership, inspectAwgOwnership } = require('../lib/CellAwgOwnership');
const config = `[Interface]\nPrivateKey = ${Buffer.alloc(32, 1).toString('base64')}\nListenPort = 54322\n`;
function fixture() {
  const manifest = createAwgOwnership({ interfaceName: 'transit', config });
  const link = { ifname: 'transit', ifalias: manifest.ownerTag, mtu: 1280, flags: ['UP', 'POINTOPOINT'],
    linkinfo: { info_kind: 'tun', info_data: { type: 'tun' } } };
  return { manifest, links: [link], actualConfig: config };
}
test('AWG ownership requires matching random tag, backend, MTU and config', () => {
  const f = fixture(); assert.deepEqual(inspectAwgOwnership(f), { present: true, verified: true, up: true });
  f.links[0].flags = []; assert.deepEqual(inspectAwgOwnership(f), { present: true, verified: true, up: false });
  assert.notEqual(createAwgOwnership({ interfaceName: 'transit', config }).ownerTag, f.manifest.ownerTag);
});
test('AWG same-name interface without ownership proof is never adopted', () => {
  for (const modify of [f => delete f.links[0].ifalias, f => f.links[0].ifalias = 'foreign',
    f => f.links[0].linkinfo.info_kind = 'veth', f => f.links[0].linkinfo.info_data.type = 'tap']) {
    const f = fixture(); modify(f); assert.throws(() => inspectAwgOwnership(f), /Foreign/);
  }
});
test('owned AWG config/MTU drift is distinct from absence and does not authorize mutation', () => {
  const f = fixture(); f.actualConfig = config.replace('54322', '54323');
  assert.throws(() => inspectAwgOwnership(f), /changed/);
  f.actualConfig = config; f.links[0].mtu = 1400; assert.throws(() => inspectAwgOwnership(f), /changed/);
  f.links = []; assert.deepEqual(inspectAwgOwnership(f), { present: false, verified: false, up: false });
});
test('ownership manifest and duplicate interface inventory are strict', () => {
  const f = fixture();
  for (const change of [m => m.ownerTag = 'awg-easy-3-cell:guess', m => m.interfaceName = 'bad name',
    m => m.mtu = 0, m => m.command = 'anything']) {
    const m = structuredClone(f.manifest); change(m); assert.throws(() => validateAwgOwnership(m));
  }
  f.links.push(f.links[0]); assert.throws(() => inspectAwgOwnership(f), /Ambiguous/);
});
