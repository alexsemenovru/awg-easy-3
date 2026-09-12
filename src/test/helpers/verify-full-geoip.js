'use strict';

// Offline verification: reads a public DB-IP archive; never reads panel state.
const fs = require('node:fs');
const { parseInWorker } = require('../../lib/GeoIpWorker');
const { renderNftablesPolicy } = require('../../lib/NftablesPolicy');

(async () => {
  const start = Date.now();
  let peakRss = 0;
  const timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
  let result;
  try { result = await parseInWorker(fs.readFileSync(process.argv[2])); }
  finally { clearInterval(timer); }
  const parseMs = Date.now() - start;
  const policies = {};
  for (const country of ['RU', 'CN', 'IR', 'US']) {
    policies[country] = renderNftablesPolicy({
      home4: ['10.8.0.2'], guest4: [], home6: ['fd42:8::2'], guest6: [], ipv6Subnet: 'fd42:8::/64',
      geoDatabase: result.database,
      geoClients: [{ address4: '10.8.0.2', address6: 'fd42:8::2', policy: { mode: 'block', countries: [country] } }],
    });
  }
  console.error(JSON.stringify({ rows: result.rows, countries: result.countries.length,
    parseMs, peakRssBytes: peakRss, sha256: result.sha256,
    policyBytes: Object.fromEntries(Object.entries(policies).map(([k,v]) => [k, Buffer.byteLength(v)])) }));
  // Pipe to a separate namespace checker or discard; contains public ranges only.
  process.stdout.write(JSON.stringify(policies));
})().catch(error => { console.error(error); process.exitCode = 1; });
