// The build inserts Vite's versioned asset paths before this file is served.
const BUILD = { version: 'local', assets: [] };
const CACHE_PREFIX = 'student-go-shell-';
const CACHE = CACHE_PREFIX + BUILD.version;
const APP_SHELL = ['/index.html', '/manifest.webmanifest', '/student-go-icon.svg', '/student-go-icon-192.png', '/student-go-icon-512.png', ...BUILD.assets];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) =>
    cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE);
      return await cache.match('/index.html') || Response.error();
    }));
    return;
  }

  // Only serve cached static files. API data and student photos stay out of this cache.
  if (!APP_SHELL.includes(url.pathname) || url.search) return;
  event.respondWith(caches.open(CACHE).then(async (cache) =>
    await cache.match(request, { ignoreVary: true }) || fetch(request)));
});
