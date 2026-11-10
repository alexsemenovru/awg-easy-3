'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { installationInfo } = require('../main-cell-install-info');

const root = path.join(__dirname, '..', '..');
const installer = fs.readFileSync(path.join(root, 'enable-main-node.sh'), 'utf8');
const overlay = fs.readFileSync(path.join(root, 'docker-compose.cells-main.yml'), 'utf8');
const updater = fs.readFileSync(path.join(root, 'lib', 'auto-update.sh'), 'utf8');
const manager = fs.readFileSync(path.join(root, 'awg-easy-3'), 'utf8');
const baseInstaller = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');

test('Main installer exports only validated public panel metadata', () => {
  const state = { server: { interfaceName: 'awg0', listenPort: 51820,
    panelPort: 51821, endpointHost: 'vpn.example.org', privateKey: 'never-print' },
  clients: [{ privateKey: 'never-print-client' }] };
  assert.equal(installationInfo(state), 'awg0 51820 51821 vpn.example.org\n');
  assert.throws(() => installationInfo({ server: { ...state.server,
    endpointHost: 'host\nINJECT=1' } }), /Invalid persisted/);
  assert.throws(() => installationInfo({ server: { ...state.server,
    interfaceName: '../foreign' } }), /Invalid persisted/);
});

test('Main installer is opt-in, preserves the existing panel and pins its running image', () => {
  assert.match(installer, /docker compose exec -T awg-easy test -r \/app\/main-cell-install-info\.js/);
  assert.match(installer, /docker inspect -f '\{\{\.Image\}\}' awg-easy-3/);
  assert.match(installer, /compose up -d --no-deps main-cell/);
  assert.match(installer, /stat -c %Y cell-status\/cells\.json/);
  assert.match(installer, /-S cell-status\/control\.sock/);
  assert.match(installer, /stat -c %a cell-status\/control\.sock/);
  assert.match(installer, /compose up -d --no-deps awg-easy/);
  assert.doesNotMatch(installer, /--reinstall|--remove-orphans|docker compose down/);
  assert.match(overlay, /profiles:\s*\n\s*- cells-main/);
  assert.match(overlay, /AWG_MAIN_USER_STATE_FILE: \/data\/state\.json/);
  assert.match(overlay, /AWG_MAIN_STATUS_FILE: \/cell-status\/cells\.json/);
  assert.match(overlay, /AWG_MAIN_INVITATION_SOCKET: \/cell-status\/control\.sock/);
  assert.match(overlay, /container_name: awg-easy-3-main-cell/);
  assert.doesNotMatch(overlay, /privileged: true/);
  assert.match(updater, /awg_easy_main_update_prepare/);
  assert.match(updater, /awg_easy_main_update_resume/);
  assert.match(manager, /enable-main-node\) exec "\$project_dir\/enable-main-node\.sh"/);
  assert.match(manager, /issue-cell\)[\s\S]*compose exec -T main-cell node \/app\/main-cell-cli\.js issue-auto/);
  assert.match(manager, /--env-file "\$project_dir\/\.env\.cells-main"/);
  assert.match(manager, /compose stop main-cell awg-easy/);
  assert.match(baseInstaller, /Main Node state exists; removal is disabled/);
});
