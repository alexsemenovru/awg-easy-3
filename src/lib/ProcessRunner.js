'use strict';

const childProcess = require('node:child_process');

const DEFAULT_MAX_OUTPUT = 1024 * 1024;

const assertToken = (value, field) => {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new TypeError(`${field} must be a non-empty string without control line breaks`);
  }
  return value;
};

const runProcess = (file, args = [], {
  input,
  maxOutputBytes = DEFAULT_MAX_OUTPUT,
  timeoutMs = 30_000,
  env,
  cwd,
  execFile = childProcess.execFile,
} = {}) => {
  assertToken(file, 'file');
  if (!Array.isArray(args)) throw new TypeError('args must be an array');
  const safeArgs = args.map((argument, index) => assertToken(argument, `args[${index}]`));
  if (input !== undefined && typeof input !== 'string' && !Buffer.isBuffer(input)) {
    throw new TypeError('input must be a string or Buffer');
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new TypeError('maxOutputBytes must be a positive integer');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive integer');
  }

  return new Promise((resolve, reject) => {
    const child = execFile(file, safeArgs, {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: maxOutputBytes,
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout = '', stderr = '') => {
      if (error) {
        error.command = Object.freeze({ file, args: Object.freeze([...safeArgs]) });
        error.stderr = String(stderr).trim();
        return reject(error);
      }
      return resolve(Object.freeze({
        stdout: String(stdout).trim(),
        stderr: String(stderr).trim(),
      }));
    });

    if (input !== undefined) child.stdin.end(input);
  });
};

module.exports = {
  DEFAULT_MAX_OUTPUT,
  runProcess,
};
