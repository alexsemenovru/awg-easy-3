'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');
const { installerMessage } = require('../lib/InstallerI18n');
const rows = require('../lib/InstallerMessages.json');
const root = path.join(__dirname, '../..');
const installerPath = path.join(root, 'install.sh').replaceAll('\\', '/');
const installer = fs.readFileSync(installerPath, 'utf8').replaceAll('\r\n', '\n');
const cli = fs.readFileSync(path.join(root, 'src/cli.js'), 'utf8');
const shell = process.env.AWG_TEST_SHELL || (process.platform === 'win32' ? null : 'sh');
const shellOptions = { skip: !shell && 'POSIX shell required' };
const languages = ['en', 'ru', 'fa', 'es', 'zh-cn'];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const environment = { ...process.env };
for (const key of ['AWG_LANG', 'AWG_HOST', 'AWG_PORT', 'AWG_PANEL_PORT']) delete environment[key];
const run = (body, env = {}) => spawnSync(shell, ['-c', body, installerPath], {
  encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...environment, ...env },
});
const beforeRoot = installer.slice(0, installer.indexOf('[ "$(id -u)" -eq 0 ]'));
const functions = installer.slice(0, installer.indexOf('\nAWG_PORT_VALUE=${AWG_PORT-}'));
const functionBody = (start, end) => installer.slice(installer.indexOf(start), installer.indexOf(end));

test('generated POSIX catalog is current and all installer literals have five translations', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/build-installer-i18n.cjs'), '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const keys = new Set(rows.map((row) => row[0]));
  for (const match of installer.matchAll(/\b(?:message|die|info) (['"])(.*?)\1/g)) {
    if (match[2].includes('$')) continue;
    const key = match[2].replaceAll('\\n', '\n');
    assert.ok(keys.has(key), `Missing translation: ${key}`);
  }
});

test('shell and Node produce identical UTF-8 messages in all five languages, even with C locale', shellOptions, () => {
  for (const language of languages) {
    const body = `. ${quote(path.join(root, 'lib/installer-i18n.sh').replaceAll('\\', '/'))}\n`
      + rows.map(([key]) => `message ${quote(key.replaceAll('\n', '\\n'))} ${['A', 'B', 'C', 'D'].slice(0, (key.match(/%s/g) || []).length).join(' ')}; printf '\\001'`).join('\n');
    const result = spawnSync(shell, ['-s'], {
      input: body, encoding: 'utf8', timeout: 10000, windowsHide: true,
      env: { ...environment, AWG_LANG_VALUE: language, LC_ALL: 'C' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.split('\x01').slice(0, -1),
      rows.map(([key]) => installerMessage(language, key, 'A', 'B', 'C', 'D')), language);
  }
});

for (const [index, language] of languages.entries()) {
  test(`installer help, errors, prompts and completion use ${language}`, shellOptions, () => {
    const row = (key) => rows.find((entry) => entry[0] === key)[index];
    // Run the actual script safely: help returns before root checks or mutation.
    const help = run(`exec sh ${quote(installerPath)} --help --lang ${quote(language)}`);
    assert.equal(help.status, 0, help.stderr);
    assert.ok(help.stdout.startsWith(row('Usage: sudo ./install.sh [--host HOST] [--port UDP_PORT] [--panel-port TCP_PORT] [--lang en|ru|fa|es|zh-cn]\n')));
    const bad = run(`exec sh ${quote(installerPath)} --port 0 --lang ${quote(language)}`);
    assert.equal(bad.status, 1);
    assert.equal(bad.stderr, row('Error: ') + row('--port must be an integer between 1 and 65535') + '\n');
    const unknown = run(`exec sh ${quote(installerPath)} '--bad%s' --lang ${quote(language)}`);
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stderr, row('Error: ') + installerMessage(language, 'unknown argument: %s', '--bad%s') + '\n');
    const prompt = run(`${functions}\nis_interactive() { return 0; }\nip() { printf '1.1.1.1 dev eth0 src 8.8.8.8'; }\n`
      + `printf '3\\nvpn.example.com\\n' | { choose_endpoint_host; printf '%s' "$AWG_HOST_VALUE"; }`, { AWG_LANG: language });
    assert.equal(prompt.status, 0, prompt.stderr);
    assert.equal(prompt.stdout, 'vpn.example.com');
    assert.ok(prompt.stderr.includes(row('DNS name: ')));
    const complete = run(`${functions}\nAWG_HOST_VALUE=vpn.example.com; AWG_PORT_VALUE=44444; AWG_PANEL_PORT_VALUE=51821\n`
      + installer.slice(installer.indexOf("message '\\nInstallation complete.")), { AWG_LANG: language, AWG_IMAGE: 'local' });
    assert.equal(complete.status, 0, complete.stderr);
    assert.ok(complete.stdout.startsWith(row('\nInstallation complete.\n')));
    assert.ok(complete.stdout.includes('http://10.8.0.1:51821'));
  });
}

test('language selection accepts --lang ru, --lang -ru and AWG_LANG without option-order surprises', shellOptions, () => {
  for (const [argumentsText, env] of [['--lang ru', {}], ['--lang -ru', {}], ['', { AWG_LANG: 'ru' }]]) {
    const result = run(`set -- ${argumentsText}\n${beforeRoot}\nprintf '%s' "$AWG_LANG_VALUE"`, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ru');
  }
  const noValue = run(`exec sh ${quote(installerPath)} --lang`, { AWG_LANG: 'ru' });
  assert.equal(noValue.status, 1);
  assert.match(noValue.stderr, /Для --lang/);
});

test('translated confirmations accept native answers and never remove on EOF or an invalid answer', shellOptions, () => {
  const confirmation = functionBody('confirm_data_removal() {', '\nchoose_existing_install_action\n');
  const dependencies = functionBody('confirm_dependency_install() {', '\napt_compose_package() {');
  for (const answer of ['да', 'sí', 'si', 'بله', '是', 'yes']) {
    const result = run(`${functions}\n${confirmation}\nis_interactive() { return 0; }\nprintf '%s\\n' ${quote(answer)} | confirm_data_removal`);
    assert.equal(result.status, 0, answer + result.stderr);
  }
  for (const answer of ['нет', 'no', 'خیر', '否']) {
    const result = run(`${functions}\n${confirmation}\nis_interactive() { return 0; }\nprintf '%s\\n' ${quote(answer)} | confirm_data_removal`);
    assert.equal(result.status, 1, answer);
    const dependency = run(`${functions}\n${dependencies}\nis_interactive() { return 0; }\nprintf '%s\\n' ${quote(answer)} | confirm_dependency_install Docker`);
    assert.equal(dependency.status, 1, answer);
  }
  for (const input of ['', 'bogus\n']) {
    const result = run(`${functions}\n${confirmation}\nis_interactive() { return 0; }\nprintf '%s' ${quote(input)} | confirm_data_removal`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /nothing was removed/);
  }
});

test('unknown diagnostics and substituted values remain literal', shellOptions, () => {
  const value = String.raw`password%s$&\test`;
  assert.ok(installerMessage('ru', 'Panel password (shown once): %s', value).endsWith(value));
  const result = run(`${functions}\nmessage 'Panel password (shown once): %s' ${quote(value)}; printf '\\n'; message ${quote(value)}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Panel password (shown once): ' + value + '\n' + value);
});

test('actual init CLI translates instructions while preserving the password, URL and VPN link', async () => {
  for (const language of languages) {
    const result = { bootstrapPassword: String.raw`secret%s$&\pass`, panelUrl: 'http://10.8.0.1:51821', vpnLink: 'vpn://test-profile' };
    let output = '';
    let initialization;
    const processStub = {
      argv: ['node', 'cli.js', 'init'], env: { AWG_LANG: language },
      stdout: { write: (value) => { output += value; } },
    };
    await vm.runInNewContext(cli, {
      require: (name) => name === './lib/InstallerI18n' ? require('../lib/InstallerI18n') : {
        Application: class { async initialize(options) { initialization = options; return result; } },
      },
      process: processStub, console: { error: (value) => assert.fail(value) },
    });
    assert.equal(initialization.uiLanguage, language);
    assert.equal(output, [
      '', installerMessage(language, 'AWG-Easy 3 initialized successfully.'),
      installerMessage(language, 'Panel after VPN connection: %s', result.panelUrl),
      installerMessage(language, 'Panel password (shown once): %s', result.bootstrapPassword),
      '', installerMessage(language, 'First Home profile for AmneziaVPN:'), result.vpnLink, '',
    ].join('\n'));
  }
});
