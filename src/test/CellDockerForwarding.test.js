'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CellDockerForwarding } = require('../lib/CellDockerForwarding');

const server = { interfaceName: 'awgcellu0', wanInterface: 'eth0', ipv4Subnet: '10.64.0.0/24' };

test('legacy Docker forwarding is limited to Cell interface, WAN and subnet', async () => {
  const calls = [];
  const runner = async (command, args) => {
    assert.equal(command, 'iptables-legacy');
    calls.push(args);
    if (args[0] === '-S' && args[1] === 'DOCKER-USER') {
      return { stdout: '-N DOCKER-USER\n-A DOCKER-USER -j RETURN\n' };
    }
    if (args[0] === '-S' && args[1] === 'FORWARD') {
      return { stdout: '-P FORWARD DROP\n-A FORWARD -j DOCKER-USER\n' };
    }
    return { stdout: '' };
  };
  assert.equal(await new CellDockerForwarding({ server, runner }).ensure(), true);
  assert.deepEqual(calls.slice(2), [
    ['-I', 'DOCKER-USER', '1', '-i', 'awgcellu0', '-o', 'eth0', '-s', '10.64.0.0/24',
      '-m', 'comment', '--comment', 'awg_easy_3_cell_forward_v4', '-j', 'ACCEPT'],
    ['-I', 'DOCKER-USER', '1', '-i', 'eth0', '-o', 'awgcellu0', '-d', '10.64.0.0/24',
      '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED',
      '-m', 'comment', '--comment', 'awg_easy_3_cell_return_v4', '-j', 'ACCEPT'],
  ]);
});

test('missing Docker legacy chain leaves host firewall unchanged', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push(args);
    throw Object.assign(new Error('No chain'), { code: 1 });
  };
  assert.equal(await new CellDockerForwarding({ server, runner }).ensure(), false);
  assert.deepEqual(calls, [['-S', 'DOCKER-USER']]);
});

test('Docker without a legacy filter table needs no compatibility rules', async () => {
  const runner = async () => {
    throw Object.assign(new Error('iptables failed'), { code: 3,
      stderr: "iptables v1.8.11 (legacy): can't initialize iptables table `filter': Table does not exist (do you need to insmod?)" });
  };
  assert.equal(await new CellDockerForwarding({ server, runner }).ensure(), false);
});

test('other legacy firewall errors are not silently ignored', async () => {
  const runner = async () => {
    throw Object.assign(new Error('iptables failed'), { code: 3,
      stderr: 'iptables v1.8.11 (legacy): Permission denied' });
  };
  await assert.rejects(new CellDockerForwarding({ server, runner }).ensure(), /iptables failed/);
});

test('existing owned rules are verified, not duplicated', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push(args);
    if (args[0] === '-S' && args[1] === 'DOCKER-USER') return { stdout: [
      '-N DOCKER-USER',
      '-A DOCKER-USER -m comment --comment awg_easy_3_cell_forward_v4 -j ACCEPT',
      '-A DOCKER-USER -m comment --comment awg_easy_3_cell_return_v4 -j ACCEPT',
    ].join('\n') };
    if (args[0] === '-S') return { stdout: '-A FORWARD -j DOCKER-USER' };
    return { stdout: '' };
  };
  await new CellDockerForwarding({ server, runner }).ensure();
  assert.deepEqual(calls.map(args => args[0]), ['-S', '-S', '-C', '-C']);
});

test('unverifiable existing marker fails closed', async () => {
  const runner = async (command, args) => {
    if (args[0] === '-S' && args[1] === 'DOCKER-USER') return {
      stdout: '-N DOCKER-USER\n-A DOCKER-USER -m comment --comment awg_easy_3_cell_forward_v4 -j ACCEPT',
    };
    if (args[0] === '-S') return { stdout: '-A FORWARD -j DOCKER-USER' };
    throw Object.assign(new Error('mismatched rule'), { code: 1 });
  };
  await assert.rejects(new CellDockerForwarding({ server, runner }).ensure(), /mismatched rule/);
});
