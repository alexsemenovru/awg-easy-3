'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { TABLE_NAME, buildAtomicNftBatch } = require('./NftablesPolicy');
const { runProcess } = require('./ProcessRunner');

const validateInterface = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(value)) {
    throw new TypeError('interfaceName must be a valid Linux interface name');
  }
  return value;
};

const requireManagedText = (value, marker, field) => {
  if (typeof value !== 'string' || !value.includes(marker)) {
    throw new TypeError(`${field} is not a managed AWG-Easy 3 artifact`);
  }
  return value.endsWith('\n') ? value : `${value}\n`;
};

class RuntimeApplier {
  constructor({
    runtimeDirectory = '/etc/awg-easy-3',
    runner = runProcess,
    fileSystem = fs,
    awgBinary = 'awg',
    awgQuickBinary = 'awg-quick',
    nftBinary = 'nft',
  } = {}) {
    if (typeof runner !== 'function') throw new TypeError('runner must be a function');
    if (!fileSystem || typeof fileSystem.writeFile !== 'function') {
      throw new TypeError('fileSystem must provide promise-based file methods');
    }
    this.runtimeDirectory = path.resolve(runtimeDirectory);
    this.runner = runner;
    this.fs = fileSystem;
    this.awgBinary = awgBinary;
    this.awgQuickBinary = awgQuickBinary;
    this.nftBinary = nftBinary;
  }

  async tableExists() {
    try {
      await this.runner(this.nftBinary, ['list', 'table', 'inet', TABLE_NAME]);
      return true;
    } catch (error) {
      if (error && (error.code === 1 || error.exitCode === 1)) return false;
      throw error;
    }
  }

  async readOptional(filePath) {
    try {
      return await this.fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async apply({ serverConfig, nftables, interfaceName = 'awg0', interfaceActive = false }) {
    const awgInterface = validateInterface(interfaceName);
    const config = requireManagedText(serverConfig, '[Interface]', 'serverConfig');
    const policy = requireManagedText(nftables, `table inet ${TABLE_NAME} {`, 'nftables');
    if (typeof interfaceActive !== 'boolean') throw new TypeError('interfaceActive must be a boolean');

    await this.fs.mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    const stagingDirectory = await this.fs.mkdtemp(path.join(this.runtimeDirectory, '.apply-'));
    const stagedConfigPath = path.join(stagingDirectory, `${awgInterface}.conf`);
    const stagedNftPath = path.join(stagingDirectory, 'rules.batch.nft');
    const stagedPolicyPath = path.join(stagingDirectory, 'rules.nft');
    const activeConfigPath = path.join(this.runtimeDirectory, `${awgInterface}.conf`);
    const activeNftPath = path.join(this.runtimeDirectory, 'rules.nft');

    const previousConfig = await this.readOptional(activeConfigPath);
    const previousPolicy = await this.readOptional(activeNftPath);
    let newStripped;
    let previousStripped;
    let awgChanged = false;
    let nftChanged = false;
    let configPersisted = false;
    let policyPersisted = false;
    const existed = await this.tableExists();

    try {
      const nftBatch = buildAtomicNftBatch(policy, { tableExists: existed });
      await this.fs.writeFile(stagedConfigPath, config, { mode: 0o600, flag: 'wx' });
      await this.fs.writeFile(stagedNftPath, nftBatch, { mode: 0o600, flag: 'wx' });
      await this.fs.writeFile(stagedPolicyPath, policy, { mode: 0o600, flag: 'wx' });

      ({ stdout: newStripped } = await this.runner(this.awgQuickBinary, ['strip', stagedConfigPath]));
      if (interfaceActive) {
        if (!previousConfig) throw new Error('Active AWG interface has no saved configuration to roll back to');
        const previousPath = path.join(stagingDirectory, 'previous.conf');
        await this.fs.writeFile(previousPath, previousConfig, { mode: 0o600, flag: 'wx' });
        ({ stdout: previousStripped } = await this.runner(this.awgQuickBinary, ['strip', previousPath]));
      }
      await this.runner(this.nftBinary, ['-c', '-f', stagedNftPath]);

      if (interfaceActive) {
        await this.runner(this.awgBinary, ['syncconf', awgInterface, '/dev/stdin'], {
          input: `${newStripped}\n`,
        });
      } else {
        await this.runner(this.awgQuickBinary, ['up', stagedConfigPath]);
      }
      awgChanged = true;

      await this.runner(this.nftBinary, ['-f', stagedNftPath]);
      nftChanged = true;

      const persistedConfigPath = path.join(stagingDirectory, 'persisted.conf');
      const persistedPolicyPath = path.join(stagingDirectory, 'persisted.nft');
      await this.fs.copyFile(stagedConfigPath, persistedConfigPath);
      await this.fs.copyFile(stagedPolicyPath, persistedPolicyPath);
      await this.fs.rename(persistedConfigPath, activeConfigPath);
      configPersisted = true;
      await this.fs.rename(persistedPolicyPath, activeNftPath);
      policyPersisted = true;
      await this.fs.chmod(activeConfigPath, 0o600);
      await this.fs.chmod(activeNftPath, 0o600);
      return Object.freeze({ interfaceActive: true, tableExisted: existed });
    } catch (error) {
      const rollbackErrors = [];
      for (const [changed, filePath, previous] of [
        [policyPersisted, activeNftPath, previousPolicy],
        [configPersisted, activeConfigPath, previousConfig],
      ]) {
        if (!changed) continue;
        try {
          if (previous === null) {
            await this.fs.rm(filePath, { force: true });
          } else {
            await this.fs.writeFile(filePath, previous, { mode: 0o600 });
            await this.fs.chmod(filePath, 0o600);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (nftChanged) {
        try {
          if (previousPolicy) {
            const rollbackPath = path.join(stagingDirectory, 'rollback.nft');
            await this.fs.writeFile(
              rollbackPath,
              buildAtomicNftBatch(previousPolicy, { tableExists: true }),
              { mode: 0o600, flag: 'wx' },
            );
            await this.runner(this.nftBinary, ['-f', rollbackPath]);
          } else {
            await this.runner(this.nftBinary, ['delete', 'table', 'inet', TABLE_NAME]);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (awgChanged) {
        try {
          if (interfaceActive) {
            await this.runner(this.awgBinary, ['syncconf', awgInterface, '/dev/stdin'], {
              input: `${previousStripped}\n`,
            });
          } else {
            await this.runner(this.awgQuickBinary, ['down', stagedConfigPath]);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      error.rollbackErrors = Object.freeze(rollbackErrors);
      throw error;
    } finally {
      await this.fs.rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}

module.exports = { RuntimeApplier };
