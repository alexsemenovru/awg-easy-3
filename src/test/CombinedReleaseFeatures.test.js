'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// This is an explicit release-bundle guard: these completed features must not
// quietly disappear while Nodes/Cells are being integrated into the installer.
test('the combined release retains auth, UX, export and installer entry points', () => {
  const html = read('src/www/index.html');
  const app = read('src/www/js/app.js');
  const api = read('src/lib/ApiService.js');
  const http = read('src/lib/HttpServer.js');
  const installer = read('install.sh');
  const dockerfile = read('Dockerfile');

  for (const id of ['login-code', 'totp-start-form', 'totp-confirm-form',
    'auth-mode-form', 'notice', 'password-form']) assert.ok(html.includes(`id="${id}"`));
  for (const asset of ['/css/pride-panels.css', '/css/tooltips.css', '/js/tooltips.js']) {
    assert.ok(html.includes(asset), `missing ${asset}`);
  }
  assert.match(http, /\/api\/v1\/totp\/setup/);
  assert.match(http, /\/api\/v1\/totp\/confirm/);
  assert.match(http, /\/api\/v1\/auth-mode/);
  assert.match(app, /showNotice\(t\('passwordChanged'\)\)/);
  assert.match(app, /showNotice\(t\('accessApplied'/);
  assert.match(app, /showNotice\(t\('geoApplied'/);
  assert.match(app, /window\.awgTooltips\?\.attach\(node\)/);
  assert.match(api, /transliterate\(String\(name/);
  assert.match(installer, /Use detected IP \(recommended\)/);
  assert.match(installer, /Enter another public IPv4/);
  assert.match(installer, /Enter a DNS name/);
  assert.match(dockerfile, /COPY src\/ \.\//);
});
