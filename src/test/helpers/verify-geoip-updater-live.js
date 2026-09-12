'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { GeoIpUpdater } = require('../../lib/GeoIpUpdater');

(async () => {
  // Dedicated test cache only; never the panel's data directory.
  const directory = process.argv[2];
  if (!directory) throw new Error('Dedicated cache directory required');
  const first = new GeoIpUpdater({ directory });
  assert.equal(await first.load(), null, 'Use a fresh test cache');
  await first.refresh();
  assert.ok(first.current, 'Production download must install a database');
  assert.equal(first.status.state, 'ready');
  const bytes = await fs.readFile(first.filename);
  const second = new GeoIpUpdater({ directory, download: async () => { throw new Error('Offline test'); } });
  await second.load();
  assert.equal(second.current.sha256, first.current.sha256);
  await second.refresh();
  assert.equal(second.status.state, 'ready');
  const future = new Date(); future.setUTCMonth(future.getUTCMonth() + 1);
  second.now = () => future;
  await second.refresh();
  assert.equal(second.current.sha256, first.current.sha256);
  assert.deepEqual(await fs.readFile(first.filename), bytes);
  console.log(JSON.stringify({ result: 'PASS production download, persist, offline reload and failed-update retention',
    release: first.current.release, rows: first.current.rows, sha256: first.current.sha256,
    failureStatus: second.status.state }));
})().catch(error => { console.error(error); process.exitCode = 1; });
