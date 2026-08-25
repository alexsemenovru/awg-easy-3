'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');

test('pins amd64 base images and official AWG source revisions', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.equal((dockerfile.match(/FROM --platform=linux\/amd64/g) || []).length, 4);
  assert.equal((dockerfile.match(/@sha256:[a-f0-9]{64}/g) || []).length, 4);
  assert.match(dockerfile, /AWG_GO_COMMIT=1b86b2ae0e493e7ea93f8c1a0f0cb6735b1551f1/);
  assert.match(dockerfile, /AWG_TOOLS_COMMIT=ee0f0a9aa34ff0a0da4b3433b9512781cfe02843/);
  assert.doesNotMatch(dockerfile, /:latest/);
  assert.match(compose, /network_mode: host/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /AWG_LANG: \$\{AWG_LANG:-en\}/);
  assert.match(compose, /ghcr\.io\/alexsemenovru\/awg-easy-3:0\.1\.0-rc\.6/);
  assert.match(dockerfile, /\$\{AWG_PANEL_PORT\}/);
  assert.doesNotMatch(compose, /SYS_MODULE|ports:/);
});

test('installs only the minimal Node runtime dependency set', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'src', 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ['bcryptjs', 'qrcode']);
  assert.equal(packageJson.devDependencies, undefined);
});

test('installer initializes before startup and never publishes the panel port', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const cli = fs.readFileSync(path.join(root, 'src', 'cli.js'), 'utf8');
  assert.match(installer, /x86_64\|amd64/);
  assert.match(installer, /docker compose run[\s\S]*awg-easy init/);
  assert.match(installer, /docker compose pull awg-easy/);
  assert.doesNotMatch(installer, /docker compose build/);
  assert.match(installer, /docker compose up -d awg-easy/);
  assert.ok(installer.indexOf('docker compose pull awg-easy') < installer.indexOf('Enabling IPv4/IPv6 forwarding'));
  assert.ok(installer.indexOf(' awg-easy init') < installer.indexOf('docker compose up -d'));
  assert.match(installer, /http:\/\/10\.8\.0\.1:%s/);
  assert.doesNotMatch(installer, /51821:51821/);
  assert.match(cli, /First Home profile for AmneziaVPN/);
  assert.doesNotMatch(cli, /type:\s*['"]terminal['"]/);
});

test('installer rejects network conflicts before changing host settings', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const forwarding = installer.indexOf('Enabling IPv4/IPv6 forwarding');
  for (const preflight of [
    'ip link show dev awg0',
    'ip -4 route show exact 10.8.0.0/24',
    'docker container inspect awg-easy-3',
    'nft list table inet awg_easy_3',
    'choose_available_port udp',
    'choose_available_port tcp',
  ]) {
    assert.match(installer, new RegExp(preflight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(installer.indexOf(preflight) < forwarding);
  }
});

test('installer can provision missing runtime dependencies without replacing foreign state', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  assert.match(installer, /detect_package_manager/);
  assert.match(installer, /apt-get dnf yum zypper pacman apk/);
  assert.match(installer, /docker-compose-v2/);
  assert.match(installer, /docker-compose-plugin/);
  assert.match(installer, /NixOS detected/);
  assert.match(installer, /virtualisation\.docker\.enable = true/);
  assert.match(installer, /\.\/awg-easy-3-runtime\.nix/);
  assert.match(installer, /nixos-rebuild switch/);
  assert.match(installer, /--option max-jobs 1 --option cores 1/);
  assert.match(installer, /does not edit configuration\.nix automatically/);
  assert.match(installer, /systemctl enable --now docker/);
  assert.match(installer, /the installer will not remove an existing container/);
  assert.match(installer, /the installer will not overwrite an unowned or stale table/);
  assert.doesNotMatch(installer, /docker (rm|stop|kill) /);
  assert.doesNotMatch(installer, /nft (delete|flush) table (?!inet awg_easy_3)/);
});

test('installer suggests ports interactively but keeps explicit options strict', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  assert.match(installer, /AWG_PORT_EXPLICIT/);
  assert.match(installer, /AWG_PANEL_PORT_EXPLICIT/);
  assert.match(installer, /next_free_port/);
  assert.match(installer, /Enter another port/);
  assert.match(installer, /rerun with --\$option/);
  assert.match(installer, /choose another value \(for example \$suggestion\)/);
});

test('installer offers owned uninstall and clean reinstall without touching foreign infrastructure', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const manager = fs.readFileSync(path.join(root, 'awg-easy-3'), 'utf8');
  assert.match(installer, /--uninstall/);
  assert.match(installer, /--reinstall/);
  assert.match(installer, /Keep the current installation and exit/);
  assert.match(installer, /Uninstall and permanently delete all clients and settings/);
  assert.match(installer, /Reinstall from scratch and permanently delete all clients and settings/);
  assert.match(installer, /com\.docker\.compose\.project\.working_dir/);
  assert.match(installer, /com\.docker\.compose\.service/);
  assert.match(installer, /docker compose --project-directory "\$EXISTING_INSTALL_DIR"/);
  assert.match(installer, /rm -rf -- "\$EXISTING_INSTALL_DIR\/data"/);
  assert.match(installer, /rm -f -- \/etc\/sysctl\.d\/99-awg-easy-3\.conf/);
  assert.match(installer, /Host forwarding values were left unchanged/);
  assert.match(installer, /ip link delete dev awg0/);
  assert.match(installer, /nft delete table inet awg_easy_3/);
  for (const marker of ['awg_easy_3_forward_v4', 'awg_easy_3_return_v4', 'awg_easy_3_forward_v6', 'awg_easy_3_return_v6']) {
    assert.match(installer, new RegExp(marker));
  }
  assert.match(installer, /nft delete rule "\$family" filter DOCKER-USER handle/);
  assert.match(installer, /\/usr\/local\/sbin\/awg-easy-3/);
  assert.match(installer, /\/etc\/awg-easy-3-install-dir/);
  assert.match(installer, /install -m 0755 "\$SCRIPT_DIR\/awg-easy-3"/);
  assert.match(installer, /Run sudo awg-easy-3 from any directory/);
  assert.match(installer, /Confirmation input was closed; nothing was removed/);
  assert.match(installer, /Please answer y\/yes \(or д\/да\)/);
  for (const command of ['start', 'stop', 'restart', 'status', 'settings', 'logs', 'diagnose', 'update', 'reset-password', 'export-client', 'uninstall', 'reinstall']) {
    assert.match(manager, new RegExp(`\\b${command.replace('-', '\\-')}\\b`));
  }
  assert.match(manager, /docker compose --project-directory "\$project_dir"/);
  assert.match(manager, /git -C "\$project_dir" pull --ff-only/);
  assert.doesNotMatch(manager, /docker system prune|docker volume prune|docker image prune/);
  assert.ok(installer.indexOf(' down --remove-orphans') < installer.indexOf('rm -rf -- "$EXISTING_INSTALL_DIR/data"'));
  assert.doesNotMatch(installer, /docker system prune|docker volume prune|docker image prune/);
});

test('installer accepts validated AWG port, panel port and language options', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  assert.match(installer, /--port/);
  assert.match(installer, /--panel-port/);
  assert.match(installer, /--lang/);
  assert.match(installer, /en\|ru\|fa\|es\|zh-cn/);
  assert.match(installer, /valid_port/);
});

test('installer rejects non-Linux kernels and WSL before provisioning packages', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const dependencyProvisioning = installer.indexOf('install_runtime_dependencies');
  for (const platformCheck of [
    'FreeBSD|OpenBSD|NetBSD|Darwin',
    "grep -qiE '(microsoft|wsl)'",
    'requires Docker Engine, Linux TUN networking and nftables',
  ]) {
    assert.match(installer, new RegExp(platformCheck.replace(/[.*+?^${}()[\]\\]/g, '\\$&')));
    assert.ok(installer.indexOf(platformCheck) < dependencyProvisioning);
  }
});
