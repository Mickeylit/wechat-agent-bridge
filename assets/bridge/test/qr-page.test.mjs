import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openQrPage } from '../lib/qr-page.mjs';

async function fixture(t, overrides = {}) {
  const view = { state: 'wait', message: '请扫码', revision: 1, png: Buffer.from('test-png-bytes'),
    token: 'never-return-bot-token', bot_token: 'never-return-another-token', verifyCode: 'secret-123456',
    ownerId: 'private-owner-id', contextToken: 'private-context', ...overrides };
  const page = await openQrPage(() => view);
  t.after(() => page.close());
  return { view, page };
}

function request(page, pathname, { method = 'GET', host } = {}) {
  const url = new URL(page.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: url.port, method, path: pathname,
      headers: { Host: host ?? url.host } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('loopback page uses no-store and restrictive browser headers without embedding credentials', async (t) => {
  const { view, page } = await fixture(t);
  assert.match(page.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const response = await request(page, '/');
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(response.headers['content-security-policy'], /default-src 'none'/);
  assert.match(response.headers['content-type'], /text\/html/);
  const html = response.body.toString();
  for (const key of ['token', 'bot_token', 'verifyCode', 'ownerId', 'contextToken']) assert.ok(!html.includes(view[key]));
  assert.match(html, /textContent=s\.message/);
  assert.match(html, /img\.hidden=!s\.showQr/);
});

test('status exposes only display fields and image fetch is never cacheable', async (t) => {
  const { view, page } = await fixture(t);
  const status = await request(page, '/status');
  assert.equal(status.status, 200);
  assert.equal(status.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(status.body), { state: 'wait', message: '请扫码', revision: 1, showQr: true });
  for (const key of ['token', 'bot_token', 'verifyCode', 'ownerId', 'contextToken']) assert.ok(!status.body.toString().includes(view[key]));
  const png = await request(page, '/qr.png?v=1');
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.equal(png.headers['cache-control'], 'no-store');
  assert.deepEqual(png.body, view.png);
});

test('rejects foreign Host headers and non-GET requests without returning QR or credentials', async (t) => {
  const { page } = await fixture(t);
  for (const [pathname, options] of [
    ['/', { host: 'attacker.example' }],
    ['/status', { host: 'localhost' }],
    ['/qr.png', { host: '127.0.0.1' }],
    ['/status', { method: 'POST' }],
  ]) {
    const response = await request(page, pathname, options);
    assert.equal(response.status, 403);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body.length, 0);
  }
  assert.equal((await request(page, '/status')).status, 200);
});

test('connected or failed states hide QR and make even a previously valid image URL unavailable', async (t) => {
  const { view, page } = await fixture(t);
  assert.equal((await request(page, '/qr.png?v=1')).status, 200);
  for (const state of ['connected', 'failed']) {
    view.state = state;
    const status = await request(page, '/status');
    assert.equal(JSON.parse(status.body).showQr, false);
    assert.equal(JSON.parse(status.body).state, state);
    const image = await request(page, '/qr.png?v=1');
    assert.equal(image.status, 404);
    assert.equal(image.body.length, 0);
    assert.equal(image.headers['cache-control'], 'no-store');
  }
});

test('status and QR image change together when login refreshes the QR code', async (t) => {
  const { view, page } = await fixture(t, { png: null, state: 'preparing' });
  assert.equal(JSON.parse((await request(page, '/status')).body).showQr, false);
  assert.equal((await request(page, '/qr.png')).status, 404);
  Object.assign(view, { state: 'wait', revision: 2, png: Buffer.from('updated-qr') });
  assert.equal(JSON.parse((await request(page, '/status')).body).revision, 2);
  assert.equal((await request(page, '/qr.png?v=2')).body.toString(), 'updated-qr');
  assert.equal((await request(page, '/missing')).status, 404);
});

test('malformed and non-origin request targets return 400 without terminating the login server', async (t) => {
  const { page } = await fixture(t);
  for (const target of ['http://[', 'http://attacker.example/status', '//attacker.example/status', '*']) {
    const response = await request(page, target);
    assert.equal(response.status, 400);
    assert.equal(response.body.length, 0);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal((await request(page, '/status')).status, 200);
  }
});
