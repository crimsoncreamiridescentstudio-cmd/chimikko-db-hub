// Only the generic offline document is cached. No app bundles, profiles,
// images, Firebase/OAuth requests or user-specific responses enter CacheStorage.
const CACHE_PREFIX = 'chimikko-offline-';
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache =>
    cache.add(new Request(OFFLINE_URL, { cache: 'reload' }))));
  // No skipWaiting: don't replace the worker during an editing session.
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(
    names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name))
  )));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate' ||
      url.origin !== self.location.origin) return;
  // Leave authentication helpers, future APIs and unrelated routes untouched.
  if (!['/', '/index.html', '/terms.html', '/privacy.html',
    '/content-guidelines.html', OFFLINE_URL].includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(async () => {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(OFFLINE_URL) || new Response(
      '接続できません。インターネット接続を確認して、もう一度開いてください。',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }));
});
