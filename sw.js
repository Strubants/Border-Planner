const CACHE = 'border-planner-v21';
const FILES = ['./', 'index.html', 'app.js', 'garden-map.js', 'geometry.js', 'store.js', 'style.css', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

// Network first so updates show up; fall back to cache when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const request = new URL(e.request.url).origin === self.location.origin
    ? new Request(e.request, { cache: 'reload' })
    : e.request;
  e.respondWith(
    fetch(request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
