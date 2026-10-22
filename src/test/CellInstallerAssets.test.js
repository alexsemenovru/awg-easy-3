'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const script = fs.readFileSync(path.join(root, 'install-cell.sh'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'docker-compose.cells-cell.yml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const linkAgent = fs.readFileSync(path.join(root, 'src', 'link-agent.js'), 'utf8');

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

test('Cell process inventory uses neutral names without passing private state as arguments', () => {
  assert.match(compose, /container_name: network-relay/);
  assert.match(compose, /WG_QUICK_USERSPACE_IMPLEMENTATION: net-forward/);
  assert.match(compose, /- \/app\/link-agent\.js/);
  assert.match(dockerfile, /ln -s \/usr\/local\/bin\/amneziawg-go \/usr\/local\/bin\/net-forward/);
  assert.match(linkAgent, /require\('\.\/cell-cli'\)/);
  assert.match(script, /legacy Cell container exists/);
  assert.doesNotMatch(compose, /container_name: awg-easy-3-cell/);
  assert.doesNotMatch(compose, /command:\s*\n\s*-.*(?:AWG_CELL_ENDPOINT|AWG_CELL_INVITATION|privateKey)/);
});
