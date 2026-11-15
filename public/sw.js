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

// Push payloads contain only a kind and a tag; private details remain inside the app.
self.addEventListener('push', (event) => {
  let message = {};
  try { message = event.data?.json() || {}; } catch { /* Show a generic notice. */ }
  const test = message.kind === 'test';
  const tag = typeof message.tag === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(message.tag)
    ? message.tag : 'studentgo-notice';
  event.waitUntil(self.registration.showNotification('StudentGo', {
    body: test ? '¡La prueba push llegó! Abre StudentGo para continuar.' : 'Tienes un nuevo aviso. Abre StudentGo para consultarlo.',
    icon: '/student-go-icon-192.png',
    tag,
    data: { path: '/?vista=avisos' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => {
      const url = new URL(client.url);
      return url.origin === self.location.origin && url.pathname === '/';
    });
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'STUDENTGO_OPEN_NOTIFICATIONS' });
    } else {
      await self.clients.openWindow(new URL('/?vista=avisos', self.location.origin).href);
    }
  })());
});
