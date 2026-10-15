'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const overlay = fs.readFileSync(path.join(root, 'docker-compose.cells-main.dev.yml'), 'utf8');
const base = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');

test('Main Cell development sidecar is opt-in and cannot silently replace the user panel', () => {
  assert.match(overlay, /profiles:\s*\n\s*- cells-main/);
  assert.match(overlay, /container_name: awg-easy-3-main-cell-dev/);
  assert.match(overlay, /- \.\/data:\/data:ro/);
  assert.match(overlay, /- \.\/cell-data:\/cell-data/);
  assert.match(overlay, /AWG_MAIN_USER_STATE_FILE: \/data\/state\.json/);
  assert.match(overlay, /read_only: true/);
  assert.match(overlay, /- no-new-privileges:true/);
  assert.match(overlay, /- \/app\/main-cell-cli\.js/);
  assert.doesNotMatch(overlay, /privileged: true/);
  assert.doesNotMatch(base, /main-cell|cells-main/);
});
