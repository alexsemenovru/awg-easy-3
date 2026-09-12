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
for (const [name, mode, countries] of [['geoBlock', 'block', ['RU']], ['geoAllow', 'allow', ['RU']],
  ['geoEmptyAllow', 'allow', ['ZZ']], ['geoEmptyBlock', 'block', ['ZZ']]]) {
  result[name] = renderNftablesPolicy({
    interfaceName: 'awg0', wanInterface: 'eth0', ipv4Subnet: '10.8.0.0/24', ipv6Subnet: 'fd42:8::/64',
    home4: ['10.8.0.2', '10.8.0.3'], guest4: ['10.8.0.4'],
    home6: ['fd42:8::2', 'fd42:8::3'], guest6: ['fd42:8::4'], nat66: true,
    geoClients: [{ address4: '10.8.0.2', address6: 'fd42:8::2', policy: { mode, countries } }],
    // Synthetic labels, not actual geolocation; includes range syntax from DB-IP.
    geoDatabase: { RU: { ipv4: ['198.51.100.2-198.51.100.2'], ipv6: ['fd42:9::2-fd42:9::2'] },
      ZZ: { ipv4: [], ipv6: [] } },
  });
}
console.log(JSON.stringify(result));
