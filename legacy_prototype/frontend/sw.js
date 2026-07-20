// sw.js — FinChat service worker: receives Web Push and shows notifications.
// Registered by finchat_settings.html when the user enables the push channel.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'FinChat', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'FinChat';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: 'plato_avatar.png',
    badge: 'plato_avatar.png',
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
