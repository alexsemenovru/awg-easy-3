'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const asset = name => fs.readFileSync(path.join(root, name), 'utf8');

test('Main and Cell reserve loose rp_filter only for owned service interfaces', () => {
  const main = asset('enable-main-node.sh');
  const cell = asset('install-cell.sh');
  const helper = asset('lib/owned-rp-filter.sh');
  assert.match(main, /awg_cells_install_rp_filter main awgmainb0 awgmainc0/);
  assert.match(cell, /awg_cells_install_rp_filter cell awgcellb0 awgcellc0 awgcellu0/);
  assert.ok(main.indexOf('awg_cells_install_rp_filter main') < main.indexOf('compose up -d --no-deps main-cell'));
  assert.ok(cell.indexOf('awg_cells_install_rp_filter cell') < cell.indexOf('compose up -d cell'));
  assert.match(helper, /99-awg-easy-3-\$\{awg_rp_role\}\.conf/);
  assert.match(helper, /net\.ipv4\.conf\.\%s\.rp_filter = 2/);
  assert.doesNotMatch(helper, /net\.ipv4\.conf\.(?:all|default)\.rp_filter =/);
  assert.match(helper, /cmp -s/);
});

test('custom local image install does not enable stable auto-updates', () => {
  const installer = asset('install.sh');
  assert.match(installer, /docker image inspect "\$AWG_IMAGE"/);
  assert.match(installer, /if \[ -n "\$\{AWG_IMAGE:-\}" \]; then\s+info "Custom image selected; automatic stable updates are not enabled"/);
});
