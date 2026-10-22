'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const script = fs.readFileSync(path.join(root, 'install-cell.sh'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'docker-compose.cells-cell.yml'), 'utf8');

test('standalone Cell installer pins its image and keeps the invitation out of env and arguments', () => {
  assert.match(script, /set -eu/);
  assert.match(script, /docker image inspect -f '\{\{\.Id\}\}'/);
  assert.match(script, /CellUserBootstrap'\)\.ensureCellUserBootstrap/);
  assert.match(script, /IFS= read -r invitation/);
  assert.match(script, /stty -echo/);
  assert.match(script, /stty "\$old_tty"/);
  assert.match(script, /ln "\$secret_tmp" cell-data\/invitation/);
  assert.match(script, /stat -c %a "\$env_file"/);
  assert.doesNotMatch(script, /printf ['"]AWG_CELL_INVITATION=/);
  assert.match(compose, /AWG_CELL_INVITATION_FILE: \/cell-data\/invitation/);
  assert.match(compose, /AWG_CELL_WAN_INTERFACE: \$\{AWG_CELL_WAN_INTERFACE:\?/);
  assert.match(compose, /AWG_CELL_ENDPOINT: \$\{AWG_CELL_ENDPOINT:\?/);
  assert.match(script, /cell_endpoint=\$\(cell_public_endpoint\)/);
  assert.match(script, /cannot detect a public Cell endpoint/);
  assert.match(compose, /network_mode: host/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /- no-new-privileges:true/);
  assert.doesNotMatch(compose, /awg-easy:|AWG_PANEL_PORT|privileged: true/);
});
