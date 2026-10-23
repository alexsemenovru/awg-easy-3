'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { productCellTopology } = require('../lib/CellProductTopology');
const { compileCellRouting } = require('../lib/CellRoutingPolicy');

const key = n => Buffer.alloc(32, n).toString('base64');
const cellId = 'a'.repeat(32);
const fixture = () => ({
  state: { version: 4, auth: { passwordHash: 'hash', sessionSecret: 'secret' },
    server: { interfaceName: 'awg0', wanInterface: 'eth0', privateKey: key(1),
      publicKey: key(2), address4: '10.8.0.1', ipv4Subnet: '10.8.0.0/24',
      endpointHost: 'main.example.test', listenPort: 51820, panelPort: 51821,
      profile: generateOfficialProfile() },
    clients: [{ id: 'owner', name: 'Owner', networkGroup: 'home', enabled: true,
      address4: '10.8.0.2', privateKey: key(3), publicKey: key(4) },
    { id: 'phone', name: 'Phone', entryCellId: cellId, networkGroup: 'home', enabled: true,
      address4: '10.88.0.2', privateKey: key(5), publicKey: key(6) }] },
  cells: [{ id: cellId, descriptor: { version: 1, endpointHost: 'cell.example.test',
    endpointPort: 51830, serverPublicKey: key(7), address4: '10.88.0.1',
    ipv4Subnet: '10.88.0.0/24', profile: generateOfficialProfile() } }],
});

test('product topology never mistakes permanent control AWG for a client data link', () => {
  const input = fixture();
  const result = productCellTopology(input);
  assert.equal(result.topology.links.length, 0);
  assert.deepEqual(result.panelPath.phone, { ipv4: false, ipv6: false });
  assert.deepEqual(result.panelPath.owner, { ipv4: true, ipv6: false });
  assert.equal(result.plans.find(plan => plan.node.id === cellId).peers.length, 1);
  assert.ok(!JSON.stringify(result).includes(key(5)));
  assert.ok(!JSON.stringify(result).includes('Phone'));
});

test('verified direct data link yields the Home panel route over the data interface', () => {
  const input = fixture();
  const result = productCellTopology({ ...input,
    readyLinks: [{ cellId, ipv4: true, ipv6: false }] });
  assert.deepEqual(result.panelPath.phone, { ipv4: true, ipv6: false });
  const policy = compileCellRouting({ topology: result.topology, nodeId: cellId,
    context: { clientInterface: 'awgcellu0', wanInterface: 'eth0', nat66: false,
      links: { main: { interfaceName: 'awgdata0', table: 52000, priority: 20000 } },
      panel: { address4: '10.8.0.1', port: 51821 } } });
  assert.ok(policy.commands.some(command => command.args.includes('10.8.0.1/32')
    && command.args.includes('awgdata0')));
  assert.match(policy.nftables,
    /iifname "awgcellu0" oifname "awgdata0" ip saddr 10\.88\.0\.2 ip daddr 10\.8\.0\.1 tcp dport 51821 accept/);
  assert.match(policy.nftables, /ip daddr 10\.8\.0\.1 drop/);
});

test('unknown links and exit Cells cannot be inferred from client state', () => {
  const input = fixture();
  assert.throws(() => productCellTopology({ ...input,
    readyLinks: [{ cellId: 'b'.repeat(32), ipv4: true, ipv6: false }] }), /data link/);
  assert.throws(() => productCellTopology({ ...input,
    readyLinks: [{ cellId, ipv4: false, ipv6: false }] }), /data link/);
  assert.throws(() => productCellTopology({ ...input,
    exits: { phone: 'b'.repeat(32) } }), /exit Cell/);
});

test('overlapping registered Cell subnets cannot produce a routing topology', () => {
  const input = fixture();
  input.cells.push({ id: 'b'.repeat(32), descriptor: {
    ...input.cells[0].descriptor, address4: '10.88.0.129',
    ipv4Subnet: '10.88.0.128/25' } });
  assert.throws(() => productCellTopology(input), /overlap/);
});
