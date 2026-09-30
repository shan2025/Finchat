// sw.js — FinChat service worker.
//
// Registered on every page by pwa.js (and by finchat_settings.html when push is
// switched on — same URL, same registration). It does three things:
//   1. shows an offline screen when a page can't be reached,
//   2. receives Web Push and shows the notification,
//   3. opens the linked page when a notification is tapped.
//
// It deliberately caches nothing else. Every page, script and API call goes to
// the network exactly as it would without a worker — the server's no-cache
// headers exist because stale copies of shared JS (sidebar_nav.js) once hid new
// features for hours, and a caching worker would bring that back.
const SHELL_CACHE = 'finchat-shell-v1';
const OFFLINE_URL = '/offline.html';
const SHELL = [OFFLINE_URL, '/assets/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Page loads only: straight to the network, the offline screen if that fails.
// Everything else (API, scripts, images, sockets) is left untouched.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(OFFLINE_URL).then((r) => r || Response.error())
    )
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'FinChat', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'FinChat';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/assets/icons/icon-192.png',
    badge: '/assets/icons/icon-192.png',
    data: { link: data.link || 'finchat_dashboard.html' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || 'finchat_dashboard.html';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) {
      if (w.url.includes('finchat') && 'focus' in w) { w.navigate(link); return w.focus(); }
    }
    return clients.openWindow(link);
  }));
});
