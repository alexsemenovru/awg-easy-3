'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../www/js/geo-client.js'), 'utf8'), {
  window, Intl, document: { createElement: () => ({}) },
});
const plain = value => JSON.parse(JSON.stringify(value));

test('country entry resolves five languages, ISO codes, multiple comma styles and duplicates', () => {
  for (const language of ['ru', 'en', 'es', 'fa', 'zh-cn']) {
    const entries = window.awgGeoClient.catalog(['RU', 'CN', 'IR'], language);
    const names = entries.map(entry => entry.name);
    assert.deepEqual(plain(window.awgGeoClient.resolve(names.join('،'), entries)), ['CN', 'IR', 'RU']);
    assert.deepEqual(plain(window.awgGeoClient.resolve('ru，RU, cn', entries)), ['CN', 'RU']);
    assert.deepEqual(plain(window.awgGeoClient.resolve('Россия', entries)), ['RU']);
    assert.throws(() => window.awgGeoClient.resolve('Atlantis', entries), /geoUnknownCountry/);
    assert.throws(() => window.awgGeoClient.resolve(' , ', entries), /geoChooseCountry/);
  }
  assert.throws(() => window.awgGeoClient.resolve('same', [{code:'AA',name:'same'}, {code:'BB',name:'same'}]), /geoUnknownCountry/);
});

test('country form preserves draft on server failure and can disable filtering without a database', async () => {
  const fields = new Map();
  const element = () => ({ value: '', disabled: false, handlers: {}, textContent: '', dataset: {},
    addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {}, replaceChildren() {} });
  const form = element();
  form.querySelector = selector => { if (!fields.has(selector)) fields.set(selector, element()); return fields.get(selector); };
  const calls = [];
  let codes = ['RU'];
  window.awgGeoClient.attach({ node: { querySelector: () => form }, client: { id: 'one' }, codes: () => codes,
    language: 'ru', t: key => key, save: async policy => { calls.push(plain(policy)); throw Object.assign(new Error('unavailable'), {code:'GEO_UNAVAILABLE'}); } });
  const mode = fields.get('.geo-mode');
  const input = fields.get('.geo-countries');
  mode.value = 'block'; mode.handlers.change(); input.value = 'Россия';
  await form.handlers.submit({ preventDefault() {} });
  assert.deepEqual(calls[0], { mode: 'block', countries: ['RU'] });
  assert.equal(input.value, 'Россия');
  assert.equal(fields.get('.geo-message').textContent, 'GEO_UNAVAILABLE');
  assert.equal(fields.get('.geo-message').dataset.i18n, 'GEO_UNAVAILABLE');
  assert.equal(fields.get('button').disabled, false);
  codes = []; mode.value = 'off';
  await form.handlers.submit({ preventDefault() {} });
  assert.deepEqual(calls[1], { mode: 'off', countries: [] });
  mode.value = 'block'; input.value = 'Atlantis';
  await form.handlers.submit({ preventDefault() {} });
  assert.equal(fields.get('.geo-message').dataset.i18n, 'geoUnknownCountry');
  assert.equal(input.value, 'Atlantis');
});
