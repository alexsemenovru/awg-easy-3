'use strict';

// Local visual QA only. No VPN commands, real state, credentials or exports.
// node src/test/helpers/preview-panel.js [normal|residual|unavailable|login|families] [port]
const { HttpServer } = require('../../lib/HttpServer');
const { ApiError, publicClient } = require('../../lib/ApiService');
const { changeClientTraffic, assertCurrentPanelPathRemains } = require('../../lib/ClientTraffic');
const { assertActiveHomeRemains } = require('../../lib/ClientPolicy');
const fs = require('node:fs/promises');
const path = require('node:path');
const mode = process.argv[2] || 'normal';
const port = Number(process.argv[3] || 0);
if (!['normal', 'residual', 'unavailable', 'login', 'families'].includes(mode)) throw new Error('Unknown preview mode');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid preview port');

let authenticated = mode !== 'login';
let samples = 0;
let clients = [
  { id: 'demo-1', name: 'Home admin · DEMO', enabled: true, networkGroup: 'home', address4: '10.8.0.2', address6: 'fd00:1234::2' },
  { id: 'demo-2', name: 'Phone · DEMO', enabled: true, networkGroup: 'home', address4: '10.8.0.3', address6: 'fd00:1234::3' },
];
if (mode === 'residual') clients.push(
  { id: 'demo-3', name: 'Never connected · DEMO', enabled: true, networkGroup: 'guest', address4: '10.8.0.4', address6: 'fd00:1234::4' },
  { id: 'demo-4', name: 'Disabled · DEMO', enabled: false, networkGroup: 'guest', address4: '10.8.0.5', address6: 'fd00:1234::5' },
  { id: 'demo-5', name: 'Measuring · DEMO', enabled: true, networkGroup: 'home', address4: '10.8.0.6', address6: 'fd00:1234::6' },
);
if (mode === 'families') clients.push(
  { id: 'demo-3', name: 'IPv4 server · DEMO', enabled: true, networkGroup: 'guest', address4: '10.8.0.4' },
);
clients = clients.map((client) => changeClientTraffic(client, {}));
const server = new HttpServer({ api: {
  session: async () => ({ authenticated, language: 'ru' }),
  logout: () => { authenticated = false; return { cookie: 'preview=; Max-Age=0; Path=/' }; },
  login: async () => { authenticated = true; return { cookie: 'preview=1; Path=/' }; },
  listClients: async () => clients.map(publicClient),
  networkInfo: async () => ({ panelIpv4Url: 'http://10.8.0.1:51821/', panelIpv6Url: 'http://[fd00:1234::1]:51821/' }),
  updateClient: async (_token, id, changes) => {
    if (!authenticated) throw new ApiError(401, 'Preview session ended');
    assertActiveHomeRemains(clients, id, changes);
    const client = clients.find((item) => item.id === id);
    const next = changeClientTraffic(client, changes);
    // Synthetic preview simulates the first peer opening the panel over IPv4.
    assertCurrentPanelPathRemains(client, next, '10.8.0.2');
    clients = clients.map((item) => item.id === id ? next : item);
    return publicClient(next);
  },
  exportClient: async (_token, id, format) => {
    if (!authenticated) throw new ApiError(401, 'Preview session ended');
    if (!clients.some((client) => client.id === id)) throw new ApiError(404, 'Unknown demo client');
    if (format !== 'vpn-link') throw new ApiError(400, 'Preview exposes only a non-working demo link');
    return { contentType: 'text/plain; charset=utf-8', value: 'vpn://DEMO-NOT-A-VALID-PROFILE' };
  },
  clientDiagnostics: async () => {
    if (!authenticated) throw new ApiError(401, 'Preview session ended');
    if (mode === 'unavailable') throw new ApiError(503, 'Simulated diagnostics failure');
    samples += 1;
    return clients.map((client, index) => ({
      id: client.id, state: !client.enabled ? 'disabled' : (index === 0 || index === 4 ? 'online' : 'offline'),
      downloadBps: samples === 1 || index === 4 ? null : (index === 0 ? 200 : (mode === 'residual' && index === 1 ? 135 : 0)),
      uploadBps: samples === 1 || index === 4 ? null : 0,
      sampleIntervalSeconds: samples === 1 || index === 4 ? null : 4,
      handshakeAgeSeconds: index === 0 || index === 4 ? 30 : (mode === 'residual' && index === 1 ? 320 : null),
      endpoint: index === 0 || index === 4 ? '203.0.113.10:54321' : (mode === 'residual' && index === 1 ? '203.0.113.20:54322' : null),
      mtu: 1280, persistentKeepalive: '25-35',
    }));
  },
} });
// A fixed-width same-origin srcdoc gives visual QA a real 390px layout viewport.
// It is confined to this synthetic localhost helper; production headers stay unchanged.
const staticRequest = server.staticRequest.bind(server);
server.staticRequest = async (request, response, url) => {
  if (url.pathname !== '/mobile-preview') return staticRequest(request, response, url);
  const source = await fs.readFile(path.join(__dirname, '../../www/index.html'), 'utf8');
  const escaped = source.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>390px synthetic panel preview</title><body style="margin:0;background:#333"><iframe title="Mobile panel preview" style="border:0;width:390px;height:1500px" srcdoc="${escaped}"></iframe></body>`);
};
server.listen({ host: '127.0.0.1', port }).then((address) => {
  console.log(`Panel preview (${mode}, synthetic data): http://127.0.0.1:${address.port}`);
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
process.on('SIGINT', () => server.close().then(() => process.exit(0)));
