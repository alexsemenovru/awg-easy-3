'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('GeoIP status renders state and release, rejects malformed data and reports network failure', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../www/js/geo-status.js'), 'utf8'), { window });
  const node = { dataset: {}, textContent: '' };
  let callbacks;
  const controller = window.awgGeoStatus({ load: () => {}, node, translate: key => key,
    createPoller: options => { callbacks = options; return { start() {}, stop() {} }; } });
  callbacks.onData({ state: 'stale', release: '2026-09' });
  assert.equal(node.textContent, 'geo_stale · 2026-09');
  controller.translate();
  assert.match(node.textContent, /2026-09/);
  assert.throws(() => callbacks.onData({ state: 'ready', release: '<script>' }), /Invalid/);
  callbacks.onError();
  assert.equal(node.textContent, 'geo_statusUnavailable');
});
