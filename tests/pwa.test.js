import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
function worker({ offline = false, cached = true } = {}) {
  const handlers = {}, added = [], deleted = [];
  const fallback = new Response('offline document');
  const cache = { add: async request => added.push(request.url), match: async () => cached ? fallback : undefined };
  const network = new Response('live document');
  vm.runInNewContext(source, {
    URL, Response,
    Request: class extends Request { constructor(url, options) { super(new URL(url, 'https://example.com'), options); } },
    self: { location: { origin: 'https://example.com' }, addEventListener: (name, handler) => { handlers[name] = handler; } },
    caches: { open: async () => cache, keys: async () => ['chimikko-offline-v0', 'chimikko-offline-v1', 'unrelated'], delete: async name => deleted.push(name) },
    fetch: async () => { if (offline) throw new TypeError('offline'); return network; }
  });
  const request = (path, mode = 'navigate', method = 'GET') => {
    let response;
    handlers.fetch({ request: { url: new URL(path, 'https://example.com').href, mode, method }, respondWith: promise => { response = promise; } });
    return response;
  };
  return { handlers, request, added, deleted, fallback, network };
}

test('PWA caches only generic offline document and removes only owned stale caches', async () => {
  const w = worker();
  let pending;
  w.handlers.install({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.deepEqual(w.added, ['https://example.com/offline.html']);
  w.handlers.activate({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.deepEqual(w.deleted, ['chimikko-offline-v0']);
});

test('PWA leaves auth, Firestore, JS, images and writes untouched', () => {
  const w = worker();
  for (const path of ['/__/auth/handler', '/api/profile', 'https://firestore.googleapis.com/v1/data']) assert.equal(w.request(path), undefined);
  for (const path of ['/app.js', '/firebase-sdk.js', '/photo.webp']) assert.equal(w.request(path, 'cors'), undefined);
  assert.equal(w.request('/', 'navigate', 'POST'), undefined);
});

test('navigation stays live online; offline fallback retains detail URL and has last-resort response', async () => {
  const live = worker();
  assert.equal(await live.request('/?profile=example'), live.network);
  const offline = worker({ offline: true });
  assert.equal(await offline.request('/?profile=example'), offline.fallback);
  assert.equal((await worker({ offline: true, cached: false }).request('/')).status, 503);
});

test('manifest has stable identity and every icon is present', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) await access(new URL(`..${icon.src}`, import.meta.url));
});
