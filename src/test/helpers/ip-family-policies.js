'use strict';

// Synthetic policies for verify-ip-families-linux.py; never load user state.
const { renderNftablesPolicy } = require('../../lib/NftablesPolicy');
const result = {};
for (const [name, ipv4, ipv6] of [['both', true, true], ['v4', true, false], ['v6', false, true], ['off', false, false]]) {
  result[name] = renderNftablesPolicy({
    interfaceName: 'awg0', wanInterface: 'eth0', ipv4Subnet: '10.8.0.0/24', ipv6Subnet: 'fd42:8::/64',
    home4: [...(ipv4 ? ['10.8.0.2'] : []), '10.8.0.3'], guest4: ['10.8.0.4'],
    home6: [...(ipv6 ? ['fd42:8::2'] : []), 'fd42:8::3'], guest6: ['fd42:8::4'], nat66: true,
  });
}
result.empty4 = renderNftablesPolicy({ home4: [], guest4: [], home6: ['fd42:8::2'], ipv6Subnet: 'fd42:8::/64' });
result.no6 = renderNftablesPolicy({ home4: ['10.8.0.2'], guest4: [] });
console.log(JSON.stringify(result));
