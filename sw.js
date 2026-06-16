/* Trader service worker — offline app shell + notification click handling.
 * Cache only the static shell; market data is always fetched fresh (network). */
const CACHE = 'trader-v2';
const SHELL = ['./index.html', './engine.js', './app.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache API data — always go to network.
  if (url.hostname.includes('twelvedata.com')) return;
  // App shell: cache-first, fall back to network.
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) if ('focus' in c) return c.focus();
    if (clients.openWindow) return clients.openWindow('./index.html');
  }));
});
