'use strict';

// Local visual QA only. No VPN commands, real state, credentials or exports.
// node src/test/helpers/preview-panel.js [normal|unavailable|login] [port]
const { HttpServer } = require('../../lib/HttpServer');
const { ApiError } = require('../../lib/ApiService');
const mode = process.argv[2] || 'normal';
const port = Number(process.argv[3] || 0);
if (!['normal', 'unavailable', 'login'].includes(mode)) throw new Error('Unknown preview mode');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid preview port');

let authenticated = mode !== 'login';
let samples = 0;
const clients = [
  { id: 'demo-1', name: 'Home admin · DEMO', enabled: true, networkGroup: 'home', address4: '10.8.0.2', address6: 'fd00:1234::2' },
  { id: 'demo-2', name: 'Phone · DEMO', enabled: true, networkGroup: 'home', address4: '10.8.0.3', address6: 'fd00:1234::3' },
];
const server = new HttpServer({ api: {
  session: async () => ({ authenticated, language: 'ru' }),
  logout: () => { authenticated = false; return { cookie: 'preview=; Max-Age=0; Path=/' }; },
  listClients: async () => clients,
  clientDiagnostics: async () => {
    if (!authenticated) throw new ApiError(401, 'Preview session ended');
    if (mode === 'unavailable') throw new ApiError(503, 'Simulated diagnostics failure');
    samples += 1;
    return clients.map((client, index) => ({
      id: client.id, state: index === 0 ? 'online' : 'offline',
      downloadBps: samples === 1 ? null : (index === 0 ? 200 : 0),
      uploadBps: samples === 1 ? null : 0,
      sampleIntervalSeconds: samples === 1 ? null : 4,
      handshakeAgeSeconds: index === 0 ? 30 : null,
      endpoint: index === 0 ? '203.0.113.10:54321' : null,
      mtu: 1280, persistentKeepalive: '25-35',
    }));
  },
} });
server.listen({ host: '127.0.0.1', port }).then((address) => {
  console.log(`Panel preview (${mode}, synthetic data): http://127.0.0.1:${address.port}`);
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
process.on('SIGINT', () => server.close().then(() => process.exit(0)));
