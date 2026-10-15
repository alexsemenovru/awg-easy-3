'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const overlay = fs.readFileSync(path.join(root, 'docker-compose.cells-main.dev.yml'), 'utf8');
const cell = fs.readFileSync(path.join(root, 'docker-compose.cells-cell.dev.yml'), 'utf8');
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

test('Cell development container has private state and no web panel or automatic enrollment', () => {
  assert.match(cell, /profiles:\s*\n\s*- cells-cell/);
  assert.match(cell, /container_name: awg-easy-3-cell-dev/);
  assert.match(cell, /- \.\/cell-data:\/cell-data/);
  assert.match(cell, /AWG_CELL_STATE_DIR: \/cell-data/);
  assert.match(cell, /AWG_CELL_RUNTIME_DIR: \/run\/awg-easy-3-cell/);
  assert.match(cell, /read_only: true/);
  assert.match(cell, /- no-new-privileges:true/);
  assert.match(cell, /- \/app\/cell-cli\.js/);
  assert.doesNotMatch(cell, /privileged: true|AWG_PANEL_PORT|\/data\/state\.json/);
  assert.doesNotMatch(base, /awg-easy-3-cell-dev|cells-cell/);
});
