// test/pwa.test.js — the app stays installable.
//
// Installing needs three things to line up: every page links the manifest,
// the manifest's icons exist, and the service worker answers page loads. The
// tags are added by middleware (not written into the HTML), so this runs the
// middleware over the real frontend directory the way the server does.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const { pwaHead, injectPwaHead } = require('../middleware/pwaHead');
const FRONTEND = path.join(__dirname, '..', '..', 'frontend');

describe('injectPwaHead', () => {
  const page = '<html><head>\n<title>x</title>\n<link rel="apple-touch-icon" href="/assets/favicon.svg">\n</head><body></body></html>';

  test('adds the manifest, the PNG touch icon and pwa.js inside <head>', () => {
    const out = injectPwaHead(page);
    const head = out.slice(0, out.indexOf('</head>'));
    assert.match(head, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    assert.match(head, /apple-touch-icon" href="\/assets\/icons\/apple-touch-icon\.png"/);
    assert.match(head, /<script src="\/pwa\.js" defer><\/script>/);
  });

  test('adds the phone layout, its script blocking so the html class lands before first paint', () => {
    const head = injectPwaHead(page).split('</head>')[0];
    assert.match(head, /<link rel="stylesheet" href="\/mobile_ui\.css">/);
    assert.match(head, /<script src="\/mobile_ui\.js"><\/script>/);
    for (const f of ['mobile_ui.css', 'mobile_ui.js']) assert.ok(fs.existsSync(path.join(FRONTEND, f)), `${f} must exist`);
  });

  test('drops the SVG touch icon iOS cannot use', () => {
    assert.doesNotMatch(injectPwaHead(page), /favicon\.svg/);
    assert.strictEqual((injectPwaHead(page).match(/rel="apple-touch-icon"/g) || []).length, 1);
  });

  test('leaves a page alone if it already links a manifest, or has no </head>', () => {
    const own = '<html><head><link rel="manifest" href="/other.json"></head></html>';
    assert.strictEqual(injectPwaHead(own), own);
    assert.strictEqual(injectPwaHead('<p>fragment</p>'), '<p>fragment</p>');
  });
});

describe('manifest and service worker files', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'manifest.webmanifest'), 'utf8'));

  test('manifest has what Chrome needs to offer install', () => {
    assert.ok(manifest.name && manifest.short_name);
    assert.strictEqual(manifest.display, 'standalone');
    assert.ok(fs.existsSync(path.join(FRONTEND, manifest.start_url)), 'start_url must be a real page');
    const sizes = manifest.icons.map((i) => i.sizes);
    assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'Android needs a maskable icon');
  });

  test('every icon the manifest, touch icon and worker name is a real PNG', () => {
    const srcs = new Set([
      ...manifest.icons.map((i) => i.src),
      '/assets/icons/apple-touch-icon.png',
      '/assets/icons/icon-192.png'
    ]);
    for (const src of srcs) {
      const buf = fs.readFileSync(path.join(FRONTEND, src));
      assert.strictEqual(buf.slice(1, 4).toString(), 'PNG', `${src} is not a PNG`);
    }
  });

  test('the worker precaches the offline page and handles page loads', () => {
    const sw = fs.readFileSync(path.join(FRONTEND, 'sw.js'), 'utf8');
    assert.ok(fs.existsSync(path.join(FRONTEND, 'offline.html')));
    assert.match(sw, /OFFLINE_URL = '\/offline\.html'/);
    assert.match(sw, /addEventListener\('fetch'/);
    assert.match(sw, /addEventListener\('push'/, 'push notifications must survive');
  });
});

describe('pwaHead middleware over the real frontend', () => {
  let server, base;
  before(async () => {
    const app = express();
    app.use(pwaHead(FRONTEND));
    app.use(express.static(FRONTEND));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  test('every top-level page is served with the manifest link', async () => {
    const pages = fs.readdirSync(FRONTEND).filter((f) => f.endsWith('.html'));
    assert.ok(pages.length > 10);
    for (const p of pages) {
      const raw = fs.readFileSync(path.join(FRONTEND, p), 'utf8');
      if (!/<\/head>/i.test(raw)) continue;
      const res = await fetch(`${base}/${p}`);
      assert.strictEqual(res.status, 200, p);
      assert.match(await res.text(), /rel="manifest"/, `${p} is not installable`);
      assert.strictEqual(res.headers.get('cache-control'), 'no-cache', p);
    }
  });

  // Plain http, not fetch: fetch adds `Cache-Control: no-cache` to any request
  // carrying If-None-Match, and a no-cache request is never answered with 304.
  test('a repeat request with the ETag is a 304', async () => {
    const get = (headers) => new Promise((resolve, reject) => {
      http.get(`${base}/finchat_chat.html`, { headers }, (res) => { res.resume(); resolve(res); }).on('error', reject);
    });
    const first = await get({});
    assert.ok(first.headers.etag);
    const again = await get({ 'If-None-Match': first.headers.etag });
    assert.strictEqual(again.statusCode, 304);
  });

  test('does not read outside the frontend directory', async () => {
    const res = await fetch(`${base}/..%2F..%2Fbackend%2Fpackage.html`);
    assert.notStrictEqual(res.status, 200);
  });

  test('non-HTML files pass straight through', async () => {
    const res = await fetch(`${base}/pwa.js`);
    assert.strictEqual(res.status, 200);
    assert.doesNotMatch(await res.text(), /rel="manifest"/);
  });
});
