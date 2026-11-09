// Viewer shell cache (PLAN §10 "Viewer backend unreachable"): stores the static shell only, keyed
// without the query string, so a repeat view works offline. API calls and viewer-config.json are
// never cached, and nothing that carries a token is ever stored.
const CACHE = 'sa-viewer-shell-v1';
const SHELL = ['./', './index.html', './ack.html', './pin.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('viewer-config.json')) return;
  if (e.request.mode === 'navigate') {
    const page = url.pathname.endsWith('/') ? './index.html' : url.pathname;
    e.respondWith(fetch(e.request).catch(() => caches.match(page, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))));
    return;
  }
  if (url.pathname.includes('/assets/')) {
    e.respondWith(
      caches.match(url.pathname).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(url.pathname, copy));
            }
            return res;
          }),
      ),
    );
  }
});
