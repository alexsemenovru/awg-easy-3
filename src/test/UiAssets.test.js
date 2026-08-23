'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const www = path.join(__dirname, '..', 'www');

test('ships a self-contained UI with every required control', () => {
  const html = fs.readFileSync(path.join(www, 'index.html'), 'utf8');
  for (const id of [
    'login-form', 'clients', 'show-create', 'client-group',
    'profile-qr', 'open-profile', 'download-config', 'password-form',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//i);
  assert.doesNotMatch(html, /backup|restore|expire|wireguard/i);
  assert.match(html, /Home/);
  assert.match(html, /Guest/);
  assert.doesNotMatch(html, /РФ напрямую|GeoIP/);
});

test('uses only the versioned API and contains no legacy endpoint calls', () => {
  const api = fs.readFileSync(path.join(www, 'js', 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(www, 'js', 'app.js'), 'utf8');
  assert.match(api, /\/api\/v1\/clients/);
  assert.doesNotMatch(`${api}\n${app}`, /\/api\/wireguard|backup|restore/);
  assert.match(app, /networkGroup/);
  assert.doesNotMatch(app, /routeMode|ru_direct/);
});
