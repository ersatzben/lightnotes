const ASSETS = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/sync.js',
  '/opfs.js',
  '/notes.js',
  '/vendor/jszip.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open('v11').then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k !== 'v11').map(k => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});


// Background Sync
self.addEventListener('sync', (event) => {
  if (event.tag === 'lightnotes-sync') {
    event.waitUntil((async () => {
      const clientsList = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      for (const client of clientsList) {
        client.postMessage({ type: 'flush-queue' });
      }
    })());
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'request-sync') {
    if ('sync' in self.registration) {
      event.waitUntil(self.registration.sync.register('lightnotes-sync'));
    }
  }
});

