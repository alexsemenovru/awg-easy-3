'use strict';

const { runProcess } = require('./ProcessRunner');

const validInterface = value => typeof value === 'string'
  && /^[A-Za-z0-9_.-]{1,15}$/.test(value);
const validSubnet = value => typeof value === 'string'
  && /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[12]?\d|3[0-2])$/.test(value)
  && value.split('/')[0].split('.').every(part => Number(part) <= 255);

class CellDockerForwarding {
  constructor({ server, runner = runProcess } = {}) {
    if (!server || !validInterface(server.interfaceName)
      || !validInterface(server.wanInterface)
      || server.interfaceName === server.wanInterface
      || !validSubnet(server.ipv4Subnet) || typeof runner !== 'function') {
      throw new TypeError('Cell interface, WAN interface and IPv4 subnet required');
    }
    this.server = server;
    this.runner = runner;
  }

  async ensure() {
    let chain, forward;
    try {
      ({ stdout: chain } = await this.runner('iptables-legacy', ['-S', 'DOCKER-USER']));
      ({ stdout: forward } = await this.runner('iptables-legacy', ['-S', 'FORWARD']));
    } catch (error) {
      if (error?.code === 1 || error?.exitCode === 1) return false;
      throw error;
    }
    if (!chain.includes('-N DOCKER-USER')
      || !forward.includes('-A FORWARD -j DOCKER-USER')) return false;
    const { interfaceName, wanInterface, ipv4Subnet } = this.server;
    for (const [marker, args] of [
      ['awg_easy_3_cell_forward_v4', ['-i', interfaceName, '-o', wanInterface,
        '-s', ipv4Subnet]],
      ['awg_easy_3_cell_return_v4', ['-i', wanInterface, '-o', interfaceName,
        '-d', ipv4Subnet, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED']],
    ]) {
      const rule = [...args, '-m', 'comment', '--comment', marker, '-j', 'ACCEPT'];
      if (chain.includes(`--comment ${marker}`) || chain.includes(`--comment "${marker}"`)) {
        await this.runner('iptables-legacy', ['-C', 'DOCKER-USER', ...rule]);
        continue;
      }
      await this.runner('iptables-legacy', ['-I', 'DOCKER-USER', '1', ...rule]);
    }
    return true;
  }
}

module.exports = { CellDockerForwarding };
