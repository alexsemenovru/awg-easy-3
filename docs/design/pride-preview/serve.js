'use strict';

// Isolated visual proposal. The app's files and real VPN state are never changed.
// Run: node docs/design/pride-preview/serve.js [port]
const fs = require('node:fs/promises');
const path = require('node:path');
const { HttpServer } = require('../../../src/lib/HttpServer');
const { ApiError } = require('../../../src/lib/ApiService');

const publicDirectory = path.resolve(__dirname, '../../../src/www');
const port = Number(process.argv[2] || 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid preview port');

const localFiles = new Map([
  ['preview-theme.css', 'theme.css'],
  ['preview-board.css', 'board.css'],
  ['preview-favicon.svg', 'favicon.svg'],
]);

const inlineLogo = async (prefix, className = '') => {
  const svg = await fs.readFile(path.join(__dirname, 'logo.svg'), 'utf8');
  return svg
    .replace('role="img" aria-labelledby="mark-title"', `class="${className}" aria-hidden="true" focusable="false"`)
    .replace(/id="([^"]+)"/g, `id="${prefix}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`);
};

const fileSystem = {
  async readFile(filePath) {
    const relative = path.relative(publicDirectory, filePath);
    if (localFiles.has(relative)) return fs.readFile(path.join(__dirname, localFiles.get(relative)));
    if (relative === 'board.html') {
      let html = await fs.readFile(path.join(__dirname, 'board.html'), 'utf8');
      html = html.replace('<!-- PREVIEW_LOGO -->', await inlineLogo('board'));
      html = html.replace('<!-- SMALL_LOGO -->', await inlineLogo('small'));
      html = html.replace('<!-- MEDIUM_LOGO -->', await inlineLogo('medium'));
      return Buffer.from(html);
    }
    if (relative === 'index.html') {
      let html = await fs.readFile(filePath, 'utf8');
      html = html.replace(/<img src="\/img\/logo\.png[^>]+>/, await inlineLogo('header', 'brand-mark'));
      html = html.replace(/href="\/img\/favicon\.ico[^"]*"/, 'href="/preview-favicon.svg"');
      html = html.replace('</head>', '<link rel="stylesheet" href="/preview-theme.css"></head>');
      html = html.replace('<body>', '<body><nav class="preview-nav" aria-label="Предпросмотр"><span>ПРЕДПРОСМОТР · Только вымышленные клиенты</span><a href="/board.html">Знак крупно и сравнение ↗</a></nav>');
      return Buffer.from(html);
    }
    return fs.readFile(filePath);
  },
};

const clients = [
  { id: 'preview-home', name: 'Home admin', enabled: true, networkGroup: 'home', address4: '10.8.0.2', address6: 'fd00:1234::2' },
  { id: 'preview-phone', name: 'Honor 50', enabled: true, networkGroup: 'home', address4: '10.8.0.3', address6: 'fd00:1234::3' },
];
let authenticated = true;
const readOnly = async () => { throw new ApiError(409, 'Предпросмотр: настоящих клиентов и профилей здесь нет.'); };
const server = new HttpServer({ publicDirectory, fileSystem, api: {
  session: async () => ({ authenticated, language: 'ru' }),
  login: async () => { authenticated = true; return { cookie: 'design-preview=1; Path=/; SameSite=Strict' }; },
  logout: () => { authenticated = false; return { cookie: 'design-preview=; Max-Age=0; Path=/' }; },
  listClients: async () => clients,
  clientDiagnostics: async () => clients.map((client, index) => ({
    id: client.id, state: index === 0 ? 'online' : 'offline',
    downloadBps: index === 0 ? 512000 : 0, uploadBps: index === 0 ? 48000 : 0,
    sampleIntervalSeconds: 4, handshakeAgeSeconds: index === 0 ? 27 : null,
    endpoint: index === 0 ? '203.0.113.10:54321' : null, mtu: 1280, persistentKeepalive: '25-35',
  })),
  createClient: readOnly, updateClient: readOnly, deleteClient: readOnly, exportClient: readOnly, changePassword: readOnly,
} });
server.listen({ host: '127.0.0.1', port }).then((address) => {
  console.log(`Design preview (synthetic data): http://127.0.0.1:${address.port}`);
  console.log(`Logo comparison: http://127.0.0.1:${address.port}/board.html`);
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
process.on('SIGINT', () => server.close().then(() => process.exit(0)));
