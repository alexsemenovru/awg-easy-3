'use strict';
// Disposable field-only startup gate. It does not change host networking.
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { ipNumber } = require('../src/lib/GeoIpAddress');
const wan = process.argv[2];
if (process.platform !== 'linux' || process.env.AWG_CELL_FIELD_TEST !== '1'
  || !/^[a-zA-Z0-9_.-]{1,15}$/.test(wan || '')) process.exit(2);
const run = (args) => {
  const result = spawnSync('ip', args, { encoding: 'utf8', timeout: 4000, maxBuffer: 256 * 1024 });
  return result.status === 0 ? result.stdout : null;
};
const ready = () => {
  try {
    const rows = JSON.parse(run(['-j', 'addr', 'show', 'dev', wan]) || 'null');
    const addresses = rows?.[0]?.addr_info || [];
    const ipv4 = addresses.some(x => x.family === 'inet' && x.scope === 'global' && net.isIP(x.local) === 4);
    const ipv6 = addresses.some(x => x.family === 'inet6' && x.scope === 'global'
      && net.isIP(x.local) === 6 && (ipNumber(x.local) >> 125n) === 1n);
    const route4 = run(['-4', 'route', 'get', '1.1.1.1']);
    const route6 = run(['-6', 'route', 'get', '2606:4700:4700::1111']);
    return ipv4 && ipv6 && route4?.includes(` dev ${wan} `) && route6?.includes(` dev ${wan} `);
  } catch { return false; }
};
(async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (ready()) { console.log('Field underlay ready'); return; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Field underlay unavailable');
})().catch(() => { console.error('Field underlay unavailable'); process.exitCode = 1; });
