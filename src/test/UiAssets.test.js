'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const www = path.join(__dirname, '..', 'www');
const root = path.join(__dirname, '..', '..');

const pngSize = (filePath) => {
  const data = fs.readFileSync(filePath);
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
};

test('ships a self-contained UI with every required control', () => {
  const html = fs.readFileSync(path.join(www, 'index.html'), 'utf8');
  for (const id of [
    'login-form', 'clients', 'show-create', 'client-group',
    'profile-dialog', 'show-profile-link', 'download-config', 'password-form', 'delete-dialog',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  const externalUrls = [...html.matchAll(/(?:src|href)="(https?:\/\/[^\"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(externalUrls, ['https://github.com/alexsemenovru']);
  assert.match(html, /<footer class="credits"><a href="https:\/\/github\.com\/alexsemenovru" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" dir="ltr">alexsemenovru<\/a><\/footer>/);
  assert.match(html, /\/js\/app\.js\?v=[0-9-]+/);
  assert.match(html, /\/js\/i18n\.js\?v=[0-9-]+/);
  assert.match(html, /\/js\/diagnostics\.js\?v=[0-9-]+/);
  assert.ok(html.indexOf('/js/diagnostics.js') < html.indexOf('/js/app.js'));
  assert.match(html, /data-i18n="diagnosticsHint"/);
  assert.match(html, /class="diag-window"/);
  assert.match(html, /class="live-rates hidden"/);
  assert.match(html, /class="diag-sent diag-rate"/);
  assert.match(html, /class="diag-received diag-rate"/);
  assert.match(html, /class="diagnostics-hint diag-delivery hidden" data-i18n="deliveryUnconfirmed"/);
  assert.match(html, /<svg class="brand-mark"[^>]+aria-hidden="true"/);
  assert.match(html, /\/img\/favicon\.svg\?v=[0-9-]+/);
  assert.match(html, /rel="alternate icon"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /rel="manifest" href="\/manifest\.json\?v=[0-9-]+"/);
  assert.match(html, /\/css\/branding\.css\?v=[0-9-]+/);
  assert.doesNotMatch(html, /<img[^>]+class="brand-mark"/);
  assert.ok(fs.existsSync(path.join(www, 'img', 'logo.png')));
  assert.ok(fs.existsSync(path.join(www, 'img', 'favicon.svg')));
  assert.ok(fs.existsSync(path.join(www, 'img', 'favicon.ico')));
  assert.ok(fs.existsSync(path.join(www, 'img', 'apple-touch-icon.png')));
  assert.doesNotMatch(html, /backup|restore|expire|wireguard/i);
  assert.match(html, /Home/);
  assert.match(html, /Guest/);
  assert.doesNotMatch(html, /РФ напрямую|GeoIP/);
});

test('keeps the IP mode visible outside collapsed access settings and read-only diagnostics', () => {
  const html = fs.readFileSync(path.join(www, 'index.html'), 'utf8');
  const template = html.match(/<template id="client-template">([\s\S]*?)<\/template>/)[1];
  const access = template.match(/<details class="access-settings">([\s\S]*?)<\/details>/)[1];
  const diagnostics = template.match(/<details class="diagnostics">([\s\S]*?)<\/details>/)[1];
  assert.match(access, /<summary data-i18n="accessSettings">/);
  for (const family of [4, 6]) assert.match(access, new RegExp(`class="ipv${family}-toggle"`));
  assert.match(access, /class="ipv6-only-warning hidden"/);
  assert.doesNotMatch(access, /class="ip-summary"/);
  assert.doesNotMatch(diagnostics, /<input|class="ip-summary"/);
  assert.match(template, /<p class="ip-summary" aria-live="polite"><\/p>/);
  assert.ok(template.indexOf('class="ip-summary"') < template.indexOf('<details'));
  assert.equal((template.match(/class="ipv[46]-toggle"/g) || []).length, 2);
});

test('ships the approved self-contained brand and standards-compatible icon set', () => {
  const html = fs.readFileSync(path.join(www, 'index.html'), 'utf8');
  const logo = fs.readFileSync(path.join(root, 'assets', 'awg-easy-3-logo.svg'), 'utf8');
  const favicon = fs.readFileSync(path.join(www, 'img', 'favicon.svg'), 'utf8');
  const branding = fs.readFileSync(path.join(www, 'css', 'branding.css'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(www, 'manifest.json'), 'utf8'));

  for (const pathData of [...logo.matchAll(/\sd="([^"]+)"/g)].map((match) => match[1])) {
    assert.ok(html.includes(`d="${pathData}"`), `inline mark is missing path: ${pathData}`);
  }
  for (const colour of ['#ef535b', '#f49a45', '#f3ce55', '#45b987', '#418ce5', '#9b71d6']) {
    assert.ok(html.includes(colour));
    assert.ok(favicon.includes(colour));
    assert.ok(branding.includes(colour));
  }
  assert.doesNotMatch(`${logo}\n${favicon}\n${branding}`, /(?:href|src)=["']https?:|url\(["']?https?:/);
  assert.match(branding, /mask-image:linear-gradient/);
  assert.deepEqual(manifest.icons.map(({ sizes }) => sizes), ['192x192', '512x512']);
  assert.deepEqual(pngSize(path.join(www, 'img', 'apple-touch-icon.png')), { width: 180, height: 180 });
  assert.deepEqual(pngSize(path.join(www, 'img', 'icon-192.png')), { width: 192, height: 192 });
  assert.deepEqual(pngSize(path.join(www, 'img', 'icon-512.png')), { width: 512, height: 512 });

  const ico = fs.readFileSync(path.join(www, 'img', 'favicon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
  assert.deepEqual([ico[6], ico[22], ico[38]], [16, 32, 48]);
});

test('uses only the versioned API and contains no legacy endpoint calls', () => {
  const html = fs.readFileSync(path.join(www, 'index.html'), 'utf8');
  const api = fs.readFileSync(path.join(www, 'js', 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(www, 'js', 'app.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(www, 'js', 'i18n.js'), 'utf8');
  assert.match(api, /\/api\/v1\/clients/);
  assert.doesNotMatch(`${api}\n${app}`, /\/api\/wireguard|backup|restore/);
  assert.match(app, /networkGroup/);
  assert.doesNotMatch(app, /routeMode|ru_direct/);
  assert.match(i18n, /en:/);
  assert.match(i18n, /ru:/);
  assert.match(i18n, /fa:/);
  assert.match(i18n, /es:/);
  assert.match(i18n, /'zh-cn':/);
  assert.match(i18n, /language === 'fa' \? 'rtl'/);
  assert.doesNotMatch(app, /document\.execCommand\('copy'\)/);
  assert.match(app, /manual-copy/);
  assert.match(app, /paintRates\(node, item, t\)/);
  assert.match(app, /paintRates\(node, \{ state: 'unavailable' \}, t\)/);
  assert.doesNotMatch(app, /navigator\.(?:share|clipboard)/);
  assert.doesNotMatch(app, /window\.location\.href/);
  assert.match(html, /id="profile-link"/);
  assert.match(i18n, /manualCopyHint:/);
});
