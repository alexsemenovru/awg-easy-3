'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { RuntimeApplier } = require('../lib/RuntimeApplier');

const CONFIG = '# Managed by AWG-Easy 3\n[Interface]\nPrivateKey = secret\n';
const POLICY = '# Managed by AWG-Easy 3\ntable inet awg_easy_3 {\n}\n';

const temporaryDirectory = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-runtime-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};

test('preflights nftables before bringing up a new interface', async (t) => {
  const directory = await temporaryDirectory(t);
  const calls = [];
  const runner = async (file, args, options = {}) => {
    calls.push({ file, args, options });
    if (args[0] === 'list') throw Object.assign(new Error('missing'), { code: 1 });
    if (args[0] === 'strip') return { stdout: '[Interface]\nPrivateKey = secret', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const result = await new RuntimeApplier({ runtimeDirectory: directory, runner }).apply({
    serverConfig: CONFIG,
    nftables: POLICY,
  });

  assert.equal(result.interfaceActive, true);
  assert.deepEqual(calls.map((call) => `${call.file} ${call.args[0]}`), [
    'nft list', 'nft -a', 'nft -a', 'awg-quick strip', 'nft -c', 'awg-quick up', 'nft -f',
  ]);
  assert.equal(await fs.readFile(path.join(directory, 'awg0.conf'), 'utf8'), CONFIG);
  assert.equal(await fs.readFile(path.join(directory, 'rules.nft'), 'utf8'), POLICY);
});

test('rolls an active interface back when nftables application fails', async (t) => {
  const directory = await temporaryDirectory(t);
  await fs.writeFile(path.join(directory, 'awg0.conf'), CONFIG.replace('secret', 'old-secret'));
  await fs.writeFile(path.join(directory, 'rules.nft'), POLICY);
  const syncInputs = [];
  const runner = async (file, args, options = {}) => {
    if (args[0] === 'list') return { stdout: '', stderr: '' };
    if (args[0] === 'strip') {
      return { stdout: args[1].endsWith('previous.conf') ? 'old-stripped' : 'new-stripped', stderr: '' };
    }
    if (file === 'awg' && args[0] === 'syncconf') syncInputs.push(options.input);
    if (file === 'nft' && args[0] === '-f') throw new Error('nft apply failed');
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(
    new RuntimeApplier({ runtimeDirectory: directory, runner }).apply({
      serverConfig: CONFIG,
      nftables: POLICY,
      interfaceActive: true,
    }),
    /nft apply failed/,
  );
  assert.deepEqual(syncInputs, ['new-stripped\n', 'old-stripped\n']);
  assert.match(await fs.readFile(path.join(directory, 'awg0.conf'), 'utf8'), /old-secret/);
});

test('does not touch AWG when nftables syntax validation fails', async (t) => {
  const directory = await temporaryDirectory(t);
  const calls = [];
  const runner = async (file, args) => {
    calls.push({ file, args });
    if (args[0] === 'list') throw Object.assign(new Error('missing'), { code: 1 });
    if (args[0] === 'strip') return { stdout: 'stripped', stderr: '' };
    if (file === 'nft' && args[0] === '-c') throw new Error('syntax error');
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(
    new RuntimeApplier({ runtimeDirectory: directory, runner }).apply({
      serverConfig: CONFIG,
      nftables: POLICY,
    }),
    /syntax error/,
  );
  assert.equal(calls.some((call) => call.file === 'awg-quick' && call.args[0] === 'up'), false);
});

test('restores runtime and persisted files when final persistence fails', async (t) => {
  const directory = await temporaryDirectory(t);
  let renameCount = 0;
  const fileSystem = {
    ...fs,
    rename: async (source, destination) => {
      renameCount++;
      if (renameCount === 2) throw new Error('simulated disk failure');
      return fs.rename(source, destination);
    },
  };
  const calls = [];
  const runner = async (file, args) => {
    calls.push({ file, args });
    if (args[0] === 'list') throw Object.assign(new Error('missing'), { code: 1 });
    if (args[0] === 'strip') return { stdout: 'stripped', stderr: '' };
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(
    new RuntimeApplier({ runtimeDirectory: directory, runner, fileSystem }).apply({
      serverConfig: CONFIG,
      nftables: POLICY,
    }),
    /simulated disk failure/,
  );
  await assert.rejects(fs.readFile(path.join(directory, 'awg0.conf')), /ENOENT/);
  assert.equal(calls.some((call) => call.file === 'nft' && call.args[0] === 'delete'), true);
  assert.equal(calls.some((call) => call.file === 'awg-quick' && call.args[0] === 'down'), true);
});

test('stops only its saved AWG interface and dedicated nftables table', async (t) => {
  const directory = await temporaryDirectory(t);
  const calls = [];
  const runner = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: '', stderr: '' };
  };
  await new RuntimeApplier({ runtimeDirectory: directory, runner }).down({ interfaceName: 'awg0' });
  assert.deepEqual(calls, [
    ['awg-quick', 'down', path.join(directory, 'awg0.conf')],
    ['nft', 'list', 'table', 'inet', 'awg_easy_3'],
    ['nft', 'delete', 'table', 'inet', 'awg_easy_3'],
    ['nft', '-a', 'list', 'chain', 'ip', 'filter', 'DOCKER-USER'],
    ['nft', '-a', 'list', 'chain', 'ip6', 'filter', 'DOCKER-USER'],
  ]);
});

test('adds and removes only marked awg0 rules in Docker user chains', async (t) => {
  const directory = await temporaryDirectory(t);
  const batches = [];
  const deleted = [];
  const runner = async (file, args) => {
    if (args[0] === 'list' && args[1] === 'table') {
      throw Object.assign(new Error('missing'), { code: 1 });
    }
    if (args[0] === '-a' && args[2] === 'chain') {
      const family = args[3];
      return {
        stdout: family === 'ip'
          ? 'chain DOCKER-USER {\n iifname "awg0" accept comment "awg_easy_3_forward_v4" # handle 41\n}'
          : 'chain DOCKER-USER {\n}',
        stderr: '',
      };
    }
    if (args[0] === 'strip') return { stdout: 'stripped', stderr: '' };
    if (file === 'nft' && args[0] === '-f') batches.push(await fs.readFile(args[1], 'utf8'));
    if (file === 'nft' && args[0] === 'delete' && args[1] === 'rule') deleted.push(args);
    return { stdout: '', stderr: '' };
  };
  const applier = new RuntimeApplier({ runtimeDirectory: directory, runner });

  await applier.apply({ serverConfig: CONFIG, nftables: POLICY });
  const dockerBatch = batches.find((batch) => batch.includes('DOCKER-USER'));
  assert.doesNotMatch(dockerBatch, /awg_easy_3_forward_v4/);
  assert.match(dockerBatch, /awg_easy_3_return_v4/);
  assert.match(dockerBatch, /awg_easy_3_forward_v6/);

  await applier.removeDockerCompatibility(['awg_easy_3_forward_v4']);
  assert.deepEqual(deleted, [
    ['delete', 'rule', 'ip', 'filter', 'DOCKER-USER', 'handle', '41'],
  ]);
});
