'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runProcess } = require('../lib/ProcessRunner');

test('uses execFile without a shell and keeps arguments separate', async () => {
  let invocation;
  const execFile = (file, args, options, callback) => {
    invocation = { file, args, options };
    queueMicrotask(() => callback(null, ' value \n', ''));
    return { stdin: { end() {} } };
  };

  const result = await runProcess('nft', ['-c', '-f', '/run/awg easy/rules.nft'], { execFile });
  assert.equal(invocation.file, 'nft');
  assert.deepEqual(invocation.args, ['-c', '-f', '/run/awg easy/rules.nft']);
  assert.equal(invocation.options.shell, false);
  assert.equal(result.stdout, 'value');
});

test('passes secret material through stdin instead of a command string', async () => {
  let suppliedInput;
  const execFile = (file, args, options, callback) => {
    queueMicrotask(() => callback(null, 'public-key\n', ''));
    return { stdin: { end(input) { suppliedInput = input; } } };
  };

  await runProcess('awg', ['pubkey'], { input: 'private-key\n', execFile });
  assert.equal(suppliedInput, 'private-key\n');
});

test('rejects tokens containing line breaks or null bytes', () => {
  assert.throws(() => runProcess('nft\nrm', []), /file/);
  assert.throws(() => runProcess('nft', ['-f', 'rules\nmalicious']), /args\[1\]/);
  assert.throws(() => runProcess('nft\0', []), /file/);
});

test('preserves safe command metadata and stderr on failure', async () => {
  const execFile = (file, args, options, callback) => {
    const error = new Error('exited with status 1');
    queueMicrotask(() => callback(error, '', 'syntax error\n'));
    return { stdin: { end() {} } };
  };

  await assert.rejects(
    runProcess('nft', ['-c', '-f', '/run/awg-easy-3/rules.nft'], { execFile }),
    (error) => {
      assert.deepEqual(error.command, {
        file: 'nft',
        args: ['-c', '-f', '/run/awg-easy-3/rules.nft'],
      });
      assert.equal(error.stderr, 'syntax error');
      return true;
    },
  );
});
