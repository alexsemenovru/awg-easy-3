'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const installer = fs.readFileSync(path.join(__dirname, '..', '..', 'install.sh'), 'utf8').replace(/\r\n/g, '\n');
const shell = process.env.AWG_TEST_SHELL || (process.platform === 'win32' ? null : 'sh');
const shellOptions = { skip: !shell && 'Set AWG_TEST_SHELL to a POSIX sh executable on Windows' };
const before = (marker) => {
  const index = installer.indexOf(marker);
  assert.ok(index > 0, `Missing installer boundary: ${marker}`);
  return installer.slice(0, index);
};
const definitions = before('AWG_HOST_VALUE=');
const portStart = installer.indexOf('port_in_use() {');
const portEnd = installer.indexOf('info "Checking interface, subnet, ports and owned object names"');
assert.ok(portStart > 0 && portEnd > portStart);
const portFunctions = installer.slice(portStart, portEnd);
const environment = { ...process.env };
delete environment.AWG_PORT;
delete environment.AWG_PANEL_PORT;
delete environment.AWG_LANG;

// Execute only pure function definitions and harmless stubs, never the installer.
const run = (body, prefix = definitions + portFunctions, env = {}) => spawnSync(shell, ['-s'], {
  input: `${prefix}\n${body}\n`, encoding: 'utf8', timeout: 10_000,
  env: { ...environment, ...env }, windowsHide: true,
});
const succeeds = (result, output) => {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), output);
};
const fails = (result, message) => {
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stdout, /SELECTED/);
};
const freePorts = 'ss() { :; }\ndocker() { :; }';

test('installer validates only explicitly supplied UDP ports before preflight', shellOptions, () => {
  const options = before('[ "$(id -u)" -eq 0 ]');
  succeeds(run('printf "%s:%s" "$AWG_PORT_EXPLICIT" "$AWG_PORT_VALUE"', options), '0:');
  succeeds(run('printf "%s:%s" "$AWG_PORT_EXPLICIT" "$AWG_PORT_VALUE"', options, { AWG_PORT: '51820' }), '1:51820');
  for (const value of ['', '0', '65536', '-2', 'abc']) {
    fails(run(':', options, { AWG_PORT: value }), /port must be an integer/);
  }
  succeeds(run('set -- --port 45321\n' + options + '\nprintf "%s:%s" "$AWG_PORT_EXPLICIT" "$AWG_PORT_VALUE"', ''), '1:45321');
});

test('random port entropy maps both inclusive range boundaries and retries rejected draws', shellOptions, () => {
  succeeds(run('od() { printf " 0\\n"; }\nrandom_port_candidate'), '20000');
  succeeds(run('od() { printf " 40000\\n"; }\nrandom_port_candidate'), '60000');
  succeeds(run('od() { if [ "$entropy_attempt" -eq 1 ]; then printf "65535\\n"; else printf "12345\\n"; fi; }\nrandom_port_candidate'), '32345');
});

test('bad or unavailable randomness fails with an actionable manual-port option', shellOptions, () => {
  for (const output of ['', 'not-a-number', '1 2', '65536', '65535']) {
    fails(run(`od() { printf '%s\\n' '${output}'; }\nrandom_port_candidate`), /use --port UDP_PORT/);
  }
  fails(run('od() { return 1; }\nrandom_port_candidate'), /unable to read random port data/);
});

test('random selector skips old default and occupied ports before selecting a free one', shellOptions, () => {
  succeeds(run(`${freePorts}
    random_port_candidate() {
      case "$random_attempt" in 1) printf '51820';; 2) printf '30000';; *) printf '40000';; esac
    }
    ss() { case "$*" in *':30000') printf 'UNCONN occupied';; esac; }
    choose_random_udp_port
  `), '40000');
});

test('random selector bounds retries when all candidates are busy', shellOptions, () => {
  fails(run(`${freePorts}
    random_port_candidate() { printf '40000'; }
    ss() { printf 'UNCONN occupied'; }
    choose_random_udp_port
  `), /after 128 attempts; use --port UDP_PORT/);
});

test('UDP conflict inspection includes connected sockets, TCP inspects listeners', shellOptions, () => {
  succeeds(run(`
    ss() { printf '%s\\n' "$*" >&2; printf 'socket'; }
    port_in_use udp 40000
    port_in_use tcp 40000
    printf 'busy'
  `), 'busy');
  const result = run(`ss() { printf '%s\\n' "$*" >&2; printf 'socket'; }; port_in_use udp 40000; port_in_use tcp 40000`);
  assert.match(result.stderr, /-H -uan sport = :40000/);
  assert.match(result.stderr, /-H -ltn sport = :40000/);
});

test('Docker DNAT port without a listening proxy is reserved only for its protocol', shellOptions, () => {
  const dockerPorts = `
    ss() { :; }
    docker() {
      case "$1" in ps) printf '0123abcd';; inspect) printf '53/udp 40000\\n80/tcp 45000\\n';; *) return 2;; esac
    }
  `;
  succeeds(run(`${dockerPorts}
    port_in_use udp 40000
    port_in_use tcp 45000
    if port_in_use tcp 40000 || port_in_use udp 45000 || port_in_use udp 50000; then exit 9; fi
    printf 'protocol-aware'
  `), 'protocol-aware');
  succeeds(run(`${dockerPorts}
    random_port_candidate() { if [ "$random_attempt" -eq 1 ]; then printf '40000'; else printf '45000'; fi; }
    choose_random_udp_port
  `), '45000');
});

test('socket and Docker inspection failures cannot be mistaken for a free port', shellOptions, () => {
  for (const [stub, message] of [
    ['ss() { return 2; }', /unable to inspect UDP sockets/],
    ['docker() { return 2; }', /unable to inspect Docker port ownership/],
    ['docker() { if [ "$1" = ps ]; then printf abcd; else return 2; fi; }', /unable to inspect Docker published ports/],
    ['docker() { printf abcd; }; awk() { return 2; }', /unable to parse Docker published ports/],
  ]) {
    fails(run(`${freePorts}\n${stub}
      random_port_candidate() { printf '40000'; }
      selected=$(choose_random_udp_port)
      printf 'SELECTED %s' "$selected"
    `), message);
  }
});

test('manual free port including 51820 is preserved and manual conflict gives a suggestion', shellOptions, () => {
  succeeds(run(`${freePorts}\nchoose_available_port udp 51820 1 'AWG UDP'`), '51820');
  fails(run(`${freePorts}
    ss() { case "$*" in *':51820') printf 'occupied';; esac; }
    choose_available_port udp 51820 1 'AWG UDP'
  `), /port 51820 is already in use; choose another value \(for example 51821\)/);
});

test('noninteractive panel conflict explains the option instead of silently changing it', shellOptions, () => {
  fails(run(`${freePorts}
    ss() { case "$*" in *':51821') printf 'occupied';; esac; }
    is_interactive() { return 1; }
    choose_available_port tcp 51821 0 'Panel TCP'
  `), /rerun with --panel-port 51822/);
});

test('random selection is only a clean-install step and exported before bootstrap', () => {
  const selection = installer.indexOf('AWG_PORT_VALUE=$(choose_random_udp_port)');
  assert.ok(selection > installer.indexOf('[ ! -e data/state.json ]'));
  assert.match(installer, /if \[ "\$AWG_PORT_EXPLICIT" -eq 0 \]; then\s+AWG_PORT_VALUE=\$\(choose_random_udp_port\)/);
  assert.ok(selection < installer.indexOf('export AWG_PORT='));
  assert.match(installer, /-e AWG_PORT="\$AWG_PORT_VALUE"/);
  const manager = fs.readFileSync(path.join(__dirname, '..', '..', 'awg-easy-3'), 'utf8');
  const update = manager.slice(manager.indexOf('  update)'), manager.indexOf('  reset-password)'));
  assert.doesNotMatch(update, /init|reinstall|choose_random|AWG_PORT=/);
});
